import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, filterGpsTrace, splitTrace, buildMatchedTrace, collapseStops } from '../src/tracking/map-match.js';

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
  // 35° respeta el sentido de circulación; con la tolerancia anterior de 60°
  // cabía engancharse a la misma calle en dirección contraria.
  assert.match(requestedUrl, /bearings=22,35;25,35/);
});

test('envía marcas de tiempo para que OSRM sepa qué transiciones son posibles', async () => {
  let requestedUrl;
  const fakeFetch = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ code: 'Ok',
      matchings: [{ geometry: { coordinates: [[-99.99, 20.39], [-99.98, 20.40]] } }], tracepoints: [] }) };
  };
  await buildMatchedTrace([
    p(20.39, -99.99, 0, { id: 1, speed_kmh: 20, course: 22 }),
    p(20.40, -99.98, 60, { id: 2, speed_kmh: 30, course: 25 }),
  ], { fetchImpl: fakeFetch });

  // Sin timestamps OSRM asume un segundo entre puntos y descarta el trayecto
  // real por imposible, prefiriendo atajos por calles que nadie recorrió.
  const timestamps = /timestamps=(\d+);(\d+)/.exec(requestedUrl);
  assert.ok(timestamps, 'la consulta debe incluir timestamps');
  assert.equal(Number(timestamps[2]) - Number(timestamps[1]), 60);
});

test('el radio declarado se ajusta a la calidad del fix', async () => {
  let requestedUrl;
  const fakeFetch = async (url) => {
    requestedUrl = url;
    return { ok: true, json: async () => ({ code: 'Ok',
      matchings: [{ geometry: { coordinates: [[-99.99, 20.39], [-99.98, 20.40]] } }], tracepoints: [] }) };
  };
  await buildMatchedTrace([
    p(20.39, -99.99, 0, { id: 1, satellites: 11 }),
    p(20.40, -99.98, 60, { id: 2, satellites: 4 }),
  ], { fetchImpl: fakeFetch });

  // Con buen fix se ancla corto; con fix pobre se le da margen para no fallar.
  assert.match(requestedUrl, /radiuses=10;30/);
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

test('una parada se reduce a sus extremos antes de consultar a OSRM', () => {
  // Doce pulsos derivando dentro de un par de metros: el vehículo no se movió.
  // Mandarlos todos obligaba a OSRM a unirlos por la red vial, y el motor
  // resolvía la deriva dando vueltas a la manzana.
  const parado = Array.from({ length: 12 }, (_, i) =>
    p(20.3900 + (i % 3) * 0.00002, -99.9900 + (i % 2) * 0.00002, i * 10, { id: i + 1 }));
  const siguiente = p(20.3950, -99.9900, 200, { id: 99 });

  const resultado = collapseStops([...parado, siguiente]);

  assert.equal(resultado.length, 3, 'deben quedar entrada, salida y el punto de marcha');
  assert.equal(resultado[0].id, 1);
  assert.equal(resultado[1].id, 12, 'el último pulso de la parada define cuánto duró');
  assert.equal(resultado[2].id, 99);
});

test('un trayecto en marcha no pierde ningún punto al colapsar paradas', () => {
  const marcha = Array.from({ length: 8 }, (_, i) => p(20.39 + i * 0.0009, -99.99, i * 15, { id: i + 1 }));
  assert.equal(collapseStops(marcha).length, marcha.length);
});

test('si el motor de rutas está caído se deja de insistir en cada trozo', async () => {
  // Traza larga: sin corte temprano se consultaría trozo a trozo hasta agotar
  // el tiempo total, y el usuario esperaría el timeout entero para ver la
  // estela cruda que ya se podía dibujar desde el primer fallo.
  let intentos = 0;
  const fakeFetch = async () => {
    intentos++;
    throw new Error('fetch failed');
  };
  const puntos = Array.from({ length: 300 }, (_, i) => p(20.39 + i * 0.0005, -99.99, i * 15, { id: i + 1 }));

  const resultado = await buildMatchedTrace(puntos, { fetchImpl: fakeFetch });

  assert.equal(resultado.matched, false);
  assert.ok(resultado.segments.length >= 1, 'debe devolver igualmente la estela del GPS');
  // Dos intentos (match y route) sobre el primer trozo bastan para concluirlo.
  assert.equal(intentos, 2, `esperaba rendirse tras 2 intentos, hizo ${intentos}`);
});

test('un tramo sin cobertura vial no se confunde con el motor caído', async () => {
  // NoMatch es una respuesta legítima del servicio: hay que seguir probando el
  // resto de la traza, no darla por perdida.
  let intentos = 0;
  const fakeFetch = async (url) => {
    intentos++;
    return url.includes('/match/')
      ? { ok: true, json: async () => ({ code: 'NoMatch', message: 'No matchings found' }) }
      : { ok: true, json: async () => ({ code: 'NoRoute', message: 'No route found' }) };
  };
  const puntos = Array.from({ length: 300 }, (_, i) => p(20.39 + i * 0.0005, -99.99, i * 15, { id: i + 1 }));

  await buildMatchedTrace(puntos, { fetchImpl: fakeFetch });

  assert.ok(intentos > 2, `debe seguir intentando los demás trozos, hizo ${intentos}`);
});
