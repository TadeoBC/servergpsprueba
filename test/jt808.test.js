import test from 'node:test';
import assert from 'node:assert/strict';
import { xorChecksum } from '../src/protocols/crc.js';
import * as jt808 from '../src/protocols/jt808.js';

const TERMINAL = '840620204473'; // últimos 12 dígitos del IMEI 351840620204473
const SJR = { lat: 20.3897, lon: -99.9961 };

/** Cuerpo de 0x0200 armado según la especificación. */
function locationBody({ lat, lon, altitud = 1900, velocidadKmh = 40, rumbo = 90, fecha = [25, 8, 12, 17, 30, 0], alarma = 0, estadoExtra = 0, extras = Buffer.alloc(0) }) {
  const b = Buffer.alloc(28);
  b.writeUInt32BE(alarma >>> 0, 0);

  let estado = 0x02 | estadoExtra; // bit 1 = posicionado
  if (lat < 0) estado |= 0x04; // bit 2 = latitud sur
  if (lon < 0) estado |= 0x08; // bit 3 = longitud oeste
  b.writeUInt32BE(estado >>> 0, 4);

  b.writeUInt32BE(Math.round(Math.abs(lat) * 1e6), 8);
  b.writeUInt32BE(Math.round(Math.abs(lon) * 1e6), 12);
  b.writeUInt16BE(altitud, 16);
  b.writeUInt16BE(Math.round(velocidadKmh * 10), 18); // décimas de km/h
  b.writeUInt16BE(rumbo, 20);
  Buffer.from(fecha.map((n) => Number.parseInt(String(n).padStart(2, '0'), 16))).copy(b, 22); // BCD
  return Buffer.concat([b, extras]);
}

function bcdFecha(partes) {
  return Buffer.from(partes.map((n) => Number.parseInt(String(n).padStart(2, '0'), 16)));
}

// ── escape ───────────────────────────────────────────────────────────────────

test('des-escapar: 0x7D01 -> 0x7D y 0x7D02 -> 0x7E', () => {
  const { data } = jt808.unescape(Buffer.from([0x01, 0x7d, 0x02, 0x03, 0x7d, 0x01, 0x04]));
  assert.deepEqual([...data], [0x01, 0x7e, 0x03, 0x7d, 0x04]);
});

test('escapar y des-escapar son inversas', () => {
  const original = Buffer.from([0x00, 0x7e, 0x7d, 0x7e, 0x7d, 0xff, 0x7d, 0x02]);
  const { data } = jt808.unescape(jt808.escape(original));
  assert.deepEqual([...data], [...original]);
});

test('escapar no toca los bytes normales', () => {
  const b = Buffer.from([0x01, 0x02, 0x03]);
  assert.deepEqual([...jt808.escape(b)], [...b]);
});

test('una secuencia de escape inválida se reporta sin tumbar el parseo', () => {
  const { data, malformado } = jt808.unescape(Buffer.from([0x7d, 0x09, 0x01]));
  assert.equal(malformado, true);
  assert.deepEqual([...data], [0x7d, 0x09, 0x01]);
});

// ── estructura ───────────────────────────────────────────────────────────────

test('trama de posición 0x0200: cabecera, checksum y coordenadas', () => {
  const body = locationBody({ lat: SJR.lat, lon: SJR.lon });
  const frame = jt808.buildFrame(jt808.MSG_LOCATION, TERMINAL, body, { serial: 0x0005 });

  assert.equal(frame[0], 0x7e);
  assert.equal(frame[frame.length - 1], 0x7e);

  const msg = jt808.decode(frame);
  assert.equal(msg.protocol, 'jt808');
  assert.equal(msg.type, 'posicion');
  assert.equal(msg.checksumOk, true);
  assert.equal(msg.msgIdHex, '0x0200');
  assert.equal(msg.terminalId, TERMINAL);
  assert.equal(msg.serial, 5);
  assert.deepEqual(msg.errors, []);

  assert.ok(Math.abs(msg.position.latitude - SJR.lat) < 1e-6);
  assert.ok(Math.abs(msg.position.longitude - SJR.lon) < 1e-6);
  assert.ok(msg.position.longitude < 0, 'bit 3 del estado => longitud oeste');
  assert.equal(msg.position.speedKmh, 40); // 400 décimas
  assert.equal(msg.position.course, 90);
  assert.equal(msg.position.altitude, 1900);
  assert.equal(msg.position.valid, true);
  assert.equal(msg.position.deviceTime.toISOString(), '2025-08-12T17:30:00.000Z');
});

