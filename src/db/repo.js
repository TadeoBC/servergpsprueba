import { query } from './pool.js';
import { logger } from '../logger.js';
import { annotateMovementStates, currentMovementState } from '../tracking/movement.js';

// Caché en memoria imei -> device row. Evita un SELECT por cada trama.
//
// Con vencimiento a 60 s a propósito: cuando actives un equipo a mano en la base
// (UPDATE devices SET activo = true ...) el cambio se refleja solo, sin reiniciar
// el servicio. Sin vencimiento, la interfaz seguiría diciendo "sin activar".
const CACHE_TTL_MS = 60000;
const deviceCache = new Map(); // clave -> { row, at }

function cacheGet(clave) {
  const e = deviceCache.get(clave);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) {
    deviceCache.delete(clave);
    return null;
  }
  return e.row;
}

function cacheSet(clave, row) {
  deviceCache.set(clave, { row, at: Date.now() });
}

export function clearDeviceCache() {
  deviceCache.clear();
}

/**
 * Busca el device por IMEI exacto. Si no existe, lo da de alta con activo=false
 * (auto-registro) y lo loguea, para descubrir equipos nuevos sin rechazar sus
 * reportes.
 */
export async function getOrCreateDevice(imei) {
  const cached = cacheGet(imei);
  if (cached) return cached;

  const found = await query('SELECT * FROM devices WHERE imei = $1', [imei]);
  if (found.rows.length > 0) {
    cacheSet(imei, found.rows[0]);
    return found.rows[0];
  }

  // ON CONFLICT cubre la carrera entre dos conexiones del mismo equipo.
  const inserted = await query(
    `INSERT INTO devices (imei, activo) VALUES ($1, false)
     ON CONFLICT (imei) DO UPDATE SET imei = EXCLUDED.imei
     RETURNING *`,
    [imei],
  );
  const device = inserted.rows[0];
  if (device.created_at && Date.now() - new Date(device.created_at).getTime() < 5000) {
    logger.warn(
      { imei, device_id: device.id },
      'IMEI desconocido: equipo dado de alta automáticamente con activo=false. ' +
        'Actívalo en la base cuando lo confirmes.',
    );
  }
  cacheSet(imei, device);
  return device;
}

/**
 * JT808 identifica al equipo con un BCD de 6 bytes = 12 dígitos, mientras que
 * el IMEI tiene 15. Muchos firmwares mandan los últimos 12 dígitos del IMEI.
 * Resolvemos así, en orden:
 *   1. coincidencia exacta,
 *   2. un único device cuyo IMEI TERMINE con esos dígitos,
 *   3. si no hay nada, auto-registro con el identificador tal cual llegó.
 * Nunca adivinamos entre varios candidatos.
 */
