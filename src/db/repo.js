import { query } from './pool.js';
import { logger } from '../logger.js';

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

/** Lista de equipos con su última posición conocida (con o sin fix). */
export async function listDevicesWithLastPosition() {
  const { rows } = await query(`
    SELECT d.id, d.imei, d.alias, d.placa, d.activo, d.archived_at, d.last_seen_at, d.created_at,
           d.speed_limit_kmh, d.report_interval_seconds, d.telemetry, d.telemetry_updated_at,
           p.id           AS position_id,
           ST_Y(p.geom::geometry) AS latitude,
           ST_X(p.geom::geometry) AS longitude,
           p.speed_kmh, p.course, p.altitude, p.satellites, p.valid,
           p.device_time, p.server_time, p.protocol, p.attributes, p.raw_hex
    FROM devices d
    LEFT JOIN LATERAL (
      SELECT * FROM positions
      WHERE device_id = d.id AND geom IS NOT NULL AND valid = true
      ORDER BY server_time DESC, id DESC
      LIMIT 1
    ) p ON true
    WHERE d.archived_at IS NULL
    ORDER BY d.alias NULLS LAST, d.imei
  `);
  return rows.map(shapeDeviceRow);
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
  return rows[0] ?? null;
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
  return rows.reverse();
}

function shapeDeviceRow(r) {
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
    last_position: r.position_id
      ? {
          id: r.position_id,
          latitude: r.latitude,
          longitude: r.longitude,
          speed_kmh: r.speed_kmh,
          course: r.course,
          altitude: r.altitude,
          satellites: r.satellites,
          valid: r.valid,
          device_time: r.device_time,
          server_time: r.server_time,
          protocol: r.protocol,
          attributes: r.attributes,
          raw_hex: r.raw_hex,
        }
      : null,
  };
}
