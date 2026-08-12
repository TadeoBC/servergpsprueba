import test from 'node:test';
import assert from 'node:assert/strict';
import { crcItu } from '../src/protocols/crc.js';
import * as gt06 from '../src/protocols/gt06.js';

// ── ayudantes para armar fixtures ────────────────────────────────────────────

function loginPayload(imei) {
  // Terminal ID: 8 bytes BCD, el IMEI de 15 dígitos con un cero de relleno.
  return Buffer.from(String(imei).padStart(16, '0'), 'hex');
}

/**
 * Bloque GPS del 0x12 / 0x16 / 0x22:
 *   fecha(6) sat(1) lat(4) lon(4) vel(1) flags(2)
 */
function gpsBlock({ fecha, satelites, lat, lon, velocidad, rumbo, norte = true, oeste = true, fijado = true }) {
  const b = Buffer.alloc(18);
  b[0] = fecha[0]; b[1] = fecha[1]; b[2] = fecha[2];
  b[3] = fecha[3]; b[4] = fecha[4]; b[5] = fecha[5];
  b[6] = (0x0c << 4) | (satelites & 0x0f); // nibble alto = largo de la info GPS
  b.writeUInt32BE(Math.round(Math.abs(lat) * 1800000), 7);
  b.writeUInt32BE(Math.round(Math.abs(lon) * 1800000), 11);
  b[15] = velocidad;
  let flags = rumbo & 0x03ff;
  if (norte) flags |= 0x0400; // bit 10 encendido = hemisferio norte
  if (oeste) flags |= 0x0800; // bit 11 encendido = longitud negativa
  if (fijado) flags |= 0x1000; // bit 12 = GPS fijado
  b.writeUInt16BE(flags, 16);
  return b;
}

function lbsBlock({ mcc = 334, mnc = 20, lac = 0x1234, cellId = 0x56789a } = {}) {
  const b = Buffer.alloc(8);
  b.writeUInt16BE(mcc, 0);
  b[2] = mnc;
  b.writeUInt16BE(lac, 3);
  b.writeUIntBE(cellId, 5, 3);
  return b;
}

// Coordenadas de referencia: San Juan del Río, Querétaro (norte y oeste).
const SJR = { lat: 20.3897, lon: -99.9961 };

// ── estructura de la trama ───────────────────────────────────────────────────

test('trama de login: estructura, CRC y IMEI', () => {
  const frame = gt06.encodeFrame(gt06.PROTOCOL_LOGIN, loginPayload('351840620204473'), 1);

  // 7878 + len(1) + contenido(len) + 0D0A ; len = proto+payload+serial+crc = 13
  assert.equal(frame.length, 18);
  assert.equal(frame.readUInt16BE(0), 0x7878);
  assert.equal(frame[2], 0x0d);
  assert.equal(frame[3], gt06.PROTOCOL_LOGIN);
  assert.deepEqual(frame.subarray(16), Buffer.from([0x0d, 0x0a]));

  // El CRC va sobre [longitud .. serial] inclusive.
  assert.equal(frame.readUInt16BE(14), crcItu(frame.subarray(2, 14)));

  const msg = gt06.decode(frame);
  assert.equal(msg.protocol, 'gt06');
  assert.equal(msg.type, 'login');
  assert.equal(msg.crcOk, true);
  assert.equal(msg.imei, '351840620204473');
  assert.equal(msg.serial, 1);
  assert.deepEqual(msg.errors, []);
});

test('el login DEBE generar respuesta: 7878 05 01 <serial> <crc> 0D0A', () => {
  const frame = gt06.encodeFrame(gt06.PROTOCOL_LOGIN, loginPayload('351840620204473'), 0x0007);
  const msg = gt06.decode(frame);

  assert.ok(msg.reply, 'sin respuesta el equipo entra en bucle de reconexión');
  assert.equal(msg.reply.length, 10);
  assert.equal(msg.reply.readUInt16BE(0), 0x7878);
  assert.equal(msg.reply[2], 0x05);
  assert.equal(msg.reply[3], gt06.PROTOCOL_LOGIN);
  // El serial se copia tal cual del paquete recibido.
  assert.equal(msg.reply.readUInt16BE(4), 0x0007);
  assert.equal(msg.reply.readUInt16BE(6), crcItu(msg.reply.subarray(2, 6)));
  assert.deepEqual(msg.reply.subarray(8), Buffer.from([0x0d, 0x0a]));
});

