import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Los timestamps los queremos como Date en UTC. node-postgres ya devuelve Date
// para TIMESTAMPTZ, pero forzamos el parseo de int8 (BIGSERIAL) a Number para
// que los ids viajen bien en JSON. Un BIGINT real superaría Number.MAX_SAFE_INTEGER,
// pero eso son ~9e15 posiciones: no vamos a llegar.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  application_name: 'atlyx-gps',
});

pool.on('error', (err) => {
  logger.error({ err }, 'error en cliente inactivo del pool de postgres');
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'falló el ROLLBACK');
    }
    throw err;
  } finally {
    client.release();
  }
}

// Espera a que postgres acepte conexiones. El contenedor de postgis tarda unos
// segundos en el primer arranque (inicializa el cluster y crea la extensión).
export async function waitForDatabase({ attempts = 30, delayMs = 2000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      logger.warn({ intento: i, de: attempts, err: err.message }, 'postgres todavía no responde, reintentando');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export async function closePool() {
  await pool.end();
}
