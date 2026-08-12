import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';

const COOKIE_NAME = 'atlyx_sess';
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };

// ── hash de contraseña ───────────────────────────────────────────────────────

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, saltB64, hashB64] = stored.split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const esperado = Buffer.from(hashB64, 'base64');
    const calculado = crypto.scryptSync(password, salt, esperado.length, SCRYPT_PARAMS);
    return crypto.timingSafeEqual(esperado, calculado);
  } catch {
    return false;
  }
}

/** Compara en tiempo constante para no filtrar información por el tiempo. */
function safeEqualStrings(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Igual hacemos una comparación para no delatar la longitud por el tiempo.
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export function checkCredentials(usuario, password) {
  if (!safeEqualStrings(usuario, config.auth.user)) return false;
  if (config.auth.passwordHash) return verifyPassword(password, config.auth.passwordHash);
  if (config.auth.passwordPlain) return safeEqualStrings(password, config.auth.passwordPlain);
  return false;
}

// ── sesión firmada en cookie ─────────────────────────────────────────────────

function sign(data) {
  return crypto.createHmac('sha256', config.auth.sessionSecret).update(data).digest('base64url');
}

export function createSessionToken(usuario) {
  const payload = Buffer.from(
    JSON.stringify({ u: usuario, exp: Date.now() + config.auth.sessionHours * 3600 * 1000 }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const punto = token.lastIndexOf('.');
  if (punto <= 0) return null;
  const payload = token.slice(0, punto);
  const firma = token.slice(punto + 1);

  const esperada = sign(payload);
  const a = Buffer.from(firma);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// ── cookies ──────────────────────────────────────────────────────────────────

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const parte of header.split(';')) {
    const i = parte.indexOf('=');
    if (i === -1) continue;
    const k = parte.slice(0, i).trim();
    const v = parte.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function setSessionCookie(res, token) {
  const partes = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.auth.sessionHours * 3600}`,
  ];
  if (config.auth.cookieSecure) partes.push('Secure');
  res.setHeader('Set-Cookie', partes.join('; '));
}

export function clearSessionCookie(res) {
  const partes = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.auth.cookieSecure) partes.push('Secure');
  res.setHeader('Set-Cookie', partes.join('; '));
}

export function getSessionFromRequest(req) {
  const cookies = parseCookies(req.headers.cookie);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

// ── middlewares ──────────────────────────────────────────────────────────────

/** Protege las rutas de la API: 401 en JSON. */
export function requireAuthApi(req, res, next) {
  const sesion = getSessionFromRequest(req);
  if (!sesion) return res.status(401).json({ error: 'no autenticado' });
  req.usuario = sesion.u;
  next();
}

/** Protege las páginas: redirige al login. */
export function requireAuthPage(req, res, next) {
  const sesion = getSessionFromRequest(req);
  if (!sesion) return res.redirect('/login');
  req.usuario = sesion.u;
  next();
}

// ── límite de intentos de login ──────────────────────────────────────────────

const intentos = new Map(); // ip -> { n, hasta }
const MAX_INTENTOS = 8;
const BLOQUEO_MS = 10 * 60 * 1000;

export function loginBloqueado(ip) {
  const e = intentos.get(ip);
  if (!e) return false;
  if (e.hasta && e.hasta > Date.now()) return true;
  if (e.hasta && e.hasta <= Date.now()) intentos.delete(ip);
  return false;
}

export function registrarFalloLogin(ip) {
  const e = intentos.get(ip) ?? { n: 0, hasta: 0 };
  e.n++;
  if (e.n >= MAX_INTENTOS) {
    e.hasta = Date.now() + BLOQUEO_MS;
    e.n = 0;
    logger.warn({ ip, minutos: BLOQUEO_MS / 60000 }, 'demasiados intentos de login fallidos: IP bloqueada temporalmente');
  }
  intentos.set(ip, e);
}

export function limpiarIntentos(ip) {
  intentos.delete(ip);
}

/** Aviso al arrancar si la configuración de seguridad quedó floja. */
export function auditarConfiguracion() {
  if (!config.auth.passwordHash && config.auth.passwordPlain) {
    logger.warn(
      'AUTH_PASSWORD_HASH está vacío: se usa AUTH_PASSWORD en texto plano. ' +
        'Genera el hash con `npm run hash-password -- "tu-password"` antes de exponer esto a internet.',
    );
  }
  if (!config.auth.passwordHash && !config.auth.passwordPlain) {
    logger.error('No hay contraseña configurada: NADIE podrá entrar. Define AUTH_PASSWORD_HASH o AUTH_PASSWORD.');
  }
  if (!config.auth.sessionSecretProvided) {
    logger.warn(
      'SESSION_SECRET no está definido: se generó uno al vuelo. Las sesiones se caerán en cada reinicio. ' +
        'Define uno fijo en .env para producción.',
    );
  }
  if (config.auth.passwordPlain === 'cambiame') {
    logger.warn('La contraseña sigue siendo la de ejemplo ("cambiame"). Cámbiala antes de publicar la interfaz.');
  }
}