test('el heartbeat 0x13 se responde y decodifica batería y señal', () => {
  // terminal info(1) + nivel de voltaje(1) + señal GSM(1) + alarma/idioma(2)
  const payload = Buffer.from([0b01000110, 0x05, 0x04, 0x00, 0x01]);
  const frame = gt06.encodeFrame(gt06.PROTOCOL_STATUS, payload, 0x0021);
  const msg = gt06.decode(frame);

  assert.equal(msg.type, 'heartbeat');
  assert.equal(msg.crcOk, true);
  assert.equal(msg.attributes.bateria.nivel, 5);
  assert.equal(msg.attributes.bateria.etiqueta, 'alto');
  assert.equal(msg.attributes.gsm_signal, 4);
  assert.equal(msg.attributes.terminal.acc_encendido, true);
  assert.equal(msg.attributes.terminal.cargando, true);
  assert.equal(msg.attributes.terminal.gps_fijado, true);
  assert.equal(msg.reply[3], gt06.PROTOCOL_STATUS);
  assert.equal(msg.reply.readUInt16BE(4), 0x0021);
});

test('heartbeat real S11L usa escala de batería 0..15', () => {
  const msg = gt06.decode(Buffer.from('78780A13400F0300020007A23B0D0A', 'hex'));
  assert.equal(msg.crcOk, true);
  assert.deepEqual(msg.attributes.bateria, { nivel: 15, escala_max: 15, etiqueta: 'lleno', porcentaje_aprox: 100 });
});

test('alarma real S11L respeta byte de longitud LBS y batería', () => {
  const raw = '787826161A080B17360CCF022FB56D0AB98D52000C0009000000000000000000000E010E02000106960D0A';
  const msg = gt06.decode(Buffer.from(raw, 'hex'));
  assert.equal(msg.crcOk, true);
  assert.equal(msg.alarmType, 'bateria_baja_gps');
  assert.equal(msg.attributes.bateria.nivel, 14);
  assert.equal(msg.attributes.bateria.escala_max, 15);
  assert.deepEqual(msg.attributes.lbs, { mcc: 0, mnc: 0, lac: 0, cell_id: 0 });
  assert.equal(msg.attributes.unmapped, undefined);
});

test('0x94 corto se clasifica como información, no trama desconocida', () => {
  const msg = gt06.decode(Buffer.from('79790008940000000079E4670D0A', 'hex'));
  assert.equal(msg.type, 'informacion');
  assert.equal(msg.attributes.info_subtipo, 0);
  assert.equal(msg.attributes.info_valor_crudo, 0);
});

test('comando 0x80 y respuesta 0x15 conservan server flag y texto', () => {
  const frame = gt06.buildCommandFrame('TIMER,60#', { serverFlag: 0x12345678, serial: 9 });
  const parsed = gt06.parseFrame(frame);
  assert.equal(parsed.protocolNumber, 0x80);
  assert.equal(parsed.crcOk, true);
  assert.equal(parsed.payload[0], 4 + 'TIMER,60#'.length);
  assert.equal(parsed.payload.readUInt32BE(1), 0x12345678);
  assert.equal(parsed.payload.subarray(5, 14).toString('ascii'), 'TIMER,60#');

  const responseText = Buffer.from('SET OK!', 'ascii');
  const responsePayload = Buffer.alloc(1 + 4 + responseText.length + 2);
  responsePayload[0] = 4 + responseText.length;
  responsePayload.writeUInt32BE(0x12345678, 1);
  responseText.copy(responsePayload, 5);
  responsePayload.writeUInt16BE(2, 5 + responseText.length);
  const response = gt06.decode(gt06.encodeFrame(gt06.PROTOCOL_STRING, responsePayload, 10));
  assert.equal(response.attributes.server_flag, 0x12345678);
  assert.equal(response.attributes.texto, 'SET OK!');
  assert.equal(response.attributes.idioma, 2);
  assert.equal(response.attributes.unmapped, undefined);
});

// ── posiciones ───────────────────────────────────────────────────────────────

