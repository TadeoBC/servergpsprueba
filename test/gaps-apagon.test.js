import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTrace } from '../src/tracking/map-match.js';
import { decode } from '../src/protocols/gt06.js';
import { normalizeBatteryReading } from '../src/tracking/battery.js';

const INICIO = Date.parse('2026-08-19T15:00:00Z');

/** Tramo sintético de pulsos regulares avanzando en línea recta. */
function tramo(desdeMs, latInicial, pulsos, pasoSegundos, deltaLat) {
  return Array.from({ length: pulsos }, (_, i) => ({
    device_time: new Date(desdeMs + i * pasoSegundos * 1000).toISOString(),
    latitude: latInicial + i * deltaLat,
    longitude: -99.96,
  }));
}

test('el equipo apagado en ruta y encendido lejos no se une con una recta', () => {
  // Escenario real reportado: la unidad se apaga, la trasladan cargada y la
  // encienden 4 km más allá ocho minutos después. Sin corte, el mapa dibujaba
  // —o peor, OSRM inventaba— una carretera que nadie recorrió.
  const antes = tramo(INICIO, 20.3800, 20, 15, 0.00012);
  const finAntes = Date.parse(antes.at(-1).device_time);
  const despues = tramo(finAntes + 8 * 60 * 1000, antes.at(-1).latitude + 0.036, 15, 15, 0.00012);

  const grupos = splitTrace([...antes, ...despues]);
  assert.equal(grupos.length, 2, 'el apagón debe partir la traza en dos tramos');
  assert.equal(grupos[0].length, 20);
  assert.equal(grupos[1].length, 15);
});

test('una pérdida corta de señal en la misma calle no fragmenta el recorrido', () => {
  // Dos minutos sin reportar y 180 m de avance es tráfico normal, no un
  // traslado: romper aquí llenaría el mapa de cortes falsos.
  const antes = tramo(INICIO, 20.3800, 20, 15, 0.00012);
  const finAntes = Date.parse(antes.at(-1).device_time);
  const despues = tramo(finAntes + 2 * 60 * 1000, antes.at(-1).latitude + 0.0016, 15, 15, 0.00012);

  assert.equal(splitTrace([...antes, ...despues]).length, 1);
});

test('un salto instantáneo imposible se corta aunque el hueco sea corto', () => {
  const antes = tramo(INICIO, 20.3800, 10, 15, 0.00012);
  const finAntes = Date.parse(antes.at(-1).device_time);
  // 11 km en 30 s son 1300 km/h: teletransporte.
  const despues = tramo(finAntes + 30 * 1000, antes.at(-1).latitude + 0.1, 10, 15, 0.00012);

  assert.equal(splitTrace([...antes, ...despues]).length, 2);
});

test('el S11L reporta el porcentaje de batería directo, no el nivel 0..6', () => {
  // Alarma real del equipo 351840620204473 (2026-08-20T00:05:53Z). El byte de
  // voltaje trae 0x56 = 86, imposible en una escala 0..15: es 86 %.
  const trama = Buffer.from(
    '787826161A0814000526C8022FB3F70AB98DC2571C9309000000000000000000405602060200C687CB0D0A',
    'hex',
  );
  const msg = decode(trama);

  assert.equal(msg.crcOk, true);
  assert.equal(msg.type, 'alarma');
  assert.equal(msg.attributes.alarma.tipo, 'exceso_velocidad');
  assert.equal(msg.attributes.bateria.nivel, 86);
  assert.equal(msg.attributes.bateria.escala_max, 100);
  assert.equal(msg.attributes.bateria.porcentaje_aprox, 86);

  // Antes esta lectura se descartaba por "imposible" y la telemetría se quedaba
  // congelada en el último valor bueno, que en producción era 0 %.
  const normalizada = normalizeBatteryReading(msg.attributes.bateria, { escala_max: 15 }, 'T');
  assert.equal(normalizada.porcentaje_aprox, 86);
});

test('una vez detectada la escala de porcentaje, un 5 vale 5 % y no 83 %', () => {
  const previa = { nivel: 86, escala_max: 100, porcentaje_aprox: 86 };
  const resultado = normalizeBatteryReading({ nivel: 5, escala_max: 6 }, previa, 'T');
  assert.equal(resultado.escala_max, 100);
  assert.equal(resultado.porcentaje_aprox, 5);
  assert.equal(resultado.etiqueta, 'critico');
});
