import { crcItu } from './crc.js';
import { FieldReader } from './reader.js';

/**
 * Decoder GT06 / GT06N.
 *
 * Trama estándar:
 *   7878 | len(1) | protocolNumber(1) | payload | serial(2) | crc(2) | 0D0A
 * Variante extendida:
 *   7979 | len(2) | protocolNumber(1) | payload | serial(2) | crc(2) | 0D0A
 *
 * `len` cuenta protocolNumber + payload + serial + crc (todo lo que va entre
 * el campo de longitud y el 0D0A final).
 *
 * El CRC-ITU se calcula sobre el rango [campo de longitud .. serial] inclusive.
 */

export const START_7878 = 0x7878;
export const START_7979 = 0x7979;
export const STOP_BYTES = Buffer.from([0x0d, 0x0a]);

export const PROTOCOL_LOGIN = 0x01;
export const PROTOCOL_LOCATION = 0x12;
export const PROTOCOL_STATUS = 0x13; // heartbeat
export const PROTOCOL_STRING = 0x15;
export const PROTOCOL_ALARM = 0x16;
export const PROTOCOL_GPS_QUERY = 0x1a;
export const PROTOCOL_LOCATION_EXT = 0x22;
export const PROTOCOL_TIME_REQUEST = 0x8a;
export const PROTOCOL_INFO = 0x94;

// Alarmas documentadas en el protocolo GT06. Los códigos que no estén aquí se
// reportan como `desconocida_0xNN` en lugar de adivinarles nombre.
const ALARM_TYPES = {
  0x00: 'normal',
  0x01: 'sos',
  0x02: 'corte_energia',
  0x03: 'vibracion',
  0x04: 'entrada_geocerca',
  0x05: 'salida_geocerca',
  0x06: 'exceso_velocidad',
  0x09: 'desplazamiento',
  0x0a: 'entrada_zona_ciega_gps',
  0x0b: 'salida_zona_ciega_gps',
  0x0c: 'encendido',
  0x0d: 'primer_fix_gps',
  0x0e: 'bateria_baja_gps',
  0x0f: 'proteccion_bateria_baja',
  0x13: 'desmontaje',
};

// Nivel de voltaje reportado por el equipo (0..6). El porcentaje es una
// APROXIMACIÓN lineal para pintar la barra en la interfaz; el equipo no manda
// porcentaje real, por eso se expone también el nivel crudo.
const VOLTAGE_LEVELS = {
  0: 'sin_energia',
  1: 'extremadamente_bajo',
  2: 'muy_bajo',
  3: 'bajo',
  4: 'medio',
  5: 'alto',
  6: 'lleno',
};

/**
 * ¿Cuántos bytes mide la trama que empieza en buf[0]?
 * @returns {number} longitud total, 0 si aún faltan bytes, -1 si no es GT06.
 */
export function frameLength(buf) {
  if (buf.length < 2) return 0;
  const start = buf.readUInt16BE(0);
  if (start === START_7878) {
    if (buf.length < 3) return 0;
    const len = buf[2];
    // start(2) + len(1) + contenido(len) + stop(2)
    return 2 + 1 + len + 2;
  }
  if (start === START_7979) {
    if (buf.length < 4) return 0;
    const len = buf.readUInt16BE(2);
    return 2 + 2 + len + 2;
  }
  return -1;
}

/**
 * Parseo estructural de una trama completa. No interpreta el payload.
 * Devuelve siempre un objeto; `errors` lista lo que no cuadró.
 */
export function parseFrame(frame) {
  const errors = [];
  const start = frame.readUInt16BE(0);
  const extended = start === START_7979;
  const lenSize = extended ? 2 : 1;
  const declaredLen = extended ? frame.readUInt16BE(2) : frame[2];

  const contentStart = 2 + lenSize;
  const contentEnd = contentStart + declaredLen;
  const crcStart = contentEnd - 2;
  const serialStart = crcStart - 2;
  const payloadStart = contentStart + 1;

  if (contentEnd + 2 > frame.length) {
    errors.push('la longitud declarada excede el tamaño de la trama');
    return { ok: false, errors, extended, declaredLen, rawHex: frame.toString('hex').toUpperCase() };
  }
  if (payloadStart > serialStart) {
    errors.push('longitud declarada demasiado corta para contener serial y crc');
    return { ok: false, errors, extended, declaredLen, rawHex: frame.toString('hex').toUpperCase() };
  }

  const stop = frame.subarray(contentEnd, contentEnd + 2);
  if (!stop.equals(STOP_BYTES)) errors.push(`terminador inesperado 0x${stop.toString('hex')} (se esperaba 0D0A)`);

  const protocolNumber = frame[contentStart];
  const payload = frame.subarray(payloadStart, serialStart);
  const serialBuf = frame.subarray(serialStart, crcStart);
  const crcRecibido = frame.readUInt16BE(crcStart);

  // CRC sobre [campo de longitud .. serial] inclusive.
  const crcCalculado = crcItu(frame.subarray(2, crcStart));
  const crcOk = crcRecibido === crcCalculado;
  if (!crcOk) errors.push(`CRC no coincide: recibido 0x${hex16(crcRecibido)}, calculado 0x${hex16(crcCalculado)}`);

  return {
    ok: true,
    extended,
    declaredLen,
    protocolNumber,
    payload,
    payloadOffset: payloadStart,
    serialBuf,
    serial: serialBuf.readUInt16BE(0),
    crcRecibido,
    crcCalculado,
    crcOk,
    errors,
    rawHex: frame.toString('hex').toUpperCase(),
  };
}

