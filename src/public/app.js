/* atlyx GPS — interfaz. Sin paso de compilación: JS de navegador a secas. */
'use strict';

// ── estado ───────────────────────────────────────────────────────────────────
const estado = {
  config: { timezone: 'America/Mexico_City', umbrales: { verde_min: 5, ambar_min: 30 } },
  equipos: new Map(), // imei -> device (con last_position)
  paquetes: new Map(), // imei -> [paquete] (los últimos, para depuración)
  comandos: new Map(), // imei -> últimos comandos remotos
  seleccionado: null,
  marcadores: new Map(), // imei -> L.Marker
  recorrido: null, // L.Polyline
  puntosRecorrido: null, // L.LayerGroup
  coordenadasRecorrido: [], // segmentos [[[lat, lon], ...], ...]
  temaMapa: cargarTemaMapa(),
  modoVista: '2d', // 2d | 3d | mosaico
  siguiendo: false,
  vigilados: cargarVigilados(),
  mapasMosaico: new Map(), // imei -> { map, marker, tile }
  mapa3d: null,
  marcador3d: null,
  vistaMovil: 'mapa',
  ws: null,
  reintentoWs: 1000,
  yaCentro: false,
};

function cargarVigilados() {
  try {
    const value = JSON.parse(localStorage.getItem('atlyx_gps_vigilados') || '[]');
    return new Set(Array.isArray(value) ? value : []);
  } catch {
    return new Set();
  }
}

function cargarTemaMapa() {
  const version = '2';
  const key = 'atlyx_tema_mapa';
  // La versión anterior solo tenía fondos raster. Estrenamos Fiord una vez y
  // después respetamos la elección guardada del usuario.
  if (localStorage.getItem('atlyx_tema_version') !== version) {
    localStorage.setItem('atlyx_tema_version', version);
    localStorage.setItem(key, 'fiord');
    return 'fiord';
  }
  return localStorage.getItem(key) || 'fiord';
}

// ── mapa ─────────────────────────────────────────────────────────────────────
// Centro inicial: San Juan del Río, Querétaro. Se reencuadra en cuanto llega
// la primera posición real.
const mapa = L.map('mapa', { zoomControl: true, attributionControl: true }).setView([20.3897, -99.9961], 13);

const TEMAS_MAPA = {
  fiord: {
    type: 'vector', style: 'https://tiles.openfreemap.org/styles/fiord',
    attribution: '&copy; OpenFreeMap &copy; OpenMapTiles &copy; OpenStreetMap',
  },
  darkmatter: {
    type: 'vector', style: 'https://tiles.openfreemap.org/styles/dark',
    attribution: '&copy; OpenFreeMap &copy; OpenMapTiles &copy; OpenStreetMap',
  },
  positron: {
    type: 'vector', style: 'https://tiles.openfreemap.org/styles/positron',
    attribution: '&copy; OpenFreeMap &copy; OpenMapTiles &copy; OpenStreetMap',
  },
  calles: {
    type: 'raster',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: { maxZoom: 19, attribution: '&copy; colaboradores de OpenStreetMap' },
  },
  satelite: {
    type: 'raster',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 19, attribution: 'Tiles &copy; Esri' },
  },
};

let capaBase = crearCapaBase(estado.temaMapa).addTo(mapa);

function crearCapaBase(tema) {
  const def = TEMAS_MAPA[tema] ?? TEMAS_MAPA.fiord;
  if (def.type === 'vector' && L.maplibreGL) {
    return L.maplibreGL({
      style: def.style,
      attributionControl: { customAttribution: def.attribution },
    });
  }
  // Un bloqueador puede impedir cargar el plugin GL: el mapa clásico evita
  // que la pantalla quede vacía y permite seguir operando la flotilla.
  if (def.type === 'vector') return L.tileLayer(TEMAS_MAPA.calles.url, TEMAS_MAPA.calles.options);
  return L.tileLayer(def.url, def.options);
}

// ── shell móvil ─────────────────────────────────────────────────────────────
const mediaMovil = window.matchMedia('(max-width: 820px)');

function esMovil() {
  return mediaMovil.matches;
}