test('el checksum es el XOR de cabecera + cuerpo', () => {
  const body = locationBody({ lat: SJR.lat, lon: SJR.lon });
  const frame = jt808.buildFrame(jt808.MSG_LOCATION, TERMINAL, body, { serial: 1 });
  const { data } = jt808.unescape(frame.subarray(1, frame.length - 1));
  assert.equal(data[data.length - 1], xorChecksum(data.subarray(0, data.length - 1)));
});

test('un checksum malo se marca pero la trama se decodifica igual', () => {
  const body = locationBody({ lat: SJR.lat, lon: SJR.lon });
  const frame = jt808.buildFrame(jt808.MSG_LOCATION, TERMINAL, body, { serial: 1 });
  // El penúltimo byte (antes del 0x7E de cierre) es el checksum.
  frame[frame.length - 2] ^= 0xff;

  const msg = jt808.decode(frame);
  assert.equal(msg.checksumOk, false);
  assert.equal(msg.type, 'posicion');
  assert.ok(msg.position.latitude > 0);
  assert.ok(msg.errors.some((e) => e.includes('checksum')));
});

test('una trama con bytes escapados se parsea bien (des-escapado antes del parseo)', () => {
  // Latitud elegida para que su codificación contenga un 0x7E, que obliga al escape.
  const body = locationBody({ lat: 20.3897, lon: -99.9961, altitud: 0x7e7d, velocidadKmh: 12.6 });
  const frame = jt808.buildFrame(jt808.MSG_LOCATION, TERMINAL, body, { serial: 2 });

  assert.ok(frame.includes(Buffer.from([0x7d, 0x02])) || frame.includes(Buffer.from([0x7d, 0x01])), 'la trama debe traer escapes');

  const msg = jt808.decode(frame);
  assert.equal(msg.checksumOk, true);
  assert.equal(msg.position.altitude, 0x7e7d);
  assert.equal(msg.position.speedKmh, 12.6);
});

// ── respuestas ───────────────────────────────────────────────────────────────

test('el registro 0x0100 se responde con 0x8100', () => {
  const body = Buffer.concat([
    Buffer.from([0x00, 0x2c, 0x00, 0x64]), // provincia, ciudad
    Buffer.from('SEEWO', 'ascii'), // fabricante (5)
    Buffer.from('S11L_LA', 'ascii'), // modelo y resto: no se parte
  ]);
  const frame = jt808.buildFrame(jt808.MSG_REGISTER, TERMINAL, body, { serial: 0x0011 });
  const msg = jt808.decode(frame);

  assert.equal(msg.type, 'registro');
  assert.equal(msg.attributes.fabricante, 'SEEWO');
  assert.ok(msg.attributes.unmapped, 'el resto del cuerpo de registro queda sin mapear a propósito');

  assert.ok(msg.reply);
  const respuesta = jt808.decode(msg.reply);
  assert.equal(respuesta.msgIdHex, '0x8100');
  assert.equal(respuesta.checksumOk, true);

  const { data } = jt808.unescape(msg.reply.subarray(1, msg.reply.length - 1));
  const cuerpo = data.subarray(12, data.length - 1); // 4 cabecera + 6 terminal + 2 serial
  assert.equal(cuerpo.readUInt16BE(0), 0x0011, 'debe responder el serial recibido');
  assert.equal(cuerpo[2], 0, 'resultado 0 = registro correcto');
  assert.equal(cuerpo.subarray(3).toString('ascii'), TERMINAL, 'devuelve el código de autenticación');
});

