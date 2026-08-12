const ALARM_MODES = new Set([0, 1, 2, 3]);

export function buildAllowedCommand(type, params = {}) {
  switch (type) {
    case 'set_interval': {
      const seconds = integer(params.seconds, 5, 18000, 'seconds');
      return { type, text: `TIMER,${seconds}#`, settings: { reportIntervalSeconds: seconds } };
    }
    case 'set_heartbeat': {
      const minutes = integer(params.minutes, 1, 1440, 'minutes');
      return { type, text: `HBT,${minutes}#` };
    }
    case 'query_parameters':
      return { type, text: 'PARAM#' };
    case 'query_status':
      return { type, text: 'STATUS#' };
    case 'vibration_alarm':
      return alarmCommand(type, 'SENALM', params);
    case 'low_battery_alarm':
      return alarmCommand(type, 'BATALM', params);
    default:
      throw new CommandValidationError('tipo de comando no permitido');
  }
}

function alarmCommand(type, prefix, params) {
  if (typeof params.enabled !== 'boolean') throw new CommandValidationError('enabled debe ser booleano');
  if (!params.enabled) return { type, text: `${prefix},OFF#` };
  const mode = integer(params.mode ?? 0, 0, 3, 'mode');
  if (!ALARM_MODES.has(mode)) throw new CommandValidationError('modo de alarma inválido');
  return { type, text: `${prefix},ON,${mode}#` };
}

function integer(value, min, max, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new CommandValidationError(`${name} debe ser entero entre ${min} y ${max}`);
  }
  return n;
}

export class CommandValidationError extends Error {}

export const COMMAND_CATALOG = Object.freeze({
  set_interval: { description: 'Intervalo GPS en movimiento', range: '5-18000 segundos' },
  set_heartbeat: { description: 'Intervalo de heartbeat', range: '1-1440 minutos' },
  query_parameters: { description: 'Consultar parámetros' },
  query_status: { description: 'Consultar estado' },
  vibration_alarm: { description: 'Activar/desactivar alarma de vibración', modes: [0, 1, 2, 3] },
  low_battery_alarm: { description: 'Activar/desactivar alarma de batería baja', modes: [0, 1, 2, 3] },
});

