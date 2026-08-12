import { xorChecksum } from './crc.js';
import { FieldReader } from './reader.js';

/**
 * Decoder JT/T 808.
 *
 * Trama:  7E | cabecera | cuerpo | checksum(1) | 7E
 *
 * Escape (se DES-escapa antes de parsear, y se escapa al construir respuestas):
 *   0x7D 0x01 -> 0x7D
 *   0x7D 0x02 -> 0x7E
 *
 * Cabecera 2013:  msgId(2) attrs(2) terminalBCD(6) serial(2) [paquete(4)]
 * Cabecera 2019:  msgId(2) attrs(2) version(1) terminalBCD(10) serial(2) [paquete(4)]
 *   - bit 14 de attrs encendido => cabecera 2019
 *   - bit 13 de attrs encendido => la trama viene sub-paquetizada (4 bytes más)
 *   - bits 0-9 de attrs = longitud del cuerpo
 *
 * Checksum: XOR de todos los bytes de cabecera + cuerpo (sin delimitadores).
 */

export const DELIMITER = 0x7e;

export const MSG_TERMINAL_GENERAL_RESPONSE = 0x0001;
export const MSG_HEARTBEAT = 0x0002;
export const MSG_REGISTER = 0x0100;
export const MSG_LOGOUT = 0x0003;
export const MSG_AUTH = 0x0102;
export const MSG_LOCATION = 0x0200;
export const MSG_LOCATION_BATCH = 0x0704;

export const MSG_PLATFORM_GENERAL_RESPONSE = 0x8001;
export const MSG_REGISTER_RESPONSE = 0x8100;

// Bits de la palabra de alarma (0x0200). Solo los que están documentados de
// forma estable en JT/T 808-2013; el resto queda en `alarma_bits_crudos`.
const ALARM_BITS = {
  0: 'emergencia_sos',
  1: 'exceso_velocidad',
  2: 'fatiga_conductor',
  3: 'alarma_prealerta',
  4: 'falla_gnss',
  5: 'antena_gnss_desconectada',
  6: 'antena_gnss_cortocircuito',
  7: 'bateria_principal_baja',
  8: 'corte_bateria_principal',
  9: 'falla_pantalla_lcd',
  10: 'falla_tts',
  11: 'falla_camara',
  18: 'tiempo_conduccion_excedido',
  19: 'detencion_prolongada',
  20: 'entrada_salida_area',
  21: 'entrada_salida_ruta',
  29: 'corte_energia_vehiculo',
  30: 'robo_vehiculo',
};

/**
 * Localiza la siguiente trama completa (delimitador a delimitador) dentro del
 * búfer. Devuelve { start, end } con índices sobre `buf`, o null si todavía no
 * hay una trama completa.
 */
export function findFrame(buf) {
  const start = buf.indexOf(DELIMITER);
  if (start === -1) return null;
  // Delimitadores repetidos (7E7E) se saltan.
  let s = start;
  while (s + 1 < buf.length && buf[s + 1] === DELIMITER) s++;
  const end = buf.indexOf(DELIMITER, s + 1);
  if (end === -1) return null;
  return { start: s, end };
}

/** Quita el escape de un cuerpo (sin delimitadores). */
export function unescape(buf) {
  const out = Buffer.alloc(buf.length);
  let j = 0;
  let malformado = false;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7d) {
      const next = buf[i + 1];
      if (next === 0x01) {
        out[j++] = 0x7d;
        i++;
      } else if (next === 0x02) {
        out[j++] = 0x7e;
        i++;
      } else {
        // Secuencia de escape inválida: se conserva el byte tal cual y se avisa.
        out[j++] = 0x7d;
        malformado = true;
      }
    } else {
      out[j++] = buf[i];
    }
  }
  return { data: out.subarray(0, j), malformado };
}

