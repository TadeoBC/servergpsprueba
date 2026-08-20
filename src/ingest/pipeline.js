import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  getOrCreateDevice, resolveDeviceByTerminalId, touchDevice, insertPosition,
  insertEvent, updateDeviceTelemetry, evaluateSpeedAlert,
  resolveDeviceCommand, getCurrentMovementState,
} from '../db/repo.js';
import { bus, recordPacket } from './bus.js';
import { normalizeBatteryReading } from '../tracking/battery.js';

/**
 * Toma una trama ya decodificada y la persiste:
 *   - resuelve/registra el equipo,
 *   - guarda posiciones (con anti-duplicado del búfer offline),
 *   - guarda eventos (login, alarma, tramas raras),
 *   - publica en el bus para el WebSocket.
 *
 * `session` es el estado de la conexión TCP: el GT06 solo manda el IMEI en el
 * login, así que las tramas siguientes se atribuyen al equipo de esa sesión.
 */
export async function processDecoded(decoded, session) {
  const imeiEnTrama = decoded.imei ?? decoded.terminalId ?? null;

  let device = null;
  if (imeiEnTrama) {
    device =
      decoded.protocol === 'jt808'
        ? await resolveDeviceByTerminalId(imeiEnTrama)
        : await getOrCreateDevice(imeiEnTrama);
    session.device = device;
    session.imei = device.imei;
  } else if (session.device) {
    device = session.device;
  }

  recordPacket(device?.imei ?? null, decoded);
  bus.emit('packet', { imei: device?.imei ?? null, decoded });

  if (!device) {
    // Trama sin IMEI y sin login previo: no se puede atribuir. Se registra el
    // hecho (sin contenido de cliente más allá del hex de la trama del equipo).
    logger.warn(
      { protocolo: decoded.protocol, tipo: decoded.type, ip: session.ip },
      'trama recibida antes del login: no se puede atribuir a ningún equipo',
    );
    await insertEvent({
      tipo: 'trama_sin_identificar',
      raw: {
        protocolo: decoded.protocol,
        tipo: decoded.type,
        raw_hex: config.storeRawHex ? decoded.rawHex : null,
        errores: decoded.errors,
      },
    }).catch((err) => logger.error({ err: err.message }, 'no se pudo guardar el evento sin identificar'));
    return { device: null, positions: [] };
  }

  const refreshedDevice = await touchDevice(device.id).catch((err) => {
    logger.error({ err: err.message, imei: device.imei }, 'no se pudo actualizar last_seen_at');
    return null;
  });
  // Además de la hora, esto refresca activo/archived_at para conexiones GT06
  // largas. Así un equipo recién archivado no reaparece en la interfaz al
  // mandar su siguiente posición, aunque conserve abierta la misma sesión TCP.
  if (refreshedDevice) {
    device = refreshedDevice;
    session.device = refreshedDevice;
  }

  const telemetryPatch = extractTelemetry(decoded, device.telemetry);
  if (Object.keys(telemetryPatch).length) {
    const state = await updateDeviceTelemetry(device.id, telemetryPatch).catch((err) => {
      logger.error({ err: err.message, imei: device.imei }, 'no se pudo actualizar la telemetría');
      return null;
    });
    if (state) bus.emit('telemetry', { device, telemetry: state.telemetry, updatedAt: state.telemetry_updated_at });
  }

  const guardadas = [];

  // Un 0x0704 de JT808 trae varias posiciones en una sola trama.
  const lote = Array.isArray(decoded.positions) && decoded.positions.length > 0 ? decoded.positions : null;

  if (lote) {
    for (const item of lote) {
      const fila = await savePosition(device, item.position, decoded, item.attributes);
      if (fila) guardadas.push(fila);
    }
  } else if (decoded.position) {
    const fila = await savePosition(device, decoded.position, decoded, decoded.attributes);
    if (fila) guardadas.push(fila);
  }

  // Eventos que valen la pena conservar aparte de la posición.
  if (decoded.type === 'login' || decoded.type === 'registro' || decoded.type === 'autenticacion') {
    await insertEvent({
      deviceId: device.id,
      tipo: decoded.type,
      raw: { protocolo: decoded.protocol, raw_hex: config.storeRawHex ? decoded.rawHex : null },
    }).catch((err) => logger.error({ err: err.message }, 'no se pudo guardar el evento de login'));
  }

  if (decoded.type === 'alarma' || (decoded.alarmType && decoded.alarmType !== 'normal')) {
    await insertEvent({
      deviceId: device.id,
      tipo: `alarma:${decoded.alarmType ?? 'desconocida'}`,
      positionId: guardadas[0]?.id ?? null,
      raw: {
        protocolo: decoded.protocol,
        attributes: decoded.attributes,
        raw_hex: config.storeRawHex ? decoded.rawHex : null,
      },
    }).catch((err) => logger.error({ err: err.message }, 'no se pudo guardar la alarma'));
    logger.warn({ imei: device.imei, alarma: decoded.alarmType }, 'alarma recibida del equipo');
    bus.emit('alert', {
      device,
      tipo: `alarma:${decoded.alarmType ?? 'desconocida'}`,
      position: guardadas[0] ?? null,
      data: { origen: 'tracker', attributes: decoded.attributes },
    });
  }

  if (decoded.type === 'texto' && decoded.attributes?.server_flag !== undefined) {
    const command = await resolveDeviceCommand(decoded.attributes.server_flag, decoded.attributes.texto ?? '')
      .catch((err) => { logger.error({ err: err.message }, 'no se pudo asociar la respuesta al comando'); return null; });
    if (command) {
      bus.emit('command', { device, command });
      await insertEvent({ deviceId: device.id, tipo: `comando:${command.status}`, raw: {
        command_id: command.id, command_type: command.command_type, response: command.response_text,
      }}).catch((err) => logger.error({ err: err.message }, 'no se pudo guardar respuesta de comando'));
    }
  }

  if (decoded.type === 'desconocido' || decoded.type === 'invalido') {
    await insertEvent({
      deviceId: device.id,
      tipo: `trama_${decoded.type}`,
      raw: {
        protocolo: decoded.protocol,
        raw_hex: config.storeRawHex ? decoded.rawHex : null,
        errores: decoded.errors,
        attributes: decoded.attributes,
      },
    }).catch((err) => logger.error({ err: err.message }, 'no se pudo guardar la trama desconocida'));
  }

  return { device, positions: guardadas };
}

