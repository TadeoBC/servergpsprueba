import test from 'node:test';
import assert from 'node:assert/strict';
import { crc16X25, crcItu, xorChecksum } from '../src/protocols/crc.js';

/**
 * Implementación bit a bit, escrita aparte de la de tabla, para verificar que
 * la versión rápida no tenga un error en la tabla. Si ambas coinciden sobre
 * datos aleatorios, la tabla está bien construida.
 */
function crcX25Bitwise(buf) {
  let crc = 0xffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0x8408 : crc >>> 1;
    }
  }
  return (crc ^ 0xffff) & 0xffff;
}

test('CRC-16/X-25: valor de comprobación del catálogo', () => {
  // Vector conocido: el CRC de la cadena ASCII "123456789" para CRC-16/X-25
  // (el "CRC-ITU" del documento GT06) es 0x906E. Este es el ancla que confirma
  // polinomio, valor inicial, reflejo y xorout de una sola vez.
  assert.equal(crc16X25(Buffer.from('123456789', 'ascii')), 0x906e);
  assert.equal(crcItu(Buffer.from('123456789', 'ascii')), 0x906e);
});

test('CRC-16/X-25: buffer vacío', () => {
  // init 0xFFFF xor xorout 0xFFFF = 0x0000
  assert.equal(crc16X25(Buffer.alloc(0)), 0x0000);
});

test('CRC-16/X-25: la versión de tabla coincide con la versión bit a bit', () => {
  for (let n = 0; n < 500; n++) {
    const len = 1 + (n % 40);
    const buf = Buffer.alloc(len);
    for (let i = 0; i < len; i++) buf[i] = (n * 31 + i * 17) & 0xff;
    assert.equal(crc16X25(buf), crcX25Bitwise(buf), `difieren en el caso ${n}`);
  }
});

test('CRC-16/X-25: cambiar un bit cambia el resultado', () => {
  const a = Buffer.from('0d0103518406202044730001', 'hex');
  const b = Buffer.from(a);
  b[5] ^= 0x01;
  assert.notEqual(crc16X25(a), crc16X25(b));
});

test('checksum XOR de JT808', () => {
  assert.equal(xorChecksum(Buffer.from([0x01, 0x02, 0x03])), 0x00);
  assert.equal(xorChecksum(Buffer.from([0xff])), 0xff);
  assert.equal(xorChecksum(Buffer.alloc(0)), 0x00);
  assert.equal(xorChecksum(Buffer.from([0x0a, 0x0b, 0x0c, 0x0d])), 0x0a ^ 0x0b ^ 0x0c ^ 0x0d);
});