test('la autenticación 0x0102 y la posición 0x0200 se responden con 0x8001', () => {
  for (const [msgId, body] of [
    [jt808.MSG_AUTH, Buffer.from('CODIGO123', 'ascii')],
    [jt808.MSG_LOCATION, locationBody({ lat: SJR.lat, lon: SJR.lon })],
    [jt808.MSG_HEARTBEAT, Buffer.alloc(0)],
  ]) {
    const frame = jt808.buildFrame(msgId, TERMINAL, body, { serial: 0x00aa });
    const msg = jt808.decode(frame);
    assert.ok(msg.reply, `el mensaje 0x${msgId.toString(16)} debe responderse`);

    const respuesta = jt808.decode(msg.reply);
    assert.equal(respuesta.msgIdHex, '0x8001');
    assert.equal(respuesta.checksumOk, true);

    const { data } = jt808.unescape(msg.reply.subarray(1, msg.reply.length - 1));
    const cuerpo = data.subarray(12, data.length - 1);
    assert.equal(cuerpo.readUInt16BE(0), 0x00aa, 'serial respondido');
    assert.equal(cuerpo.readUInt16BE(2), msgId, 'msgId respondido');
    assert.equal(cuerpo[4], 0, 'resultado correcto');
  }
});

// ── elementos adicionales y lotes ────────────────────────────────────────────

test('los TLV conocidos se mapean y los desconocidos quedan marcados', () => {
  const extras = Buffer.concat([
    Buffer.from([0x31, 0x01, 0x0b]), // satélites = 11
    Buffer.from([0x30, 0x01, 0x1a]), // señal GSM = 26
    Buffer.from([0x01, 0x04, 0x00, 0x00, 0x30, 0x39]), // kilometraje 12345 -> 1234.5 km
    Buffer.from([0xe5, 0x02, 0xab, 0xcd]), // propietario del fabricante: no se inventa
  ]);
  const body = locationBody({ lat: SJR.lat, lon: SJR.lon, extras });
  const msg = jt808.decode(jt808.buildFrame(jt808.MSG_LOCATION, TERMINAL, body, { serial: 3 }));

  assert.equal(msg.position.satellites, 11);
  assert.equal(msg.attributes.extras.satelites, 11);
  assert.equal(msg.attributes.extras.gsm_signal, 26);
  assert.equal(msg.attributes.extras.kilometraje_km, 1234.5);
  assert.equal(msg.attributes.unmapped.elementos[0].id, '0xE5');
  assert.equal(msg.attributes.unmapped.elementos[0].hex, 'ABCD');
  assert.match(msg.attributes.unmapped.nota, /TODO/);
});

test('el lote 0x0704 (búfer offline) devuelve todas las posiciones', () => {
  const items = [
    locationBody({ lat: SJR.lat, lon: SJR.lon, fecha: [25, 8, 12, 17, 30, 0] }),
    locationBody({ lat: SJR.lat + 0.001, lon: SJR.lon - 0.001, fecha: [25, 8, 12, 17, 31, 0] }),
    locationBody({ lat: SJR.lat + 0.002, lon: SJR.lon - 0.002, fecha: [25, 8, 12, 17, 32, 0] }),
  ];
  const partes = [Buffer.alloc(3)];
  partes[0].writeUInt16BE(items.length, 0);
  partes[0][2] = 1; // reenvío de zona ciega
  for (const it of items) {
    const len = Buffer.alloc(2);
    len.writeUInt16BE(it.length, 0);
    partes.push(len, it);
  }

  const msg = jt808.decode(jt808.buildFrame(jt808.MSG_LOCATION_BATCH, TERMINAL, Buffer.concat(partes), { serial: 4 }));

  assert.equal(msg.type, 'posiciones_lote');
  assert.equal(msg.attributes.lote.cantidad, 3);
  assert.equal(msg.attributes.lote.tipo, 'reenvio_zona_ciega');
  assert.equal(msg.positions.length, 3);
  assert.equal(msg.positions[0].position.deviceTime.toISOString(), '2025-08-12T17:30:00.000Z');
  assert.equal(msg.positions[2].position.deviceTime.toISOString(), '2025-08-12T17:32:00.000Z');
  assert.ok(msg.reply, 'el lote debe confirmarse');
});