async function savePosition(device, position, decoded, attributes) {
  if (!position) return null;

  const attrs = { ...(attributes ?? {}) };
  if (decoded.errors?.length) attrs.errores_decodificacion = decoded.errors;
  attrs.tipo_trama = decoded.type;
  if (decoded.protocolNumberHex) attrs.protocol_number = decoded.protocolNumberHex;
  if (decoded.msgIdHex) attrs.msg_id = decoded.msgIdHex;
  if (decoded.crcOk === false || decoded.checksumOk === false) attrs.crc_invalido = true;

  let fila;
  try {
    fila = await insertPosition({
      deviceId: device.id,
      latitude: position.latitude,
      longitude: position.longitude,
      speedKmh: position.speedKmh,
      course: position.course,
      altitude: position.altitude,
      satellites: position.satellites,
      valid: position.valid,
      deviceTime: position.deviceTime,
      rawHex: config.storeRawHex ? decoded.rawHex : null,
      protocol: decoded.protocol,
      attributes: attrs,
    });
  } catch (err) {
    logger.error({ err: err.message, imei: device.imei }, 'no se pudo guardar la posición');
    return null;
  }

  if (!fila) {
    // ON CONFLICT DO NOTHING: ya teníamos esa (device_id, device_time).
    // Pasa normalmente cuando el equipo reenvía su búfer offline.
    logger.debug(
      { imei: device.imei, device_time: position.deviceTime },
      'posición duplicada descartada (reenvío del búfer del equipo)',
    );
    return null;
  }

  Object.assign(fila, await getCurrentMovementState(device.id).catch((err) => {
    logger.error({ err: err.message, imei: device.imei }, 'no se pudo calcular el estado de movimiento');
    return { movement_state: 'moving', stopped_pulses: 0, stopped_since: null };
  }));

  logger.info(
    {
      imei: device.imei,
      lat: fila.latitude,
      lon: fila.longitude,
      vel: fila.speed_kmh,
      sat: fila.satellites,
      valida: fila.valid,
      protocolo: decoded.protocol,
    },
    'posición guardada',
  );

  bus.emit('position', { device, position: fila });

  const speedState = await evaluateSpeedAlert(device, fila).catch((err) => {
    logger.error({ err: err.message, imei: device.imei }, 'no se pudo evaluar el límite de velocidad');
    return null;
  });
  if (speedState?.entered) {
    const event = {
      deviceId: device.id, tipo: 'alerta:exceso_velocidad', positionId: fila.id,
      raw: { velocidad_kmh: fila.speed_kmh, limite_kmh: speedState.speed_limit_kmh },
    };
    await insertEvent(event).catch((err) => logger.error({ err: err.message }, 'no se pudo guardar la alerta de velocidad'));
    bus.emit('alert', { device, tipo: event.tipo, position: fila, data: event.raw });
  } else if (speedState?.cleared) {
    await insertEvent({ deviceId: device.id, tipo: 'alerta:velocidad_normalizada', positionId: fila.id,
      raw: { velocidad_kmh: fila.speed_kmh, limite_kmh: speedState.speed_limit_kmh } })
      .catch((err) => logger.error({ err: err.message }, 'no se pudo guardar el fin de alerta de velocidad'));
  }
  return fila;
}

function extractTelemetry(decoded, previousTelemetry = {}) {
  const a = decoded.attributes ?? {};
  const out = {};
  if (a.bateria) {
    const battery = normalizeBatteryReading(a.bateria, previousTelemetry?.bateria);
    // Bytes fuera de las escalas conocidas no reemplazan la última lectura
    // válida que ya está guardada para el dispositivo.
    if (battery) out.bateria = battery;
  }
  if (a.gsm_signal !== undefined) out.gsm_signal = a.gsm_signal;
  if (a.terminal) out.terminal = a.terminal;
  if (a.acc_encendido !== undefined) out.acc_encendido = a.acc_encendido;
  if (a.odometro) out.odometro = a.odometro;
  if (a.gps_fijado !== undefined) out.gps_fijado = a.gps_fijado;
  return out;
}
