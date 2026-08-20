import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/public/styles.css', import.meta.url), 'utf8');

test('el acceso a equipos vive en la barra superior, entre alertas y salir', () => {
  const barra = html.slice(html.indexOf('<header id="barra-superior">'), html.indexOf('</header>'));
  const notificaciones = barra.indexOf('id="activar-notificaciones"');
  const equipos = barra.indexOf('id="abrir-equipos"');
  const salir = barra.indexOf('id="salir"');

  assert.ok(equipos !== -1, 'el botón de equipos debe estar en la barra superior');
  assert.ok(notificaciones < equipos && equipos < salir,
    'el botón va entre el de notificaciones y el de cerrar sesión');
});

test('la gestión de equipos es una sección del panel lateral, no un flotante', () => {
  assert.match(html, /<section class="seccion" id="seccion-gestion">/);
  // El lateral la revela igual que telemetría o alertas, y con su propio ancho.
  assert.match(css, /body\[data-vista="gestion"\] #seccion-gestion/);
  assert.match(css, /body\[data-vista="gestion"\]\s*\{ --panel-ancho/);
  assert.ok(!html.includes('panel-flotante'), 'no debe quedar el panel flotante sobre el mapa');
  assert.ok(!css.includes('.panel-flotante'), 'no deben quedar estilos del flotante');
});

test('abrir equipos cambia de vista y cerrarla devuelve al mapa', () => {
  assert.match(app, /const validas = new Set\(\['mapa', 'telemetria', 'recorrido', 'alertas', 'diagnostico', 'gestion'\]\)/);
  assert.match(app, /cambiarVista\(abrir \? 'gestion' : 'mapa'\)/);
  assert.match(app, /if \(vista === 'gestion'\) renderEquipos\(\)/);
});

test('el panel permite dar de alta y editar sin salir del mapa', () => {
  for (const id of ['form-alta-equipo', 'alta-imei', 'alta-alias', 'lista-equipos', 'aviso-equipos']) {
    assert.ok(html.includes(`id="${id}"`), `falta el elemento ${id} en el panel`);
  }
  for (const accion of ['data-ver=', 'data-editar=', 'data-vigilar=', 'data-quitar=', 'data-guardar=']) {
    assert.ok(app.includes(accion), `el panel no expone la acción ${accion}`);
  }
});

test('renombrar un equipo llega al servidor por PATCH', () => {
  assert.match(app, /method: 'PATCH'/);
  assert.match(app, /JSON\.stringify\(\{ alias: alias \|\| null, placa: placa \|\| null \}\)/);
});

test('el bloque de rango libre del recorrido es visible en su vista', () => {
  // Se añadió como sección aparte y al principio quedó sin regla de CSS, así
  // que existía en el HTML pero nunca llegaba a mostrarse.
  assert.match(html, /id="seccion-recorrido-rango"/);
  assert.match(css, /body\[data-vista="recorrido"\] #seccion-recorrido-rango/);
});

test('al seguir una unidad se ocultan las estelas de las demás', () => {
  assert.match(app, /function estelaVisible\(imei\)/);
  assert.match(app, /if \(!estado\.siguiendo \|\| !estado\.seleccionado\) return true;/);
  assert.match(app, /return imei === estado\.seleccionado;/);
  assert.ok(app.includes('refrescarVisibilidadEstelas()'), 'nadie reevalúa la visibilidad');
});

test('las estelas de las unidades ocultas se siguen calculando', () => {
  const cuerpo = app.slice(app.indexOf('function actualizarEstelaViva('));
  const bloque = cuerpo.slice(0, cuerpo.indexOf('\n}'));
  assert.ok(bloque.includes('registrarEstelaViva(device)'), 'la estela debe registrarse siempre');
  assert.ok(!bloque.includes('estelaVisible'), 'el registro no debe depender de la visibilidad');
});

test('la estela viva guarda la posición cruda y la ajustada por separado', () => {
  assert.match(app, /display_latitude: p\.display_latitude != null/);
  assert.ok(app.includes('ultimo.id === entrada.id'), 'el punto debe reconocerse por id para actualizarse');
});

test('la estela viva se corta donde el equipo dejó de reportar', () => {
  assert.match(app, /function geometriaEstelaViva\(imei\)/);
  for (const umbral of ['ESTELA_HUECO_SEGUNDOS', 'ESTELA_SALTO_MINIMO_M', 'ESTELA_SALTO_GRANDE_M', 'ESTELA_KMH_IMPOSIBLE']) {
    assert.ok(app.includes(umbral), `falta el umbral ${umbral}`);
  }
  assert.ok(app.includes("geometry: { type: 'MultiLineString'"), 'el 3D debe dibujar tramos separados');
});
