import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  listPositions, getDailyRoute, upsertDailyRoute, listDailyRoutes,
  listDevicesWithPositionsBetween, dailyRouteIsClosed,
} from '../db/repo.js';
import { buildDailyRoute, dayRangeUtc, localDate, previousDate, isValidDate, segmentsToWkt } from './daily-routes.js';

/**
 * Consolidación de recorridos por día.
 *
 * El día en curso se recalcula al vuelo (los datos siguen llegando); los días
 * ya terminados se congelan una sola vez y a partir de ahí se sirven desde
 * `daily_routes` sin volver a tocar `positions` ni el servicio de map matching.
 * Eso es lo que permite que el mapa amanezca limpio y que consultar "el martes"
 * sea instantáneo.
 */

const opcionesMapMatch = () => ({
  baseUrl: config.tracking.mapMatchUrl,
  timeoutMs: config.tracking.mapMatchTimeoutMs,
  maxPoints: config.tracking.mapMatchMaxPoints,
});

export function hoyLocal(now = new Date()) {
  return localDate(now, config.rutas.zonaHoraria);
}

/** Calcula la ruta del día y la guarda. Devuelve la forma que sirve la API. */
export async function consolidarDia(device, fecha, { cerrar = false, ajustarCalles = true } = {}) {
  const construida = await buildDailyRoute(device, fecha, {
    listPositions,
    timeZone: config.rutas.zonaHoraria,
    limit: config.rutas.maxPuntosPorDia,
    ajustarCalles: ajustarCalles && config.tracking.mapMatchEnabled,
    mapMatch: opcionesMapMatch(),
  });

  await upsertDailyRoute({ ...construida, wkt: segmentsToWkt(construida.segments) }, { cerrada: cerrar });

  return {
    fecha: construida.fecha,
    zona_horaria: construida.zona_horaria,
    distancia_km: construida.distancia_km,
    puntos: construida.puntos,
    tramos: construida.tramos,
    paradas: construida.paradas,
    velocidad_max_kmh: construida.velocidad_max_kmh,
    primer_punto: construida.primer_punto,
    ultimo_punto: construida.ultimo_punto,
    ajustada_calles: construida.ajustada_calles,
    cerrada: cerrar,
    resumen: construida.resumen,
    segments: construida.segments,
  };
}

/**
 * Ruta de un día lista para servir.
 * El día en curso se recalcula siempre; los anteriores salen de caché salvo que
 * todavía no se hayan cerrado (por ejemplo, si el servicio estuvo apagado).
 */
export async function obtenerRutaDelDia(device, fecha, { forzar = false } = {}) {
  if (!isValidDate(fecha)) throw Object.assign(new Error('fecha inválida'), { statusCode: 400 });

  const hoy = hoyLocal();
  const esHoy = fecha === hoy;
  const futura = fecha > hoy;
  if (futura) return { fecha, zona_horaria: config.rutas.zonaHoraria, segments: [], puntos: 0, tramos: 0,
    distancia_km: 0, paradas: 0, cerrada: false, resumen: { motivo: 'fecha_futura' } };

  if (!forzar && !esHoy) {
    const guardada = await getDailyRoute(device.id, fecha);
    if (guardada?.cerrada) return guardada;
  }
  return consolidarDia(device, fecha, { cerrar: !esHoy });
}

export async function listarDias(device, opciones = {}) {
  return listDailyRoutes(device.id, opciones);
}

/**
 * Cierra los días vencidos que quedaron pendientes. Se ejecuta periódicamente y
 * también al arrancar, para recuperar el histórico si el servicio estuvo caído.
 */
export async function cerrarDiasPendientes({ dias = config.rutas.diasRelleno, now = new Date() } = {}) {
  const margenMs = config.rutas.margenCierreMinutos * 60000;
  const hoy = hoyLocal(now);
  let cerrados = 0;

  for (let i = 1; i <= dias; i++) {
    const fecha = previousDate(hoy, i);
    const { hasta } = dayRangeUtc(fecha, config.rutas.zonaHoraria);
    // Se respeta el margen: un día que acaba de terminar todavía puede recibir
    // el búfer de un equipo que venía sin señal.
    if (now.getTime() < hasta.getTime() + margenMs) continue;

    const { desde } = dayRangeUtc(fecha, config.rutas.zonaHoraria);
    const equipos = await listDevicesWithPositionsBetween(desde, hasta);
    for (const device of equipos) {
      if (await dailyRouteIsClosed(device.id, fecha)) continue;
      try {
        const ruta = await consolidarDia(device, fecha, { cerrar: true });
        cerrados++;
        logger.info(
          { imei: device.imei, fecha, km: ruta.distancia_km, tramos: ruta.tramos, puntos: ruta.puntos },
          'ruta diaria consolidada',
        );
      } catch (err) {
        logger.error({ err, imei: device.imei, fecha }, 'no se pudo consolidar la ruta del día');
      }
    }
  }
  return cerrados;
}

/** Arranca el barrido periódico. Devuelve la función para detenerlo. */
export function iniciarConsolidadorDiario() {
  const ejecutar = () => {
    cerrarDiasPendientes().catch((err) => logger.error({ err }, 'fallo en el consolidador de rutas diarias'));
  };
  // Un primer barrido al arrancar recupera lo que se haya perdido mientras el
  // servicio estuvo abajo, sin esperar al siguiente intervalo.
  const inicial = setTimeout(ejecutar, 15000);
  const periodico = setInterval(ejecutar, config.rutas.consolidarCadaMs);
  periodico.unref?.();
  inicial.unref?.();
  return () => { clearTimeout(inicial); clearInterval(periodico); };
}