/** Aplica el escape para transmitir. */
export function escape(buf) {
  const parts = [];
  let last = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x7d) {
      parts.push(buf.subarray(last, i), Buffer.from([0x7d, 0x01]));
      last = i + 1;
    } else if (buf[i] === 0x7e) {
      parts.push(buf.subarray(last, i), Buffer.from([0x7d, 0x02]));
      last = i + 1;
    }
  }
  parts.push(buf.subarray(last));
  return Buffer.concat(parts);
}

let platformSerial = 0;
function nextPlatformSerial() {
  platformSerial = (platformSerial + 1) & 0xffff;
  return platformSerial;
}

/**
 * Decodifica una trama JT808 completa INCLUYENDO los delimitadores 0x7E.
 */
export function decode(frame) {
  const rawHex = frame.toString('hex').toUpperCase();
  const msg = {
    protocol: 'jt808',
    rawHex,
    type: 'desconocido',
    errors: [],
    fields: [],
    attributes: {},
    reply: null,
    checksumOk: false,
  };

  if (frame.length < 3 || frame[0] !== DELIMITER || frame[frame.length - 1] !== DELIMITER) {
    msg.type = 'invalido';
    msg.errors.push('la trama no está delimitada por 0x7E');
    return msg;
  }

  // Des-escapar ANTES de parsear: si no, un 0x7D02 dentro del cuerpo corre
  // todos los offsets y el checksum nunca cuadra.
  const { data, malformado } = unescape(frame.subarray(1, frame.length - 1));
  if (malformado) msg.errors.push('secuencia de escape 0x7D inválida en la trama');

  if (data.length < 13) {
    msg.type = 'invalido';
    msg.errors.push(`trama demasiado corta tras des-escapar (${data.length} bytes)`);
    return msg;
  }

  const checksumRecibido = data[data.length - 1];
  const cuerpoConCabecera = data.subarray(0, data.length - 1);
  const checksumCalculado = xorChecksum(cuerpoConCabecera);
  msg.checksumRecibido = checksumRecibido;
  msg.checksumCalculado = checksumCalculado;
  msg.checksumOk = checksumRecibido === checksumCalculado;
  if (!msg.checksumOk) {
    msg.errors.push(
      `checksum no coincide: recibido 0x${hex8(checksumRecibido)}, calculado 0x${hex8(checksumCalculado)}`,
    );
  }

  const h = new FieldReader(cuerpoConCabecera, 0);
  const msgId = h.field('msg_id', 2, (b) => b.readUInt16BE(0), 'identificador del mensaje');
  const attrs = h.field(
    'atributos',
    2,
    (b) => b.readUInt16BE(0),
    'bits 0-9 longitud del cuerpo, bit 10-12 cifrado, bit 13 sub-paquete, bit 14 versión 2019',
  );

  const bodyLength = attrs & 0x03ff;
  const esSubpaquete = (attrs & 0x2000) !== 0;
  const es2019 = (attrs & 0x4000) !== 0;
  const cifrado = (attrs >> 10) & 0x07;

  h.derived('longitud_cuerpo', bodyLength);
  h.derived('sub-paquete (bit 13)', esSubpaquete);
  h.derived('versión 2019 (bit 14)', es2019);
  if (cifrado !== 0) {
    msg.errors.push(`la trama declara cifrado (bits 10-12 = ${cifrado}); el cuerpo NO se interpreta`);
    msg.attributes.cifrado = cifrado;
  }

  if (es2019) {
    h.field('version_protocolo', 1, (b) => b[0]);
  }

  const terminalBytes = es2019 ? 10 : 6;
  const terminalId = h.field(
    'terminal_bcd',
    terminalBytes,
    (b) => {
      const digits = b.toString('hex');
      return digits.replace(/^0+/, '') || digits;
    },
    'BCD; se quitan los ceros de relleno a la izquierda. Suele ser el IMEI o sus últimos dígitos.',
  );
  msg.terminalId = terminalId;

  msg.serial = h.field('serial', 2, (b) => b.readUInt16BE(0));

  if (esSubpaquete) {
    msg.attributes.subpaquete = {
      total: h.field('paquetes_totales', 2, (b) => b.readUInt16BE(0)),
      indice: h.field('indice_paquete', 2, (b) => b.readUInt16BE(0)),
    };
  }

  const headerLen = h.consumed;
  const body = cuerpoConCabecera.subarray(headerLen);
  if (body.length !== bodyLength) {
    msg.errors.push(
      `la longitud declarada del cuerpo (${bodyLength}) no coincide con la real (${body.length})`,
    );
  }

  msg.msgId = msgId;
  msg.msgIdHex = `0x${msgId.toString(16).padStart(4, '0').toUpperCase()}`;

  const r = new FieldReader(body, headerLen);

  try {
    if (cifrado !== 0) {
      msg.type = 'cifrado';
      msg.attributes.unmapped = r.unmapped('Cuerpo cifrado: no se intenta interpretar.');
    } else {
      switch (msgId) {
        case MSG_REGISTER:
          decodeRegister(msg, r);
          break;
        case MSG_AUTH:
          decodeAuth(msg, r);
          break;
        case MSG_HEARTBEAT:
          msg.type = 'heartbeat';
          break;
        case MSG_LOGOUT:
          msg.type = 'logout';
          break;
        case MSG_LOCATION:
          msg.type = 'posicion';
          msg.position = decodeLocationBody(msg, r);
          break;
        case MSG_LOCATION_BATCH:
          decodeLocationBatch(msg, r);
          break;
        case MSG_TERMINAL_GENERAL_RESPONSE:
          msg.type = 'respuesta_terminal';
          if (r.has(5)) {
            msg.attributes.respuesta = {
              serial: r.field('serial_respondido', 2, (b) => b.readUInt16BE(0)),
              msg_id: r.field('msg_id_respondido', 2, (b) => `0x${b.toString('hex').toUpperCase()}`),
              resultado: r.field('resultado', 1, (b) => b[0]),
            };
          }
          break;
        default:
          msg.type = 'desconocido';
          msg.attributes.unmapped = r.unmapped(
            `TODO: mensaje ${msg.msgIdHex} no implementado. Cuerpo completo sin mapear.`,
          );
      }
    }
  } catch (err) {
    msg.errors.push(`error al decodificar: ${err.message}`);
    if (msg.position) msg.position.valid = false;
  }

  if (r.remaining > 0 && !msg.attributes.unmapped) {
    msg.attributes.unmapped = r.unmapped();
  }

  msg.fields = [...h.fields, ...r.fields];
  msg.reply = buildReply(msg);
  return msg;
}

