#!/usr/bin/env node
/**
 * Genera el hash scrypt de una contraseña para AUTH_PASSWORD_HASH.
 *
 *   npm run hash-password -- 'mi contraseña'
 *
 * Pega el resultado en .env:
 *   AUTH_PASSWORD_HASH=scrypt$....$....
 * y borra AUTH_PASSWORD (la de texto plano).
 */
import { hashPassword } from '../src/web/auth.js';

const password = process.argv.slice(2).join(' ');

if (!password) {
  console.error('Uso: npm run hash-password -- \'tu-password\'');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Advertencia: la contraseña tiene menos de 8 caracteres. Usa una más larga.');
}

console.log('\nAgrega esta línea a tu .env (y quita AUTH_PASSWORD):\n');
console.log(`AUTH_PASSWORD_HASH=${hashPassword(password)}\n`);