// ── robustez ─────────────────────────────────────────────────────────────────

test('sin fix (bit 1 del estado apagado) no se reporta coordenada', () => {
  const b = locationBody({ lat: SJR.lat, lon: SJR.lon });
  b.writeUInt32BE(b.readUInt32BE(4) & ~0x02, 4); // se apaga "posicionado"
  const msg = jt808.decode(jt808.buildFrame(jt808.MSG_LOCATION, TERMINAL, b, { serial: 6 }));

  assert.equal(msg.position.valid, false);
  assert.equal(msg.position.latitude, null);
  assert.ok(msg.attributes.coordenadas_sin_fix);
});

test('coordenadas imposibles se descartan', () => {
  const b = locationBody({ lat: SJR.lat, lon: SJR.lon });
  b.writeUInt32BE(200 * 1e6, 8); // latitud 200°
  const msg = jt808.decode(jt808.buildFrame(jt808.MSG_LOCATION, TERMINAL, b, { serial: 7 }));

  assert.equal(msg.position.latitude, null);
  assert.equal(msg.attributes.coordenadas_descartadas.motivo, 'fuera_de_rango');
});

test('un BCD de fecha inválido deja device_time nulo', () => {
  const b = locationBody({ lat: SJR.lat, lon: SJR.lon });
  Buffer.from([0x25, 0x8f, 0x12, 0x17, 0x30, 0x00]).copy(b, 22); // 0x8F no es BCD
  const msg = jt808.decode(jt808.buildFrame(jt808.MSG_LOCATION, TERMINAL, b, { serial: 8 }));
  assert.equal(msg.position.deviceTime, null);
  assert.ok(msg.errors.some((e) => e.includes('BCD')));
});

test('un msgId desconocido deja el cuerpo entero sin mapear', () => {
  const msg = jt808.decode(jt808.buildFrame(0x0999, TERMINAL, Buffer.from([1, 2, 3]), { serial: 9 }));
  assert.equal(msg.type, 'desconocido');
  assert.equal(msg.attributes.unmapped.hex, '010203');
  assert.match(msg.attributes.unmapped.nota, /0x0999/);
});

test('parseBcdDateUtc valida los dígitos', () => {
  assert.equal(jt808.parseBcdDateUtc(bcdFecha([25, 8, 12, 17, 30, 0])).toISOString(), '2025-08-12T17:30:00.000Z');
  assert.equal(jt808.parseBcdDateUtc(Buffer.from([0x25, 0x1a, 0x12, 0x17, 0x30, 0x00])), null);
  assert.equal(jt808.parseBcdDateUtc(bcdFecha([25, 13, 12, 17, 30, 0])), null);
  assert.equal(jt808.parseBcdDateUtc(bcdFecha([25, 2, 30, 17, 30, 0])), null);
});

test('findFrame localiza una trama completa y omite delimitadores repetidos', () => {
  const frame = jt808.buildFrame(jt808.MSG_HEARTBEAT, TERMINAL, Buffer.alloc(0), { serial: 10 });
  const conBasura = Buffer.concat([Buffer.from([0x7e, 0x7e]), frame.subarray(1)]);
  const found = jt808.findFrame(conBasura);
  assert.ok(found);
  assert.equal(conBasura[found.start], 0x7e);
  assert.equal(conBasura[found.end], 0x7e);
  assert.equal(jt808.findFrame(Buffer.from([0x7e, 0x01, 0x02])), null);
});
