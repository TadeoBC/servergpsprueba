import express from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { pool } from '../db/pool.js';
import {
  listDevicesWithLastPosition,
  getDeviceByImei,
  getLastPosition,
  listPositions,
  listEvents,
  updateDeviceSettings,
  listDeviceCommands,
  createOrRestoreDevice,
  archiveDevice,
} from '../db/repo.js';
import { createApiKey, listApiKeys, revokeApiKey } from './api-keys.js';
import { buildAllowedCommand, COMMAND_CATALOG, CommandValidationError } from '../commands/catalog.js';
import { queueDeviceCommand, isDeviceOnline } from '../commands/dispatcher.js';
import { getPackets, getUnidentifiedPackets } from '../ingest/bus.js';
import { decodeFrame, FrameAccumulator } from '../tcp/framing.js';
import {
  checkCredentials,
  createSessionToken,
  setSessionCookie,
  clearSessionCookie,
  requireAuthApi,
  loginBloqueado,
  registrarFalloLogin,
  limpiarIntentos,
  getSessionFromRequest,
} from './auth.js';

export function buildApiRouter() {
  const router = express.Router();

  // ── salud ──────────────────────────────────────────────────────────────────
  // Sin autenticación a propósito: la usan el healthcheck de Docker y el doctor.
  // No revela datos de los equipos.
  router.get('/health', async (req, res) => {
    const salud = {
      ok: true,
      hora_servidor: new Date().toISOString(),
      zona_horaria_interfaz: config.ui.timezone,
      puerto_tcp: config.tcp.port,
      base_de_datos: 'desconocida',
    };
    try {
      const { rows } = await pool.query('SELECT postgis_version() AS postgis, now() AS ahora');
      salud.base_de_datos = 'ok';
      salud.postgis = rows[0].postgis;
      salud.hora_base = rows[0].ahora;
    } catch (err) {
      salud.ok = false;
      salud.base_de_datos = 'error';
      salud.error = err.message;
      return res.status(503).json(salud);
    }
    res.json(salud);
  });

  // ── sesión ─────────────────────────────────────────────────────────────────
  router.post('/login', (req, res) => {
    const ip = req.ip;
    if (loginBloqueado(ip)) {
      return res.status(429).json({ error: 'demasiados intentos fallidos, espera unos minutos' });
    }
    const { usuario, password } = req.body ?? {};
    if (typeof usuario !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'faltan usuario y contraseña' });
    }
    if (!checkCredentials(usuario, password)) {
      registrarFalloLogin(ip);
      logger.warn({ ip }, 'intento de login fallido');
      return res.status(401).json({ error: 'usuario o contraseña incorrectos' });
    }
    limpiarIntentos(ip);
    setSessionCookie(res, createSessionToken(usuario));
    logger.info({ ip, usuario }, 'login correcto');
    res.json({ ok: true, usuario });
  });

  router.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/session', (req, res) => {
    const s = getSessionFromRequest(req);
    res.json(s ? { autenticado: true, usuario: s.u } : { autenticado: false });
  });

  // ── configuración que necesita el frontend ─────────────────────────────────
  router.get('/config', requireAuthApi, (req, res) => {
    res.json({
      timezone: config.ui.timezone,
      umbrales: { verde_min: config.ui.greenMinutes, ambar_min: config.ui.amberMinutes },
      dominios: { gps: config.deploy.gpsDomain, view: config.deploy.viewDomain },
      puerto_tcp: config.tcp.port,
    });
  });

  // ── equipos ────────────────────────────────────────────────────────────────
  router.get('/devices', requireAuthApi, async (req, res, next) => {
    try {
      res.json({ devices: await listDevicesWithLastPosition() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/devices', requireAuthApi, async (req, res, next) => {
    try {
      const imei = String(req.body?.imei ?? '').trim();
      const alias = optionalText(req.body?.alias, 100);
      const placa = optionalText(req.body?.placa, 30);
      if (!/^\d{15}$/.test(imei)) {
        return res.status(400).json({ error: 'el IMEI debe contener exactamente 15 dígitos' });
      }
      if (alias === undefined || placa === undefined) {
        return res.status(400).json({ error: 'alias (máx. 100) o placa (máx. 30) inválidos' });
      }
      const device = await createOrRestoreDevice({ imei, alias, placa });
      logger.info({ imei, usuario: req.usuario }, 'equipo dado de alta o restaurado desde la interfaz');
      res.status(201).json({ device, message: 'Equipo agregado. Si ya existía archivado, se restauró con su historial.' });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/devices/:imei', requireAuthApi, async (req, res, next) => {
    try {
      const device = await getDeviceByImei(req.params.imei);
      if (!device || device.archived_at) return res.status(404).json({ error: 'equipo no encontrado' });
      const archived = await archiveDevice(device.id);
      logger.info({ imei: device.imei, usuario: req.usuario }, 'equipo archivado desde la interfaz');
      res.json({ device: archived, message: 'Equipo quitado de la flotilla. Su historial se conservó.' });
    } catch (err) {
      next(err);
    }
  });

  router.get('/devices/:imei/last', requireAuthApi, async (req, res, next) => {
    try {
      const device = await getDeviceByImei(req.params.imei);
      if (!device) return res.status(404).json({ error: 'equipo no encontrado' });
      const position = await getLastPosition(device.id);
      res.json({ device, position });
    } catch (err) {
      next(err);
    }
  });

  router.get('/devices/:imei/positions', requireAuthApi, async (req, res, next) => {
    try {
      const device = await getDeviceByImei(req.params.imei);
      if (!device) return res.status(404).json({ error: 'equipo no encontrado' });

      const limit = clampLimit(req.query.limit);
      const desde = parseFecha(req.query.desde);
      const hasta = parseFecha(req.query.hasta);
      if (req.query.desde && !desde) return res.status(400).json({ error: 'parámetro "desde" inválido (usa ISO 8601)' });
      if (req.query.hasta && !hasta) return res.status(400).json({ error: 'parámetro "hasta" inválido (usa ISO 8601)' });

      const positions = await listPositions(device.id, {
        desde,
        hasta,
        limit,
        soloValidas: req.query.solo_validas === '1',
      });
      res.json({ device, positions, limit });
    } catch (err) {
      next(err);
    }
  });

  router.get('/devices/:imei/events', requireAuthApi, async (req, res, next) => {
    try {
      const device = await getDeviceByImei(req.params.imei);
      if (!device) return res.status(404).json({ error: 'equipo no encontrado' });
      const desde = parseFecha(req.query.desde);
      if (req.query.desde && !desde) return res.status(400).json({ error: 'parámetro "desde" inválido (usa ISO 8601)' });
      res.json({ events: await listEvents(device.id, { desde, limit: clampLimit(req.query.limit) }) });
    } catch (err) { next(err); }
  });

  router.patch('/devices/:imei/settings', requireAuthApi, async (req, res, next) => {
    try {
      const device = await getDeviceByImei(req.params.imei);
      if (!device) return res.status(404).json({ error: 'equipo no encontrado' });
      const speed = nullableNumber(req.body?.speed_limit_kmh, 1, 300);
      const interval = nullableInteger(req.body?.report_interval_seconds, 10, 86400);
      if (speed === undefined || interval === undefined) return res.status(400).json({ error: 'límite (1-300 km/h) o intervalo (10-86400 s) inválido' });
      const updated = await updateDeviceSettings(device.id, { speedLimitKmh: speed, reportIntervalSeconds: interval });
      res.json({ device: updated, aviso: 'El intervalo queda registrado. Aplicarlo al hardware requiere confirmar el comando del firmware S11L.' });
    } catch (err) { next(err); }
  });

  router.get('/commands/catalog', requireAuthApi, (req, res) => res.json({ commands: COMMAND_CATALOG }));

  router.get('/devices/:imei/commands', requireAuthApi, async (req, res, next) => {
    try {
      const device = await getDeviceByImei(req.params.imei);
      if (!device) return res.status(404).json({ error: 'equipo no encontrado' });
      res.json({ online: isDeviceOnline(device.imei), commands: await listDeviceCommands(device.id, { limit: clampLimit(req.query.limit) }) });
    } catch (err) { next(err); }
  });

  router.post('/devices/:imei/commands', requireAuthApi, async (req, res, next) => {
    try {
      const device = await getDeviceByImei(req.params.imei);
      if (!device) return res.status(404).json({ error: 'equipo no encontrado' });
      const command = buildAllowedCommand(req.body?.type, req.body?.params ?? {});
      const queued = await queueDeviceCommand({ device, command, requestedBy: req.usuario });
      if (command.settings) {
        await updateDeviceSettings(device.id, {
          speedLimitKmh: device.speed_limit_kmh ?? null,
          reportIntervalSeconds: command.settings.reportIntervalSeconds,
        });
      }
      res.status(202).json({ command: queued,
        message: queued.online ? 'comando enviado; esperando respuesta' : 'equipo offline; comando en cola' });
    } catch (err) {
      if (err instanceof CommandValidationError) return res.status(400).json({ error: err.message });
      next(err);
    }
  });

  router.get('/api-keys', requireAuthApi, async (req, res, next) => {
    try { res.json({ api_keys: await listApiKeys() }); } catch (err) { next(err); }
  });
  router.post('/api-keys', requireAuthApi, async (req, res, next) => {
    try {
      const name = String(req.body?.name ?? '').trim();
      if (!name || name.length > 100) return res.status(400).json({ error: 'nombre requerido (máximo 100 caracteres)' });
      const expiresAt = req.body?.expires_at ? parseFecha(req.body.expires_at) : null;
      if (req.body?.expires_at && !expiresAt) return res.status(400).json({ error: 'expires_at inválido' });
      const apiKey = await createApiKey({ name, expiresAt });
      res.status(201).json({ api_key: apiKey, aviso: 'Guarda key ahora: no volverá a mostrarse.' });
    } catch (err) { next(err); }
  });
  router.delete('/api-keys/:id', requireAuthApi, async (req, res, next) => {
    try { const row = await revokeApiKey(req.params.id); res.status(row ? 200 : 404).json(row ? { ok: true } : { error: 'clave no encontrada o ya revocada' }); } catch (err) { next(err); }
  });

  // ── depuración ─────────────────────────────────────────────────────────────
  // Últimas tramas decodificadas campo por campo. Esto NO es adorno: es lo que
  // permite ver qué byte produjo una coordenada rara.
  router.get('/devices/:imei/debug', requireAuthApi, (req, res) => {
    res.json({ imei: req.params.imei, paquetes: getPackets(req.params.imei) });
  });

  router.get('/debug/sin-identificar', requireAuthApi, (req, res) => {
    res.json({ paquetes: getUnidentifiedPackets() });
  });

  /**
   * Re-decodifica un hex arbitrario. Sirve para pegar un raw_hex del histórico
   * y volver a leerlo con el decoder actual, sin tocar la base.
   */
  router.post('/decode', requireAuthApi, (req, res) => {
    const { hex } = req.body ?? {};
    if (typeof hex !== 'string') return res.status(400).json({ error: 'falta el campo "hex"' });

    const limpio = hex.replace(/[^0-9a-fA-F]/g, '');
    if (limpio.length === 0 || limpio.length % 2 !== 0) {
      return res.status(400).json({ error: 'el hex debe tener un número par de dígitos' });
    }
    if (limpio.length > 4096) return res.status(400).json({ error: 'hex demasiado largo' });

    const buf = Buffer.from(limpio, 'hex');
    const acc = new FrameAccumulator({ maxBufferBytes: 8192 });
    const { frames, reject } = acc.push(buf);
    if (reject) return res.status(400).json({ error: `entrada rechazada: ${reject}` });
    if (frames.length === 0) {
      return res.status(400).json({ error: 'no se encontró ninguna trama completa en ese hex' });
    }
    res.json({ resultados: frames.map((f) => decodeFrame(f)) });
  });

  return router;
}

function clampLimit(v) {
  const n = Number.parseInt(v ?? '100', 10);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(n, 5000);
}

function parseFecha(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function nullableNumber(v, min, max) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}
function nullableInteger(v, min, max) {
  const n = nullableNumber(v, min, max); return n === null || n === undefined ? n : Number.isInteger(n) ? n : undefined;
}

function optionalText(v, maxLength) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return undefined;
  const clean = v.trim();
  if (!clean) return null;
  return clean.length <= maxLength ? clean : undefined;
}
