import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');

const VACIAS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'path', 'circle', 'rect', 'use']);

/** Recorre las etiquetas y devuelve los desajustes de anidación encontrados. */
function revisarAnidacion(fuente) {
  const pila = [];
  const problemas = [];
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
  let m;
  let linea = 1;
  let ultimo = 0;

  while ((m = re.exec(fuente)) !== null) {
    linea += (fuente.slice(ultimo, m.index).match(/\n/g) || []).length;
    ultimo = m.index;
    const [, cierre, tag, autocierre] = m;
    const nombre = tag.toLowerCase();

    if (VACIAS.has(nombre) || autocierre === '/') continue;
    // El contenido SVG tiene sus propias reglas; se salta entero.
    if (nombre === 'svg' && !cierre) {
      const fin = fuente.indexOf('</svg>', m.index);
      if (fin !== -1) { re.lastIndex = fin + 6; continue; }
    }

    if (!cierre) {
      pila.push({ nombre, linea });
      continue;
    }
    const abierto = pila.pop();
    if (!abierto) problemas.push(`línea ${linea}: </${nombre}> sin apertura`);
    else if (abierto.nombre !== nombre) {
      problemas.push(`línea ${linea}: </${nombre}> cierra un <${abierto.nombre}> abierto en la línea ${abierto.linea}`);
    }
  }
  for (const resto of pila) problemas.push(`<${resto.nombre}> de la línea ${resto.linea} nunca se cierra`);
  return problemas;
}

test('el HTML del panel está bien formado', () => {
  // Un cierre de más rompe la anidación en silencio: el navegador reubica los
  // elementos, el mapa deja de estar dentro de su contenedor, se ancla al
  // viewport y acaba tapando la barra superior y el panel lateral. No aparece
  // como error en ninguna parte, solo como interfaz rota.
  const problemas = revisarAnidacion(html);
  assert.deepEqual(problemas, [], 'etiquetas descuadradas:\n  ' + problemas.join('\n  '));
});

test('las superficies de mapa viven dentro del área de mapas', () => {
  const inicio = html.indexOf('<main id="area-mapas">');
  const fin = html.indexOf('</main>', inicio);
  assert.ok(inicio !== -1 && fin !== -1, 'no se encuentra #area-mapas');
  const area = html.slice(inicio, fin);
  for (const id of ['mapa', 'mapa-3d', 'mosaico']) {
    assert.ok(area.includes(`id="${id}"`), `${id} quedó fuera de #area-mapas`);
  }
});

test('el detector reconoce un cierre huérfano', () => {
  // Comprobación del propio detector: si esto dejara de fallar, el test de
  // arriba pasaría siempre y no protegería de nada.
  const roto = '<main id="x"><div class="a"></div>\n</div>\n<div id="mapa"></div></main>';
  assert.ok(revisarAnidacion(roto).length > 0, 'el detector no ve el cierre sobrante');
});
