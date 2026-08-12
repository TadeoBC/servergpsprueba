/**
 * CRC-16/X-25 — el documento GT06 lo llama "CRC-ITU".
 *
 *   polinomio  0x1021 (reflejado: 0x8408)
 *   init       0xFFFF
 *   refin      true
 *   refout     true
 *   xorout     0xFFFF
 *
 * Valor de comprobación del catálogo: CRC de la cadena ASCII "123456789"
 * es 0x906E. test/crc.test.js lo verifica, y además compara esta versión
 * con una implementación bit a bit independiente.
 */

const TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let bit = 0; bit < 8; bit++) {
    c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
  }
  TABLE[i] = c;
}

export function crc16X25(buf) {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffff) & 0xffff;
}

/** Alias con el nombre que usa la documentación GT06. */
export const crcItu = crc16X25;

/** Checksum de JT808: XOR de todos los bytes (cabecera + cuerpo). */
export function xorChecksum(buf) {
  let x = 0;
  for (let i = 0; i < buf.length; i++) x ^= buf[i];
  return x & 0xff;
}
