import { EventEmitter } from 'node:events';

/**
 * Bus interno de eventos. Desacopla la ingesta TCP del WebSocket: el pipeline
 * publica y el servidor web reparte, sin que uno conozca al otro.
 *
 * Eventos:
 *   'position' -> { device, position }   posición nueva guardada
 *   'packet'   -> { imei, decoded }      cualquier trama decodificada (depuración)
 *   'device'   -> { device }             alta o cambio de estado de un equipo
 */
export const bus = new EventEmitter();
bus.setMaxListeners(50);

/**
 * Anillo con las últimas tramas decodificadas por equipo. Es lo que alimenta el
 * panel de depuración: hex crudo + decodificación campo por campo.
 * Vive solo en memoria (se pierde al reiniciar); el histórico permanente está
 * en positions.raw_hex.
 */
const MAX_POR_EQUIPO = 20;
const ultimosPaquetes = new Map(); // imei -> array

export function recordPacket(imei, decoded) {
  const clave = imei ?? 'sin_identificar';
  let lista = ultimosPaquetes.get(clave);
  if (!lista) {
    lista = [];
    ultimosPaquetes.set(clave, lista);
  }
  lista.unshift({
    recibido_en: new Date().toISOString(),
    protocolo: decoded.protocol,
    tipo: decoded.type,
    raw_hex: decoded.rawHex,
    crc_ok: decoded.crcOk ?? decoded.checksumOk ?? null,
    errores: decoded.errors ?? [],
    campos: decoded.fields ?? [],
    attributes: decoded.attributes ?? {},
  });
  if (lista.length > MAX_POR_EQUIPO) lista.length = MAX_POR_EQUIPO;

  // Evita que el Map crezca sin límite si nos barren el puerto con basura.
  if (ultimosPaquetes.size > 200) {
    const primera = ultimosPaquetes.keys().next().value;
    if (primera !== clave) ultimosPaquetes.delete(primera);
  }
}

export function getPackets(imei) {
  return ultimosPaquetes.get(imei) ?? [];
}

export function getUnidentifiedPackets() {
  return ultimosPaquetes.get('sin_identificar') ?? [];
}
