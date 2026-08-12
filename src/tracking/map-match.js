const EARTH_RADIUS_M = 6371008.8;
const DEFAULT_MAX_POINTS = 400;
const MAX_CHUNK_POINTS = 40;

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

/** Separa periodos largos sin señal para que OSRM no invente una carretera entre viajes. */
export function splitTrace(points, { gapSeconds = 600 } = {}) {
  const groups = [];
  let current = [];
  for (const point of points) {
    const previous = current.at(-1);
    if (previous) {
      const a = new Date(previous.device_time ?? previous.server_time ?? 0).getTime();
      const b = new Date(point.device_time ?? point.server_time ?? 0).getTime();
      if (Number.isFinite(a) && Number.isFinite(b) && b - a > gapSeconds * 1000) {
        groups.push(current);
        current = [];
      }
    }
    current.push(point);
  }
  if (current.length) groups.push(current);
  return groups;
}

function chunksWithOverlap(points, size = MAX_CHUNK_POINTS) {
  if (points.length <= size) return [points];
  const chunks = [];
  for (let i = 0; i < points.length; i += size - 1) {
    const chunk = points.slice(i, i + size);
    if (chunk.length >= 2) chunks.push(chunk);
  }
  return chunks;
}

function rawCoordinates(points) {
  return points.map((p) => [p.latitude, p.longitude]);
}

async function matchChunk(points, { baseUrl, timeoutMs, fetchImpl }) {
  const coordinates = points.map((p) => `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`).join(';');
  const url = `${baseUrl.replace(/\/$/, '')}/match/v1/driving/${coordinates}` +
    '?geometries=geojson&overview=full&gaps=split&tidy=true';
  const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`OSRM HTTP ${response.status}: ${data.message ?? data.code ?? 'respuesta inválida'}`);
  if (data.code !== 'Ok' || !Array.isArray(data.matchings)) throw new Error(`OSRM ${data.code ?? 'sin respuesta'}`);
  return data.matchings
    .map((m) => (m.geometry?.coordinates ?? []).map(([lon, lat]) => [lat, lon]))
    .filter((segment) => segment.length >= 2);
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
  fetchImpl = fetch,
} = {}) {
  const filtered = filterGpsTrace(positions, { maxPoints });
  if (!enabled || filtered.length < 2) {
    const coordinates = rawCoordinates(filtered);
    return { coordinates, segments: coordinates.length ? [coordinates] : [], matched: false,
      reason: enabled ? 'pocos_puntos' : 'desactivado' };
  }

  const groups = splitTrace(filtered);
  const segments = [];
  const errors = [];
  let matchedChunks = 0;
  const deadline = Date.now() + timeoutMs;
  // Secuencial a propósito: el servidor público de demostración no debe
  // recibir ráfagas paralelas desde nuestra aplicación.
  for (const group of groups) {
    if (group.length < 2) {
      segments.push(rawCoordinates(group));
      continue;
    }
    for (const chunk of chunksWithOverlap(group)) {
      try {
        const remainingMs = deadline - Date.now();
        if (remainingMs < 100) throw new Error('tiempo total de ajuste agotado');
        const chunkSegments = await matchChunk(chunk, { baseUrl, timeoutMs: remainingMs, fetchImpl });
        if (!chunkSegments.length) throw new Error('OSRM no encontró segmentos viales');
        segments.push(...chunkSegments);
        matchedChunks++;
      } catch (err) {
        segments.push(rawCoordinates(chunk));
        errors.push(err.message);
      }
    }
  }
  const coordinates = segments.flat();
  return {
    coordinates,
    segments,
    matched: matchedChunks > 0,
    partial: errors.length > 0 && matchedChunks > 0,
    reason: matchedChunks > 0 ? undefined : 'fallback',
    error: errors.length ? errors[0] : undefined,
    input_points: filtered.length,
  };
}
