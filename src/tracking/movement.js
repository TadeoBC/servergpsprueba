import { distanceMeters } from './map-match.js';

export const STOP_RADIUS_METERS = 15;
export const STOP_MIN_PULSES = 3;

function usable(point) {
  return point?.valid !== false && point?.latitude !== null && point?.latitude !== undefined &&
    point?.longitude !== null && point?.longitude !== undefined && Number.isFinite(Number(point.latitude)) &&
    Number.isFinite(Number(point.longitude));
}

/**
 * Marca como "stopped" una secuencia de tres o más pulsos consecutivos que
 * permanece dentro de 15 m del primer punto. La tolerancia absorbe el ruido
 * normal del GPS cuando el vehículo está estacionado.
 *
 * El cálculo es derivado y no altera las filas recibidas.
 */
export function annotateMovementStates(positions, {
  radiusMeters = STOP_RADIUS_METERS,
  minPulses = STOP_MIN_PULSES,
} = {}) {
  const result = positions.map((point) => ({
    ...point,
    movement_state: 'moving',
    stopped_pulses: 0,
    stopped_since: null,
  }));

  let clusterStart = 0;
  for (let index = 0; index < result.length; index++) {
    const point = result[index];
    if (!usable(point)) {
      clusterStart = index + 1;
      continue;
    }

    const anchor = result[clusterStart];
    if (!usable(anchor) || distanceMeters(anchor, point) > radiusMeters) clusterStart = index;

    const pulseCount = index - clusterStart + 1;
    if (pulseCount < minPulses) continue;
    const stoppedSince = result[clusterStart].device_time ?? result[clusterStart].server_time ?? null;
    for (let stoppedIndex = clusterStart; stoppedIndex <= index; stoppedIndex++) {
      result[stoppedIndex].movement_state = 'stopped';
      result[stoppedIndex].stopped_pulses = pulseCount;
      result[stoppedIndex].stopped_since = stoppedSince;
    }
  }
  return result;
}

export function currentMovementState(positions, options) {
  const current = annotateMovementStates(positions, options).at(-1);
  return current
    ? {
        movement_state: current.movement_state,
        stopped_pulses: current.stopped_pulses,
        stopped_since: current.stopped_since,
      }
    : { movement_state: 'moving', stopped_pulses: 0, stopped_since: null };
}
