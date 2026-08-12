import { WebSocketServer } from 'ws';
import { logger } from '../logger.js';
import { bus } from '../ingest/bus.js';
import { getSessionFromRequest } from './auth.js';

/**
 * WebSocket en /ws. Reparte cada posición nueva a las interfaces conectadas.
 *
 * La autenticación se valida en el handshake HTTP (misma cookie httpOnly que la
 * API): un WebSocket sin sesión válida se rechaza con 401 antes de establecerse.
 */
export function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const sesion = getSessionFromRequest(req);
    if (!sesion) {
      logger.warn({ ip: req.socket.remoteAddress }, 'intento de WebSocket sin sesión válida');
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.usuario = sesion.u;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    logger.info({ usuario: ws.usuario, clientes: wss.clients.size }, 'cliente WebSocket conectado');

    ws.send(JSON.stringify({ tipo: 'hola', hora_servidor: new Date().toISOString() }));

    ws.on('close', () => {
      logger.info({ clientes: wss.clients.size - 1 }, 'cliente WebSocket desconectado');
    });
    ws.on('error', (err) => logger.debug({ err: err.message }, 'error de WebSocket'));
  });

  // Ping periódico: sin esto, una conexión móvil caída se queda colgada.
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  ping.unref();

  const difundir = (mensaje) => {
    const payload = JSON.stringify(mensaje);
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  };

  bus.on('position', ({ device, position }) => {
    difundir({
      tipo: 'posicion',
      imei: device.imei,
      device: { id: device.id, imei: device.imei, alias: device.alias, placa: device.placa, activo: device.activo },
      position,
    });
  });

  // El panel de depuración también recibe las tramas que NO son posición
  // (login, heartbeat, alarmas, tramas raras), para poder verlas en vivo.
  bus.on('packet', ({ imei, decoded }) => {
    difundir({
      tipo: 'paquete',
      imei,
      paquete: {
        recibido_en: new Date().toISOString(),
        protocolo: decoded.protocol,
        tipo: decoded.type,
        raw_hex: decoded.rawHex,
        crc_ok: decoded.crcOk ?? decoded.checksumOk ?? null,
        errores: decoded.errors ?? [],
        campos: decoded.fields ?? [],
        attributes: decoded.attributes ?? {},
      },
    });
  });

  server.on('close', () => {
    clearInterval(ping);
    wss.close();
  });

  return wss;
}
