#!/usr/bin/env node
/**
 * Administra las claves de integración (`atlyx_…`) desde la línea de comandos.
 *
 * El panel ya permite crearlas, pero pide sesión web y un navegador. Para
 * enchufar el POS a un atlyx recién levantado — y para automatizar el arranque
 * de un entorno de pruebas — hace falta poder emitir la clave sin eso.
 *
 *   npm run api-key -- crear "POS Glimmer"
 *   npm run api-key -- crear "Integración temporal" --vence=2026-12-31
 *   npm run api-key -- listar
 *   npm run api-key -- revocar 7f1c…
 *
 * El secreto completo se imprime UNA sola vez: la base guarda sólo su SHA-256.
 *
 * Se conecta a la misma base que el servidor, así que hay que ejecutarlo donde
 * `POSTGRES_HOST` resuelva. Con la composición de Docker eso es dentro del
 * contenedor:
 *
 *   docker compose exec app npm run api-key -- crear "POS Glimmer"
 *
 * Desde la Mac, con la sobrecapa de desarrollo publicando postgres en el 5433:
 *
 *   POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=5433 npm run api-key -- listar
 */
import { createApiKey, listApiKeys, revokeApiKey } from '../src/web/api-keys.js';
import { closePool } from '../src/db/pool.js';

const USO = `Uso:
  npm run api-key -- crear <nombre> [--vence=YYYY-MM-DD]
  npm run api-key -- listar
  npm run api-key -- revocar <id>`;

async function crear(args) {
  const vence = args.find((a) => a.startsWith('--vence='))?.slice('--vence='.length) ?? null;
  const nombre = args.filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!nombre) throw new Error(`Falta el nombre de la clave.\n${USO}`);
  let expiresAt = null;
  if (vence) {
    const d = new Date(vence);
    if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida en --vence: ${vence}`);
    expiresAt = d.toISOString();
  }
  const { key, ...fila } = await createApiKey({ name: nombre, expiresAt });
  console.log(`\nClave creada: ${fila.name} (id ${fila.id})`);
  console.log(`Vence: ${fila.expires_at ?? 'nunca'}\n`);
  console.log('Guárdala ahora, no se vuelve a mostrar:\n');
  console.log(`  ${key}\n`);
  console.log('Pégala en el POS: Administración → GPS → API Key de atlyx.\n');
}

async function listar() {
  const claves = await listApiKeys();
  if (!claves.length) return console.log('No hay claves emitidas.');
  for (const c of claves) {
    const estado = c.revoked_at ? 'REVOCADA' : c.expires_at && new Date(c.expires_at) < new Date() ? 'VENCIDA' : 'activa';
    console.log(
      `${c.id}  ${estado.padEnd(9)}  ${c.key_prefix}…  ${c.name}  ` +
        `(último uso: ${c.last_used_at ?? 'nunca'})`,
    );
  }
}

async function revocar(args) {
  const id = args[0];
  if (!id) throw new Error(`Falta el id de la clave.\n${USO}`);
  const fila = await revokeApiKey(id);
  console.log(fila ? `Clave ${id} revocada.` : `No se encontró una clave activa con id ${id}.`);
}

const [comando, ...args] = process.argv.slice(2);

try {
  if (comando === 'crear') await crear(args);
  else if (comando === 'listar') await listar();
  else if (comando === 'revocar') await revocar(args);
  else {
    console.error(USO);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\n${err.message}\n`);
  process.exitCode = 1;
} finally {
  await closePool();
}