test('posición 0x12: coordenadas de San Juan del Río con los signos correctos', () => {
  const payload = Buffer.concat([
    gpsBlock({ fecha: [25, 8, 12, 17, 30, 0], satelites: 9, lat: SJR.lat, lon: SJR.lon, velocidad: 42, rumbo: 90 }),
    lbsBlock(),
  ]);
  const frame = gt06.encodeFrame(gt06.PROTOCOL_LOCATION, payload, 0x0002);
  const msg = gt06.decode(frame);

  assert.equal(msg.type, 'posicion');
  assert.equal(msg.crcOk, true);
  assert.deepEqual(msg.errors, []);

  // Norte => latitud positiva. Oeste => longitud NEGATIVA (bit 11 encendido).
  assert.ok(msg.position.latitude > 0, 'la latitud debe ser positiva en el hemisferio norte');
  assert.ok(msg.position.longitude < 0, 'la longitud debe ser negativa en el oeste');
  assert.ok(Math.abs(msg.position.latitude - SJR.lat) < 1e-5);
  assert.ok(Math.abs(msg.position.longitude - SJR.lon) < 1e-5);

  assert.equal(msg.position.speedKmh, 42);
  assert.equal(msg.position.course, 90);
  assert.equal(msg.position.satellites, 9);
  assert.equal(msg.position.valid, true);

  // La fecha viene en UTC (el equipo está con UTC:ON).
  assert.equal(msg.position.deviceTime.toISOString(), '2025-08-12T17:30:00.000Z');

  assert.deepEqual(msg.attributes.lbs, { mcc: 334, mnc: 20, lac: 0x1234, cell_id: 0x56789a });
  // Un 0x12 bien formado no debe dejar bytes sin mapear.
  assert.equal(msg.attributes.unmapped, undefined);

  // Las posiciones del GT06 no llevan ACK.
  assert.equal(msg.reply, null);
});

test('hemisferio sur y longitud este cuando los bits van al revés', () => {
  const payload = Buffer.concat([
    gpsBlock({
      fecha: [25, 1, 2, 3, 4, 5],
      satelites: 7,
      lat: -33.4489, // Santiago de Chile
      lon: -70.6693,
      velocidad: 10,
      rumbo: 180,
      norte: false, // bit 10 apagado => sur
      oeste: true,
    }),
    lbsBlock(),
  ]);
  const msg = gt06.decode(gt06.encodeFrame(gt06.PROTOCOL_LOCATION, payload, 3));
  assert.ok(msg.position.latitude < 0, 'bit 10 apagado debe dar latitud sur');
  assert.ok(msg.position.longitude < 0);

  const payloadEste = Buffer.concat([
    gpsBlock({ fecha: [25, 1, 2, 3, 4, 5], satelites: 7, lat: 39.9, lon: 116.4, velocidad: 0, rumbo: 0, norte: true, oeste: false }),
    lbsBlock(),
  ]);
  const este = gt06.decode(gt06.encodeFrame(gt06.PROTOCOL_LOCATION, payloadEste, 4));
  assert.ok(este.position.longitude > 0, 'bit 11 apagado debe dar longitud este (positiva)');
});

test('sin fix GPS no se reporta coordenada (nada de motos en el océano)', () => {
  const payload = Buffer.concat([
    gpsBlock({ fecha: [25, 8, 12, 17, 30, 10], satelites: 0, lat: SJR.lat, lon: SJR.lon, velocidad: 0, rumbo: 0, fijado: false }),
    lbsBlock(),
  ]);
  const msg = gt06.decode(gt06.encodeFrame(gt06.PROTOCOL_LOCATION, payload, 5));

  assert.equal(msg.position.valid, false);
  assert.equal(msg.position.latitude, null);
  assert.equal(msg.position.longitude, null);
  // Pero el valor decodificado queda a la vista para depurar.
  assert.ok(msg.attributes.coordenadas_sin_fix);
});

test('lat/lon en cero se descartan (0,0 es el Golfo de Guinea, no una posición)', () => {
  const payload = Buffer.concat([
    gpsBlock({ fecha: [25, 8, 12, 17, 30, 20], satelites: 0, lat: 0, lon: 0, velocidad: 0, rumbo: 0, fijado: true }),
    lbsBlock(),
  ]);
  const msg = gt06.decode(gt06.encodeFrame(gt06.PROTOCOL_LOCATION, payload, 6));

  assert.equal(msg.position.latitude, null);
  assert.equal(msg.position.longitude, null);
  assert.equal(msg.position.valid, false);
  assert.equal(msg.attributes.coordenadas_descartadas.motivo, 'lat_lon_en_cero_sin_fix');
});