function actualizarNavegacionMovil(vista) {
  estado.vistaMovil = vista;
  document.querySelectorAll('[data-vista-movil]').forEach((button) => {
    const active = button.dataset.vistaMovil === vista;
    button.classList.toggle('activo', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function actualizarPanelMovil(open) {
  const sidebar = document.getElementById('sidebar');
  sidebar.classList.toggle('abierto', open);
  document.body.classList.toggle('panel-movil-abierto', open);
  const toggle = document.getElementById('alternar-panel');
  toggle.textContent = open ? '▼' : '▲';
  toggle.setAttribute('aria-expanded', String(open));
  document.getElementById('asa-panel').setAttribute('aria-expanded', String(open));
  if (!open) actualizarNavegacionMovil('mapa');
  programarResizeMapas();
}

function mostrarVistaMovil(vista, { suave = true } = {}) {
  if (!esMovil()) return;
  if (vista === 'mapa') {
    actualizarPanelMovil(false);
    return;
  }

  let target;
  if (vista === 'gps') {
    target = estado.seleccionado ? document.getElementById('seccion-detalle') : document.getElementById('seccion-equipos');
    if (!estado.seleccionado) vista = 'equipos';
  } else if (vista === 'ruta') target = document.getElementById('seccion-recorrido');
  else target = document.getElementById('seccion-equipos');

  actualizarPanelMovil(true);
  actualizarNavegacionMovil(vista);
  requestAnimationFrame(() => {
    const content = document.getElementById('contenido-panel');
    const top = Math.max(0, target.offsetTop - content.offsetTop);
    content.scrollTo({ top, behavior: suave ? 'smooth' : 'auto' });
  });
}

let resizeMapasTimer;
function programarResizeMapas() {
  clearTimeout(resizeMapasTimer);
  resizeMapasTimer = setTimeout(() => {
    mapa.invalidateSize({ pan: false });
    estado.mapa3d?.resize();
    for (const item of estado.mapasMosaico.values()) item.map.invalidateSize({ pan: false });
  }, 320);
}

function configurarInterfazMovil() {
  document.querySelectorAll('[data-vista-movil]').forEach((button) => {
    button.addEventListener('click', () => mostrarVistaMovil(button.dataset.vistaMovil));
  });

  const handle = document.getElementById('asa-panel');
  let pointerStartY = null;
  let ignorarClickHandle = false;
  handle.addEventListener('click', () => {
    if (ignorarClickHandle) {
      ignorarClickHandle = false;
      return;
    }
    actualizarPanelMovil(!document.getElementById('sidebar').classList.contains('abierto'));
  });
  handle.addEventListener('pointerdown', (event) => {
    pointerStartY = event.clientY;
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener('pointerup', (event) => {
    if (pointerStartY === null) return;
    const movement = event.clientY - pointerStartY;
    pointerStartY = null;
    if (Math.abs(movement) > 35) ignorarClickHandle = true;
    if (movement > 35) actualizarPanelMovil(false);
    else if (movement < -35) mostrarVistaMovil(estado.seleccionado ? 'gps' : 'equipos');
  });
  handle.addEventListener('pointercancel', () => { pointerStartY = null; });

  mediaMovil.addEventListener?.('change', () => {
    if (!esMovil()) {
      document.getElementById('sidebar').classList.remove('abierto');
      document.body.classList.remove('panel-movil-abierto');
    } else actualizarNavegacionMovil('mapa');
    programarResizeMapas();
  });
  window.addEventListener('orientationchange', programarResizeMapas);
  window.visualViewport?.addEventListener('resize', programarResizeMapas);
}

// ── utilidades de formato ────────────────────────────────────────────────────
// Todo se guarda en UTC; aquí y solo aquí se convierte a la zona de la interfaz.
function fmtFecha(iso) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone: estado.config.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function fmtHora(iso) {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone: estado.config.timezone,
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function desdeHace(iso) {
  if (!iso) return 'nunca';
  const seg = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seg < 0) return 'en el futuro';
  if (seg < 60) return `hace ${seg} s`;
  const min = Math.floor(seg / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h ${min % 60} min`;
  const d = Math.floor(h / 24);
  return `hace ${d} d ${h % 24} h`;
}

/** Semáforo: verde <5 min, ámbar <30 min, rojo si más. Gris si nunca reportó. */
function claseEstado(device) {
  const ref = device.last_seen_at ?? device.telemetry_updated_at ?? device.last_position?.server_time;
  if (!ref) return 'gris';
  const min = (Date.now() - new Date(ref).getTime()) / 60000;
  if (min < estado.config.umbrales.verde_min) return 'verde';
  if (min < estado.config.umbrales.ambar_min) return 'ambar';
  return 'rojo';
}

const COLOR_ESTADO = { verde: '#2ecc71', ambar: '#f5a623', rojo: '#e74c3c', gris: '#5a6572' };

function nombre(device) {
  return device.alias || device.placa || device.imei;
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function num(v, dec = 0, sufijo = '') {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return Number(v).toFixed(dec) + sufijo;
}

// ── API ──────────────────────────────────────────────────────────────────────
async function api(ruta, opciones) {
  const res = await fetch(ruta, { credentials: 'same-origin', ...opciones });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('sesión expirada');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── lista de equipos ─────────────────────────────────────────────────────────
function renderLista() {
  const cont = document.getElementById('lista');
  const equipos = [...estado.equipos.values()];
  document.getElementById('conteo').textContent = equipos.length;

  if (equipos.length === 0) {
    cont.innerHTML = '<div class="vacio">Todavía no hay equipos. En cuanto uno se conecte aparece aquí solo.</div>';
    return;
  }

  const orden = { verde: 0, ambar: 1, rojo: 2, gris: 3 };
  equipos.sort((a, b) => orden[claseEstado(a)] - orden[claseEstado(b)] || nombre(a).localeCompare(nombre(b)));

  cont.innerHTML = equipos
    .map((d) => {
      const p = d.last_position;
      const ref = d.last_seen_at ?? p?.server_time ?? p?.device_time;
      return `
      <div class="equipo ${estado.seleccionado === d.imei ? 'seleccionado' : ''}" data-imei="${esc(d.imei)}">
        <span class="punto ${claseEstado(d)}"></span>
        <div class="datos">
          <div class="nombre">${esc(nombre(d))}${d.activo ? '' : '<span class="inactivo-tag">sin activar</span>'}</div>
          <div class="sub">${esc(desdeHace(ref))}${p && !p.valid ? ' · sin fix' : ''}</div>
        </div>
        <div class="vel">${p ? num(p.speed_kmh, 0, ' km/h') : '—'}</div>
        <button class="vigilar ${estado.vigilados.has(d.imei) ? 'activo' : ''}" data-vigilar="${esc(d.imei)}"
          type="button" title="${estado.vigilados.has(d.imei) ? 'Quitar del mosaico' : 'Agregar al mosaico'}"
          aria-label="${estado.vigilados.has(d.imei) ? 'Quitar del mosaico' : 'Agregar al mosaico'}">${estado.vigilados.has(d.imei) ? '◉' : '◎'}</button>
      </div>`;
    })
    .join('');

  cont.querySelectorAll('.equipo').forEach((el) => {
    el.addEventListener('click', () => seleccionar(el.dataset.imei, true));
  });
  cont.querySelectorAll('[data-vigilar]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      alternarVigilado(button.dataset.vigilar);
    });
  });
}

// ── detalle ──────────────────────────────────────────────────────────────────
function renderDetalle() {
  const sec = document.getElementById('seccion-detalle');
  const cont = document.getElementById('detalle');
  const d = estado.equipos.get(estado.seleccionado);

  if (!d) {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;

  const p = d.last_position;
  const attrs = p?.attributes ?? {};
  const telemetria = { ...(attrs ?? {}), ...(d.telemetry ?? {}) };
  const bateria = telemetria.bateria;

  const filas = [
    ['IMEI', esc(d.imei)],
    ['Placa', esc(d.placa || '—')],
    ['Estado', d.activo ? 'activo' : '<span style="color:var(--ambar)">sin activar</span>'],
    ['Último contacto', `${esc(fmtFecha(d.last_seen_at))}<br><span style="color:var(--texto-2)">${esc(desdeHace(d.last_seen_at))}</span>`],
  ];

  if (p) {
    filas.push(
      ['Última posición válida', `${esc(fmtFecha(p.device_time ?? p.server_time))}<br><span style="color:var(--texto-2)">${esc(desdeHace(p.device_time ?? p.server_time))}</span>`],
      ['Coordenadas', p.latitude !== null ? `${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}` : '<span style="color:var(--ambar)">sin fix</span>'],
      ['Velocidad', num(p.speed_kmh, 1, ' km/h')],
      ['Rumbo', p.course === null ? '—' : num(p.course, 0, '°')],
      ['Satélites', p.satellites ?? '—'],
      ['Altitud', p.altitude === null ? '—' : num(p.altitude, 0, ' m')],
      ['Protocolo', esc(p.protocol ?? '—') + (attrs.protocol_number ? ` (${esc(attrs.protocol_number)})` : '') + (attrs.msg_id ? ` (${esc(attrs.msg_id)})` : '')],
      ['Fix GPS', p.valid ? '<span style="color:var(--verde)">sí</span>' : '<span style="color:var(--ambar)">no</span>'],
    );

    if (bateria) {
      filas.push([
        'Batería',
        `<div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
           <div class="barra-bateria"><i style="width:${Number(bateria.porcentaje_aprox ?? 0)}%"></i></div>
           <span>${esc(bateria.etiqueta)} (${bateria.nivel}/${bateria.escala_max ?? 6}, ~${bateria.porcentaje_aprox ?? '—'}%)</span>
         </div>`,
      ]);
    }
    if (telemetria.gsm_signal !== undefined) filas.push(['Señal GSM', `${telemetria.gsm_signal}/4`]);
    if (telemetria.terminal?.acc_encendido !== undefined) filas.push(['ACC', telemetria.terminal.acc_encendido ? 'encendido' : 'apagado']);
    if (telemetria.acc_encendido !== undefined) filas.push(['ACC', telemetria.acc_encendido ? 'encendido' : 'apagado']);
    if (telemetria.odometro?.kilometros_estimados !== undefined) filas.push(['Odómetro', num(telemetria.odometro.kilometros_estimados, 3, ' km')]);
  } else {
    filas.push(['Último reporte', 'todavía no reporta']);
  }

  let html = filas.map(([k, v]) => `<div class="fila"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('');

  if (attrs.unmapped) {
    html += `<div class="aviso">Esta trama trae bytes <b>sin mapear</b>. Míralos en el panel de depuración.</div>`;
  }
  if (attrs.crc_invalido) {
    html += `<div class="errores">La última trama llegó con <b>CRC inválido</b>. Los valores pueden no ser confiables.</div>`;
  }
  if (attrs.coordenadas_descartadas) {
    html += `<div class="aviso">Se descartaron coordenadas imposibles (${esc(attrs.coordenadas_descartadas.motivo)}). No se dibuja punto en el mapa.</div>`;
  }

  cont.innerHTML = html;
  document.getElementById('limite-velocidad').value = d.speed_limit_kmh ?? '';
  document.getElementById('intervalo-reporte').value = d.report_interval_seconds ?? '';
}

// ── panel de depuración ──────────────────────────────────────────────────────
function renderDepuracion() {
  const cont = document.getElementById('cuerpo-depuracion');
  const imei = estado.seleccionado;
  if (!imei) {
    cont.innerHTML = '<div class="vacio" style="padding:0">Selecciona un equipo para ver su último paquete.</div>';
    return;
  }

  const lista = estado.paquetes.get(imei) ?? [];
  if (lista.length === 0) {
    cont.innerHTML =
      '<div class="vacio" style="padding:0">Sin paquetes en memoria para este equipo. ' +
      'Aparecen aquí en cuanto llegue uno (o tras reiniciar el servidor, con el primero nuevo).</div>';
    return;
  }

  const p = lista[0];
  const crc = p.crc_ok === null ? '' : p.crc_ok
    ? '<span class="pastilla viva">CRC ok</span>'
    : '<span class="pastilla muerta">CRC inválido</span>';

  let html = `
    <div class="fila"><span class="k">Recibido</span><span class="v">${esc(fmtHora(p.recibido_en))}</span></div>
    <div class="fila"><span class="k">Protocolo</span><span class="v">${esc(p.protocolo)} · ${esc(p.tipo)} ${crc}</span></div>
    <div style="margin:8px 0 4px;color:var(--texto-2);font-size:11px;text-transform:uppercase;letter-spacing:.6px">Trama cruda</div>
    <div class="hex">${formatearHex(p.raw_hex)}</div>`;

  if (p.errores?.length) {
    html += `<div class="errores">${p.errores.map((e) => esc(e)).join('<br>')}</div>`;
  }

  if (p.campos?.length) {
    html += `
      <div style="margin:10px 0 0;color:var(--texto-2);font-size:11px;text-transform:uppercase;letter-spacing:.6px">Campo por campo</div>
      <table class="campos">
        <thead><tr><th>Off</th><th>Bytes</th><th>Campo</th><th>Valor</th></tr></thead>
        <tbody>
          ${p.campos.map(filaCampo).join('')}
        </tbody>
      </table>`;
  }

  const sinMapear = p.attributes?.unmapped;
  if (sinMapear) {
    html += `<div class="aviso"><b>Sin mapear:</b> ${esc(sinMapear.nota ?? 'bytes sin significado confirmado')}
      ${sinMapear.hex ? `<div class="hex" style="margin-top:6px">${formatearHex(sinMapear.hex)}</div>` : ''}</div>`;
  }

  html += `
    <div style="margin-top:10px" class="botonera">
      <button class="btn pequeno" id="copiar-hex" type="button">Copiar hex</button>
      <button class="btn pequeno" id="ver-attrs" type="button">Ver attributes</button>
    </div>
    <pre id="attrs-json" class="hex" style="display:none;margin-top:8px;max-height:220px;white-space:pre-wrap">${esc(JSON.stringify(p.attributes, null, 2))}</pre>
    <div style="margin-top:8px;color:var(--texto-2);font-size:11px">Últimos ${lista.length} paquete(s) en memoria. El histórico completo está en <code>positions.raw_hex</code>.</div>`;

  cont.innerHTML = html;

  document.getElementById('copiar-hex')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(p.raw_hex ?? '');
  });
  document.getElementById('ver-attrs')?.addEventListener('click', () => {
    const pre = document.getElementById('attrs-json');
    pre.style.display = pre.style.display === 'none' ? 'block' : 'none';
  });
}

function filaCampo(c) {
  const clase = c.nombre === 'unmapped' ? 'sin-mapear' : c.derivado ? 'derivado' : '';
  const off = c.offset === null || c.offset === undefined ? '·' : c.offset;
  return `<tr class="${clase}">
    <td class="mono">${off}</td>
    <td class="mono">${esc(c.hex || '·')}</td>
    <td>${esc(c.nombre)}${c.nota ? `<span class="nota">${esc(c.nota)}</span>` : ''}</td>
    <td>${esc(c.valor)}</td>
  </tr>`;
}

function formatearHex(hex) {
  if (!hex) return '—';
  return (hex.match(/.{1,2}/g) ?? []).join(' ');
}

// ── marcadores ───────────────────────────────────────────────────────────────
function iconoMarcador(device) {
  const color = COLOR_ESTADO[claseEstado(device)];
  const p = device.last_position;
  const rumbo = p?.course;
  const flecha = rumbo === null || rumbo === undefined
    ? ''
    : `<i class="flecha" style="transform: rotate(${rumbo}deg) translateY(-17px)"></i>`;
  return L.divIcon({
    className: '',
    html: `<div class="marcador" style="color:${color};position:relative">
             ${flecha}<span class="cuerpo"></span>
             <span class="etiqueta">${esc(nombre(device))}</span>
           </div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function actualizarMarcador(device) {
  const p = device.last_position;
  if (!p || p.latitude === null || p.longitude === null) {
    // Sin fix: quitamos el marcador en vez de dejarlo en una posición vieja
    // haciéndose pasar por actual.
    const viejo = estado.marcadores.get(device.imei);
    if (viejo) {
      mapa.removeLayer(viejo);
      estado.marcadores.delete(device.imei);
    }
    return;
  }

  const latlng = [p.latitude, p.longitude];
  let m = estado.marcadores.get(device.imei);
  if (m) {
    m.setLatLng(latlng);
    m.setIcon(iconoMarcador(device));
  } else {
    m = L.marker(latlng, { icon: iconoMarcador(device) }).addTo(mapa);
    m.on('click', () => seleccionar(device.imei, false));
    estado.marcadores.set(device.imei, m);
  }
  m.bindPopup(
    `<b>${esc(nombre(device))}</b><br>${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}<br>` +
      `${num(p.speed_kmh, 1, ' km/h')} · ${esc(fmtHora(p.device_time ?? p.server_time))}`,
  );

  if (estado.siguiendo && estado.seleccionado === device.imei && estado.modoVista === '2d') {
    mapa.panTo(latlng, { animate: true, duration: 0.8 });
  }
  actualizarGps3d(device);
  actualizarGpsMosaico(device);
}

function encuadrarTodo() {
  const puntos = [...estado.marcadores.values()].map((m) => m.getLatLng());
  if (puntos.length === 0) return;
  if (puntos.length === 1) mapa.setView(puntos[0], 15);
  else mapa.fitBounds(L.latLngBounds(puntos).pad(0.2));
}

function cambiarTemaMapa(tema) {
  if (!TEMAS_MAPA[tema]) return;
  estado.temaMapa = tema;
  localStorage.setItem('atlyx_tema_mapa', tema);
  if (capaBase) mapa.removeLayer(capaBase);
  capaBase = crearCapaBase(tema).addTo(mapa);
  capaBase.bringToBack?.();
  for (const item of estado.mapasMosaico.values()) {
    item.map.removeLayer(item.tile);
    item.tile = crearCapaBase(tema).addTo(item.map);
    item.tile.bringToBack?.();
  }
  if (estado.mapa3d) {
    estado.mapa3d.setStyle(mapa3dStyle());
    estado.mapa3d.once('style.load', () => {
      asegurarTerreno3d();
      sincronizarEstela3d();
    });
  }
}

function alternarSeguimiento() {
  if (!estado.seleccionado) {
    document.getElementById('info-recorrido').textContent = 'Selecciona un GPS para seguirlo.';
    return;
  }
  estado.siguiendo = !estado.siguiendo;
  const button = document.getElementById('seguir-gps');
  button.classList.toggle('activo', estado.siguiendo);
  button.setAttribute('aria-pressed', String(estado.siguiendo));
  button.textContent = estado.siguiendo ? '◉ Siguiendo' : '◎ Seguir';
  if (estado.siguiendo) centrarSeleccionado();
}

function centrarSeleccionado() {
  const device = estado.equipos.get(estado.seleccionado);
  const p = device?.last_position;
  if (!p || p.latitude === null || p.longitude === null) return;
  if (estado.modoVista === '3d' && estado.mapa3d) {
    estado.mapa3d.easeTo({ center: [p.longitude, p.latitude], zoom: Math.max(estado.mapa3d.getZoom(), 17),
      bearing: p.course ?? estado.mapa3d.getBearing(), pitch: 67, duration: 900 });
  } else if (estado.modoVista === '2d') {
    mapa.setView([p.latitude, p.longitude], Math.max(mapa.getZoom(), 16), { animate: true });
  }
}

function alternarVigilado(imei) {
  if (estado.vigilados.has(imei)) estado.vigilados.delete(imei);
  else estado.vigilados.add(imei);
  localStorage.setItem('atlyx_gps_vigilados', JSON.stringify([...estado.vigilados]));
  renderLista();
  if (estado.modoVista === 'mosaico') renderMosaico();
}

function destruirMosaico() {
  for (const item of estado.mapasMosaico.values()) item.map.remove();
  estado.mapasMosaico.clear();
  document.getElementById('mosaico').replaceChildren();
}

function renderMosaico() {
  destruirMosaico();
  const container = document.getElementById('mosaico');
  const devices = [...estado.vigilados].map((imei) => estado.equipos.get(imei)).filter(Boolean);
  if (devices.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mosaico-vacio';
    empty.innerHTML = '<div><b>Selecciona los GPS que quieres vigilar</b><br>Usa el botón ◎ junto a cada equipo.</div>';
    container.append(empty);
    return;
  }
  for (const device of devices) {
    const card = document.createElement('article');
    card.className = 'mosaico-tarjeta';
    const mapElement = document.createElement('div');
    mapElement.className = 'mosaico-mapa';
    const label = document.createElement('div');
    label.className = 'mosaico-etiqueta';
    label.innerHTML = `<span><b>${esc(nombre(device))}</b></span><span>${num(device.last_position?.speed_kmh, 0, ' km/h')}</span>`;
    card.append(mapElement, label);
    container.append(card);
    const p = device.last_position;
    const center = p && p.latitude !== null ? [p.latitude, p.longitude] : [20.3897, -99.9961];
    const miniMap = L.map(mapElement, { zoomControl: false, attributionControl: false, dragging: true }).setView(center, p ? 16 : 12);
    const tile = crearCapaBase(estado.temaMapa).addTo(miniMap);
    let marker = null;
    if (p && p.latitude !== null) marker = L.marker(center, { icon: iconoMarcador(device) }).addTo(miniMap);
    estado.mapasMosaico.set(device.imei, { map: miniMap, marker, tile, label });
  }
}

function actualizarGpsMosaico(device) {
  const item = estado.mapasMosaico.get(device.imei);
  const p = device.last_position;
  if (!item || !p || p.latitude === null) return;
  const latlng = [p.latitude, p.longitude];
  if (item.marker) {
    item.marker.setLatLng(latlng).setIcon(iconoMarcador(device));
  } else {
    item.marker = L.marker(latlng, { icon: iconoMarcador(device) }).addTo(item.map);
  }
  item.map.panTo(latlng, { animate: true, duration: 0.8 });
  item.label.lastElementChild.textContent = num(p.speed_kmh, 0, ' km/h');
}

function mapa3dStyle() {
  const def = TEMAS_MAPA[estado.temaMapa] ?? TEMAS_MAPA.fiord;
  if (def.type === 'vector') return def.style;
  return {
    version: 8,
    sources: {
      base: { type: 'raster', tiles: [def.url.replace('{s}', 'a').replace('{r}', '')], tileSize: 256,
        maxzoom: def.options.maxZoom, attribution: def.options.attribution },
      terrain: { type: 'raster-dem', url: 'https://tiles.mapterhorn.com/tilejson.json', tileSize: 256 },
    },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
    terrain: { source: 'terrain', exaggeration: 1.15 },
    sky: {},
  };
}

function asegurarTerreno3d() {
  const map3d = estado.mapa3d;
  if (!map3d?.isStyleLoaded()) return;
  if (!map3d.getSource('terrain')) {
    map3d.addSource('terrain', {
      type: 'raster-dem', url: 'https://tiles.mapterhorn.com/tilejson.json', tileSize: 256,
    });
  }
  map3d.setTerrain({ source: 'terrain', exaggeration: 1.15 });
}

function asegurarMapa3d() {
  if (estado.mapa3d || !window.maplibregl) return;
  estado.mapa3d = new maplibregl.Map({
    container: 'mapa-3d', style: mapa3dStyle(), center: [-99.9961, 20.3897], zoom: 16,
    pitch: 67, bearing: 0, maxPitch: 85, attributionControl: true,
  });
  estado.mapa3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  estado.mapa3d.on('load', () => {
    asegurarTerreno3d();
    sincronizarEstela3d();
    actualizarGps3d(estado.equipos.get(estado.seleccionado));
  });
}

function sincronizarEstela3d() {
  const map3d = estado.mapa3d;
  if (!map3d?.isStyleLoaded()) return;
  const coordinates = estado.coordenadasRecorrido
    .filter((segment) => segment.length >= 2)
    .map((segment) => segment.map(([lat, lon]) => [lon, lat]));
  const geojson = coordinates.length
    ? { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates } }
    : { type: 'FeatureCollection', features: [] };
  if (map3d.getSource('estela')) map3d.getSource('estela').setData(geojson);
  else {
    map3d.addSource('estela', { type: 'geojson', data: geojson });
    map3d.addLayer({ id: 'estela-halo', type: 'line', source: 'estela', paint: { 'line-color': '#06121f', 'line-width': 8, 'line-opacity': .65 } });
    map3d.addLayer({ id: 'estela-linea', type: 'line', source: 'estela', paint: { 'line-color': '#3fa7ff', 'line-width': 4 } });
  }
}

function actualizarGps3d(device) {
  if (!device || estado.modoVista !== '3d' || !estado.mapa3d) return;
  const p = device.last_position;
  if (!p || p.latitude === null) return;
  const lngLat = [p.longitude, p.latitude];
  if (!estado.marcador3d) {
    const el = document.createElement('div');
    el.className = 'marcador-3d';
    estado.marcador3d = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(estado.mapa3d);
  } else estado.marcador3d.setLngLat(lngLat);
  if (estado.siguiendo) estado.mapa3d.easeTo({ center: lngLat, zoom: Math.max(estado.mapa3d.getZoom(), 17),
    bearing: p.course ?? estado.mapa3d.getBearing(), pitch: 67, duration: 900 });
}

function cambiarModoVista(mode) {
  if (mode === '3d' && !window.maplibregl) {
    document.getElementById('info-recorrido').textContent = 'La vista 3D no pudo cargar. Se mantiene el mapa 2D.';
    mode = '2d';
  }
  estado.modoVista = mode;
  document.getElementById('mapa').hidden = mode !== '2d';
  document.getElementById('mapa-3d').hidden = mode !== '3d';
  document.getElementById('mosaico').hidden = mode !== 'mosaico';
  document.getElementById('vista-3d').classList.toggle('activo', mode === '3d');
  document.getElementById('vista-mosaico').classList.toggle('activo', mode === 'mosaico');
  document.getElementById('vista-3d').setAttribute('aria-pressed', String(mode === '3d'));
  document.getElementById('vista-mosaico').setAttribute('aria-pressed', String(mode === 'mosaico'));
  if (mode === '2d') setTimeout(() => { mapa.invalidateSize(); centrarSeleccionado(); }, 0);
  if (mode === '3d') {
    asegurarMapa3d();
    setTimeout(() => { estado.mapa3d?.resize(); centrarSeleccionado(); }, 0);
  }
  if (mode === 'mosaico') renderMosaico();
}

// ── selección ────────────────────────────────────────────────────────────────
async function seleccionar(imei, centrar) {
  estado.seleccionado = imei;
  renderLista();
  renderDetalle();
  renderDepuracion();
  mostrarVistaMovil('gps');

  const m = estado.marcadores.get(imei);
  if (centrar && m) mapa.setView(m.getLatLng(), Math.max(mapa.getZoom(), 15));
  const selectedDevice = estado.equipos.get(imei);
  if (estado.modoVista === '3d') {
    actualizarGps3d(selectedDevice);
    if (centrar && selectedDevice?.last_position && estado.mapa3d) {
      estado.mapa3d.easeTo({ center: [selectedDevice.last_position.longitude, selectedDevice.last_position.latitude],
        zoom: Math.max(estado.mapa3d.getZoom(), 17), pitch: 67, duration: 700 });
    }
  }
  if (estado.siguiendo) centrarSeleccionado();

  // Traemos los paquetes de depuración de este equipo (los que ya estaban en
  // memoria del servidor antes de que abriéramos la interfaz).
  try {
    const data = await api(`/api/devices/${encodeURIComponent(imei)}/debug`);
    if (data.paquetes?.length) {
      estado.paquetes.set(imei, data.paquetes);
      if (estado.seleccionado === imei) renderDepuracion();
    }
  } catch (err) {
    console.warn('no se pudieron traer los paquetes de depuración:', err.message);
  }
  await cargarComandos(imei);
  // La estela de las últimas seis horas aparece al seleccionar, sin exigir un
  // clic adicional. Los controles permiten ampliar o reducir el rango.
  const fin = new Date();
  document.getElementById('hasta').value = fechaLocalAInput(fin);
  document.getElementById('desde').value = fechaLocalAInput(new Date(fin.getTime() - 6 * 3600 * 1000));
  cargarRecorrido();
}

// ── recorrido ────────────────────────────────────────────────────────────────
function fechaLocalAInput(d) {
  // datetime-local trabaja en la zona del navegador. Convertimos la fecha a la
  // zona de la interfaz para que lo que se escribe sea lo que se ve en el mapa.
  const partes = new Intl.DateTimeFormat('sv-SE', {
    timeZone: estado.config.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const v = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}T${v.hour}:${v.minute}`;
}

/** Interpreta un valor de datetime-local COMO hora de la zona de la interfaz. */
function inputAIso(valor) {
  if (!valor) return null;
  // Se calcula el desfase real de la zona en esa fecha (respeta horario de verano).
  const tentativa = new Date(`${valor}:00Z`);
  const enZona = new Date(tentativa.toLocaleString('en-US', { timeZone: estado.config.timezone }));
  const enUtc = new Date(tentativa.toLocaleString('en-US', { timeZone: 'UTC' }));
  const desfase = enZona.getTime() - enUtc.getTime();
  return new Date(tentativa.getTime() - desfase).toISOString();
}

async function cargarRecorrido() {
  const imei = estado.seleccionado;
  const info = document.getElementById('info-recorrido');
  if (!imei) {
    info.textContent = 'Selecciona primero un equipo.';
    return;
  }

  const desde = inputAIso(document.getElementById('desde').value);
  const hasta = inputAIso(document.getElementById('hasta').value);

  const params = new URLSearchParams({ limit: '5000', solo_validas: '1' });
  if (document.getElementById('ajustar-calles').checked) params.set('ajustar_calles', '1');
  if (desde) params.set('desde', desde);
  if (hasta) params.set('hasta', hasta);

  info.textContent = 'Cargando…';
  try {
    const data = await api(`/api/devices/${encodeURIComponent(imei)}/positions?${params}`);
    limpiarRecorrido();

    const puntos = data.positions
      .filter((p) => p.latitude !== null && p.longitude !== null)
      .map((p) => [p.latitude, p.longitude, p]);

    if (puntos.length === 0) {
      info.textContent = 'No hay posiciones con fix en ese rango.';
      return;
    }

    const segmentos = data.trace?.segments?.some((segment) => segment.length >= 2)
      ? data.trace.segments
      : [puntos.map((p) => [p[0], p[1]])];
    estado.coordenadasRecorrido = segmentos;
    estado.recorrido = L.polyline(segmentos, {
      color: '#3fa7ff',
      weight: 3,
      opacity: 0.85,
    }).addTo(mapa);
    sincronizarEstela3d();

    estado.puntosRecorrido = L.layerGroup(
      puntos.map(([lat, lon, p]) =>
        L.circleMarker([lat, lon], { radius: 3, color: '#3fa7ff', fillOpacity: 0.9, weight: 1 }).bindPopup(
          `${esc(fmtFecha(p.device_time ?? p.server_time))}<br>${num(p.speed_kmh, 1, ' km/h')} · ${p.satellites ?? '—'} sat`,
        ),
      ),
    ).addTo(mapa);

    mapa.fitBounds(estado.recorrido.getBounds().pad(0.15));
    const calidad = data.trace
      ? data.trace.matched
        ? ` · ajustada a calles${data.trace.partial ? ' parcialmente' : ''}`
        : ` · GPS filtrado${data.trace.error ? ' (ajuste no disponible)' : ''}`
      : '';
    info.innerHTML = `${puntos.length} punto(s)${calidad} · ${esc(fmtFecha(data.positions[0].device_time ?? data.positions[0].server_time))} → ${esc(fmtFecha(data.positions.at(-1).device_time ?? data.positions.at(-1).server_time))}`;
  } catch (err) {
    info.textContent = 'Error: ' + err.message;
  }
}

function limpiarRecorrido() {
  if (estado.recorrido) {
    mapa.removeLayer(estado.recorrido);
    estado.recorrido = null;
  }
  if (estado.puntosRecorrido) {
    mapa.removeLayer(estado.puntosRecorrido);
    estado.puntosRecorrido = null;
  }
  estado.coordenadasRecorrido = [];
  sincronizarEstela3d();
}

// ── WebSocket ────────────────────────────────────────────────────────────────
function conectarWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  estado.ws = ws;

  const pastilla = document.getElementById('estado-ws');

  ws.addEventListener('open', () => {
    estado.reintentoWs = 1000;
    pastilla.textContent = 'en vivo';
    pastilla.className = 'pastilla viva';
  });

  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (m.tipo === 'posicion') {
      if (m.device?.archived_at) {
        const marker = estado.marcadores.get(m.imei);
        if (marker) mapa.removeLayer(marker);
        estado.marcadores.delete(m.imei);
        estado.equipos.delete(m.imei);
        if (estado.seleccionado === m.imei) estado.seleccionado = null;
        renderLista();
        renderDetalle();
        return;
      }
      const previo = estado.equipos.get(m.imei) ?? m.device;
      // Un paquete sin fix no debe borrar la última coordenada confiable.
      const usable = m.position?.valid && m.position.latitude !== null && m.position.longitude !== null;
      const device = { ...previo, ...m.device, last_position: usable ? m.position : previo.last_position };
      device.last_seen_at = m.position?.server_time ?? new Date().toISOString();
      estado.equipos.set(m.imei, device);
      actualizarMarcador(device);
      if (usable && estado.seleccionado === m.imei && estado.recorrido) {
        const coordinate = [m.position.latitude, m.position.longitude];
        estado.recorrido.addLatLng(coordinate);
        if (!estado.coordenadasRecorrido.length) estado.coordenadasRecorrido.push([]);
        estado.coordenadasRecorrido.at(-1).push(coordinate);
        sincronizarEstela3d();
      }
      renderLista();
      if (estado.seleccionado === m.imei) renderDetalle();
      if (!estado.yaCentro) {
        estado.yaCentro = true;
        encuadrarTodo();
      }
    }

    if (m.tipo === 'telemetria') {
      const d = estado.equipos.get(m.imei);
      if (d) {
        d.telemetry = m.telemetry;
        d.telemetry_updated_at = m.telemetry_updated_at;
        d.last_seen_at = m.telemetry_updated_at;
        renderLista();
        if (estado.seleccionado === m.imei) renderDetalle();
      }
    }

    if (m.tipo === 'alerta') {
      const d = estado.equipos.get(m.imei);
      const label = nombre(d ?? { imei: m.imei });
      const detalle = m.alerta === 'alerta:exceso_velocidad'
        ? `exceso de velocidad (${m.data.velocidad_kmh} / ${m.data.limite_kmh} km/h)`
        : m.alerta.replace(/^alarma:/, '').replaceAll('_', ' ');
      document.getElementById('info-recorrido').textContent = `⚠ ${label}: ${detalle}`;
      if (window.Notification?.permission === 'granted') new Notification(`Alerta GPS — ${label}`, { body: detalle });
    }

    if (m.tipo === 'comando') {
      const list = estado.comandos.get(m.imei) ?? [];
      const index = list.findIndex((c) => c.id === m.command.id);
      if (index >= 0) list[index] = m.command; else list.unshift(m.command);
      estado.comandos.set(m.imei, list);
      if (estado.seleccionado === m.imei) {
        renderComandos();
        document.getElementById('info-ajustes').textContent = `Comando ${m.command.status}: ${m.command.response_text ?? ''}`;
      }
    }

    if (m.tipo === 'paquete' && m.imei) {
      const lista = estado.paquetes.get(m.imei) ?? [];
      lista.unshift(m.paquete);
      if (lista.length > 20) lista.length = 20;
      estado.paquetes.set(m.imei, lista);
      if (estado.seleccionado === m.imei) renderDepuracion();
    }
  });

  ws.addEventListener('close', () => {
    pastilla.textContent = 'sin conexión';
    pastilla.className = 'pastilla muerta';
    // Reintento con espera creciente, tope 30 s.
    setTimeout(conectarWs, estado.reintentoWs);
    estado.reintentoWs = Math.min(estado.reintentoWs * 2, 30000);
  });

  ws.addEventListener('error', () => ws.close());
}

// ── arranque ─────────────────────────────────────────────────────────────────
async function cargarEquipos() {
  const data = await api('/api/devices');
  estado.equipos = new Map(data.devices.map((d) => [d.imei, d]));
  for (const d of estado.equipos.values()) actualizarMarcador(d);
  renderLista();
  if (!estado.yaCentro && estado.marcadores.size > 0) {
    estado.yaCentro = true;
    encuadrarTodo();
  }
  if (estado.seleccionado) {
    renderDetalle();
  }
}

async function iniciar() {
  configurarInterfazMovil();
  try {
    estado.config = await api('/api/config');
  } catch {
    /* se usan los valores por omisión */
  }

  const ahora = new Date();
  document.getElementById('hasta').value = fechaLocalAInput(ahora);
  document.getElementById('desde').value = fechaLocalAInput(new Date(ahora.getTime() - 6 * 3600 * 1000));

  await cargarEquipos().catch((err) => {
    document.getElementById('lista').innerHTML = `<div class="vacio">Error al cargar: ${esc(err.message)}</div>`;
  });

  conectarWs();

  // Refresco de respaldo: si el WebSocket se cae, la lista no se queda vieja.
  // También recalcula el semáforo de estado con el paso del tiempo.
  setInterval(() => {
    renderLista();
    if (estado.seleccionado) renderDetalle();
  }, 15000);
  setInterval(() => {
    if (!estado.ws || estado.ws.readyState !== WebSocket.OPEN) cargarEquipos().catch(() => {});
  }, 60000);

  // ── eventos de la interfaz ──
  document.getElementById('cargar-recorrido').addEventListener('click', cargarRecorrido);
  document.getElementById('tema-mapa').value = estado.temaMapa;
  document.getElementById('tema-mapa').addEventListener('change', (e) => cambiarTemaMapa(e.currentTarget.value));
  document.getElementById('seguir-gps').addEventListener('click', alternarSeguimiento);
  document.getElementById('vista-3d').addEventListener('click', () => cambiarModoVista(estado.modoVista === '3d' ? '2d' : '3d'));
  document.getElementById('vista-mosaico').addEventListener('click', () => cambiarModoVista(estado.modoVista === 'mosaico' ? '2d' : 'mosaico'));
  document.getElementById('ajustar-calles').addEventListener('change', () => {
    if (estado.seleccionado) cargarRecorrido();
  });
  document.getElementById('limpiar-recorrido').addEventListener('click', () => {
    limpiarRecorrido();
    document.getElementById('info-recorrido').textContent = '';
  });

  document.querySelectorAll('[data-rango]').forEach((b) => {
    b.addEventListener('click', () => {
      const horas = Number(b.dataset.rango);
      const fin = new Date();
      document.getElementById('hasta').value = fechaLocalAInput(fin);
      document.getElementById('desde').value = fechaLocalAInput(new Date(fin.getTime() - horas * 3600 * 1000));
      cargarRecorrido();
    });
  });

  document.getElementById('salir').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    location.href = '/login';
  });

  document.getElementById('activar-notificaciones').addEventListener('click', async (e) => {
    if (!window.Notification) return (e.currentTarget.textContent = 'No compatible');
    const permission = await Notification.requestPermission();
    e.currentTarget.textContent = permission === 'granted' ? 'Alertas ON' : 'Alertas bloqueadas';
  });

  document.getElementById('guardar-ajustes').addEventListener('click', guardarAjustes);
  document.getElementById('quitar-equipo').addEventListener('click', quitarEquipo);
  document.getElementById('form-equipo').addEventListener('submit', agregarEquipo);
  document.getElementById('aplicar-intervalo').addEventListener('click', () => enviarComando('set_interval', { seconds: Number(document.getElementById('intervalo-reporte').value) }));
  document.getElementById('consultar-estado').addEventListener('click', () => enviarComando('query_status'));
  document.getElementById('consultar-parametros').addEventListener('click', () => enviarComando('query_parameters'));
  document.getElementById('vibracion-on').addEventListener('click', () => enviarComando('vibration_alarm', { enabled: true, mode: Number(document.getElementById('modo-alarma').value) }));
  document.getElementById('vibracion-off').addEventListener('click', () => enviarComando('vibration_alarm', { enabled: false }));
  document.getElementById('bateria-on').addEventListener('click', () => enviarComando('low_battery_alarm', { enabled: true, mode: Number(document.getElementById('modo-alarma').value) }));
  document.getElementById('bateria-off').addEventListener('click', () => enviarComando('low_battery_alarm', { enabled: false }));
  document.getElementById('generar-api-key').addEventListener('click', generarApiKey);

  const sidebar = document.getElementById('sidebar');
  document.getElementById('alternar-panel').addEventListener('click', (e) => {
    if (esMovil()) {
      const open = !sidebar.classList.contains('abierto');
      if (open) mostrarVistaMovil(estado.seleccionado ? 'gps' : 'equipos');
      else actualizarPanelMovil(false);
    }
  });
}

iniciar();

async function agregarEquipo(e) {
  e.preventDefault();
  const info = document.getElementById('info-equipo');
  const imei = document.getElementById('nuevo-imei').value.trim();
  if (!/^\d{15}$/.test(imei)) {
    info.textContent = 'El IMEI debe tener exactamente 15 dígitos.';
    return;
  }
  info.textContent = 'Agregando…';
  try {
    const data = await api('/api/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imei,
        alias: document.getElementById('nuevo-alias').value.trim() || null,
        placa: document.getElementById('nueva-placa').value.trim() || null,
      }),
    });
    e.currentTarget.reset();
    await cargarEquipos();
    info.textContent = data.message;
    await seleccionar(imei, true);
  } catch (err) {
    info.textContent = 'Error: ' + err.message;
  }
}

