import net from 'node:net';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { FrameAccumulator, decodeFrame } from './framing.js';
import { ConnectionLimiter } from './ratelimit.js';
import { processDecoded } from '../ingest/pipeline.js';
import { registerDeviceConnection, unregisterDeviceConnection } from '../commands/dispatcher.js';

let conexionSeq = 0;

export function createTcpServer() {
  const limiter = new ConnectionLimiter({
    maxConcurrent: config.tcp.maxConnPerIp,
    maxPerWindow: config.tcp.connRatePerIp,
    windowMs: config.tcp.connRateWindowMs,
  });

  const sweeper = setInterval(() => limiter.sweep(), 60000);
  sweeper.unref();

  const server = net.createServer({ noDelay: true }, (socket) => {
    const ip = socket.remoteAddress ?? 'desconocida';
    const id = ++conexionSeq;

    const permiso = limiter.tryAcquire(ip);
    if (!permiso.allowed) {
      logger.warn({ ip, conn: id, motivo: permiso.reason }, 'conexión rechazada por rate limit');
      socket.destroy();
      return;
    }

    const log = logger.child({ conn: id, ip });
    const acc = new FrameAccumulator({ maxBufferBytes: config.tcp.maxBufferBytes });
    const session = { ip, device: null, imei: null, conn: id };

    let liberado = false;
    const liberar = () => {
      if (liberado) return;
      liberado = true;
      limiter.release(ip);
    };

    // Cola secuencial: las tramas de un mismo socket se procesan en orden, aunque
    // el pipeline sea asíncrono. Sin esto, dos posiciones seguidas podrían
    // escribirse invertidas.
    let cola = Promise.resolve();

    socket.setTimeout(config.tcp.socketTimeoutMs);
    log.info({ puerto: config.tcp.port }, 'conexión entrante');

    socket.on('data', (chunk) => {
      let resultado;
      try {
        resultado = acc.push(chunk);
      } catch (err) {
        log.error({ err: err.message }, 'error al acumular bytes; se cierra la conexión');
        socket.destroy();
        return;
      }

      if (resultado.reject) {
        // Escáner HTTP o basura. Se registra el MOTIVO, nunca el contenido:
        // un navegador puede mandar cookies de sesión en los encabezados.
        log.warn({ motivo: resultado.reject }, 'conexión descartada sin registrar su contenido');
        socket.destroy();
        return;
      }

      for (const aviso of resultado.notices) log.debug({ aviso }, 'ajuste del búfer de recepción');

      for (const frame of resultado.frames) {
        if (!session.protocoloLogueado) {
          session.protocoloLogueado = true;
          log.info({ protocolo: frame.protocol }, 'protocolo detectado en la primera trama de la conexión');
        }
        cola = cola.then(() => manejarTrama(frame, { socket, session, log })).catch((err) => {
          log.error({ err: err.message }, 'error al procesar la trama');
        });
      }
    });

    socket.on('timeout', () => {
      log.info({ minutos: Math.round(config.tcp.socketTimeoutMs / 60000) }, 'socket inactivo; se cierra por timeout');
      socket.destroy();
    });

    socket.on('error', (err) => {
      // ECONNRESET es rutina: la red móvil corta conexiones sin avisar.
      const nivel = err.code === 'ECONNRESET' ? 'debug' : 'warn';
      log[nivel]({ err: err.message, code: err.code }, 'error de socket');
    });

    socket.on('close', () => {
      if (session.imei) unregisterDeviceConnection(session.imei, socket);
      liberar();
      log.info({ imei: session.imei ?? null }, 'conexión cerrada');
    });
  });

  server.on('error', (err) => {
    logger.error({ err: err.message, code: err.code }, 'error del servidor TCP');
    if (err.code === 'EADDRINUSE') {
      logger.error({ puerto: config.tcp.port }, 'el puerto de ingesta ya está ocupado');
      process.exit(1);
    }
  });

  server.on('close', () => clearInterval(sweeper));

  return server;
}

async function manejarTrama(frame, { socket, session, log }) {
  const decoded = decodeFrame(frame);

  if (decoded.crcOk === false || decoded.checksumOk === false) {
    // Se avisa pero NO se cierra la conexión ni se descarta la trama: un CRC
    // malo suele ser un byte corrupto en un campo, no una trama inútil.
    log.warn(
      { protocolo: decoded.protocol, tipo: decoded.type, errores: decoded.errors },
      'checksum inválido; la trama se procesa igual y queda marcada',
    );
  }

  const processed = await processDecoded(decoded, session);

  if (decoded.reply && !socket.destroyed) {
    await new Promise((resolve) => socket.write(decoded.reply, (err) => {
      if (err) log.warn({ err: err.message }, 'no se pudo enviar la respuesta al equipo');
      resolve();
    }));
    log.debug(
      { tipo: decoded.type, respuesta: decoded.reply.toString('hex').toUpperCase() },
      'respuesta enviada al equipo',
    );
  }

  // El ACK de login siempre sale antes que cualquier comando pendiente.
  if (decoded.type === 'login' && processed.device && !socket.destroyed) {
    await registerDeviceConnection(processed.device, socket);
  }
}

export function startTcpServer() {
  const server = createTcpServer();
  return new Promise((resolve) => {
    server.listen(config.tcp.port, config.tcp.host, () => {
      logger.info(
        { host: config.tcp.host, puerto: config.tcp.port },
        'ingesta TCP escuchando (GT06 / JT808 / GPS103)',
      );
      resolve(server);
    });
  });
}