// ── cuerpos ──────────────────────────────────────────────────────────────────

function decodeRegister(msg, r) {
  msg.type = 'registro';
  // provincia(2) + ciudad(2) + fabricante(5) son estables entre versiones.
  // El modelo mide 20 bytes en 2013 y 30 en 2019, y después vienen el id de
  // terminal, el color de placa y la placa. Como el tamaño depende del firmware,
  // NO partimos el resto: queda visible sin mapear.
  if (r.has(2)) msg.attributes.provincia = r.field('provincia', 2, (b) => b.readUInt16BE(0));
  if (r.has(2)) msg.attributes.ciudad = r.field('ciudad', 2, (b) => b.readUInt16BE(0));
  if (r.has(5)) {
    msg.attributes.fabricante = r.field('fabricante', 5, (b) => b.toString('ascii').replace(/\0+$/, '').trim());
  }
  if (r.remaining > 0) {
    msg.attributes.unmapped = r.unmapped(
      'TODO: resto del cuerpo de registro (modelo, id de terminal, color y número de placa). ' +
        'El tamaño del campo "modelo" cambia entre JT808-2013 (20 bytes) y 2019 (30 bytes); ' +
        'sin confirmar cuál usa este firmware no se parte.',
    );
  }
}

function decodeAuth(msg, r) {
  msg.type = 'autenticacion';
  if (r.remaining > 0) {
    msg.attributes.codigo_auth = r.field('codigo_auth', r.remaining, (b) =>
      b.toString('ascii').replace(/[^\x20-\x7e]/g, ''),
    );
  }
}

