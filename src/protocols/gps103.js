/**
 * Decoder GPS103 / TK103 (texto plano ASCII).
 *
 * Se incluye porque la detección lo contempla: si el equipo llega a hablar este
 * protocolo, queremos guardar la posición en vez de descartar la trama.
 *
 * Formatos que reconoce:
 *   imei:<imei>,<evento>,<fecha>,<tel>,F,<hhmmss.sss>,<A|V>,<ddmm.mmmm>,<N|S>,<dddmm.mmmm>,<E|W>,<nudos>,<rumbo>,...;
 *   ##,imei:<imei>,A;            (handshake)
 *   imei:<imei>;                 (heartbeat)
 *
 * Todo campo que no se pueda mapear con certeza queda en attributes.unmapped.
 */

const NUDOS_A_KMH = 1.852;

/** Extrae mensajes completos (terminados en ';') del búfer de texto. */
export function splitMessages(text) {
  const mensajes = [];
  let resto = text;
  for (;;) {
    const idx = resto.indexOf(';');
    if (idx === -1) break;
    const m = resto.slice(0, idx + 1).trim();
    if (m.length > 0) mensajes.push(m);
    resto = resto.slice(idx + 1);
  }
  return { mensajes, resto };
}

export function decode(text, rawBuffer) {
  const msg = {
    protocol: 'gps103',
    rawHex: rawBuffer ? rawBuffer.toString('hex').toUpperCase() : Buffer.from(text, 'ascii').toString('hex').toUpperCase(),
    texto: text,
    type: 'desconocido',
    errors: [],
    fields: [],
    attributes: {},
    reply: null,
  };

  const limpio = text.replace(/;$/, '');

  // Handshake: ##,imei:123456789012345,A
  const handshake = limpio.match(/^##,imei:(\d+),A$/);
  if (handshake) {
    msg.type = 'login';
    msg.imei = handshake[1];
    msg.reply = Buffer.from('LOAD');
    msg.fields.push({ nombre: 'imei', offset: null, len: 0, hex: '', valor: msg.imei, derivado: true });
    return msg;
  }

  // Heartbeat: imei:123456789012345
  const heartbeat = limpio.match(/^imei:(\d+)$/);
  if (heartbeat) {
    msg.type = 'heartbeat';
    msg.imei = heartbeat[1];
    msg.reply = Buffer.from('ON');
    return msg;
  }

  if (!limpio.startsWith('imei:')) {
    msg.type = 'invalido';
    msg.errors.push('la trama no empieza con "imei:"');
    msg.attributes.unmapped = { nota: 'TODO: formato GPS103 no reconocido', texto: limpio.slice(0, 200) };
    return msg;
  }

  const p = limpio.split(',');
  msg.imei = p[0].slice('imei:'.length);
  msg.attributes.evento = p[1] ?? null;

  // Sin bloque GPS (p[4] debería ser F o L): es un aviso sin posición.
  if (p.length < 12 || (p[4] !== 'F' && p[4] !== 'L')) {
    msg.type = p[1] ? `evento_${p[1]}` : 'desconocido';
    msg.attributes.unmapped = {
      nota: 'TODO: trama GPS103 sin bloque GPS reconocible. Campos guardados en crudo.',
      campos: p,
    };
    return msg;
  }

  msg.type = p[1] === 'tracker' ? 'posicion' : 'alarma';
  if (msg.type === 'alarma') msg.alarmType = p[1];

  const fechaCompacta = p[2]; // yymmddhhmm
  const horaGps = p[5]; // hhmmss.sss
  const estado = p[6]; // A = válido, V = inválido
  const latitude = dmToDegrees(p[7], p[8], 2);
  const longitude = dmToDegrees(p[9], p[10], 3);
  const nudos = Number.parseFloat(p[11]);
  const rumbo = p[12] !== undefined && p[12] !== '' ? Number.parseFloat(p[12]) : null;

  const deviceTime = parseGps103DateUtc(fechaCompacta, horaGps);
  const valido = estado === 'A' && latitude !== null && longitude !== null;

  msg.position = {
    latitude: valido ? latitude : null,
    longitude: valido ? longitude : null,
    speedKmh: Number.isFinite(nudos) ? Number((nudos * NUDOS_A_KMH).toFixed(2)) : null,
    course: rumbo !== null && Number.isFinite(rumbo) && rumbo <= 360 ? rumbo : null,
    altitude: null,
    satellites: null,
    valid: valido,
    deviceTime,
  };

  msg.fields = [
    { nombre: 'imei', offset: null, len: 0, hex: '', valor: msg.imei, derivado: true },
    { nombre: 'evento', offset: null, len: 0, hex: '', valor: p[1], derivado: true },
    { nombre: 'fecha (yymmddhhmm)', offset: null, len: 0, hex: '', valor: fechaCompacta, derivado: true },
    { nombre: 'hora GPS', offset: null, len: 0, hex: '', valor: horaGps, derivado: true },
    { nombre: 'estado fix', offset: null, len: 0, hex: '', valor: estado, derivado: true, nota: 'A = válido, V = sin fix' },
    { nombre: 'latitud', offset: null, len: 0, hex: '', valor: `${p[7]} ${p[8]}`, derivado: true, nota: 'ddmm.mmmm' },
    { nombre: 'longitud', offset: null, len: 0, hex: '', valor: `${p[9]} ${p[10]}`, derivado: true, nota: 'dddmm.mmmm' },
    { nombre: 'velocidad', offset: null, len: 0, hex: '', valor: `${p[11]} nudos`, derivado: true },
  ];

  if (!valido && estado !== 'A') msg.errors.push('la trama reporta fix inválido (V)');
  if (deviceTime === null) msg.errors.push('no se pudo armar la fecha/hora; device_time queda nulo');

  if (p.length > 13) {
    msg.attributes.unmapped = {
      nota: 'TODO: campos adicionales de GPS103 sin mapear (varían por modelo).',
      campos: p.slice(13),
    };
  }

  return msg;
}

/** "2234.4669" + "N" -> grados decimales. gradosDigitos = 2 (lat) o 3 (lon). */
function dmToDegrees(valor, hemisferio, gradosDigitos) {
  if (!valor || valor.length < gradosDigitos + 1) return null;
  const grados = Number.parseInt(valor.slice(0, gradosDigitos), 10);
  const minutos = Number.parseFloat(valor.slice(gradosDigitos));
  if (!Number.isFinite(grados) || !Number.isFinite(minutos)) return null;
  let d = grados + minutos / 60;
  if (hemisferio === 'S' || hemisferio === 'W') d = -d;
  const limite = gradosDigitos === 2 ? 90 : 180;
  return Math.abs(d) <= limite ? d : null;
}

/** yymmddhhmm + hhmmss.sss -> Date UTC. Los segundos vienen de la hora GPS. */
function parseGps103DateUtc(fecha, hora) {
  if (!/^\d{10}$/.test(fecha ?? '')) return null;
  const yy = Number(fecha.slice(0, 2));
  const mm = Number(fecha.slice(2, 4));
  const dd = Number(fecha.slice(4, 6));
  const hh = Number(fecha.slice(6, 8));
  const mi = Number(fecha.slice(8, 10));
  let ss = 0;
  if (/^\d{6}(\.\d+)?$/.test(hora ?? '')) ss = Number(hora.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  const d = new Date(Date.UTC(2000 + yy, mm - 1, dd, hh, mi, ss));
  if (d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
  return d;
}
