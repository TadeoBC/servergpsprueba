#!/usr/bin/env node
/**
 * Rastreador falso para probar toda la interfaz sin el equipo real.
 *
 *   npm run simulate                  GT06 (lo que se espera del S11L_LA)
 *   npm run simulate -- --jt808       JT808, para probar la detección
 *   npm run simulate -- --replay      reenvía posiciones ya mandadas
 *                                     (prueba el anti-duplicado del búfer offline)
 *   npm run simulate -- --imei=... --intervalo=3 --equipos=3
 *
 * Recorre un circuito por San Juan del Río, Querétaro. Las coordenadas de los
 * vértices son aproximadas (tomadas del mapa de la ciudad); entre vértices se
 * interpola, y el rumbo y la velocidad se calculan del propio movimiento, así
 * que no hay valores inventados sueltos.
 */
import net from 'node:net';
import 'dotenv/config';
import * as gt06 from '../src/protocols/gt06.js';
import * as jt808 from '../src/protocols/jt808.js';

// ── argumentos ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, def) => {
  const a = args.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : def;
};

const HOST = opt('host', process.env.SIM_HOST || '127.0.0.1');
const PORT = Number(opt('puerto', process.env.SIM_PORT || process.env.TCP_PORT || 5023));
const IMEI_BASE = opt('imei', process.env.SIM_IMEI || '351840620204473');
const INTERVALO = Number(opt('intervalo', process.env.SIM_INTERVAL_SECONDS || 5)) * 1000;
const EQUIPOS = Number(opt('equipos', 1));
const USAR_JT808 = flag('jt808');
const REPLAY = flag('replay');

// ── circuito por San Juan del Río, Querétaro ─────────────────────────────────
// Vértices aproximados de un recorrido urbano: centro → av. Juárez → periférico
// → zona industrial → regreso. Suficientemente real para ver el trazo en el mapa.
const RUTA = [
  [20.38970, -99.99570], // Plaza Independencia (centro)
  [20.38820, -99.99080], // Av. Benito Juárez oriente
  [20.38510, -99.98650], // salida hacia el libramiento
  [20.37960, -99.98420], // libramiento sur
  [20.37480, -99.99180], // cruce carretera federal 57
  [20.37690, -100.00230], // poniente
  [20.38350, -100.00910], // zona industrial Valle de Oro
  [20.39150, -100.00420], // norte
  [20.39380, -99.99760], // regreso por el norte del centro
  [20.38970, -99.99570], // cierra el circuito
];

const R_TIERRA = 6371000;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function distanciaM([lat1, lon1], [lat2, lon2]) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_TIERRA * Math.asin(Math.sqrt(a));
}

function rumbo([lat1, lon1], [lat2, lon2]) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x =
    Math.cos(rad(lat1)) * Math.sin(rad(lat2)) -
    Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Camina la ruta a ~35 km/h, devolviendo un punto por llamada. */
function crearRecorrido(desplazamiento = 0) {
  let tramo = 0;
  let avance = desplazamiento;

  return function siguiente(segundos) {
    const metros = (35 * 1000 / 3600) * segundos * (0.7 + Math.random() * 0.6);
    avance += metros;

    for (let intentos = 0; intentos < RUTA.length * 2; intentos++) {
      const a = RUTA[tramo];
      const b = RUTA[(tramo + 1) % RUTA.length];
      const largo = distanciaM(a, b);
      if (avance <= largo) {
        const t = largo === 0 ? 0 : avance / largo;
        return {
          lat: a[0] + (b[0] - a[0]) * t,
          lon: a[1] + (b[1] - a[1]) * t,
          rumbo: rumbo(a, b),
          velocidad: Math.round((metros / segundos) * 3.6),
        };
      }
      avance -= largo;
      tramo = (tramo + 1) % RUTA.length;
    }
    return { lat: RUTA[0][0], lon: RUTA[0][1], rumbo: 0, velocidad: 0 };
  };
}

// ── constructores de tramas ──────────────────────────────────────────────────

