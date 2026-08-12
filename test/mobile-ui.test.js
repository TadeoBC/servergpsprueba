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
  assert.equal(manifest.theme_color, '#0e1116');
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
