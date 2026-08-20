import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBatteryReading } from '../src/tracking/battery.js';

test('conserva la escala S11L 0..15 cuando el nivel baja de 7', () => {
  const previous = { nivel: 14, escala_max: 15, porcentaje_aprox: 93 };
  const result = normalizeBatteryReading({ nivel: 6, escala_max: 6 }, previous, '2026-08-18T00:00:00.000Z');
  assert.deepEqual(result, {
    nivel: 6, escala_max: 15, etiqueta: 'bajo', porcentaje_aprox: 40,
    actualizada_en: '2026-08-18T00:00:00.000Z',
  });
});

test('mantiene compatibilidad con la escala GT06 clásica 0..6', () => {
  const result = normalizeBatteryReading({ nivel: 5, escala_max: 6 }, null, '2026-08-18T00:00:00.000Z');
  assert.equal(result.escala_max, 6);
  assert.equal(result.porcentaje_aprox, 83);
  assert.equal(result.etiqueta, 'muy_alto');
});

test('descarta bytes de batería imposibles', () => {
  assert.equal(normalizeBatteryReading({ nivel: 255, escala_max: null }), null);
  assert.equal(normalizeBatteryReading({ nivel: null, escala_max: null }), null);
});
