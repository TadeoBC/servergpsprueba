const LABELS_CLASSIC = ['apagado', 'muy_bajo', 'bajo', 'medio', 'alto', 'muy_alto', 'lleno'];

// Escalas conocidas para el byte de "nivel de voltaje" del GT06.
//   6   → GT06 clásico: 0..6 según la documentación original.
//   15  → variante observada en algunos firmwares S11L.
//   100 → el S11L de esta flotilla manda el PORCENTAJE de batería directo.
//         Se confirmó con el histórico: los valores observados se reparten de
//         forma continua entre 0 y 91, cosa imposible en una escala 0..6/0..15.
export const BATTERY_SCALES = [6, 15, 100];
const MAX_RAW_LEVEL = 100;

function labelFor(percent, level, scale) {
  if (scale === 6) return LABELS_CLASSIC[level] ?? 'desconocido';
  if (percent <= 10) return 'critico';
  if (percent <= 20) return 'muy_bajo';
  if (percent <= 40) return 'bajo';
  if (percent <= 70) return 'medio';
  if (percent < 100) return 'alto';
  return 'lleno';
}

/**
 * Decide en qué escala está el byte crudo.
 *
 * La escala es "pegajosa" hacia arriba: en cuanto un equipo demuestra una vez
 * que usa una escala mayor, se conserva. Sin esto un equipo que reporta 100%
 * y luego baja a 5 se leería como 5/6 = 83%, que es justo el error que hacía
 * ver baterías llenas cuando estaban por morir (y viceversa).
 */
function resolveScale(level, reportedScale, previousScale) {
  const candidates = [level > 15 ? 100 : level > 6 ? 15 : 6];
  if (BATTERY_SCALES.includes(reportedScale)) candidates.push(reportedScale);
  if (BATTERY_SCALES.includes(previousScale)) candidates.push(previousScale);
  return Math.max(...candidates);
}

/**
 * Normaliza la lectura ambigua de GT06/S11L a un porcentaje utilizable.
 * Devuelve null cuando la lectura no es interpretable, para que el llamador
 * conserve el último valor bueno en vez de pisar la telemetría con basura.
 */
export function normalizeBatteryReading(reading, previous = null, now = new Date().toISOString()) {
  if (reading?.nivel === null || reading?.nivel === undefined || reading?.nivel === '') return null;
  const level = Number(reading?.nivel);
  if (!Number.isInteger(level) || level < 0 || level > MAX_RAW_LEVEL) return null;

  const scale = resolveScale(level, Number(reading?.escala_max), Number(previous?.escala_max));
  // Un nivel por encima de su escala significa que la escala quedó mal
  // detectada; se recorta en lugar de reportar 130 %.
  const percentage = Math.min(100, Math.round((Math.min(level, scale) / scale) * 100));

  return {
    nivel: level,
    escala_max: scale,
    etiqueta: labelFor(percentage, level, scale),
    porcentaje_aprox: Math.max(0, percentage),
    actualizada_en: now,
  };
}
