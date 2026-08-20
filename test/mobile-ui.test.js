import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/public/styles.css', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../src/public/manifest.webmanifest', import.meta.url), 'utf8'));

test('la interfaz tiene navegación móvil y destinos completos', () => {
  for (const id of ['navegacion-movil', 'asa-panel', 'contenido-panel', 'seccion-equipos', 'seccion-detalle', 'seccion-recorrido']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const view of ['mapa', 'equipos', 'gps', 'ruta']) assert.match(html, new RegExp(`data-vista-movil="${view}"`));
  assert.match(html, /viewport-fit=cover/);
});

test('el CSS móvil contempla tacto, notch y orientación horizontal', () => {
  assert.match(css, /@media \(max-width: 820px\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /min-height:44px/);
  assert.match(css, /orientation: landscape/);
});

test('el shell móvil recalcula mapas y navega entre secciones', () => {
  assert.match(js, /function mostrarVistaMovil/);
  assert.match(js, /function configurarInterfazMovil/);
  assert.match(js, /visualViewport\?\.addEventListener\('resize'/);
  assert.match(js, /mapa\.invalidateSize/);
});

test('el manifiesto permite abrir el panel como web app independiente', () => {
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.theme_color, '#04070a');
  assert.ok(manifest.icons.some((icon) => icon.purpose.includes('maskable')));
});

test('el selector ofrece estilos vectoriales limpios con fallback clásico', () => {
  for (const theme of ['fiord', 'darkmatter', 'positron', 'satelite', 'calles']) {
    assert.match(html, new RegExp(`<option value="${theme}"`));
  }
  assert.match(html, /@maplibre\/maplibre-gl-leaflet@0\.1\.3/);
  assert.match(js, /tiles\.openfreemap\.org\/styles\/fiord/);
  assert.match(js, /tiles\.openfreemap\.org\/styles\/dark/);
  assert.match(js, /if \(def\.type === 'vector' && L\.maplibreGL\)/);
  assert.match(js, /customAttribution: def\.attribution/);
});

test('la UI representa paradas y muestra velocidad en los marcadores', () => {
  assert.match(js, /function aplicarTooltipVelocidad/);
  assert.match(js, /function renderParadasRecorrido/);
  assert.match(js, /movement_state === 'stopped'/);
  assert.match(js, /color: '#f59e0b'/);
  assert.match(css, /\.marcador\.parado/);
  assert.match(css, /\.tooltip-velocidad/);
});

test('el panel HUD tiene sus cinco vistas y los destinos que llena app.js', () => {
  for (const id of ['barra-superior', 'pestanas', 'mostrar-panel', 'sidebar', 'panel-estado-global',
    'seccion-alertas', 'seccion-diagnostico', 'perfil-velocidad', 'buscar-equipo', 'titulo-unidad']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const vista of ['mapa', 'telemetria', 'recorrido', 'alertas', 'diagnostico']) {
    assert.match(html, new RegExp(`data-vista="${vista}"`));
  }
  // El ancho del panel y qué sección se ve dependen de body[data-vista].
  assert.match(css, /body\[data-vista="telemetria"\]/);
  assert.match(js, /function cambiarVista/);
  assert.match(js, /document\.body\.dataset\.vista = vista/);
  assert.doesNotMatch(html, /OBJETIVO_FIJADO|id="rail"/);
});

test('el mapa domina la vista y las herramientas de flotilla se pliegan', () => {
  assert.match(css, /#area-mapas \{ position: absolute; inset: 0; \}/);
  assert.match(css, /width: clamp\(320px, 20vw, 410px\)/);
  assert.match(css, /#sidebar\.abierto/);
  assert.match(js, /mostrar-panel/);
});

test('globo, colores por GPS y temas por mosaico son configurables', () => {
  assert.match(js, /setProjection\(\{ type: 'globe' \}\)/);
  assert.match(js, /function colorUnidad/);
  assert.match(js, /function actualizarEstelaViva/);
  assert.match(js, /TEMAS_MOSAICO/);
  assert.match(js, /atlyx_temas_mosaico/);
});

test('los indicadores del HUD se calculan con datos reales del equipo', () => {
  assert.match(js, /function renderEstadoGlobal/);
  assert.match(js, /function renderTelemetria/);
  assert.match(js, /function renderObjetivo/);
  assert.match(js, /function renderAlertas/);
  assert.match(js, /function renderPerfilVelocidad/);
  // Nada de métricas inventadas: los valores salen de la última posición y de
  // la telemetría que manda el rastreador.
  assert.match(js, /telemetria\.bateria|telemetry\?\.bateria|telemetria\?\.bateria/);
  assert.match(js, /gsm_signal/);
  assert.match(js, /speed_limit_kmh/);
});

test('la interfaz aguanta una flotilla entera, no dos equipos', () => {
  // Los repintados se agrupan en vez de dispararse en cada trama del WebSocket.
  assert.match(js, /function programarRender/);
  assert.match(js, /requestAnimationFrame\(ejecutarRenderPendiente\)/);
  assert.match(js, /document\.hidden/);
  // El mosaico usaba un mapa vectorial (contexto WebGL) por unidad vigilada.
  assert.match(js, /MAX_MOSAICO|mosaico.{0,40}8|8.{0,40}mosaico/s);
  // Solo se reciben las tramas de depuración de la unidad abierta.
  assert.match(js, /tipo: 'suscribir'/);
});
