import { distanceMeters, filterGpsTrace, splitTrace, buildMatchedTrace } from './map-match.js';

/**
 * Recorridos agrupados por día natural.
 *
 * La jornada se corta por el día LOCAL del operador, no por UTC: en México eso
 * son seis horas de diferencia, suficientes para que todo lo trabajado después
 * de las 18:00 apareciera en el día siguiente. Todo el módulo trabaja con la
 * fecha en formato 'YYYY-MM-DD' y traduce a instantes UTC solo al consultar.
 */

/** Desfase de la zona horaria (en minutos) vigente en ese instante. */
function offsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return (local - date.getTime()) / 60000;
}

/** Fecha local 'YYYY-MM-DD' correspondiente a un instante. */
export function localDate(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return dtf.format(date instanceof Date ? date : new Date(date));
}

/** Día local anterior a `fecha` ('YYYY-MM-DD'), sin depender de la zona. */
export function previousDate(fecha, days = 1) {
  const [y, m, d] = fecha.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) - days * 86400000;
  const back = new Date(t);
  return `${back.getUTCFullYear()}-${String(back.getUTCMonth() + 1).padStart(2, '0')}-${String(back.getUTCDate()).padStart(2, '0')}`;
}

export function isValidDate(fecha) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha ?? ''))) return false;
  const [y, m, d] = fecha.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/**
 * Instantes UTC que delimitan un día local: [inicio, fin).
 * Se resuelve en dos pasadas porque el desfase depende de la propia fecha
 * (horario de verano); la primera aproximación puede caer del lado equivocado
 * del cambio de hora.
 */
export function dayRangeUtc(fecha, timeZone) {
  const [y, m, d] = fecha.split('-').map(Number);
  const nominal = Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  let inicio = nominal;
  for (let i = 0; i < 2; i++) inicio = nominal - offsetMinutes(new Date(inicio), timeZone) * 60000;

  const nominalFin = nominal + 86400000;
  let fin = nominalFin;
  for (let i = 0; i < 2; i++) fin = nominalFin - offsetMinutes(new Date(fin), timeZone) * 60000;

  return { desde: new Date(inicio), hasta: new Date(fin - 1) };
}

/**
 * Métricas de la jornada.
 *
 * La distancia se acumula DENTRO de cada tramo y nunca entre tramos: sumar el
 * salto de un apagón inflaría el kilometraje con un trayecto que el vehículo
 * no recorrió por su cuenta.
 */
export function resumirRuta(positions, grupos) {
  let distanciaMetros = 0;
  for (const grupo of grupos) {
    for (let i = 1; i < grupo.length; i++) distanciaMetros += distanceMeters(grupo[i - 1], grupo[i]);
  }

  const conFix = positions.filter((p) => p.latitude !== null && p.longitude !== null);
  const velocidades = conFix.map((p) => Number(p.speed_kmh)).filter(Number.isFinite);
  const tiempos = conFix
    .map((p) => p.device_time ?? p.server_time)
    .filter(Boolean)
    .map((t) => new Date(t))
    .filter((t) => Number.isFinite(t.getTime()))
    .sort((a, b) => a - b);

  // Una parada es una racha contigua de pulsos marcados como detenidos por
  // annotateMovementStates; cuentan los bloques, no los pulsos sueltos.
  let paradas = 0;
  let dentroDeParada = false;
  for (const p of conFix) {
    if (p.movement_state === 'stopped') {
      if (!dentroDeParada) paradas++;
      dentroDeParada = true;
    } else dentroDeParada = false;
  }

  return {
    distancia_km: Number((distanciaMetros / 1000).toFixed(3)),
    puntos: conFix.length,
    tramos: grupos.length,
    paradas,
    velocidad_max_kmh: velocidades.length ? Math.max(...velocidades) : null,
    primer_punto: tiempos[0] ?? null,
    ultimo_punto: tiempos.at(-1) ?? null,
  };
}

/** MultiLineString en WKT a partir de los tramos [[lat, lon], ...]. */
export function segmentsToWkt(segments) {
  const utiles = segments.filter((s) => Array.isArray(s) && s.length >= 2);
  if (!utiles.length) return null;
  const cuerpo = utiles
    .map((s) => `(${s.map(([lat, lon]) => `${Number(lon)} ${Number(lat)}`).join(',')})`)
    .join(',');
  return `SRID=4326;MULTILINESTRING(${cuerpo})`;
}

/**
 * Construye la ruta de un día para un equipo. No toca la base: devuelve el
 * material listo para que el repositorio lo guarde o para servirlo en vivo.
 */
export async function buildDailyRoute(device, fecha, {
  listPositions,
  timeZone,
  limit = 20000,
  ajustarCalles = true,
  mapMatch = {},
} = {}) {
  const { desde, hasta } = dayRangeUtc(fecha, timeZone);
  const positions = await listPositions(device.id, { desde, hasta, limit, soloValidas: true });

  const filtradas = filterGpsTrace(positions, { maxPoints: Math.max(2, limit) });
  const grupos = splitTrace(filtradas);
  const resumen = resumirRuta(positions, grupos);

  const trace = await buildMatchedTrace(positions, { enabled: ajustarCalles, ...mapMatch });
  const segments = trace.segments?.length ? trace.segments : grupos.map((g) => g.map((p) => [p.latitude, p.longitude]));

  return {
    device_id: device.id,
    fecha,
    zona_horaria: timeZone,
    segments: segments.filter((s) => s.length >= 2),
    ajustada_calles: Boolean(trace.matched),
    ...resumen,
    resumen: {
      gaps: trace.gaps ?? Math.max(0, grupos.length - 1),
      map_match: { matched: Boolean(trace.matched), parcial: Boolean(trace.partial), motivo: trace.reason ?? null },
      rango_utc: { desde: desde.toISOString(), hasta: hasta.toISOString() },
    },
  };
}
