import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameAccumulator, decodeFrame, PROTOCOLS } from '../src/tcp/framing.js';
import * as gt06 from '../src/protocols/gt06.js';
import * as jt808 from '../src/protocols/jt808.js';

const IMEI = '351840620204473';
const TERMINAL = '840620204473';

function loginGt06(serial = 1) {
  return gt06.encodeFrame(gt06.PROTOCOL_LOGIN, Buffer.from(IMEI.padStart(16, '0'), 'hex'), serial);
}

function heartbeatGt06(serial = 2) {
  return gt06.encodeFrame(gt06.PROTOCOL_STATUS, Buffer.from([0x00, 0x05, 0x04, 0x00, 0x01]), serial);
}

test('detecta GT06 por el primer byte', () => {
  const acc = new FrameAccumulator();
  const { frames } = acc.push(loginGt06());
  assert.equal(frames.length, 1);
  assert.equal(frames[0].protocol, PROTOCOLS.GT06);
  assert.equal(acc.protocol, PROTOCOLS.GT06);
});

test('detecta JT808 por el delimitador 0x7E', () => {
  const acc = new FrameAccumulator();
  const frame = jt808.buildFrame(jt808.MSG_HEARTBEAT, TERMINAL, Buffer.alloc(0), { serial: 1 });
  const { frames } = acc.push(frame);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].protocol, PROTOCOLS.JT808);
  assert.equal(acc.protocol, PROTOCOLS.JT808);
});

test('detecta GPS103 por el prefijo "imei:"', () => {
  const acc = new FrameAccumulator();
  const texto = 'imei:351840620204473,tracker,250812173000,,F,173000.000,A,2023.3820,N,09959.7660,W,0.00,0;';
  const { frames } = acc.push(Buffer.from(texto, 'ascii'));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].protocol, PROTOCOLS.GPS103);

  const msg = decodeFrame(frames[0]);
  assert.equal(msg.type, 'posicion');
  assert.equal(msg.imei, IMEI);
  assert.ok(msg.position.latitude > 20 && msg.position.latitude < 21);
  assert.ok(msg.position.longitude < -99 && msg.position.longitude > -100);
});

// ── el punto clave: TCP no respeta los límites de paquete ────────────────────

test('una trama partida en varios chunks se arma bien', () => {
  const acc = new FrameAccumulator();
  const frame = loginGt06(7);

  // Byte por byte: el caso más agresivo.
  let total = [];
  for (let i = 0; i < frame.length; i++) {
    const { frames } = acc.push(frame.subarray(i, i + 1));
    total = total.concat(frames);
  }
  assert.equal(total.length, 1);
  const msg = decodeFrame(total[0]);
  assert.equal(msg.type, 'login');
  assert.equal(msg.imei, IMEI);
  assert.equal(msg.crcOk, true);
});

test('dos tramas pegadas en un solo chunk se separan', () => {
  const acc = new FrameAccumulator();
  const { frames } = acc.push(Buffer.concat([loginGt06(1), heartbeatGt06(2)]));

  assert.equal(frames.length, 2);
  assert.equal(decodeFrame(frames[0]).type, 'login');
  assert.equal(decodeFrame(frames[1]).type, 'heartbeat');
});

test('una trama y media: se entrega la completa y se guarda el remanente', () => {
  const acc = new FrameAccumulator();
  const a = loginGt06(1);
  const b = heartbeatGt06(2);

  const primero = acc.push(Buffer.concat([a, b.subarray(0, 5)]));
  assert.equal(primero.frames.length, 1);
  assert.equal(decodeFrame(primero.frames[0]).type, 'login');

  const segundo = acc.push(b.subarray(5));
  assert.equal(segundo.frames.length, 1);
  assert.equal(decodeFrame(segundo.frames[0]).type, 'heartbeat');
});

test('mezcla de tres tramas repartidas en chunks arbitrarios', () => {
  const acc = new FrameAccumulator();
  const todo = Buffer.concat([loginGt06(1), heartbeatGt06(2), loginGt06(3)]);

  const recogidas = [];
  let i = 0;
  const cortes = [3, 11, 7, 1, 20, 5, 99];
  let c = 0;
  while (i < todo.length) {
    const n = cortes[c++ % cortes.length];
    const { frames } = acc.push(todo.subarray(i, i + n));
    recogidas.push(...frames);
    i += n;
  }
  assert.equal(recogidas.length, 3);
  assert.deepEqual(recogidas.map((f) => decodeFrame(f).type), ['login', 'heartbeat', 'login']);
});

