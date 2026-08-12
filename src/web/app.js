import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import pinoHttp from 'pino-http';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { buildApiRouter } from './routes.js';
import { buildPublicApiRouter } from './public-api.js';
import { requireAuthPage, getSessionFromRequest } from './auth.js';

const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('../public', import.meta.url)));

export function buildApp() {
  const app = express();

  // Caddy va delante: confiamos en su X-Forwarded-For para que req.ip sea la IP
  // real del visitante (importante para el límite de intentos de login).
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      // /api/health lo llama el healthcheck de Docker cada pocos segundos:
      // sin esto el log se llena de ruido.
      autoLogging: { ignore: (req) => req.url === '/api/health' },
      customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );

  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.use('/api', buildApiRouter());
  app.use('/api/v1', buildPublicApiRouter());

  // ── páginas ────────────────────────────────────────────────────────────────
  // La hoja de estilos se sirve SIN sesión: la necesita la propia pantalla de
  // login. Es CSS, no expone ningún dato. Todo lo demás (incluido app.js, que
  // sí conoce la forma de la API) queda detrás de la sesión.
  app.get('/styles.css', (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'styles.css'));
  });

  app.get('/login', (req, res) => {
    if (getSessionFromRequest(req)) return res.redirect('/');
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  app.get('/', requireAuthPage, (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // Los archivos estáticos (js, css) también van detrás de la sesión: la
  // interfaz no queda abierta a internet.
  app.use(requireAuthPage, express.static(PUBLIC_DIR, { index: false }));

  app.use((req, res) => res.status(404).json({ error: 'no encontrado' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error({ err: err.message, stack: err.stack }, 'error no controlado en la API');
    res.status(500).json({ error: 'error interno' });
  });

  return app;
}

export function startHttpServer() {
  const app = buildApp();
  return new Promise((resolve) => {
    const server = app.listen(config.http.port, '0.0.0.0', () => {
      logger.info({ puerto: config.http.port }, 'servidor web escuchando (Caddy hace el proxy hacia aquí)');
      resolve(server);
    });
  });
}