/**
 * Cuerpo de posición 0x0200:
 *   alarma(4) estado(4) lat(4) lon(4) altitud(2) velocidad(2) rumbo(2) tiempo BCD(6)
 *   + elementos adicionales TLV
 */
function decodeLocationBody(msg, r) {
  const alarma = r.field('alarma', 4, (b) => b.readUInt32BE(0), 'palabra de bits de alarma');
  const estado = r.field('estado', 4, (b) => b.readUInt32BE(0), 'bit0 ACC, bit1 posicionado, bit2 latitud sur, bit3 longitud oeste');

  const latRaw = r.field('latitud_cruda', 4, (b) => b.readUInt32BE(0), 'grados = valor / 1e6');
  const lonRaw = r.field('longitud_cruda', 4, (b) => b.readUInt32BE(0), 'grados = valor / 1e6');
  const altitude = r.field('altitud', 2, (b) => b.readUInt16BE(0), 'metros');
  const speedRaw = r.field('velocidad', 2, (b) => b.readUInt16BE(0), 'décimas de km/h');
  const course = r.field('rumbo', 2, (b) => b.readUInt16BE(0), 'grados, 0-359');
  const deviceTime = r.field('fecha_hora', 6, (b) => parseBcdDateUtc(b), 'BCD YYMMDDHHMMSS en UTC');

  const posicionado = (estado & 0x02) !== 0;
  const sur = (estado & 0x04) !== 0;
  const oeste = (estado & 0x08) !== 0;

  r.derived('acc (bit 0)', (estado & 0x01) !== 0);
  r.derived('posicionado (bit 1)', posicionado);
  r.derived('hemisferio (bit 2)', sur ? 'sur' : 'norte');
  r.derived('signo longitud (bit 3)', oeste ? 'oeste (negativa)' : 'este (positiva)');

  let latitude = latRaw / 1e6;
  let longitude = lonRaw / 1e6;
  if (sur) latitude = -latitude;
  if (oeste) longitude = -longitude;

  const alarmas = [];
  for (let bit = 0; bit < 32; bit++) {
    if ((alarma & (1 << bit)) !== 0) alarmas.push(ALARM_BITS[bit] ?? `bit_${bit}`);
  }
  if (alarmas.length > 0) {
    msg.attributes.alarmas = alarmas;
    msg.alarmType = alarmas[0];
  }
  msg.attributes.alarma_bits_crudos = `0x${alarma.toString(16).padStart(8, '0').toUpperCase()}`;
  msg.attributes.estado_bits_crudos = `0x${estado.toString(16).padStart(8, '0').toUpperCase()}`;
  msg.attributes.acc_encendido = (estado & 0x01) !== 0;

  const position = {
    latitude,
    longitude,
    speedKmh: speedRaw / 10,
    course: course <= 360 ? course : null,
    altitude,
    satellites: null, // llega, si acaso, en el TLV 0x31
    valid: posicionado,
    deviceTime,
  };

  if (course > 360) {
    msg.errors.push(`rumbo fuera de rango (${course}), se reporta como nulo`);
    msg.attributes.rumbo_crudo_fuera_de_rango = course;
  }

  // Mismas salvaguardas que en GT06: nada de coordenadas imposibles.
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    msg.errors.push(`coordenadas fuera de rango (lat ${latitude}, lon ${longitude}); se descartan`);
    msg.attributes.coordenadas_descartadas = { motivo: 'fuera_de_rango', latitude, longitude, latRaw, lonRaw };
    position.latitude = null;
    position.longitude = null;
    position.valid = false;
  } else if (latRaw === 0 && lonRaw === 0) {
    msg.attributes.coordenadas_descartadas = { motivo: 'lat_lon_en_cero_sin_fix', latRaw, lonRaw };
    position.latitude = null;
    position.longitude = null;
    position.valid = false;
  } else if (!posicionado) {
    msg.attributes.coordenadas_sin_fix = { latitude, longitude };
    position.latitude = null;
    position.longitude = null;
    position.valid = false;
  }

  if (deviceTime === null) msg.errors.push('fecha/hora BCD inválida; device_time queda nulo');

  decodeExtras(msg, r, position);
  return position;
}

