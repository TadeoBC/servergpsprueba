import 'dotenv/config';
import crypto from 'node:crypto';

function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`La variable ${name} no es un entero válido: ${v}`);
  return n;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

const databaseUrl =
  str('DATABASE_URL') ||
  `postgres://${encodeURIComponent(str('POSTGRES_USER', 'atlyx'))}:` +
    `${encodeURIComponent(str('POSTGRES_PASSWORD', 'atlyx'))}@` +
    `${str('POSTGRES_HOST', 'db')}:${int('POSTGRES_PORT', 5432)}/` +
    `${str('POSTGRES_DB', 'atlyx_gps')}`;

// El secreto de sesión es obligatorio en producción. Si no viene, generamos uno
// efímero: el servidor arranca (útil en desarrollo) pero las sesiones se caen
// en cada reinicio, y lo advertimos fuerte al arrancar.
const sessionSecret = str('SESSION_SECRET');

export const config = {
  env: str('NODE_ENV', 'development'),

  db: {
    url: databaseUrl,
    poolMax: int('PG_POOL_MAX', 10),
  },

  tcp: {
    host: str('TCP_HOST', '0.0.0.0'),
    port: int('TCP_PORT', 5023),
    socketTimeoutMs: int('TCP_SOCKET_TIMEOUT_MS', 300000),
    maxConnPerIp: int('MAX_CONN_PER_IP', 20),
    connRatePerIp: int('CONN_RATE_PER_IP', 60),
    connRateWindowMs: int('CONN_RATE_WINDOW_MS', 60000),
    maxBufferBytes: int('TCP_MAX_BUFFER_BYTES', 65536),
  },

  http: {
    port: int('HTTP_PORT', 8080),
    publicUrl: str('PUBLIC_URL', 'http://localhost:8080'),
  },

  auth: {
    user: str('AUTH_USER', 'admin'),
    passwordHash: str('AUTH_PASSWORD_HASH', ''),
    passwordPlain: str('AUTH_PASSWORD', ''),
    sessionSecret: sessionSecret || crypto.randomBytes(32).toString('hex'),
    sessionSecretProvided: Boolean(sessionSecret),
    sessionHours: int('SESSION_HOURS', 168),
    cookieSecure: bool('COOKIE_SECURE', true),
  },

  ui: {
    timezone: str('DISPLAY_TIMEZONE', 'America/Mexico_City'),
    greenMinutes: int('STATUS_GREEN_MINUTES', 5),
    amberMinutes: int('STATUS_AMBER_MINUTES', 30),
  },

  tracking: {
    mapMatchEnabled: bool('MAP_MATCH_ENABLED', true),
    mapMatchUrl: str('MAP_MATCH_URL', 'https://router.project-osrm.org'),
    mapMatchTimeoutMs: int('MAP_MATCH_TIMEOUT_MS', 5000),
    mapMatchMaxPoints: int('MAP_MATCH_MAX_POINTS', 400),
  },

  log: {
    level: str('LOG_LEVEL', 'info'),
    pretty: bool('LOG_PRETTY', false),
  },

  storeRawHex: bool('STORE_RAW_HEX', true),

  deploy: {
    vpsIp: str('VPS_PUBLIC_IP', ''),
    gpsDomain: str('GPS_DOMAIN', 'gps.atlyx.online'),
    viewDomain: str('VIEW_DOMAIN', 'view.atlyx.online'),
  },
};
