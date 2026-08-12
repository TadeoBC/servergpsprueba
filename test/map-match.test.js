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
  let requestedUrl;
  const fakeFetch = async (url) => {
    requestedUrl = url;
    return {
    ok: true,
    json: async () => ({ code: 'Ok',
      matchings: [{ geometry: { coordinates: [[-99.99, 20.39], [-99.98, 20.40]] } }],
      tracepoints: [{ location: [-99.9901, 20.3901] }, { location: [-99.9801, 20.4001] }],
    }),
  }; };
  const result = await buildMatchedTrace([p(20.39, -99.99, 0, { id: 1 }), p(20.40, -99.98, 60, { id: 2 })], { fetchImpl: fakeFetch });
  assert.equal(result.matched, true);
  assert.deepEqual(result.coordinates, [[20.39, -99.99], [20.40, -99.98]]);
  assert.deepEqual(result.segments, [[[20.39, -99.99], [20.40, -99.98]]]);
  assert.match(requestedUrl, /radiuses=25;25/);
  assert.deepEqual(result.snapped_points, [
    { id: 1, latitude: 20.3901, longitude: -99.9901 },
    { id: 2, latitude: 20.4001, longitude: -99.9801 },
  ]);
});

test('envía rumbo de puntos en movimiento para distinguir vías paralelas', async () => {
  let requestedUrl;
  const fakeFetch = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ code: 'Ok',
      matchings: [{ geometry: { coordinates: [[-99.99, 20.39], [-99.98, 20.40]] } }],
      tracepoints: [],
    }) };
  };
  await buildMatchedTrace([
    p(20.39, -99.99, 0, { id: 1, speed_kmh: 20, course: 22 }),
    p(20.40, -99.98, 60, { id: 2, speed_kmh: 30, course: 25 }),
  ], { fetchImpl: fakeFetch });
  assert.match(requestedUrl, /bearings=22,60;25,60/);
});

test('buildMatchedTrace usa rutas viales si el servicio Match rechaza la traza', async () => {
  const fakeFetch = async (url) => url.includes('/match/')
    ? { ok: true, json: async () => ({ code: 'NoMatch', message: 'No matchings found' }) }
    : { ok: true, json: async () => ({ code: 'Ok',
      routes: [{ geometry: { coordinates: [[-99.99, 20.39], [-99.985, 20.395], [-99.98, 20.40]] } }],
      waypoints: [{ location: [-99.99, 20.39] }, { location: [-99.98, 20.40] }],
    }) };
  const result = await buildMatchedTrace(
    [p(20.39, -99.99, 0, { id: 1 }), p(20.40, -99.98, 60, { id: 2 })],
    { fetchImpl: fakeFetch },
  );
  assert.equal(result.matched, true);
  assert.equal(result.routed_fallback, true);
  assert.equal(result.segments[0].length, 3);
});

test('un pulso estacionario filtrado hereda la coordenada ajustada a la calle', async () => {
  const fakeFetch = async () => ({ ok: true, json: async () => ({ code: 'Ok',
    matchings: [{ geometry: { coordinates: [[-99.99, 20.39], [-99.98, 20.40]] } }],
    tracepoints: [{ location: [-99.9901, 20.3901] }, { location: [-99.9801, 20.4001] }],
  }) });
  const result = await buildMatchedTrace([
    p(20.39, -99.99, 0, { id: 1 }),
    p(20.390001, -99.990001, 10, { id: 2 }),
    p(20.40, -99.98, 60, { id: 3 }),
  ], { fetchImpl: fakeFetch });
  assert.deepEqual(result.snapped_points.find((point) => point.id === 2),
    { id: 2, latitude: 20.3901, longitude: -99.9901 });
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
