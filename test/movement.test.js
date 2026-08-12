import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateMovementStates, currentMovementState } from '../src/tracking/movement.js';

function point(latitude, longitude, seconds) {
  return { latitude, longitude, valid: true, device_time: new Date(1700000000000 + seconds * 1000).toISOString() };
}

test('marca parado al tercer pulso dentro de la tolerancia GPS', () => {
  const positions = annotateMovementStates([
    point(20.390000, -99.990000, 0),
    point(20.390030, -99.990020, 60),
    point(20.389980, -99.989980, 120),
  ]);
  assert.deepEqual(positions.map((p) => p.movement_state), ['stopped', 'stopped', 'stopped']);
  assert.equal(positions.at(-1).stopped_pulses, 3);
  assert.equal(positions.at(-1).stopped_since, positions[0].device_time);
});

test('reinicia la cuenta cuando el GPS se desplaza fuera de 15 metros', () => {
  const positions = annotateMovementStates([
    point(20.390000, -99.990000, 0),
    point(20.390030, -99.990020, 60),
    point(20.391000, -99.990000, 120),
  ]);
  assert.deepEqual(positions.map((p) => p.movement_state), ['moving', 'moving', 'moving']);
  assert.equal(currentMovementState(positions).movement_state, 'moving');
});

test('mantiene parado mientras sigan llegando pulsos en el mismo lugar', () => {
  const state = currentMovementState([
    point(20.390000, -99.990000, 0),
    point(20.390010, -99.990010, 60),
    point(20.390020, -99.990020, 120),
    point(20.390000, -99.990030, 180),
  ]);
  assert.equal(state.movement_state, 'stopped');
  assert.equal(state.stopped_pulses, 4);
});

test('un reporte sin coordenadas corta la secuencia estacionaria', () => {
  const positions = annotateMovementStates([
    point(20.390000, -99.990000, 0),
    { latitude: null, longitude: null, valid: false, device_time: new Date(1700000060000).toISOString() },
    point(20.390010, -99.990010, 120),
  ]);
  assert.deepEqual(positions.map((p) => p.movement_state), ['moving', 'moving', 'moving']);
});
