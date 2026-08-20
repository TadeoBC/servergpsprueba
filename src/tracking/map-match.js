const EARTH_RADIUS_M = 6371008.8;
const DEFAULT_MAX_POINTS = 400;
// El servicio público de OSRM acepta hasta 100 coordenadas por consulta de
// match. Trozos más largos dan al motor más contexto y menos costuras.
const MAX_CHUNK_POINTS = 100;
const CHUNK_OVERLAP = 5;
// Radio dentro del cual se considera que la unidad no se movió, solo derivó.
const STOP_CLUSTER_METERS = 20;
// Tolerancia angular del rumbo. Con 60° cabía la calle en sentido contrario;
// 35° obliga a respetar el sentido de circulación sin descartar curvas suaves.
const BEARING_TOLERANCE = 35;
// Por debajo de esta velocidad el rumbo que reporta el equipo es ruido.
const BEARING_MIN_KMH = 5;

/** Distancia Haversine entre dos posiciones GPS. */
export function distanceMeters(a, b) {
  const toRad = Math.PI / 180;
  const lat1 = Number(a.latitude) * toRad;
  const lat2 = Number(b.latitude) * toRad;
  const dLat = (Number(b.latitude) - Number(a.latitude)) * toRad;
  const dLon = (Number(b.longitude) - Number(a.longitude)) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Quita duplicados milimétricos y saltos que exigirían una velocidad absurda.
 * No modifica las filas almacenadas: solo limpia la geometría que se dibuja.
 */
export function filterGpsTrace(positions, { maxPoints = DEFAULT_MAX_POINTS } = {}) {
  const valid = positions.filter((p) =>
    p?.valid !== false && Number.isFinite(Number(p?.latitude)) && Number.isFinite(Number(p?.longitude)) &&
    Math.abs(Number(p.latitude)) <= 90 && Math.abs(Number(p.longitude)) <= 180,
  );
  // Para no saturar el servicio externo en rangos grandes se conserva la parte
  // más reciente, que es la relevante al seguir un vehículo en vivo.
  const recent = valid.slice(-Math.max(2, maxPoints));
  const out = [];
  for (const point of recent) {
    const normalized = { ...point, latitude: Number(point.latitude), longitude: Number(point.longitude) };
    const previous = out.at(-1);
    if (!previous) {
      out.push(normalized);
      continue;
    }
    const distance = distanceMeters(previous, normalized);
    const previousTime = new Date(previous.device_time ?? previous.server_time ?? 0).getTime();
    const currentTime = new Date(normalized.device_time ?? normalized.server_time ?? 0).getTime();
    const seconds = Math.max(1, (currentTime - previousTime) / 1000);
    const impliedKmh = distance / seconds * 3.6;
    // Menos de 1 m normalmente es ruido estacionario. Los saltos mayores a
    // 250 m se descartan solo si implican >220 km/h; así no dañamos búferes
    // offline con intervalos largos ni viajes reales por carretera.
    if (distance < 1) continue;
    if (distance > 250 && impliedKmh > 220) continue;
    out.push(normalized);
  }
  return out;
}

export const SPLIT_DEFAULTS = {
  gapSeconds: 600,        // tope duro: 10 min sin un solo pulso ya es un corte
  gapFactor: 6,           // …o 6 veces la cadencia habitual del propio equipo
  minJumpMeters: 300,     // por debajo de esto el hueco no merece romper la línea
  jumpMeters: 1000,       // un salto así entre dos pulsos consecutivos es sospechoso
  maxImpliedKmh: 120,     // …y a esta velocidad implícita, imposible en reparto urbano
};

function tiempoDe(point) {
  const t = new Date(point?.device_time ?? point?.server_time ?? 0).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Cadencia habitual de reporte (mediana de los deltas). Se usa como referencia
 * porque cada equipo reporta a su ritmo: exigirle el mismo hueco fijo a uno que
 * manda cada 10 s y a otro que manda cada 2 min da resultados muy distintos.
 */
function cadenciaMedianaSegundos(points) {
  const deltas = [];
  for (let i = 1; i < points.length; i++) {
    const a = tiempoDe(points[i - 1]);
    const b = tiempoDe(points[i]);
    if (a === null || b === null || b <= a) continue;
    deltas.push((b - a) / 1000);
  }
  if (!deltas.length) return null;
  deltas.sort((x, y) => x - y);
  return deltas[Math.floor(deltas.length / 2)];
}

/**
 * Parte la traza en tramos realmente recorridos.
 *
 * Un corte significa "entre estos dos pulsos no sabemos por dónde anduvo", y es
 * lo que evita que se dibuje —o que OSRM invente— una carretera que el vehículo
 * nunca tomó. El caso que motivó esto: el equipo se apaga en ruta, la unidad se
 * traslada cargada y se vuelve a encender en otro punto; sin corte, el mapa
 * mostraba un trayecto continuo que nunca ocurrió.
 *
 * Se corta cuando pasa cualquiera de estas cosas:
 *   · el hueco temporal supera el tope duro (gapSeconds);
 *   · el hueco supera varias veces la cadencia normal del equipo y además el
 *     vehículo apareció a más de minJumpMeters de donde se quedó;
 *   · el salto es grande y exigiría una velocidad imposible (teletransporte).
 */
export function splitTrace(points, options = {}) {
  const { gapSeconds, gapFactor, minJumpMeters, jumpMeters, maxImpliedKmh } = { ...SPLIT_DEFAULTS, ...options };
  const cadencia = cadenciaMedianaSegundos(points);
  // El umbral por cadencia nunca baja de 60 s ni sube del tope duro: así un
  // equipo con reporte muy espaciado no provoca cortes en cada pulso.
  const umbralCadencia = cadencia ? Math.min(gapSeconds, Math.max(60, cadencia * gapFactor)) : gapSeconds;

  const groups = [];
  let current = [];
  for (const point of points) {
    const previous = current.at(-1);
    if (previous) {
      const a = tiempoDe(previous);
      const b = tiempoDe(point);
      const segundos = a !== null && b !== null ? (b - a) / 1000 : null;
      const metros = distanceMeters(previous, point);
      const kmhImplicita = segundos && segundos > 0 ? (metros / segundos) * 3.6 : null;

      const huecoDuro = segundos !== null && segundos > gapSeconds;
      const huecoRelativo = segundos !== null && segundos > umbralCadencia && metros > minJumpMeters;
      const teletransporte = metros > jumpMeters && kmhImplicita !== null && kmhImplicita > maxImpliedKmh;

      if (huecoDuro || huecoRelativo || teletransporte) {
        groups.push(current);
        current = [];
      }
    }
    current.push(point);
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Divide un tramo en peticiones para OSRM.
 *
 * El solape importa: con un solo punto en común, cada trozo se resolvía casi a
 * ciegas en su primer metro y las uniones daban saltos entre calles paralelas.
 * Repitiendo varios puntos, el trozo siguiente arranca con contexto suficiente
 * para engancharse a la misma vía que traía el anterior.
 */
function chunksWithOverlap(points, size = MAX_CHUNK_POINTS, overlap = CHUNK_OVERLAP) {
  if (points.length <= size) return [points];
  const paso = Math.max(1, size - overlap);
  const chunks = [];
  for (let i = 0; i < points.length; i += paso) {
    const chunk = points.slice(i, i + size);
    if (chunk.length >= 2) chunks.push(chunk);
    if (i + size >= points.length) break;
  }
  return chunks;
}

/**
 * Colapsa las paradas a sus extremos.
 *
 * Con el vehículo detenido el GPS sigue reportando y la posición deriva unos
 * metros en cualquier dirección. Esos puntos entran a OSRM como si fueran
 * movimiento, y el motor —obligado a unirlos por la red vial— resuelve la
 * deriva dando vueltas a la manzana. Es la causa habitual de que la línea se
 * salga de la calle y dibuje lazos donde la unidad solo estuvo parada.
 *
 * Se conservan el primero y el último pulso de cada parada, que es lo que
 * define dónde y cuánto se detuvo; los intermedios solo aportan ruido.
 */
export function collapseStops(points, { radiusMeters = STOP_CLUSTER_METERS, minPoints = 3 } = {}) {
  if (points.length <= 2) return points;
  const out = [];
  let i = 0;
  while (i < points.length) {
    let fin = i;
    while (fin + 1 < points.length && distanceMeters(points[i], points[fin + 1]) <= radiusMeters) fin++;

    const largo = fin - i + 1;
    if (largo >= minPoints) {
      out.push(points[i], points[fin]);
    } else {
      for (let k = i; k <= fin; k++) out.push(points[k]);
    }
    i = fin + 1;
  }
  return out;
}

/**
 * Radio de búsqueda por punto, en metros.
 *
 * Es la incertidumbre que se le declara a OSRM: cuanto mayor, más libertad
 * tiene para engancharse a una calle vecina. Un valor fijo y generoso era parte
 * del problema de que la línea se saliera de la vía, así que se ajusta a la
 * calidad real del fix — con muchos satélites la posición es buena y conviene
 * anclarla corto.
 */
function radiusFor(point) {
  const satelites = Number(point?.satellites);
  if (!Number.isFinite(satelites) || satelites <= 0) return 25;
  if (satelites >= 10) return 10;
  if (satelites >= 7) return 14;
  if (satelites >= 5) return 20;
  return 30;
}

/**
 * Marcas de tiempo en segundos Unix, estrictamente crecientes.
 *
 * OSRM las usa en el modelo oculto de Markov para decidir qué transiciones
 * entre calles candidatas son plausibles. Sin ellas asume un segundo entre
 * puntos: con reportes cada 15 o 30 s, los tramos reales le parecen imposibles
 * de recorrer y prefiere atajos por calles que la unidad nunca tomó. Es la
 * mejora que más precisión aporta.
 *
 * Devuelve null si la traza no trae tiempos utilizables, para no mandar una
 * secuencia inventada que empeoraría el ajuste.
 */
function timestampsFor(points) {
  const segundos = [];
  let anterior = null;
  for (const point of points) {
    const t = tiempoDe(point);
    if (t === null || t === 0) return null;
    let valor = Math.floor(t / 1000);
    // OSRM exige una secuencia no decreciente; dos pulsos en el mismo segundo
    // se separan artificialmente en lugar de descartar el punto.
    if (anterior !== null && valor <= anterior) valor = anterior + 1;
    segundos.push(valor);
    anterior = valor;
  }
  return segundos;
}

function rawCoordinates(points) {
  return points.map((p) => [p.latitude, p.longitude]);
}

async function matchChunk(points, { baseUrl, timeoutMs, fetchImpl }) {
  const coordinates = points.map((p) => `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`).join(';');
  const radiuses = points.map(radiusFor).join(';');
  // El rumbo solo se declara con el vehículo en marcha: parado, la veleta del
  // GPS gira sola y fijarla clavaría la línea en la calle equivocada.
  const bearings = points.map((p) =>
    Number(p.speed_kmh) >= BEARING_MIN_KMH && Number.isFinite(Number(p.course))
      ? `${Math.round(Number(p.course))},${BEARING_TOLERANCE}`
      : '',
  ).join(';');
  const timestamps = timestampsFor(points);
  const url = `${baseUrl.replace(/\/$/, '')}/match/v1/driving/${coordinates}` +
    `?geometries=geojson&overview=full&gaps=split&tidy=true&radiuses=${radiuses}` +
    (timestamps ? `&timestamps=${timestamps.join(';')}` : '') +
    (bearings.replaceAll(';', '') ? `&bearings=${bearings}` : '');
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OSRM HTTP ${response.status}: ${data.message ?? data.code ?? 'respuesta inválida'}`);
  if (data.code !== 'Ok' || !Array.isArray(data.matchings)) throw new Error(`OSRM ${data.code ?? 'sin respuesta'}`);
  const segments = data.matchings
    .map((m) => (m.geometry?.coordinates ?? []).map(([lon, lat]) => [lat, lon]))
    .filter((segment) => segment.length >= 2);
  const snappedPoints = points.flatMap((point, index) => {
    const location = data.tracepoints?.[index]?.location;
    return Array.isArray(location) ? [{ id: point.id, latitude: location[1], longitude: location[0] }] : [];
  });
  return { segments, snappedPoints };
}

/** Route es un segundo intento más permisivo: conserva la estela sobre la red vial. */
async function routeChunk(points, { baseUrl, timeoutMs, fetchImpl }) {
  const coordinates = points.map((p) => `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`).join(';');
  const url = `${baseUrl.replace(/\/$/, '')}/route/v1/driving/${coordinates}` +
    '?geometries=geojson&overview=full&continue_straight=true';
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.code !== 'Ok' || !data.routes?.[0]?.geometry?.coordinates) {
    throw new Error(`OSRM route ${data.message ?? data.code ?? response.status}`);
  }
  return {
    segments: [data.routes[0].geometry.coordinates.map(([lon, lat]) => [lat, lon])],
    snappedPoints: points.flatMap((point, index) => {
      const location = data.waypoints?.[index]?.location;
      return Array.isArray(location) ? [{ id: point.id, latitude: location[1], longitude: location[0] }] : [];
    }),
  };
}

/**
 * Ajusta la estela a calles. Devuelve fallback local ante timeout, falta de
 * cobertura vial o cualquier error del proveedor.
 */
export async function buildMatchedTrace(positions, {
  enabled = true,
  baseUrl = 'https://router.project-osrm.org',
  timeoutMs = 5000,
  maxPoints = DEFAULT_MAX_POINTS,
  splitOptions = {},
  fetchImpl = fetch,
} = {}) {
  const filtered = filterGpsTrace(positions, { maxPoints });
  const groups = splitTrace(filtered, splitOptions);
  if (!enabled || filtered.length < 2) {
    // Sin ajuste a calles la geometría sigue siendo la del GPS, pero ya viene
    // partida: unir los tramos aquí volvería a pintar la recta del apagón.
    const segments = groups.map(rawCoordinates).filter((segment) => segment.length >= 2);
    return { coordinates: segments.flat(), segments, matched: false, gaps: Math.max(0, groups.length - 1),
      reason: enabled ? 'pocos_puntos' : 'desactivado' };
  }
  const segments = [];
  const errors = [];
  let matchedChunks = 0;
  let routedChunks = 0;
  const snappedPoints = new Map();
  const deadline = Date.now() + timeoutMs;
  // Secuencial a propósito: el servidor público de demostración no debe
  // recibir ráfagas paralelas desde nuestra aplicación.
  for (const group of groups) {
    if (group.length < 2) {
      segments.push(rawCoordinates(group));
      continue;
    }
    // Las paradas se colapsan solo para consultar: los pulsos completos se
    // conservan para la lista, las métricas y el heredado del ajuste.
    for (const chunk of chunksWithOverlap(collapseStops(group))) {
      try {
        const remainingMs = deadline - Date.now();
        if (remainingMs < 100) throw new Error('tiempo total de ajuste agotado');
        const matched = await matchChunk(chunk, { baseUrl, timeoutMs: remainingMs, fetchImpl });
        if (!matched.segments.length) throw new Error('OSRM no encontró segmentos viales');
        segments.push(...matched.segments);
        for (const point of matched.snappedPoints) snappedPoints.set(point.id, point);
        matchedChunks++;
      } catch (err) {
        try {
          const remainingMs = deadline - Date.now();
          if (remainingMs < 100) throw new Error('tiempo total de ajuste agotado');
          const routed = await routeChunk(chunk, { baseUrl, timeoutMs: remainingMs, fetchImpl });
          segments.push(...routed.segments);
          for (const point of routed.snappedPoints) snappedPoints.set(point.id, point);
          routedChunks++;
        } catch (routeError) {
          segments.push(rawCoordinates(chunk));
          errors.push(`${err.message}; ${routeError.message}`);
        }
      }
    }
  }
  const coordinates = segments.flat();
  // Los duplicados estacionarios que filterGpsTrace quitó deben heredar el
  // ajuste del pulso cercano; así las paradas tampoco reaparecen fuera de vía.
  for (const point of positions) {
    if (snappedPoints.has(point.id) || !Number.isFinite(Number(point.latitude)) || !Number.isFinite(Number(point.longitude))) continue;
    let nearest = null;
    let nearestDistance = Infinity;
    for (const candidate of filtered) {
      const snapped = snappedPoints.get(candidate.id);
      if (!snapped) continue;
      const distance = distanceMeters(point, candidate);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = snapped;
      }
    }
    if (nearest && nearestDistance <= 25) {
      snappedPoints.set(point.id, { id: point.id, latitude: nearest.latitude, longitude: nearest.longitude });
    }
  }
  return {
    coordinates,
    segments,
    matched: matchedChunks > 0 || routedChunks > 0,
    partial: errors.length > 0 && (matchedChunks > 0 || routedChunks > 0),
    routed_fallback: routedChunks > 0,
    snapped_points: [...snappedPoints.values()],
    gaps: Math.max(0, groups.length - 1),
    reason: matchedChunks > 0 || routedChunks > 0 ? undefined : 'fallback',
    error: errors.length ? errors[0] : undefined,
    input_points: filtered.length,
  };
}
