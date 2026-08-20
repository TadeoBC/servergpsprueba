import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dayRangeUtc, localDate, previousDate, isValidDate, resumirRuta, segmentsToWkt,
} from '../src/tracking/daily-routes.js';

const TZ = 'America/Mexico_City';

test('el día local abarca de medianoche a medianoche en hora de México, no en UTC', () => {
  const { desde, hasta } = dayRangeUtc('2026-08-19', TZ);
  // México está en UTC-6: el día local empieza a las 06:00 UTC.
  assert.equal(desde.toISOString(), '2026-08-19T06:00:00.000Z');
  assert.equal(hasta.toISOString(), '2026-08-20T05:59:59.999Z');
});

test('una jornada que termina de noche no se cuenta en el día siguiente', () => {
  // 23:30 hora local del 19 son las 05:30 UTC del 20: agrupar por UTC lo habría
  // mandado al día equivocado, que es justo el error que se quería evitar.
  assert.equal(localDate(new Date('2026-08-20T05:30:00Z'), TZ), '2026-08-19');
  assert.equal(localDate(new Date('2026-08-20T06:00:00Z'), TZ), '2026-08-20');
});

test('el día anterior cruza bien fin de mes y de año', () => {
  assert.equal(previousDate('2026-03-01'), '2026-02-28');
  assert.equal(previousDate('2026-01-01'), '2025-12-31');
  assert.equal(previousDate('2026-08-19', 7), '2026-08-12');
});

test('rechaza fechas inexistentes y formatos que no son AAAA-MM-DD', () => {
  assert.equal(isValidDate('2026-02-29'), false);
  assert.equal(isValidDate('19-08-2026'), false);
  assert.equal(isValidDate('2026-08-19'), true);
});

test('el kilometraje del día no incluye el salto entre tramos separados', () => {
  const tramoA = [
    { latitude: 20.380, longitude: -99.96, speed_kmh: 20, device_time: '2026-08-19T15:00:00Z', movement_state: 'moving' },
    { latitude: 20.390, longitude: -99.96, speed_kmh: 45, device_time: '2026-08-19T15:05:00Z', movement_state: 'moving' },
  ];
  // El equipo se apagó y reapareció 23 km más allá: ese trecho no lo recorrió
  // reportando, así que no debe sumar al kilometraje del día.
  const tramoB = [
    { latitude: 20.600, longitude: -99.96, speed_kmh: 0, device_time: '2026-08-19T15:40:00Z', movement_state: 'stopped' },
    { latitude: 20.610, longitude: -99.96, speed_kmh: 10, device_time: '2026-08-19T15:45:00Z', movement_state: 'moving' },
  ];
  const resumen = resumirRuta([...tramoA, ...tramoB], [tramoA, tramoB]);

  assert.equal(resumen.tramos, 2);
  assert.ok(resumen.distancia_km > 2 && resumen.distancia_km < 3,
    `esperaba ~2.2 km recorridos, no el salto completo; recibí ${resumen.distancia_km}`);
  assert.equal(resumen.velocidad_max_kmh, 45);
  assert.equal(resumen.puntos, 4);
});

test('cuenta cada racha detenida como una sola parada', () => {
  const puntos = [
    { latitude: 20.38, longitude: -99.96, movement_state: 'moving' },
    { latitude: 20.38, longitude: -99.96, movement_state: 'stopped' },
    { latitude: 20.38, longitude: -99.96, movement_state: 'stopped' },
    { latitude: 20.39, longitude: -99.96, movement_state: 'moving' },
    { latitude: 20.40, longitude: -99.96, movement_state: 'stopped' },
  ];
  assert.equal(resumirRuta(puntos, [puntos]).paradas, 2);
});

test('el WKT invierte a lon/lat y descarta tramos de un solo punto', () => {
  const wkt = segmentsToWkt([[[20.38, -99.96], [20.39, -99.96]], [[20.5, -99.9]]]);
  assert.equal(wkt, 'SRID=4326;MULTILINESTRING((-99.96 20.38,-99.96 20.39))');
  assert.equal(segmentsToWkt([]), null);
});