test('un rumbo fuera de rango se reporta nulo en vez de inventado', () => {
  const b = gpsBlock({ fecha: [25, 8, 12, 1, 2, 3], satelites: 5, lat: SJR.lat, lon: SJR.lon, velocidad: 5, rumbo: 0 });
  // Se fuerzan los 10 bits de rumbo a 1000 (> 360) conservando los bits de estado.
  b.writeUInt16BE((b.readUInt16BE(16) & 0xfc00) | 1000, 16);
  const msg = gt06.decode(gt06.encodeFrame(gt06.PROTOCOL_LOCATION, Buffer.concat([b, lbsBlock()]), 7));

  assert.equal(msg.position.course, null);
  assert.equal(msg.attributes.rumbo_crudo_fuera_de_rango, 1000);
  assert.ok(msg.errors.some((e) => e.includes('rumbo fuera de rango')));
});

test('una fecha imposible deja device_time nulo', () => {
  const b = gpsBlock({ fecha: [25, 2, 31, 10, 0, 0], satelites: 5, lat: SJR.lat, lon: SJR.lon, velocidad: 5, rumbo: 0 });
  const msg = gt06.decode(gt06.encodeFrame(gt06.PROTOCOL_LOCATION, Buffer.concat([b, lbsBlock()]), 8));
  assert.equal(msg.position.deviceTime, null);
  assert.ok(msg.errors.some((e) => e.includes('fecha')));
});

test('el 0x22 deja sin mapear los bytes posteriores al LBS, con su TODO', () => {
  const payload = Buffer.concat([
    gpsBlock({ fecha: [25, 8, 12, 18, 0, 0], satelites: 8, lat: SJR.lat, lon: SJR.lon, velocidad: 30, rumbo: 45 }),
    lbsBlock(),
    Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x12, 0x34]), // bytes extra del firmware
  ]);
  const msg = gt06.decode(gt06.encodeFrame(gt06.PROTOCOL_LOCATION_EXT, payload, 9));

  assert.equal(msg.type, 'posicion');
  assert.ok(msg.position.latitude > 0);
  assert.ok(msg.attributes.unmapped, 'los bytes no confirmados deben quedar registrados');
  assert.match(msg.attributes.unmapped.nota, /TODO/);
  assert.equal(msg.attributes.unmapped.hex, '01000000001234');
  assert.equal(msg.attributes.unmapped.len, 7);
});

test('trama real S11L 0x12: decodifica los 4 bytes finales como odómetro conservando el crudo', () => {
  const raw = '787823121A080C113431CF022FB2EB0AB9828B001D5D000000000000000000218615001C3F710D0A';
  const msg = gt06.decode(Buffer.from(raw, 'hex'));
  assert.equal(msg.crcOk, true);
  assert.equal(msg.position.speedKmh, 0);
  assert.equal(msg.position.satellites, 15);
  assert.ok(Math.abs(msg.position.latitude - 20.378015) < 1e-6);
  assert.ok(Math.abs(msg.position.longitude - -99.9609661111111) < 1e-6);
  assert.deepEqual(msg.attributes.odometro, {
    valor_crudo: 0x00218615,
    kilometros_estimados: 0x00218615 / 1000,
    unidad_asumida: 'metros',
  });
  assert.equal(msg.attributes.unmapped, undefined);
});

// ── alarmas ──────────────────────────────────────────────────────────────────

test('alarma 0x16: se identifica el tipo y se responde', () => {
  const payload = Buffer.concat([
    gpsBlock({ fecha: [25, 8, 12, 19, 0, 0], satelites: 6, lat: SJR.lat, lon: SJR.lon, velocidad: 0, rumbo: 0 }),
    lbsBlock(),
    Buffer.from([0b00000011, 0x04, 0x03, 0x01, 0x02]), // terminal info, voltaje, gsm, alarma=SOS, idioma
  ]);
  const msg = gt06.decode(gt06.encodeFrame(gt06.PROTOCOL_ALARM, payload, 0x0030));

  assert.equal(msg.type, 'alarma');
  assert.equal(msg.attributes.alarma.tipo, 'sos');
  assert.equal(msg.alarmType, 'sos');
  assert.equal(msg.attributes.bateria.nivel, 4);
  assert.ok(msg.reply, 'la alarma debe confirmarse al equipo');
  assert.equal(msg.reply[3], gt06.PROTOCOL_ALARM);
});

