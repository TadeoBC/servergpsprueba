import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, waitForDatabase, closePool } from './pool.js';
import { logger } from '../logger.js';

const MIGRATIONS_DIR = path.resolve(fileURLToPath(new URL('../../migrations', import.meta.url)));

// Runner de migraciones en SQL plano.
// - Los archivos se aplican en orden alfabético (por eso el prefijo numérico).
// - Cada archivo corre dentro de una transacción; si falla, no queda a medias.
// - Se registra en schema_migrations para no repetirlo.
export async function runMigrations() {
  await waitForDatabase();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // Candado a nivel de base: si arrancan dos instancias del servicio a la vez,
  // solo una aplica las migraciones y la otra espera.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [0x41544c59]); // 'ATLY'

    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      logger.info({ migracion: file }, 'aplicando migración');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ migracion: file, err: err.message }, 'la migración falló, se revirtió');
        throw err;
      }
    }

    if (count === 0) logger.info('base de datos al día, no había migraciones pendientes');
    else logger.info({ aplicadas: count }, 'migraciones aplicadas');

    return count;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [0x41544c59]).catch(() => {});
    client.release();
  }
}

// Permite ejecutarlo suelto:  npm run migrate
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runMigrations()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err: err.message }, 'error al migrar');
      process.exit(1);
    });
}
