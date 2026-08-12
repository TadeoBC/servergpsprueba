import crypto from 'node:crypto';
import { query } from '../db/pool.js';

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

export async function createApiKey({ name, scopes = ['read'], expiresAt = null }) {
  const secret = `atlyx_${crypto.randomBytes(32).toString('base64url')}`;
  const { rows } = await query(
    `INSERT INTO api_keys (name, key_prefix, key_hash, scopes, expires_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id,name,key_prefix,scopes,expires_at,created_at`,
    [name, secret.slice(0, 14), hashKey(secret), scopes, expiresAt],
  );
  return { ...rows[0], key: secret };
}

export async function listApiKeys() {
  const { rows } = await query(
    `SELECT id,name,key_prefix,scopes,last_used_at,expires_at,revoked_at,created_at
     FROM api_keys ORDER BY created_at DESC`,
  );
  return rows;
}

export async function revokeApiKey(id) {
  const { rows } = await query(
    'UPDATE api_keys SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id', [id]);
  return rows[0] ?? null;
}

export async function authenticateApiKey(req) {
  const auth = req.headers.authorization ?? '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  const key = bearer ?? req.headers['x-api-key'];
  if (typeof key !== 'string' || !key.startsWith('atlyx_')) return null;
  const { rows } = await query(
    `UPDATE api_keys SET last_used_at=now()
     WHERE key_hash=$1 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
     RETURNING id,name,scopes`, [hashKey(key)]);
  return rows[0] ?? null;
}

export async function requireApiKey(req, res, next) {
  try {
    const apiKey = await authenticateApiKey(req);
    if (!apiKey) return res.status(401).json({ error: 'API key inválida, vencida o revocada' });
    req.apiKey = apiKey;
    next();
  } catch (err) {
    next(err);
  }
}

