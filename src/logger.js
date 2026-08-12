import pino from 'pino';
import { config } from './config.js';

// Logs estructurados a stdout. La rotación NO se hace en la aplicación:
// la hace el driver json-file de Docker (max-size / max-file en compose).
// Eso evita que dos procesos escriban y roten el mismo archivo.
const options = {
  level: config.log.level,
  base: { service: 'atlyx-gps' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    // Nunca queremos estos campos en el log, ni por accidente.
    paths: ['req.headers.cookie', 'req.headers.authorization', 'password', '*.password'],
    censor: '[oculto]',
  },
};

// LOG_PRETTY=true da salida legible en desarrollo, pero pino-pretty solo está
// en devDependencies: la imagen de producción se construye con --omit=dev y no
// lo trae. Si falta, se cae a JSON en vez de reventar el arranque.
function crearLogger() {
  if (!config.log.pretty) return pino(options);
  try {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:standard', ignore: 'pid,hostname,service' },
      },
    });
  } catch {
    const l = pino(options);
    l.warn('LOG_PRETTY=true pero pino-pretty no está instalado; se registra en JSON');
    return l;
  }
}

export const logger = crearLogger();

export function child(bindings) {
  return logger.child(bindings);
}
