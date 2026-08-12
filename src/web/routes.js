import express from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { pool } from '../db/pool.js';
import {
  listDevicesWithLastPosition,
  getDeviceByImei,
  getLastPosition,
  listPositions,
} from '../db/repo.js';
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
