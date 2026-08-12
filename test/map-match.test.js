import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, filterGpsTrace, splitTrace, buildMatchedTrace } from '../src/tracking/map-match.js';

function p(latitude, longitude, seconds, extra = {}) {
  return { latitude, longitude, valid: true, device_time: new Date(1700000000000 + seconds * 1000).toISOString(), ...extra };
}

test('distanceMeters calcula una distancia geográfica razonable', () => {
  const distance = distanceMeters(p(20.39, -99.99, 0), p(20.391, -99.99, 1));
  assert.ok(distance > 110 && distance < 112);
});

test('filterGpsTrace quita duplicados y saltos físicamente imposibles', () => {
  const points = [
    p(20.39, -99.99, 0),
    p(20.390001, -99.990001, 10),
    p(21.39, -98.99, 20),
    p(20.391, -99.99, 60),
  ];
  const result = filterGpsTrace(points);
  assert.equal(result.length, 2);
  assert.equal(result[1].latitude, 20.391);
});

test('splitTrace no une viajes separados por más de diez minutos', () => {
  const groups = splitTrace([p(20.39, -99.99, 0), p(20.391, -99.99, 30), p(20.40, -99.98, 800)]);
  assert.deepEqual(groups.map((g) => g.length), [2, 1]);
});

test('buildMatchedTrace convierte GeoJSON lon/lat de OSRM a lat/lon', async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({ code: 'Ok', matchings: [{ geometry: { coordinates: [[-99.99, 20.39], [-99.98, 20.40]] } }] }),
  });
  const result = await buildMatchedTrace([p(20.39, -99.99, 0), p(20.40, -99.98, 60)], { fetchImpl: fakeFetch });
  assert.equal(result.matched, true);
  assert.deepEqual(result.coordinates, [[20.39, -99.99], [20.40, -99.98]]);
  assert.deepEqual(result.segments, [[[20.39, -99.99], [20.40, -99.98]]]);
});

test('buildMatchedTrace cae a la estela filtrada si OSRM falla', async () => {
  const result = await buildMatchedTrace(
    [p(20.39, -99.99, 0), p(20.40, -99.98, 60)],
    { fetchImpl: async () => { throw new Error('sin red'); } },
  );
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'fallback');
  assert.equal(result.coordinates.length, 2);
});
