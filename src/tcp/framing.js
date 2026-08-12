import * as gt06 from '../protocols/gt06.js';
import * as jt808 from '../protocols/jt808.js';
import * as gps103 from '../protocols/gps103.js';

/**
 * Acumulador de bytes POR SOCKET.
 *
 * Un chunk de TCP NO equivale a un paquete: puede llegar media trama, o dos
 * pegadas, o una y media. Esta clase guarda el remanente entre chunks y solo
 * entrega tramas completas.
 *
 * También decide el protocolo por el primer byte, sin asumir cuál habla el
 * equipo:
 *   0x78 / 0x79  -> GT06
 *   0x7E         -> JT808
 *   "imei:" "##" -> GPS103
 *   "GET " "POST " "HEAD " -> escáner HTTP: se rechaza la conexión y su
 *                             contenido NUNCA se escribe al log.
 */

const HTTP_PREFIXES = ['GET ', 'POST ', 'HEAD '];
const HTTP_MAX_PREFIX = Math.max(...HTTP_PREFIXES.map((p) => p.length));

export const PROTOCOLS = { GT06: 'gt06', JT808: 'jt808', GPS103: 'gps103' };

export class FrameAccumulator {
  constructor({ maxBufferBytes = 65536 } = {}) {
    this.buffer = Buffer.alloc(0);
    this.maxBufferBytes = maxBufferBytes;
    /** Protocolo detectado en la primera trama de la conexión. */
    this.protocol = null;
    this.rejected = null;
    this.bytesDescartados = 0;
  }

  /**
   * Alimenta un chunk y devuelve lo que se pudo extraer.
   * @returns {{frames: Array, reject: string|null, notices: string[]}}
   *   frames[i] = { protocol, buffer, text? }
   *   reject    = motivo por el que hay que cerrar la conexión (o null)
   *   notices   = avisos seguros de loguear (nunca contienen datos del cliente)
   */
  push(chunk) {
    const notices = [];
    if (this.rejected) return { frames: [], reject: this.rejected, notices };

    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    // 1. Escáneres HTTP / navegadores. Se corta ANTES de tocar el contenido.
    const http = this.#detectHttp();
    if (http) {
      this.rejected = http;
      // A propósito: no se registra ni un byte del contenido. Un navegador
      // puede mandar cookies de sesión en texto plano en los encabezados.
      this.buffer = Buffer.alloc(0);
      return { frames: [], reject: http, notices };
    }

    if (this.buffer.length > this.maxBufferBytes) {
      this.rejected = `búfer excedido (${this.buffer.length} > ${this.maxBufferBytes} bytes) sin una trama válida`;
      this.buffer = Buffer.alloc(0);
      return { frames: [], reject: this.rejected, notices };
    }

    const frames = [];
    for (;;) {
      const antes = this.buffer.length;
      const frame = this.#extractOne(notices);
      if (!frame) break;
      if (frame === 'wait') break;
      frames.push(frame);
      if (this.buffer.length === antes) break; // seguro contra bucle infinito
    }

    return { frames, reject: null, notices };
  }

  #detectHttp() {
    if (this.buffer.length < 4) return null;
    const head = this.buffer.subarray(0, HTTP_MAX_PREFIX).toString('latin1');
    for (const prefix of HTTP_PREFIXES) {
      if (head.startsWith(prefix)) return `petición HTTP (${prefix.trim()}) en el puerto de ingesta`;
    }
    return null;
  }

  /** @returns {object|'wait'|null} una trama, 'wait' si faltan bytes, null si no hay nada */
  #extractOne(notices) {
    if (this.buffer.length === 0) return null;

    // Resincronización: descarta bytes hasta encontrar un inicio conocido.
    const start = this.#findStart();
    if (start === -1) {
      // Nada reconocible todavía. Conservamos una cola pequeña por si el inicio
      // viene partido entre dos chunks.
      const conservar = Math.min(this.buffer.length, 8);
      const descartar = this.buffer.length - conservar;
      if (descartar > 0) {
        this.bytesDescartados += descartar;
        this.buffer = this.buffer.subarray(descartar);
        notices.push(`descartados ${descartar} byte(s) sin cabecera reconocible`);
      }
      return 'wait';
    }
    if (start > 0) {
      this.bytesDescartados += start;
      this.buffer = this.buffer.subarray(start);
      notices.push(`resincronizado: descartados ${start} byte(s) previos a una cabecera válida`);
    }

    const b0 = this.buffer[0];

    if (b0 === 0x78 || b0 === 0x79) {
      const total = gt06.frameLength(this.buffer);
      if (total === 0) return 'wait';
      if (total < 0) {
        // 0x78 suelto que no formaba cabecera: lo tiramos y seguimos.
        this.buffer = this.buffer.subarray(1);
        this.bytesDescartados += 1;
        return 'wait';
      }
      if (total > this.maxBufferBytes) {
        this.buffer = this.buffer.subarray(2);
        notices.push('trama GT06 con longitud declarada absurda; se descarta la cabecera');
        return 'wait';
      }
      if (this.buffer.length < total) return 'wait';
      const frame = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);
      this.#markProtocol(PROTOCOLS.GT06);
      return { protocol: PROTOCOLS.GT06, buffer: Buffer.from(frame) };
    }

    if (b0 === jt808.DELIMITER) {
      const found = jt808.findFrame(this.buffer);
      if (!found) return 'wait';
      const frame = this.buffer.subarray(found.start, found.end + 1);
      this.buffer = this.buffer.subarray(found.end + 1);
      this.#markProtocol(PROTOCOLS.JT808);
      return { protocol: PROTOCOLS.JT808, buffer: Buffer.from(frame) };
    }

    // GPS103: texto terminado en ';'
    const idx = this.buffer.indexOf(0x3b); // ';'
    if (idx === -1) return 'wait';
    const frame = this.buffer.subarray(0, idx + 1);
    this.buffer = this.buffer.subarray(idx + 1);
    this.#markProtocol(PROTOCOLS.GPS103);
    return {
      protocol: PROTOCOLS.GPS103,
      buffer: Buffer.from(frame),
      text: frame.toString('ascii').trim(),
    };
  }

  /** Índice del primer byte que puede iniciar una trama, o -1. */
  #findStart() {
    for (let i = 0; i < this.buffer.length; i++) {
      const b = this.buffer[i];
      if (b === 0x78 || b === 0x79 || b === jt808.DELIMITER) return i;
      // "imei:" o "##,imei:"
      if (b === 0x69 /* i */ || b === 0x23 /* # */) {
        const head = this.buffer.subarray(i, i + 5).toString('latin1');
        if (head.startsWith('imei:') || head.startsWith('##')) return i;
        if (this.buffer.length - i < 5) return i; // puede completarse luego
      }
    }
    return -1;
  }

  #markProtocol(p) {
    if (this.protocol === null) this.protocol = p;
  }
}

/** Decodifica una trama ya extraída con el decoder que le toca. */
export function decodeFrame(frame) {
  switch (frame.protocol) {
    case PROTOCOLS.GT06:
      return gt06.decode(frame.buffer);
    case PROTOCOLS.JT808:
      return jt808.decode(frame.buffer);
    case PROTOCOLS.GPS103:
      return gps103.decode(frame.text ?? frame.buffer.toString('ascii'), frame.buffer);
    default:
      return {
        protocol: 'desconocido',
        type: 'invalido',
        errors: [`protocolo sin decoder: ${frame.protocol}`],
        fields: [],
        attributes: {},
        rawHex: frame.buffer.toString('hex').toUpperCase(),
        reply: null,
      };
  }
}
