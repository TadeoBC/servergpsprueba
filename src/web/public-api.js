import express from 'express';
import { config } from '../config.js';
import { requireApiKey } from './api-keys.js';
import { getDeviceByImei, getLastPosition, listPositions, listEvents, listDeviceCommands } from '../db/repo.js';
import { buildMatchedTrace } from '../tracking/map-match.js';

export function buildPublicApiRouter() {
  const router = express.Router();
  router.use(requireApiKey);

  router.get('/devices/:imei/last', async (req, res, next) => {
    try {
      const device = await getDeviceByImei(req.params.imei);
      if (!device) return res.status(404).json({ error: 'equipo no encontrado' });
      res.json({ device: publicDevice(device), position: await getLastPosition(device.id) });
    } catch (err) { next(err); }
  });

  router.get('/devices/:imei/positions', async (req, res, next) => {
    try {
      const device = await getDeviceByImei(req.params.imei);
      if (!device) return res.status(404).json({ error: 'equipo no encontrado' });
      const range = parseRange(req, res); if (!range) return;
      const positions = await listPositions(device.id, range);
      res.json({ device: publicDevice(device), positions });
    } catch (err) { next(err); }
  });

  router.get('/devices/:imei/route.geojson', async (req, res, next) => {
    try {
      const device = await getDeviceByImei(req.params.imei);
      if (!device) return res.status(404).json({ error: 'equipo no encontrado' });
      const range = parseRange(req, res); if (!range) return;
      const positions = await listPositions(device.id, { ...range, soloValidas: true });
      let trace = null;
      if (req.query.ajustar_calles === '1') trace = await buildMatchedTrace(positions, {
        enabled: config.tracking.mapMatchEnabled,
        baseUrl: config.tracking.mapMatchUrl,
        timeoutMs: config.tracking.mapMatchTimeoutMs,
        maxPoints: config.tracking.mapMatchMaxPoints,
      });
      const segments = trace?.segments?.length
        ? trace.segments.map((segment) => segment.map(([lat, lon]) => [lon, lat]))
        : [positions.map((p) => [p.longitude, p.latitude])];
      const usableSegments = segments.filter((segment) => segment.length >= 2);
      if (!usableSegments.length && positions.length >= 2) {
        usableSegments.push(positions.map((p) => [p.longitude, p.latitude]));
      }
      const feature = positions.length === 0 ? [] : [{
        type: 'Feature', properties: {
          imei: device.imei, alias: device.alias, points: positions.length,
          matched_to_roads: trace?.matched ?? false, partial_match: trace?.partial ?? false,
        },
        geometry: positions.length === 1
          ? { type: 'Point', coordinates: [positions[0].longitude, positions[0].latitude] }
          : usableSegments.length === 1
            ? { type: 'LineString', coordinates: usableSegments[0] }
            : { type: 'MultiLineString', coordinates: usableSegments },
      }];
      res.json({ type: 'FeatureCollection', features: feature });
    } catch (err) { next(err); }
  });

  router.get('/devices/:imei/events', async (req, res, next) => {
    try {
      const device = await getDeviceByImei(req.params.imei);
      if (!device) return res.status(404).json({ error: 'equipo no encontrado' });
      const desde = req.query.desde ? validDate(req.query.desde) : null;
      if (req.query.desde && !desde) return res.status(400).json({ error: 'desde inválido' });
      res.json({ events: await listEvents(device.id, { desde, limit: limit(req.query.limit, 1000) }) });
    } catch (err) { next(err); }
  });

  router.get('/devices/:imei/commands', async (req, res, next) => {
    try {
      const device = await getDeviceByImei(req.params.imei);
      if (!device) return res.status(404).json({ error: 'equipo no encontrado' });
      const commands = await listDeviceCommands(device.id, { limit: limit(req.query.limit, 100) });
      res.json({ commands: commands.map(({ command_text, requested_by, ...safe }) => safe) });
    } catch (err) { next(err); }
  });
  return router;
}

function publicDevice(d) {
  return { imei: d.imei, alias: d.alias, placa: d.placa, activo: d.activo,
    last_seen_at: d.last_seen_at, telemetry: d.telemetry, telemetry_updated_at: d.telemetry_updated_at };
}
function limit(v, max = 5000) { const n = Number.parseInt(v ?? '1000', 10); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 1000; }
function validDate(v) { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
function parseRange(req, res) {
  const desde = req.query.desde ? validDate(req.query.desde) : null;
  const hasta = req.query.hasta ? validDate(req.query.hasta) : null;
  if ((req.query.desde && !desde) || (req.query.hasta && !hasta)) { res.status(400).json({ error: 'fecha inválida; usa ISO 8601' }); return null; }
  return { desde, hasta, limit: limit(req.query.limit), soloValidas: req.query.solo_validas === '1' };
}
