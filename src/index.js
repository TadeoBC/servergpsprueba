import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './db/migrate.js';
import { closePool } from './db/pool.js';
import { startTcpServer } from './tcp/server.js';
import { startHttpServer } from './web/app.js';
import { attachWebSocket } from './web/ws.js';
import { auditarConfiguracion } from './web/auth.js';

async function main() {
  logger.info(
    {
      entorno: config.env,
      puerto_tcp: config.tcp.port,
      puerto_http: config.http.port,
      zona_interfaz: config.ui.timezone,
    },
    'arrancando atlyx-gps',
  );

  auditarConfiguracion();

  // Las migraciones corren en el arranque: un despliegue nuevo queda listo sin
  // pasos manuales. El candado en base evita choques si hay varias réplicas.
  await runMigrations();

  const httpServer = await startHttpServer();
  attachWebSocket(httpServer);
  const tcpServer = await startTcpServer();

  logger.info('todo arriba: ingesta TCP + API + WebSocket');

  const apagar = async (senal) => {
    logger.info({ senal }, 'apagando de forma ordenada');
    const cierres = [
      new Promise((r) => tcpServer.close(r)),
      new Promise((r) => httpServer.close(r)),
    ];
    // Si algo se queda colgado, salimos igual a los 10 s.
    const limite = setTimeout(() => {
      logger.warn('el apagado tardó demasiado, se fuerza la salida');
      process.exit(1);
    }, 10000);
    limite.unref();

    await Promise.allSettled(cierres);
    await closePool().catch(() => {});
    logger.info('adiós');
    process.exit(0);
  };

  process.on('SIGTERM', () => apagar('SIGTERM'));
  process.on('SIGINT', () => apagar('SIGINT'));

  process.on('unhandledRejection', (err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'promesa rechazada sin manejar');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'excepción no capturada');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'no se pudo arrancar');
  process.exit(1);
});