/**
 * Decodifica una trama GT06 completa a la forma normalizada que consume el
 * pipeline de ingesta.
 */
export function decode(frame) {
  const parsed = parseFrame(frame);
  const base = {
    protocol: 'gt06',
    rawHex: parsed.rawHex,
    crcOk: parsed.crcOk === true,
    crcRecibido: parsed.crcRecibido ?? null,
    crcCalculado: parsed.crcCalculado ?? null,
    errors: parsed.errors ?? [],
    fields: [],
    attributes: {},
    reply: null,
  };

  if (!parsed.ok) {
    return { ...base, type: 'invalido', protocolNumber: null, serial: null };
  }

  const msg = {
    ...base,
    protocolNumber: parsed.protocolNumber,
    protocolNumberHex: `0x${parsed.protocolNumber.toString(16).padStart(2, '0').toUpperCase()}`,
    serial: parsed.serial,
    type: 'desconocido',
  };

  const r = new FieldReader(parsed.payload, parsed.payloadOffset);

  try {
    switch (parsed.protocolNumber) {
      case PROTOCOL_LOGIN:
        decodeLogin(msg, r);
        break;
      case PROTOCOL_LOCATION:
      case PROTOCOL_LOCATION_EXT:
        decodeLocation(msg, r, parsed.protocolNumber);
        break;
      case PROTOCOL_STATUS:
        decodeStatus(msg, r);
        break;
      case PROTOCOL_ALARM:
        decodeAlarm(msg, r);
        break;
      case PROTOCOL_TIME_REQUEST:
        msg.type = 'solicitud_hora';
        r.unmapped('El equipo pide la hora del servidor; esta trama normalmente no trae payload.');
        break;
      case PROTOCOL_STRING:
        msg.type = 'texto';
        decodeString(msg, r);
        break;
      default:
        msg.type = 'desconocido';
        msg.attributes.unmapped = r.unmapped(
          `TODO: protocolNumber ${msg.protocolNumberHex} no implementado. Payload completo sin mapear.`,
        );
        break;
    }
  } catch (err) {
    // Un payload más corto de lo esperado no debe tumbar la ingesta: guardamos
    // lo que se alcanzó a leer y el resto queda como error visible.
    msg.errors.push(`error al decodificar: ${err.message}`);
    if (msg.position) msg.position.valid = false;
  }

  msg.fields = r.fields;
  msg.reply = buildReply(msg, parsed);
  return msg;
}

// ── decoders por tipo ────────────────────────────────────────────────────────

function decodeLogin(msg, r) {
  msg.type = 'login';
  // Terminal ID: 8 bytes BCD = 16 dígitos. El IMEI tiene 15, así que el primer
  // nibble viene en cero como relleno.
  msg.imei = r.field('terminal_id_bcd', 8, (b) => {
    let digits = b.toString('hex');
    while (digits.length > 15 && digits.startsWith('0')) digits = digits.slice(1);
    return digits;
  }, 'BCD de 8 bytes; se quita el relleno de ceros a la izquierda para dejar 15 dígitos de IMEI');

  // Algunas variantes agregan "type identification code" (2) y zona horaria /
  // idioma (2). No los damos por hecho: si vienen, quedan sin mapear.
  if (r.remaining > 0) {
    msg.attributes.unmapped = r.unmapped(
      'TODO: bytes extra en el login (algunas variantes traen type identification code y timezone/language). ' +
        'Confirmar contra la documentación del firmware antes de usarlos.',
    );
  }
}