test('un código de alarma no documentado no se inventa', () => {
  const payload = Buffer.concat([
    gpsBlock({ fecha: [25, 8, 12, 19, 0, 30], satelites: 6, lat: SJR.lat, lon: SJR.lon, velocidad: 0, rumbo: 0 }),
    lbsBlock(),
    Buffer.from([0x00, 0x04, 0x03, 0x7f, 0x02]),
  ]);
  const msg = gt06.decode(gt06.encodeFrame(gt06.PROTOCOL_ALARM, payload, 11));
  assert.equal(msg.attributes.alarma.tipo, 'desconocida_0x7F');
});

// ── robustez ─────────────────────────────────────────────────────────────────

test('un CRC malo se marca pero la trama se sigue decodificando', () => {
  const frame = gt06.encodeFrame(gt06.PROTOCOL_LOGIN, loginPayload('351840620204473'), 1);
  frame[14] ^= 0xff; // se corrompe el CRC

  const msg = gt06.decode(frame);
  assert.equal(msg.crcOk, false);
  assert.equal(msg.type, 'login', 'no se debe descartar la trama por el CRC');
  assert.equal(msg.imei, '351840620204473');
  assert.ok(msg.errors.some((e) => e.includes('CRC no coincide')));
  assert.ok(msg.reply, 'aun con CRC malo se responde el login');
});

test('un protocolNumber desconocido no revienta: todo el payload queda sin mapear', () => {
  const frame = gt06.encodeFrame(0x77, Buffer.from([1, 2, 3, 4]), 12);
  const msg = gt06.decode(frame);
  assert.equal(msg.type, 'desconocido');
  assert.equal(msg.attributes.unmapped.hex, '01020304');
  assert.match(msg.attributes.unmapped.nota, /0x77/);
  assert.equal(msg.reply, null);
});

test('un payload más corto de lo esperado no tumba el decoder', () => {
  const frame = gt06.encodeFrame(gt06.PROTOCOL_LOCATION, Buffer.from([25, 8, 12]), 13);
  const msg = gt06.decode(frame);
  assert.ok(msg.errors.length > 0);
  assert.equal(msg.protocol, 'gt06');
});

test('la respuesta a la solicitud de hora 0x8A trae la fecha UTC', () => {
  const frame = gt06.encodeFrame(gt06.PROTOCOL_TIME_REQUEST, Buffer.alloc(0), 14);
  const msg = gt06.decode(frame);

  assert.equal(msg.type, 'solicitud_hora');
  assert.equal(msg.reply[2], 0x0b);
  assert.equal(msg.reply[3], 0x8a);
  const ahora = new Date();
  assert.equal(msg.reply[4], ahora.getUTCFullYear() % 100);
  assert.equal(msg.reply[5], ahora.getUTCMonth() + 1);
  assert.equal(msg.reply.readUInt16BE(msg.reply.length - 4), crcItu(msg.reply.subarray(2, msg.reply.length - 4)));
});

test('frameLength: pide más bytes mientras la trama esté incompleta', () => {
  const frame = gt06.encodeFrame(gt06.PROTOCOL_LOGIN, loginPayload('351840620204473'), 1);
  assert.equal(gt06.frameLength(frame.subarray(0, 1)), 0);
  assert.equal(gt06.frameLength(frame.subarray(0, 3)), 18);
  assert.equal(gt06.frameLength(frame), 18);
  assert.equal(gt06.frameLength(Buffer.from([0xaa, 0xbb, 0xcc])), -1);
});

test('parseDateTimeUtc rechaza valores fuera de rango', () => {
  assert.equal(gt06.parseDateTimeUtc(Buffer.from([25, 13, 1, 0, 0, 0])), null); // mes 13
  assert.equal(gt06.parseDateTimeUtc(Buffer.from([25, 1, 1, 24, 0, 0])), null); // hora 24
  assert.equal(gt06.parseDateTimeUtc(Buffer.from([25, 2, 30, 0, 0, 0])), null); // 30 de febrero
  assert.equal(
    gt06.parseDateTimeUtc(Buffer.from([25, 12, 31, 23, 59, 59])).toISOString(),
    '2025-12-31T23:59:59.000Z',
  );
});