async function quitarEquipo() {
  const imei = estado.seleccionado;
  const d = estado.equipos.get(imei);
  if (!d) return;
  const confirmado = window.confirm(
    `¿Quitar ${nombre(d)} (${imei}) de la flotilla?\n\nEl historial NO se borrará y podrás restaurarlo agregando el mismo IMEI.`,
  );
  if (!confirmado) return;
  const info = document.getElementById('info-ajustes');
  try {
    const data = await api(`/api/devices/${encodeURIComponent(imei)}`, { method: 'DELETE' });
    const marker = estado.marcadores.get(imei);
    if (marker) mapa.removeLayer(marker);
    estado.marcadores.delete(imei);
    estado.equipos.delete(imei);
    estado.seleccionado = null;
    if (estado.marcador3d) {
      estado.marcador3d.remove();
      estado.marcador3d = null;
    }
    limpiarRecorrido();
    renderLista();
    renderDetalle();
    renderDepuracion();
    if (estado.modoVista === 'mosaico') renderMosaico();
    document.getElementById('info-equipo').textContent = data.message;
  } catch (err) {
    info.textContent = 'Error: ' + err.message;
  }
}

async function guardarAjustes() {
  const imei = estado.seleccionado;
  if (!imei) return;
  const info = document.getElementById('info-ajustes');
  try {
    const body = {
      speed_limit_kmh: document.getElementById('limite-velocidad').value || null,
      report_interval_seconds: document.getElementById('intervalo-reporte').value || null,
    };
    const data = await api(`/api/devices/${encodeURIComponent(imei)}/settings`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = estado.equipos.get(imei); d.speed_limit_kmh = data.device.speed_limit_kmh; d.report_interval_seconds = data.device.report_interval_seconds;
    info.textContent = 'Guardado. ' + data.aviso;
  } catch (err) { info.textContent = 'Error: ' + err.message; }
}

async function generarApiKey() {
  const result = document.getElementById('api-key-result');
  try {
    const name = document.getElementById('api-key-name').value.trim();
    const data = await api('/api/api-keys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const key = data.api_key.key;
    const base = `${location.origin}/api/v1`;
    result.innerHTML = `<b>Guárdala ahora:</b><div class="hex">${esc(key)}</div><div style="margin-top:6px">URL base: <code>${esc(base)}</code><br>Header: <code>Authorization: Bearer TU_CLAVE</code></div>`;
  } catch (err) { result.textContent = 'Error: ' + err.message; }
}

async function enviarComando(type, params = {}) {
  const imei = estado.seleccionado;
  const info = document.getElementById('info-ajustes');
  if (!imei) return;
  try {
    const data = await api(`/api/devices/${encodeURIComponent(imei)}/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, params }),
    });
    info.textContent = data.message;
    await cargarComandos(imei);
  } catch (err) { info.textContent = 'Error: ' + err.message; }
}

async function cargarComandos(imei) {
  try {
    const data = await api(`/api/devices/${encodeURIComponent(imei)}/commands?limit=20`);
    estado.comandos.set(imei, data.commands ?? []);
    if (estado.seleccionado === imei) renderComandos(data.online);
  } catch (err) { console.warn('no se pudo cargar comandos:', err.message); }
}

function renderComandos(online) {
  const el = document.getElementById('historial-comandos');
  const list = estado.comandos.get(estado.seleccionado) ?? [];
  const rows = list.slice(0, 8).map((c) => `<div class="comando-fila"><span>${esc(c.command_type)}</span><b class="estado-${esc(c.status)}">${esc(c.status)}</b>${c.response_text ? `<small>${esc(c.response_text)}</small>` : ''}</div>`).join('');
  el.innerHTML = `<div>${online === undefined ? '' : online ? '● GPS conectado' : '○ GPS offline; se encolará'}</div>${rows || '<div>Sin comandos.</div>'}`;
}