test('JT808 partido entre chunks', () => {
  const acc = new FrameAccumulator();
  const frame = jt808.buildFrame(jt808.MSG_HEARTBEAT, TERMINAL, Buffer.alloc(0), { serial: 1 });

  const a = acc.push(frame.subarray(0, 6));
  assert.equal(a.frames.length, 0);
  const b = acc.push(frame.subarray(6));
  assert.equal(b.frames.length, 1);
  assert.equal(decodeFrame(b.frames[0]).type, 'heartbeat');
});

// ── escáneres HTTP ───────────────────────────────────────────────────────────

test('una petición GET se rechaza sin exponer su contenido', () => {
  const acc = new FrameAccumulator();
  const peticion = 'GET / HTTP/1.1\r\nHost: gps.atlyx.online\r\nCookie: sesion=secreto\r\n\r\n';
  const r = acc.push(Buffer.from(peticion, 'ascii'));

  assert.ok(r.reject);
  assert.equal(r.frames.length, 0);
  // El motivo se puede loguear; NO debe contener nada de lo que mandó el cliente.
  assert.ok(!r.reject.includes('secreto'));
  assert.ok(!r.reject.includes('Cookie'));
  assert.ok(!r.reject.includes('gps.atlyx.online'));
  assert.match(r.reject, /HTTP/);
});

test('POST y HEAD también se rechazan, y la conexión queda marcada', () => {
  for (const verbo of ['POST /x HTTP/1.1\r\n\r\n', 'HEAD / HTTP/1.0\r\n\r\n']) {
    const acc = new FrameAccumulator();
    const r = acc.push(Buffer.from(verbo, 'ascii'));
    assert.ok(r.reject, `${verbo.split(' ')[0]} debe rechazarse`);
    // Una vez rechazada, no vuelve a procesar nada de esa conexión.
    const r2 = acc.push(loginGt06());
    assert.ok(r2.reject);
    assert.equal(r2.frames.length, 0);
  }
});

test('un GET partido entre chunks se detecta cuando llegan los 4 bytes', () => {
  const acc = new FrameAccumulator();
  assert.equal(acc.push(Buffer.from('GE', 'ascii')).reject, null);
  assert.ok(acc.push(Buffer.from('T /index.html HTTP/1.1\r\n', 'ascii')).reject);
});

// ── basura y resincronización ────────────────────────────────────────────────

test('la basura previa se descarta y la trama siguiente se recupera', () => {
  const acc = new FrameAccumulator();
  const { frames, notices } = acc.push(Buffer.concat([Buffer.from([0x00, 0x11, 0x22, 0x33]), loginGt06(1)]));

  assert.equal(frames.length, 1);
  assert.equal(decodeFrame(frames[0]).type, 'login');
  assert.ok(notices.some((n) => n.includes('descartad')));
});

test('el búfer no crece sin límite si nunca llega una trama válida', () => {
  const acc = new FrameAccumulator({ maxBufferBytes: 256 });
  const r = acc.push(Buffer.alloc(300, 0x78)); // 0x78 sin longitud coherente
  assert.ok(r.reject === null || r.reject.includes('búfer'));
  assert.ok(acc.buffer.length <= 256);
});

test('un TLS ClientHello (escáner por HTTPS) no rompe nada', () => {
  const acc = new FrameAccumulator();
  const hello = Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00, 0x01, 0xfc]);
  const r = acc.push(hello);
  assert.equal(r.frames.length, 0);
  // Y después de la basura, una trama real se sigue leyendo.
  const r2 = acc.push(loginGt06(1));
  assert.equal(r2.frames.length, 1);
});

test('el acumulador es independiente por instancia (uno por socket)', () => {
  const a = new FrameAccumulator();
  const b = new FrameAccumulator();
  const frame = loginGt06(1);

  a.push(frame.subarray(0, 10));
  const rb = b.push(frame);

  assert.equal(rb.frames.length, 1, 'el socket B no debe verse afectado por el búfer de A');
  assert.equal(a.buffer.length, 10);
});