export async function resolveDeviceByTerminalId(terminalId) {
  const cacheKey = `t:${terminalId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const exact = await query('SELECT * FROM devices WHERE imei = $1', [terminalId]);
  if (exact.rows.length > 0) {
    cacheSet(cacheKey, exact.rows[0]);
    return exact.rows[0];
  }

  const suffix = await query('SELECT * FROM devices WHERE imei LIKE $1', [`%${terminalId}`]);
  if (suffix.rows.length === 1) {
    logger.info(
      { terminal_id: terminalId, imei: suffix.rows[0].imei },
      'identificador JT808 resuelto por sufijo del IMEI',
    );
    cacheSet(cacheKey, suffix.rows[0]);
    return suffix.rows[0];
  }
  if (suffix.rows.length > 1) {
    logger.warn(
      { terminal_id: terminalId, candidatos: suffix.rows.map((r) => r.imei) },
      'el identificador JT808 coincide con varios IMEI, no se asigna: se registra aparte',
    );
  }

  const device = await getOrCreateDevice(terminalId);
  cacheSet(cacheKey, device);
  return device;
}

export async function touchDevice(deviceId) {
  const { rows } = await query(
    'UPDATE devices SET last_seen_at = now() WHERE id = $1 RETURNING *',
    [deviceId],
  );
  return rows[0] ?? null;
}

export async function updateDeviceTelemetry(deviceId, patch) {
  if (!patch || Object.keys(patch).length === 0) return null;
  const { rows } = await query(
    `UPDATE devices
     SET telemetry = COALESCE(telemetry, '{}'::jsonb) || $2::jsonb,
         telemetry_updated_at = now(), last_seen_at = now()
     WHERE id = $1 RETURNING telemetry, telemetry_updated_at`,
    [deviceId, JSON.stringify(patch)],
  );
  return rows[0] ?? null;
}

export async function updateDeviceSettings(deviceId, { speedLimitKmh, reportIntervalSeconds }) {
  const { rows } = await query(
    `UPDATE devices SET speed_limit_kmh = $2, report_interval_seconds = $3
     WHERE id = $1 RETURNING *`,
    [deviceId, speedLimitKmh, reportIntervalSeconds],
  );
  clearDeviceCache();
  return rows[0] ?? null;
}

/**
 * Da de alta un IMEI o restaura uno archivado. El ON CONFLICT conserva sus
 * posiciones y eventos anteriores, en vez de crear una identidad duplicada.
 */
export async function createOrRestoreDevice({ imei, alias = null, placa = null }) {
  const { rows } = await query(
    `INSERT INTO devices (imei, alias, placa, activo, archived_at)
     VALUES ($1, $2, $3, true, NULL)
     ON CONFLICT (imei) DO UPDATE SET
       alias = COALESCE(EXCLUDED.alias, devices.alias),
       placa = COALESCE(EXCLUDED.placa, devices.placa),
       activo = true,
       archived_at = NULL
     RETURNING *`,
    [imei, alias, placa],
  );
  clearDeviceCache();
  return rows[0];
}

/** Oculta el equipo sin destruir posiciones, eventos ni comandos. */
export async function archiveDevice(deviceId) {
  const { rows } = await query(
    `UPDATE devices
     SET activo = false, archived_at = now()
     WHERE id = $1 AND archived_at IS NULL
     RETURNING *`,
    [deviceId],
  );
  clearDeviceCache();
  return rows[0] ?? null;
}

export async function evaluateSpeedAlert(device, position) {
  if (!position?.valid || position.speed_kmh === null) return null;
  const { rows } = await query(
    `WITH settings AS (
       SELECT speed_limit_kmh FROM devices WHERE id=$1
     ), previous AS (
       SELECT speeding FROM device_alert_state WHERE device_id=$1
     ), upserted AS (
       INSERT INTO device_alert_state (device_id, speeding, speeding_since)
       SELECT $1, $2 > speed_limit_kmh,
              CASE WHEN $2 > speed_limit_kmh THEN now() ELSE NULL END
       FROM settings WHERE speed_limit_kmh IS NOT NULL
       ON CONFLICT (device_id) DO UPDATE SET
       speeding = EXCLUDED.speeding,
       speeding_since = CASE
         WHEN EXCLUDED.speeding AND NOT device_alert_state.speeding THEN now()
         WHEN EXCLUDED.speeding THEN device_alert_state.speeding_since
         ELSE NULL END,
       updated_at = now()
       RETURNING speeding, speeding_since
     )
     SELECT u.*, s.speed_limit_kmh,
            (u.speeding AND NOT COALESCE(p.speeding, false)) AS entered,
            (NOT u.speeding AND COALESCE(p.speeding, false)) AS cleared
     FROM upserted u CROSS JOIN settings s LEFT JOIN previous p ON true`,
    [device.id, Number(position.speed_kmh)],
  );
  return rows[0] ?? null;
}

/**
 * Inserta una posición. Devuelve la fila insertada, o null si fue descartada
 * por duplicado (mismo device_id + device_time): eso pasa cuando el equipo
 * reenvía su búfer offline y no debe duplicar histórico.
 */
export async function insertPosition(p) {
  const point =
    p.latitude === null || p.latitude === undefined || p.longitude === null || p.longitude === undefined
      ? null
      : `SRID=4326;POINT(${p.longitude} ${p.latitude})`;

  const { rows } = await query(
    `INSERT INTO positions
       (device_id, geom, speed_kmh, course, altitude, satellites, valid,
        device_time, raw_hex, protocol, attributes)
     VALUES ($1, $2::geography, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
     ON CONFLICT (device_id, device_time) DO NOTHING
     RETURNING id, device_id, speed_kmh, course, altitude, satellites, valid,
               device_time, server_time, raw_hex, protocol, attributes,
               ST_Y(geom::geometry) AS latitude, ST_X(geom::geometry) AS longitude`,
    [
      p.deviceId,
      point,
      p.speedKmh ?? null,
      p.course ?? null,
      p.altitude ?? null,
      p.satellites ?? null,
      p.valid === true,
      p.deviceTime ?? null,
      p.rawHex ?? null,
      p.protocol ?? null,
      JSON.stringify(p.attributes ?? {}),
    ],
  );
  return rows[0] ?? null;
}

export async function insertEvent({ deviceId = null, tipo, positionId = null, raw = {} }) {
  const { rows } = await query(
    `INSERT INTO events (device_id, tipo, position_id, raw)
     VALUES ($1, $2, $3, $4::jsonb) RETURNING id`,
    [deviceId, tipo, positionId, JSON.stringify(raw)],
  );
  return rows[0];
}

/**
 * Lista de equipos con su última posición conocida (con o sin fix).
 *
 * Una sola consulta para toda la flotilla: el LATERAL trae los últimos tres
 * fixes de cada equipo y el estado de movimiento se calcula aquí. La versión
 * anterior lanzaba un SELECT extra POR EQUIPO (getCurrentMovementState), así
 * que con una flotilla de verdad el panel hacía N+1 consultas cada vez que se
 * refrescaba la lista.
 */
export async function listDevicesWithLastPosition() {
  const { rows } = await query(`
    SELECT d.id, d.imei, d.alias, d.placa, d.activo, d.archived_at, d.last_seen_at, d.created_at,
           d.speed_limit_kmh, d.report_interval_seconds, d.telemetry, d.telemetry_updated_at,
           p.ultimas
    FROM devices d
    LEFT JOIN LATERAL (
      SELECT json_agg(u ORDER BY u.server_time ASC, u.id ASC) AS ultimas
      FROM (
        SELECT id, speed_kmh, course, altitude, satellites, valid,
               device_time, server_time, protocol, attributes, raw_hex,
               ST_Y(geom::geometry) AS latitude,
               ST_X(geom::geometry) AS longitude
        FROM positions
        WHERE device_id = d.id AND geom IS NOT NULL AND valid = true
        ORDER BY server_time DESC, id DESC
        LIMIT 3
      ) u
    ) p ON true
    WHERE d.archived_at IS NULL
    ORDER BY d.alias NULLS LAST, d.imei
  `);

  return rows.map((row) => {
    const ultimas = row.ultimas ?? [];
    const device = shapeDeviceRow(row, ultimas.at(-1) ?? null);
    if (device.last_position) Object.assign(device.last_position, currentMovementState(ultimas));
    return device;
  });
}

export async function getDeviceByImei(imei) {
  const { rows } = await query('SELECT * FROM devices WHERE imei = $1', [imei]);
  return rows[0] ?? null;
}

export async function getLastPosition(deviceId) {
  const { rows } = await query(
    `SELECT id, device_id, ST_Y(geom::geometry) AS latitude, ST_X(geom::geometry) AS longitude,
            speed_kmh, course, altitude, satellites, valid, device_time, server_time,
            protocol, attributes, raw_hex
     FROM positions
     WHERE device_id = $1 AND geom IS NOT NULL AND valid = true
     ORDER BY server_time DESC, id DESC
     LIMIT 1`,
    [deviceId],
  );
  const position = rows[0] ?? null;
  if (position) Object.assign(position, await getCurrentMovementState(deviceId));
  return position;
}

/** Estado actual a partir de los últimos tres fixes, usado por API y WebSocket. */
export async function getCurrentMovementState(deviceId) {
  const { rows } = await query(
    `SELECT id, valid, device_time, server_time,
            ST_Y(geom::geometry) AS latitude, ST_X(geom::geometry) AS longitude
     FROM positions
     WHERE device_id = $1 AND geom IS NOT NULL AND valid = true
     ORDER BY server_time DESC, id DESC
     LIMIT 3`,
    [deviceId],
  );
  return currentMovementState(rows.reverse());
}

export async function listEvents(deviceId, { desde = null, limit = 100 } = {}) {
  const params = [deviceId];
  let dateFilter = '';
  if (desde) { params.push(desde); dateFilter = ` AND created_at >= $${params.length}`; }
  params.push(limit);
  const { rows } = await query(
    `SELECT id, tipo, position_id, raw, created_at FROM events
     WHERE device_id=$1${dateFilter} ORDER BY created_at DESC LIMIT $${params.length}`, params);
  return rows;
}

export async function createDeviceCommand({ deviceId, commandType, commandText, serverFlag, requestedBy }) {
  const { rows } = await query(
    `INSERT INTO device_commands (device_id, command_type, command_text, server_flag, requested_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [deviceId, commandType, commandText, serverFlag, requestedBy ?? null],
  );
  return rows[0];
}

export async function listDeviceCommands(deviceId, { limit = 50 } = {}) {
  await expireDeviceCommands();
  const { rows } = await query(
    `SELECT * FROM device_commands WHERE device_id=$1 ORDER BY id DESC LIMIT $2`, [deviceId, limit]);
  return rows;
}

export async function getDeviceCommand(id) {
  const { rows } = await query('SELECT * FROM device_commands WHERE id=$1', [id]);
  return rows[0] ?? null;
}

export async function getQueuedDeviceCommands(deviceId) {
  await expireDeviceCommands();
  const { rows } = await query(
    `SELECT * FROM device_commands WHERE device_id=$1 AND status='queued' AND expires_at > now()
     ORDER BY id ASC LIMIT 20`, [deviceId]);
  return rows;
}

export async function markDeviceCommandSent(id) {
  const { rows } = await query(
    `UPDATE device_commands SET status='sent', sent_at=now(), attempts=attempts+1
     WHERE id=$1 AND status='queued' RETURNING *`, [id]);
  return rows[0] ?? null;
}

export async function resolveDeviceCommand(serverFlag, responseText) {
  const failed = /(?:ERROR|FAIL|INVALID|INCORRECT|ERR!)/i.test(responseText ?? '');
  const { rows } = await query(
    `UPDATE device_commands SET status=$2, response_text=$3, responded_at=now()
     WHERE server_flag=$1 AND status IN ('queued','sent') RETURNING *`,
    [serverFlag, failed ? 'failed' : 'acknowledged', responseText ?? ''],
  );
  return rows[0] ?? null;
}

export async function expireDeviceCommands() {
  await query(
    `UPDATE device_commands SET status='expired'
     WHERE status IN ('queued','sent')
       AND (expires_at <= now() OR (status='sent' AND sent_at < now() - interval '10 minutes'))`,
  );
}

/**
 * Histórico de posiciones. Filtra por device_time (la hora del equipo) y cae a
 * server_time para las tramas sin fecha válida, así el recorrido no pierde
 * puntos por una fecha corrupta.
 */
export async function listPositions(deviceId, { desde = null, hasta = null, limit = 100, soloValidas = false } = {}) {
  const params = [deviceId];
  const where = ['device_id = $1'];

  if (desde) {
    params.push(desde);
    where.push(`COALESCE(device_time, server_time) >= $${params.length}`);
  }
  if (hasta) {
    params.push(hasta);
    where.push(`COALESCE(device_time, server_time) <= $${params.length}`);
  }
  if (soloValidas) where.push('valid = true AND geom IS NOT NULL');

  params.push(limit);

  const { rows } = await query(
    `SELECT id, device_id, ST_Y(geom::geometry) AS latitude, ST_X(geom::geometry) AS longitude,
            speed_kmh, course, altitude, satellites, valid, device_time, server_time,
            protocol, attributes, raw_hex
     FROM positions
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(device_time, server_time) DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  // Se devuelven en orden cronológico ascendente: así el frontend dibuja la
  // polilínea directo sin invertir el arreglo.
  return annotateMovementStates(rows.reverse());
}

function shapeDeviceRow(r, position = null) {
  return {
    id: r.id,
    imei: r.imei,
    alias: r.alias,
    placa: r.placa,
    activo: r.activo,
    archived_at: r.archived_at,
    speed_limit_kmh: r.speed_limit_kmh,
    report_interval_seconds: r.report_interval_seconds,
    telemetry: r.telemetry ?? {},
    telemetry_updated_at: r.telemetry_updated_at,
    last_seen_at: r.last_seen_at,
    created_at: r.created_at,
    last_position: position
      ? {
          id: position.id,
          latitude: position.latitude,
          longitude: position.longitude,
          speed_kmh: position.speed_kmh,
          course: position.course,
          altitude: position.altitude,
          satellites: position.satellites,
          valid: position.valid,
          device_time: position.device_time,
          server_time: position.server_time,
          protocol: position.protocol,
          attributes: position.attributes,
          raw_hex: position.raw_hex,
        }
      : null,
  };
}

// ── rutas diarias ────────────────────────────────────────────────────────────

// La geometría llega como WKT MultiLineString y se guarda ya proyectada a 4326.
// `cerrada` marca los días que ya no van a cambiar: el día en curso se
// reescribe en cada consulta, los anteriores se congelan una sola vez.
export async function upsertDailyRoute(route, { cerrada = false } = {}) {
  const { rows } = await query(
    `INSERT INTO daily_routes
       (device_id, fecha, zona_horaria, geom, distancia_km, puntos, tramos, paradas,
        velocidad_max_kmh, primer_punto, ultimo_punto, ajustada_calles, cerrada, resumen, generada_en)
     VALUES ($1, $2, $3, ST_GeomFromEWKT($4), $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
     ON CONFLICT (device_id, fecha) DO UPDATE SET
       zona_horaria = EXCLUDED.zona_horaria,
       geom = EXCLUDED.geom,
       distancia_km = EXCLUDED.distancia_km,
       puntos = EXCLUDED.puntos,
       tramos = EXCLUDED.tramos,
       paradas = EXCLUDED.paradas,
       velocidad_max_kmh = EXCLUDED.velocidad_max_kmh,
       primer_punto = EXCLUDED.primer_punto,
       ultimo_punto = EXCLUDED.ultimo_punto,
       ajustada_calles = EXCLUDED.ajustada_calles,
       cerrada = EXCLUDED.cerrada,
       resumen = EXCLUDED.resumen,
       generada_en = now()
     RETURNING id, cerrada`,
    [
      route.device_id, route.fecha, route.zona_horaria, route.wkt,
      route.distancia_km, route.puntos, route.tramos, route.paradas,
      route.velocidad_max_kmh, route.primer_punto, route.ultimo_punto,
      route.ajustada_calles, cerrada, JSON.stringify(route.resumen ?? {}),
    ],
  );
  return rows[0] ?? null;
}

function shapeDailyRoute(r) {
  return {
    fecha: r.fecha instanceof Date ? r.fecha.toISOString().slice(0, 10) : String(r.fecha).slice(0, 10),
    zona_horaria: r.zona_horaria,
    distancia_km: r.distancia_km,
    puntos: r.puntos,
    tramos: r.tramos,
    paradas: r.paradas,
    velocidad_max_kmh: r.velocidad_max_kmh,
    primer_punto: r.primer_punto,
    ultimo_punto: r.ultimo_punto,
    ajustada_calles: r.ajustada_calles,
    cerrada: r.cerrada,
    resumen: r.resumen ?? {},
    generada_en: r.generada_en,
    // Los tramos vuelven como [[lat, lon], ...] para que el mapa los dibuje sin
    // transformar nada; PostGIS entrega lon/lat y aquí se invierte.
    segments: (r.segments ?? []).map((linea) => linea.map(([lon, lat]) => [lat, lon])),
  };
}

const DAILY_ROUTE_COLUMNS = `fecha, zona_horaria, distancia_km, puntos, tramos, paradas,
         velocidad_max_kmh, primer_punto, ultimo_punto, ajustada_calles, cerrada, resumen, generada_en`;

export async function getDailyRoute(deviceId, fecha) {
  const { rows } = await query(
    `SELECT ${DAILY_ROUTE_COLUMNS},
            -- En un MultiLineString el arreglo 'coordinates' de GeoJSON ya es
            -- la lista de tramos, así que no hace falta desarmar la geometría.
            COALESCE(ST_AsGeoJSON(geom)::jsonb -> 'coordinates', '[]'::jsonb) AS segments
     FROM daily_routes WHERE device_id = $1 AND fecha = $2`,
    [deviceId, fecha],
  );
  return rows[0] ? shapeDailyRoute(rows[0]) : null;
}

// El listado de días es para el selector de la interfaz: sin geometría, que
// pesa mucho y no se dibuja hasta que el usuario elige un día.
export async function listDailyRoutes(deviceId, { limit = 60, desde = null, hasta = null } = {}) {
  const params = [deviceId];
  const where = ['device_id = $1'];
  if (desde) { params.push(desde); where.push(`fecha >= $${params.length}`); }
  if (hasta) { params.push(hasta); where.push(`fecha <= $${params.length}`); }
  params.push(limit);
  const { rows } = await query(
    `SELECT ${DAILY_ROUTE_COLUMNS}
     FROM daily_routes WHERE ${where.join(' AND ')}
     ORDER BY fecha DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({ ...shapeDailyRoute(r), segments: undefined }));
}

/** Equipos con posiciones en un rango: a quiénes hay que consolidarles el día. */
export async function listDevicesWithPositionsBetween(desde, hasta) {
  const { rows } = await query(
    `SELECT DISTINCT d.id, d.imei, d.alias
     FROM devices d
     JOIN positions p ON p.device_id = d.id
     WHERE COALESCE(p.device_time, p.server_time) >= $1
       AND COALESCE(p.device_time, p.server_time) <= $2`,
    [desde, hasta],
  );
  return rows;
}

/** ¿Ya quedó cerrado ese día para ese equipo? Evita recalcular en cada barrido. */
export async function dailyRouteIsClosed(deviceId, fecha) {
  const { rows } = await query(
    'SELECT cerrada FROM daily_routes WHERE device_id = $1 AND fecha = $2',
    [deviceId, fecha],
  );
  return rows[0]?.cerrada === true;
}

/**
 * Cambia el nombre visible y la placa de un equipo. Es lo único editable de su
 * identidad: el IMEI lo fija el hardware y renombrarlo rompería el historial.
 */
export async function updateDeviceIdentity(deviceId, { alias, placa }) {
  const { rows } = await query(
    `UPDATE devices SET alias = $2, placa = $3 WHERE id = $1 RETURNING *`,
    [deviceId, alias, placa],
  );
  clearDeviceCache();
  return rows[0] ?? null;
}