function decodeStatus(msg, r) {
  msg.type = 'heartbeat';
  // Paquete de estado GT06: terminal info(1) + nivel de voltaje(1) +
  // señal GSM(1) + alarma/idioma(2).
  if (r.has(1)) readTerminalInfo(msg, r);
  if (r.has(1)) readVoltageLevel(msg, r);
  if (r.has(1)) readGsmSignal(msg, r);
  if (r.has(2)) readAlarmLanguage(msg, r);
  if (r.remaining > 0) msg.attributes.unmapped = r.unmapped();
}

function decodeLocation(msg, r, protocolNumber) {
  msg.type = 'posicion';
  msg.position = readGpsBlock(msg, r);
  readLbs(msg, r);

  if (r.remaining > 0) {
    // El 0x22 documenta más campos después del LBS (ACC, modo de subida,
    // reenvío en tiempo real, kilometraje), pero el orden y el tamaño varían
    // entre firmwares. Preferimos dejarlos visibles sin mapear a inventar un
    // offset y sacar un kilometraje absurdo.
    const nota =
      protocolNumber === PROTOCOL_LOCATION_EXT
        ? 'TODO: bytes posteriores al LBS en el paquete 0x22. Candidatos según la documentación GT06N: ' +
          'ACC(1), modo de subida de datos(1), reenvío en tiempo real/histórico(1), kilometraje(4). ' +
          'Sin confirmar contra este firmware — NO se interpretan.'
        : undefined;
    msg.attributes.unmapped = r.unmapped(nota);
  }
}

function decodeAlarm(msg, r) {
  msg.type = 'alarma';
  msg.position = readGpsBlock(msg, r);
  readLbs(msg, r);
  if (r.has(1)) readTerminalInfo(msg, r);
  if (r.has(1)) readVoltageLevel(msg, r);
  if (r.has(1)) readGsmSignal(msg, r);
  if (r.has(2)) readAlarmLanguage(msg, r);
  if (r.remaining > 0) msg.attributes.unmapped = r.unmapped();
}

function decodeString(msg, r) {
  // Longitud del comando(1) + flag del servidor(4) + contenido ASCII.
  if (r.has(1)) {
    const len = r.field('longitud_comando', 1, (b) => b[0]);
    if (r.has(4)) r.field('flag_servidor', 4, (b) => b.toString('hex').toUpperCase());
    const contentLen = Math.max(0, Math.min(len - 4, r.remaining));
    if (contentLen > 0) {
      msg.attributes.texto = r.field('contenido', contentLen, (b) => b.toString('ascii').replace(/\0+$/, ''));
    }
  }
  if (r.remaining > 0) msg.attributes.unmapped = r.unmapped();
}

// ── bloques compartidos ──────────────────────────────────────────────────────

/**
 * Bloque GPS común a 0x12, 0x16 y 0x22:
 *   fecha(6) + [largo info GPS | satélites](1) + lat(4) + lon(4) + vel(1) + flags(2)
 */