function payloadPosicionGt06({ lat, lon, velocidad, rumbo: curso, satelites, fecha }) {
  const b = Buffer.alloc(26);
  b[0] = fecha.getUTCFullYear() % 100;
  b[1] = fecha.getUTCMonth() + 1;
  b[2] = fecha.getUTCDate();
  b[3] = fecha.getUTCHours();
  b[4] = fecha.getUTCMinutes();
  b[5] = fecha.getUTCSeconds();
  b[6] = (0x0c << 4) | (satelites & 0x0f);
  b.writeUInt32BE(Math.round(Math.abs(lat) * 1800000), 7);
  b.writeUInt32BE(Math.round(Math.abs(lon) * 1800000), 11);
  b[15] = Math.min(255, Math.max(0, Math.round(velocidad)));

  // México: hemisferio norte (bit 10) y longitud oeste (bit 11), con fix (bit 12).
  const flags = (Math.round(curso) & 0x03ff) | 0x0400 | 0x0800 | 0x1000;
  b.writeUInt16BE(flags, 16);

  // LBS: Telcel = MCC 334, MNC 20.
  b.writeUInt16BE(334, 18);
  b[20] = 20;
  b.writeUInt16BE(0x1a2b, 21);
  b.writeUIntBE(0x3c4d5e, 23, 3);
  return b;
}

function payloadPosicionJt808({ lat, lon, velocidad, rumbo: curso, satelites, fecha }) {
  const b = Buffer.alloc(28);
  b.writeUInt32BE(0, 0); // sin alarmas
  let estado = 0x02 | 0x01; // posicionado + ACC encendido
  if (lat < 0) estado |= 0x04;
  if (lon < 0) estado |= 0x08;
  b.writeUInt32BE(estado >>> 0, 4);
  b.writeUInt32BE(Math.round(Math.abs(lat) * 1e6), 8);
  b.writeUInt32BE(Math.round(Math.abs(lon) * 1e6), 12);
  b.writeUInt16BE(1920, 16); // altitud de San Juan del Río, ~1920 m
  b.writeUInt16BE(Math.round(velocidad * 10), 18);
  b.writeUInt16BE(Math.round(curso) % 360, 20);
  const bcd = [
    fecha.getUTCFullYear() % 100,
    fecha.getUTCMonth() + 1,
    fecha.getUTCDate(),
    fecha.getUTCHours(),
    fecha.getUTCMinutes(),
    fecha.getUTCSeconds(),
  ].map((n) => Number.parseInt(String(n).padStart(2, '0'), 16));
  Buffer.from(bcd).copy(b, 22);

  const extras = Buffer.from([0x31, 0x01, satelites, 0x30, 0x01, 0x1c]);
  return Buffer.concat([b, extras]);
}

// ── equipo simulado ──────────────────────────────────────────────────────────