/** Elementos adicionales TLV: id(1) + longitud(1) + valor. */
function decodeExtras(msg, r, position) {
  const extras = {};
  const desconocidos = [];

  while (r.remaining >= 2) {
    const id = r.field('extra_id', 1, (b) => b[0]);
    const len = r.field('extra_len', 1, (b) => b[0]);
    if (r.remaining < len) {
      msg.errors.push(`elemento adicional 0x${hex8(id)} declara ${len} bytes y solo quedan ${r.remaining}`);
      break;
    }
    const valor = r.field(`extra_0x${hex8(id)}`, len, (b) => b);

    switch (id) {
      case 0x01:
        if (len === 4) extras.kilometraje_km = valor.readUInt32BE(0) / 10;
        else desconocidos.push({ id: `0x${hex8(id)}`, hex: valor.toString('hex').toUpperCase(), nota: 'longitud inesperada para kilometraje' });
        break;
      case 0x02:
        if (len === 2) extras.combustible_l = valor.readUInt16BE(0) / 10;
        break;
      case 0x03:
        if (len === 2) extras.velocidad_tacometro_kmh = valor.readUInt16BE(0) / 10;
        break;
      case 0x04:
        if (len === 2) extras.id_evento_alarma = valor.readUInt16BE(0);
        break;
      case 0x30:
        if (len === 1) extras.gsm_signal = valor[0];
        break;
      case 0x31:
        if (len === 1) {
          extras.satelites = valor[0];
          position.satellites = valor[0];
        }
        break;
      default:
        // TODO: elementos adicionales propios del fabricante. Se guardan en
        // crudo para poder identificarlos desde el panel de depuración.
        desconocidos.push({ id: `0x${hex8(id)}`, len, hex: valor.toString('hex').toUpperCase() });
    }
  }

  if (Object.keys(extras).length > 0) msg.attributes.extras = extras;
  if (desconocidos.length > 0) {
    msg.attributes.unmapped = {
      nota: 'TODO: elementos adicionales TLV no reconocidos. Confirmar significado con la documentación del fabricante.',
      elementos: desconocidos,
    };
  }
}

/**
 * 0x0704 — subida masiva de posiciones. Es lo que manda el equipo cuando
 * recupera señal y vacía su búfer offline.
 *   cantidad(2) + tipo(1) + [ longitud(2) + cuerpo de 0x0200 ] * cantidad
 */
function decodeLocationBatch(msg, r) {
  msg.type = 'posiciones_lote';
  const cantidad = r.field('cantidad', 2, (b) => b.readUInt16BE(0));
  const tipo = r.field('tipo_lote', 1, (b) => b[0], '0 = posiciones normales, 1 = reenvío de zona ciega');
  msg.attributes.lote = { cantidad, tipo: tipo === 1 ? 'reenvio_zona_ciega' : 'normal' };

  const positions = [];
  for (let i = 0; i < cantidad && r.remaining >= 2; i++) {
    const len = r.field(`item_${i}_len`, 2, (b) => b.readUInt16BE(0));
    if (r.remaining < len) {
      msg.errors.push(`el elemento ${i} del lote declara ${len} bytes y solo quedan ${r.remaining}`);
      break;
    }
    const itemBytes = r.field(`item_${i}`, len, (b) => b);
    const sub = { errors: [], attributes: {}, protocol: 'jt808' };
    const sr = new FieldReader(itemBytes, 0);
    try {
      const pos = decodeLocationBody(sub, sr);
      positions.push({ position: pos, attributes: sub.attributes, errors: sub.errors });
    } catch (err) {
      msg.errors.push(`elemento ${i} del lote ilegible: ${err.message}`);
    }
  }
  msg.positions = positions;
  // La posición "principal" del mensaje es la más reciente del lote, si hay.
  if (positions.length > 0) msg.position = positions[positions.length - 1].position;
}