function readGpsBlock(msg, r) {
  const deviceTime = r.field(
    'fecha_hora',
    6,
    (b) => parseDateTimeUtc(b),
    'YY MM DD HH MM SS. El equipo está configurado con UTC:ON, así que estos bytes YA vienen en UTC ' +
      'y su TimeZone se ignora deliberadamente.',
  );

  const satellites = r.field(
    'satelites',
    1,
    (b) => b[0] & 0x0f,
    'Nibble alto = longitud de la información GPS, nibble bajo = satélites en uso',
  );

  const latRaw = r.field('latitud_cruda', 4, (b) => b.readUInt32BE(0), 'uint32 big-endian; grados = valor / 1800000');
  const lonRaw = r.field('longitud_cruda', 4, (b) => b.readUInt32BE(0), 'uint32 big-endian; grados = valor / 1800000');
  const speedKmh = r.field('velocidad', 1, (b) => b[0], 'km/h en 1 byte (0..255)');

  const flags = r.field(
    'rumbo_estado',
    2,
    (b) => b.readUInt16BE(0),
    'bits 0-9 rumbo en grados; bit 10 hemisferio; bit 11 signo de longitud (invertido); bit 12 GPS fijado',
  );

  const gpsFijado = (flags & 0x1000) !== 0; // bit 12
  const bit10 = (flags & 0x0400) !== 0;
  const bit11 = (flags & 0x0800) !== 0;

  // Signo de las coordenadas.
  //   bit 10 APAGADO  -> hemisferio sur    -> latitud negativa
  //   bit 11 ENCENDIDO -> longitud negativa (oeste)
  // El bit 11 va al revés de lo que sugiere su nombre en la documentación:
  // encendido significa oeste, no este. Para San Juan del Río se esperan
  // bit10 = 1 (norte) y bit11 = 1 (oeste, longitud negativa).
  const hemisferio = bit10 ? 'norte' : 'sur';
  const signoLongitud = bit11 ? 'oeste (negativa)' : 'este (positiva)';
  r.derived('hemisferio (bit 10)', hemisferio);
  r.derived('signo longitud (bit 11)', signoLongitud);
  r.derived('gps fijado (bit 12)', gpsFijado);

  let latitude = latRaw / 1800000.0;
  let longitude = lonRaw / 1800000.0;
  if (!bit10) latitude = -latitude;
  if (bit11) longitude = -longitude;

  const cursoCrudo = flags & 0x03ff;
  // El rumbo vive en 10 bits (0..1023) pero solo 0..360 tiene sentido. Si sale
  // fuera de rango preferimos no reportarlo antes que pintar una flecha al azar.
  const course = cursoCrudo <= 360 ? cursoCrudo : null;
  if (course === null) {
    msg.errors.push(`rumbo fuera de rango (${cursoCrudo}), se reporta como nulo`);
    msg.attributes.rumbo_crudo_fuera_de_rango = cursoCrudo;
  }

  const position = {
    latitude,
    longitude,
    speedKmh,
    course,
    altitude: null, // GT06 no reporta altitud en estos paquetes
    satellites,
    valid: gpsFijado,
    deviceTime,
  };

  msg.attributes.flags_rumbo_estado = `0x${hex16(flags)}`;
  msg.attributes.gps_fijado = gpsFijado;

  // Salvaguardas: nada de motos en el océano.
  const fueraDeRango = Math.abs(latitude) > 90 || Math.abs(longitude) > 180;
  const enCeroAbsoluto = latRaw === 0 && lonRaw === 0;

  if (fueraDeRango) {
    msg.errors.push(
      `coordenadas fuera de rango (lat ${latitude}, lon ${longitude}); se descartan y quedan solo en attributes`,
    );
    msg.attributes.coordenadas_descartadas = { motivo: 'fuera_de_rango', latitude, longitude, latRaw, lonRaw };
    position.latitude = null;
    position.longitude = null;
    position.valid = false;
  } else if (enCeroAbsoluto) {
    // 0,0 es el Golfo de Guinea: es el valor típico de un equipo sin fix.
    msg.attributes.coordenadas_descartadas = { motivo: 'lat_lon_en_cero_sin_fix', latRaw, lonRaw };
    position.latitude = null;
    position.longitude = null;
    position.valid = false;
  } else if (!gpsFijado) {
    // Sin fix guardamos el renglón (con raw_hex) pero sin punto en el mapa.
    msg.attributes.coordenadas_sin_fix = { latitude, longitude };
    position.latitude = null;
    position.longitude = null;
    position.valid = false;
  }

  if (deviceTime === null) {
    msg.errors.push('la fecha/hora de la trama no es válida; se guarda device_time nulo');
  }

  return position;
}

/** LBS: MCC(2) + MNC(1) + LAC(2) + CellID(3). */
function readLbs(msg, r) {
  if (r.remaining < 8) return;
  const lbs = {
    mcc: r.field('mcc', 2, (b) => b.readUInt16BE(0)),
    mnc: r.field('mnc', 1, (b) => b[0]),
    lac: r.field('lac', 2, (b) => b.readUInt16BE(0)),
    cell_id: r.field('cell_id', 3, (b) => b.readUIntBE(0, 3)),
  };
  msg.attributes.lbs = lbs;
}

function readTerminalInfo(msg, r) {
  const info = r.field('terminal_info', 1, (b) => b[0], 'bit0 defensa activada, bit1 ACC, bit2 cargando, bits3-5 estado de alarma, bit6 GPS fijado, bit7 aceite/electricidad cortados');
  msg.attributes.terminal = {
    defensa_activada: (info & 0x01) !== 0,
    acc_encendido: (info & 0x02) !== 0,
    cargando: (info & 0x04) !== 0,
    gps_fijado: (info & 0x40) !== 0,
    corte_aceite_electricidad: (info & 0x80) !== 0,
    estado_alarma_bits: (info >> 3) & 0x07,
    byte_crudo: `0x${info.toString(16).padStart(2, '0').toUpperCase()}`,
  };
}

function readVoltageLevel(msg, r) {
  const nivel = r.field('nivel_voltaje', 1, (b) => b[0], '0=sin energía … 6=lleno. No es un porcentaje real.');
  msg.attributes.bateria = {
    nivel: nivel,
    etiqueta: VOLTAGE_LEVELS[nivel] ?? `desconocido_${nivel}`,
    // Aproximación lineal solo para pintar la barra en la interfaz.
    porcentaje_aprox: nivel >= 0 && nivel <= 6 ? Math.round((nivel / 6) * 100) : null,
  };
}