function arrancarEquipo(indice) {
  const imei = EQUIPOS === 1 ? IMEI_BASE : String(BigInt(IMEI_BASE) + BigInt(indice));
  const etiqueta = `[${imei}]`;
  const recorrido = crearRecorrido(indice * 900);
  const historial = [];
  let inbound = Buffer.alloc(0);

  let serial = 0;
  const siguienteSerial = () => (serial = (serial + 1) & 0xffff);

  const socket = net.connect({ host: HOST, port: PORT }, () => {
    console.log(`${etiqueta} conectado a ${HOST}:${PORT} hablando ${USAR_JT808 ? 'JT808' : 'GT06'}`);

    if (USAR_JT808) {
      const terminal = imei.slice(-12);
      enviar(
        jt808.buildFrame(
          jt808.MSG_REGISTER,
          terminal,
          Buffer.concat([Buffer.from([0x00, 0x2c, 0x00, 0x64]), Buffer.from('SEEWO', 'ascii'), Buffer.from('S11L_LA', 'ascii')]),
          { serial: siguienteSerial() },
        ),
        'registro 0x0100',
      );
      setTimeout(() => {
        enviar(jt808.buildFrame(jt808.MSG_AUTH, terminal, Buffer.from(terminal, 'ascii'), { serial: siguienteSerial() }), 'auth 0x0102');
      }, 400);
    } else {
      enviar(gt06.encodeFrame(gt06.PROTOCOL_LOGIN, Buffer.from(imei.padStart(16, '0'), 'hex'), siguienteSerial()), 'login 0x01');
    }

    // Primera posición un segundo después del login, y luego cada INTERVALO.
    setTimeout(() => {
      enviarPosicion();
      timers.push(setInterval(enviarPosicion, INTERVALO));
    }, 1000);

    // Heartbeat cada 180 s, como está configurado el equipo real (HBT 180).
    timers.push(setInterval(enviarHeartbeat, 180000));

    if (REPLAY) {
      // A los 30 s reenvía las posiciones ya mandadas: la base debe descartarlas
      // por la restricción UNIQUE(device_id, device_time).
      timers.push(
        setTimeout(() => {
          console.log(`${etiqueta} reenviando ${historial.length} posiciones (simula el búfer offline)`);
          for (const trama of historial) enviar(trama, 'reenvío');
        }, 30000),
      );
    }
  });

  const timers = [];

  function enviar(buf, que) {
    if (socket.destroyed) return;
    socket.write(buf);
    console.log(`${etiqueta} → ${que}: ${buf.toString('hex').toUpperCase()}`);
  }

  function enviarPosicion() {
    const punto = recorrido(INTERVALO / 1000);
    const datos = {
      lat: punto.lat,
      lon: punto.lon,
      velocidad: punto.velocidad,
      rumbo: punto.rumbo,
      satelites: 6 + Math.floor(Math.random() * 6),
      fecha: new Date(),
    };

    const trama = USAR_JT808
      ? jt808.buildFrame(jt808.MSG_LOCATION, imei.slice(-12), payloadPosicionJt808(datos), { serial: siguienteSerial() })
      : gt06.encodeFrame(gt06.PROTOCOL_LOCATION, payloadPosicionGt06(datos), siguienteSerial());

    if (REPLAY && historial.length < 6) historial.push(trama);
    enviar(trama, `posición ${datos.lat.toFixed(5)},${datos.lon.toFixed(5)} ${datos.velocidad} km/h`);
  }

  function enviarHeartbeat() {
    if (USAR_JT808) {
      enviar(jt808.buildFrame(jt808.MSG_HEARTBEAT, imei.slice(-12), Buffer.alloc(0), { serial: siguienteSerial() }), 'heartbeat 0x0002');
    } else {
      // terminal info(1) voltaje(1) señal gsm(1) alarma/idioma(2)
      const nivel = 4 + Math.floor(Math.random() * 3);
      enviar(
        gt06.encodeFrame(gt06.PROTOCOL_STATUS, Buffer.from([0b01000110, nivel, 0x04, 0x00, 0x01]), siguienteSerial()),
        'heartbeat 0x13',
      );
    }
  }

  socket.on('data', (chunk) => {
    console.log(`${etiqueta} ← respuesta del servidor: ${chunk.toString('hex').toUpperCase()}`);
    if (USAR_JT808) return;
    inbound = Buffer.concat([inbound, chunk]);
    while (inbound.length >= 3) {
      const size = gt06.frameLength(inbound);
      if (size <= 0 || inbound.length < size) break;
      const frame = inbound.subarray(0, size);
      inbound = inbound.subarray(size);
      const parsed = gt06.parseFrame(frame);
      if (parsed.ok && parsed.protocolNumber === 0x80) responderComando(parsed);
    }
  });

  function responderComando(parsed) {
    const p = parsed.payload;
    if (p.length < 7) return;
    const commandLength = p[0];
    const flag = p.readUInt32BE(1);
    const textLength = Math.max(0, commandLength - 4);
    const command = p.subarray(5, 5 + textLength).toString('ascii');
    const response = /^(?:TIMER|HBT|SENALM|BATALM),/i.test(command)
      ? 'SET OK!'
      : command === 'PARAM#' ? 'IMEI:SIMULATED;TIMER:10;HBT:3;UTC:ON'
      : command === 'STATUS#' ? 'Battery:80%;GPRS:Link Up;GPS:FIXED'
      : 'ERROR!';
    const responseText = Buffer.from(response, 'ascii');
    const payload = Buffer.alloc(1 + 4 + responseText.length + 2);
    payload[0] = 4 + responseText.length;
    payload.writeUInt32BE(flag, 1);
    responseText.copy(payload, 5);
    payload.writeUInt16BE(2, 5 + responseText.length);
    enviar(gt06.encodeFrame(gt06.PROTOCOL_STRING, payload, siguienteSerial()), `respuesta comando ${command}`);
  }

  socket.on('error', (err) => console.error(`${etiqueta} error: ${err.message}`));

  socket.on('close', () => {
    for (const t of timers) {
      clearInterval(t);
      clearTimeout(t);
    }
    console.log(`${etiqueta} conexión cerrada; reintentando en 5 s`);
    setTimeout(() => arrancarEquipo(indice), 5000);
  });

  return socket;
}

console.log(
  `Simulador de rastreadores — ${EQUIPOS} equipo(s), protocolo ${USAR_JT808 ? 'JT808' : 'GT06'}, ` +
    `una posición cada ${INTERVALO / 1000}s hacia ${HOST}:${PORT}`,
);
console.log('Recorrido: circuito urbano por San Juan del Río, Querétaro. Ctrl+C para salir.\n');

for (let i = 0; i < EQUIPOS; i++) {
  setTimeout(() => arrancarEquipo(i), i * 700);
}