// ── respuestas ───────────────────────────────────────────────────────────────

/** Arma una trama JT808 lista para transmitir (con escape y delimitadores). */
export function buildFrame(msgId, terminalIdDigits, body, { serial = nextPlatformSerial(), terminalBytes = 6 } = {}) {
  const attrs = body.length & 0x03ff;
  const header = Buffer.alloc(4 + terminalBytes + 2);
  header.writeUInt16BE(msgId, 0);
  header.writeUInt16BE(attrs, 2);
  bcdEncode(terminalIdDigits, terminalBytes).copy(header, 4);
  header.writeUInt16BE(serial & 0xffff, 4 + terminalBytes);

  const sinChecksum = Buffer.concat([header, body]);
  const checksum = Buffer.from([xorChecksum(sinChecksum)]);
  return Buffer.concat([
    Buffer.from([DELIMITER]),
    escape(Buffer.concat([sinChecksum, checksum])),
    Buffer.from([DELIMITER]),
  ]);
}

/** 0x8001 — respuesta general de la plataforma. resultado 0 = correcto. */
export function buildGeneralResponse(terminalId, respondedSerial, respondedMsgId, resultado = 0, terminalBytes = 6) {
  const body = Buffer.alloc(5);
  body.writeUInt16BE(respondedSerial & 0xffff, 0);
  body.writeUInt16BE(respondedMsgId & 0xffff, 2);
  body[4] = resultado;
  return buildFrame(MSG_PLATFORM_GENERAL_RESPONSE, terminalId, body, { terminalBytes });
}

/** 0x8100 — respuesta al registro. Devuelve el código de autenticación. */
export function buildRegisterResponse(terminalId, respondedSerial, authCode, resultado = 0, terminalBytes = 6) {
  const auth = Buffer.from(authCode, 'ascii');
  const body = Buffer.alloc(3 + (resultado === 0 ? auth.length : 0));
  body.writeUInt16BE(respondedSerial & 0xffff, 0);
  body[2] = resultado;
  if (resultado === 0) auth.copy(body, 3);
  return buildFrame(MSG_REGISTER_RESPONSE, terminalId, body, { terminalBytes });
}

function buildReply(msg) {
  if (!msg.terminalId || msg.serial === undefined) return null;
  const terminalBytes = msg.fields.find((f) => f.nombre === 'terminal_bcd')?.len ?? 6;

  switch (msg.msgId) {
    case MSG_REGISTER:
      // El código de autenticación lo elige la plataforma; usamos el propio
      // identificador del terminal para que sea reproducible tras un reinicio.
      return buildRegisterResponse(msg.terminalId, msg.serial, msg.terminalId, 0, terminalBytes);
    case MSG_AUTH:
    case MSG_LOCATION:
    case MSG_LOCATION_BATCH:
    case MSG_HEARTBEAT:
    case MSG_LOGOUT:
      return buildGeneralResponse(msg.terminalId, msg.serial, msg.msgId, 0, terminalBytes);
    default:
      return null;
  }
}

// ── utilidades ───────────────────────────────────────────────────────────────

/** BCD YYMMDDHHMMSS -> Date UTC, o null si algún dígito no es válido. */
export function parseBcdDateUtc(b) {
  const n = [];
  for (let i = 0; i < 6; i++) {
    const hi = b[i] >> 4;
    const lo = b[i] & 0x0f;
    if (hi > 9 || lo > 9) return null; // no es BCD válido
    n.push(hi * 10 + lo);
  }
  const [yy, mm, dd, hh, mi, ss] = n;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  const d = new Date(Date.UTC(2000 + yy, mm - 1, dd, hh, mi, ss));
  if (d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
  return d;
}

export function bcdEncode(digits, bytes) {
  const padded = String(digits).padStart(bytes * 2, '0').slice(-bytes * 2);
  return Buffer.from(padded, 'hex');
}

function hex8(n) {
  return n.toString(16).padStart(2, '0').toUpperCase();
}