function readGsmSignal(msg, r) {
  const s = r.field('senal_gsm', 1, (b) => b[0], '0=sin señal, 1=muy débil, 2=débil, 3=buena, 4=fuerte');
  msg.attributes.gsm_signal = s;
}

function readAlarmLanguage(msg, r) {
  const w = r.field('alarma_idioma', 2, (b) => b.readUInt16BE(0), 'byte alto = tipo de alarma, byte bajo = idioma');
  const code = (w >> 8) & 0xff;
  msg.attributes.alarma = {
    codigo: `0x${code.toString(16).padStart(2, '0').toUpperCase()}`,
    tipo: ALARM_TYPES[code] ?? `desconocida_0x${code.toString(16).padStart(2, '0').toUpperCase()}`,
  };
  msg.alarmType = msg.attributes.alarma.tipo;
}

// ── respuestas ───────────────────────────────────────────────────────────────

/**
 * ACK genérico: 7878 05 <protocolNumber> <serial copiado> <crc> 0D0A
 * El 05 es la longitud: protocolNumber(1) + serial(2) + crc(2).
 */
export function buildAck(protocolNumber, serialBuf) {
  const contenido = Buffer.concat([Buffer.from([0x05, protocolNumber]), serialBuf]);
  const crc = crcItu(contenido);
  return Buffer.concat([
    Buffer.from([0x78, 0x78]),
    contenido,
    Buffer.from([(crc >> 8) & 0xff, crc & 0xff]),
    STOP_BYTES,
  ]);
}

/**
 * Respuesta a la solicitud de hora (0x8A): se devuelve la hora UTC actual.
 *   7878 0B 8A YY MM DD HH MM SS <serial> <crc> 0D0A
 */
export function buildTimeResponse(serialBuf, date = new Date()) {
  const fecha = Buffer.from([
    date.getUTCFullYear() % 100,
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ]);
  const contenido = Buffer.concat([Buffer.from([0x0b, PROTOCOL_TIME_REQUEST]), fecha, serialBuf]);
  const crc = crcItu(contenido);
  return Buffer.concat([
    Buffer.from([0x78, 0x78]),
    contenido,
    Buffer.from([(crc >> 8) & 0xff, crc & 0xff]),
    STOP_BYTES,
  ]);
}

function buildReply(msg, parsed) {
  switch (parsed.protocolNumber) {
    // El login DEBE contestarse: si no, el equipo entra en bucle de reconexión.
    case PROTOCOL_LOGIN:
    case PROTOCOL_STATUS:
    case PROTOCOL_ALARM:
      return buildAck(parsed.protocolNumber, parsed.serialBuf);
    case PROTOCOL_TIME_REQUEST:
      return buildTimeResponse(parsed.serialBuf);
    default:
      // Los paquetes de posición del GT06 no llevan ACK.
      return null;
  }
}

// ── utilidades ───────────────────────────────────────────────────────────────

/**
 * YY MM DD HH MM SS -> Date en UTC. Devuelve null si algún campo está fuera de
 * rango, en vez de producir una fecha imposible.
 */
export function parseDateTimeUtc(b) {
  const [yy, mm, dd, hh, mi, ss] = [b[0], b[1], b[2], b[3], b[4], b[5]];
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 59) return null;
  const d = new Date(Date.UTC(2000 + yy, mm - 1, dd, hh, mi, ss));
  // Rechaza fechas como el 31 de febrero, que Date.UTC "corrige" en silencio.
  if (d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) return null;
  return d;
}

/** Arma una trama GT06 completa. Se usa en el simulador y en los tests. */
export function encodeFrame(protocolNumber, payload = Buffer.alloc(0), serial = 1) {
  const len = 1 + payload.length + 2 + 2;
  if (len > 0xff) throw new Error('payload demasiado grande para una trama 0x7878');
  const serialBuf = Buffer.alloc(2);
  serialBuf.writeUInt16BE(serial & 0xffff, 0);
  const contenido = Buffer.concat([Buffer.from([len, protocolNumber]), payload, serialBuf]);
  const crc = crcItu(contenido);
  return Buffer.concat([
    Buffer.from([0x78, 0x78]),
    contenido,
    Buffer.from([(crc >> 8) & 0xff, crc & 0xff]),
    STOP_BYTES,
  ]);
}

function hex16(n) {
  return n.toString(16).padStart(4, '0').toUpperCase();
}
