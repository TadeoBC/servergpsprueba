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
  paradasRecorrido: null, // L.LayerGroup con tramos naranjas
  posicionesRecorrido: [], // posiciones crudas, incluidas las estacionarias
  coordenadasRecorrido: [], // segmentos [[[lat, lon], ...], ...]
  temaMapa: cargarTemaMapa(),
  modoVista: cargarModoMapa(), // 2d | 3d | mosaico
  siguiendo: false,
  vigilados: cargarVigilados(),
  mapasMosaico: new Map(), // imei -> { map, marker, tile }
  temasMosaico: cargarTemasMosaico(),
  mapa3d: null,
  marcadores3d: new Map(),
  estelasVivas: new Map(),
  capasEstelasVivas: new Map(),
  vistaMovil: 'mapa',
  vista: 'mapa',
  filtro: '',
  alertas: [],
  ws: null,
  reintentoWs: 1000,
  recorridoRequestId: 0,
  timerAjusteVivo: null,
  timerLiberar3d: null,
  yaCentro: false,
};

const renderPendiente = new Set();
let renderFrame = null;
let renderTimer = null;
let ultimoRenderLista = 0;
let ultimoRenderGlobal = 0;

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

function cargarTemasMosaico() {
  try { return JSON.parse(localStorage.getItem('atlyx_temas_mosaico') || '{}'); }
  catch { return {}; }
}

function cargarModoMapa() {
  const value = localStorage.getItem('atlyx_proyeccion_mapa');
  return value === '2d' ? '2d' : '3d';
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

const TEMAS_MOSAICO = {
  fiord: { nombre: 'Fiord', url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', options: { maxZoom: 19, attribution: '&copy; OpenStreetMap' } },
  darkmatter: { nombre: 'Oscuro', url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', options: { maxZoom: 20, attribution: '&copy; OpenStreetMap &copy; CARTO' } },
  positron: { nombre: 'Claro', url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', options: { maxZoom: 20, attribution: '&copy; OpenStreetMap &copy; CARTO' } },
  satelite: { nombre: 'Satélite', url: TEMAS_MAPA.satelite.url, options: TEMAS_MAPA.satelite.options },
  calles: { nombre: 'Calles', url: TEMAS_MAPA.calles.url, options: TEMAS_MAPA.calles.options },
};

function crearCapaMosaico(tema) {
  const def = TEMAS_MOSAICO[tema] || TEMAS_MOSAICO.calles;
  return L.tileLayer(def.url, def.options);
}

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
  else if (vista === 'alertas') target = document.getElementById('seccion-alertas');
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
    button.addEventListener('click', () => {
      const vista = button.dataset.vistaMovil;
      const equivalencias = { mapa: 'mapa', equipos: 'mapa', gps: 'telemetria', ruta: 'recorrido', alertas: 'alertas' };
      cambiarVista(equivalencias[vista] ?? 'mapa');
      mostrarVistaMovil(vista);
    });
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

function cambiarVista(vista) {
  const validas = new Set(['mapa', 'telemetria', 'recorrido', 'alertas', 'diagnostico']);
  if (!validas.has(vista)) vista = 'mapa';
  estado.vista = vista;
  document.body.dataset.vista = vista;
  localStorage.setItem('atlyx_vista', vista);
  document.querySelectorAll('#pestanas button[data-vista], #rail-nav button[data-vista]').forEach((button) => {
    const activo = button.dataset.vista === vista;
    button.classList.toggle('activo', activo);
    if (activo) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (!esMovil()) {
    const panel = document.getElementById('sidebar');
    panel.classList.toggle('abierto', vista !== 'mapa');
    document.getElementById('mostrar-panel').setAttribute('aria-expanded', String(vista !== 'mapa'));
  }
  const aviso = document.getElementById('aviso-seleccion');
  aviso.hidden = !((vista === 'telemetria' || vista === 'recorrido') && !estado.seleccionado);
  if (vista === 'telemetria') programarRender('detalle', 'telemetria');
  if (vista === 'mapa') programarRender('objetivo');
  if (vista === 'alertas') programarRender('alertas');
  if (vista === 'diagnostico') programarRender('depuracion');
  if (vista === 'recorrido') programarRender('perfil', 'recorrido');
  programarResizeMapas();
}

function programarRender(...tipos) {
  tipos.flat().forEach((tipo) => renderPendiente.add(tipo));
  if (document.hidden) return;
  if (renderFrame !== null) return;
  renderFrame = requestAnimationFrame(ejecutarRenderPendiente);
}

function ejecutarRenderPendiente() {
  renderFrame = null;
  if (document.hidden) return;
  const ahora = performance.now();
  let espera = Infinity;

  const ejecutar = (tipo, fn, visible = true, intervalo = 0) => {
    if (!renderPendiente.has(tipo)) return;
    if (!visible) {
      renderPendiente.delete(tipo);
      return;
    }
    const ultimo = tipo === 'lista' ? ultimoRenderLista : tipo === 'global' ? ultimoRenderGlobal : 0;
    if (intervalo && ahora - ultimo < intervalo) {
      espera = Math.min(espera, intervalo - (ahora - ultimo));
      return;
    }
    renderPendiente.delete(tipo);
    fn();
    if (tipo === 'lista') ultimoRenderLista = ahora;
    if (tipo === 'global') ultimoRenderGlobal = ahora;
  };

  const vista = document.body.dataset.vista;
  ejecutar('lista', renderLista, true, 250);
  ejecutar('global', renderEstadoGlobal, true, 1000);
  ejecutar('detalle', renderDetalle, vista === 'telemetria');
  ejecutar('telemetria', renderTelemetria, vista === 'telemetria');
  ejecutar('objetivo', renderObjetivo, vista === 'mapa');
  ejecutar('indicador-alertas', renderIndicadorAlertas);
  ejecutar('alertas', renderAlertas, vista === 'alertas');
  ejecutar('depuracion', renderDepuracion, vista === 'diagnostico');
  ejecutar('paradas', renderParadasRecorrido);
  ejecutar('estela', sincronizarEstela3d, estado.modoVista === '3d');
  ejecutar('perfil', renderPerfilVelocidad, vista === 'recorrido');
  ejecutar('recorrido', renderRecorrido, vista === 'recorrido');

  clearTimeout(renderTimer);
  renderTimer = null;
  if (renderPendiente.size) {
    if (Number.isFinite(espera)) {
      renderTimer = setTimeout(() => programarRender(), Math.max(0, espera));
    } else {
      programarRender();
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && renderPendiente.size) programarRender();
});

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
const COLORES_UNIDAD = ['#22e0f0', '#ff5c8a', '#a78bfa', '#fbbf24', '#34d399', '#fb7185', '#60a5fa', '#f97316', '#c4f042', '#e879f9'];
const coloresAsignados = new Map();

function colorUnidad(imei) {
  const key = String(imei ?? 'sin-unidad');
  if (coloresAsignados.has(key)) return coloresAsignados.get(key);
  let hash = 0;
  for (const char of key) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  const usados = new Set(coloresAsignados.values());
  const inicio = Math.abs(hash) % COLORES_UNIDAD.length;
  const color = Array.from({ length: COLORES_UNIDAD.length }, (_, i) => COLORES_UNIDAD[(inicio + i) % COLORES_UNIDAD.length])
    .find((candidate) => !usados.has(candidate)) || COLORES_UNIDAD[inicio];
  coloresAsignados.set(key, color);
  return color;
}

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

function fmtCoord(lat, lon) {
  if (lat === null || lat === undefined || lon === null || lon === undefined) return '—';
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return '—';
  return `${Math.abs(latitude).toFixed(4)}°${latitude < 0 ? 'S' : 'N'} ${Math.abs(longitude).toFixed(4)}°${longitude < 0 ? 'W' : 'E'}`;
}

function estaParado(position) {
  return position?.movement_state === 'stopped';
}

function textoMovimiento(position) {
  return estaParado(position) ? 'Parado' : 'En movimiento';
}

function tooltipVelocidad(device) {
  const p = device.last_position;
  return `<b>${esc(nombre(device))}</b><br>${num(p?.speed_kmh, 1, ' km/h')}` +
    (estaParado(p) ? '<br><span class="texto-parado">● Parado</span>' : '');
}

function coordenadaVisual(position) {
  return [position.display_latitude ?? position.latitude, position.display_longitude ?? position.longitude];
}

function aplicarTooltipVelocidad(marker, device) {
  const content = tooltipVelocidad(device);
  if (marker._atlyxTooltip === content) return;
  marker._atlyxTooltip = content;
  if (marker.getTooltip?.()) marker.setTooltipContent(content);
  else marker.bindTooltip(content, { direction: 'top', offset: [0, -16], sticky: true, className: 'tooltip-velocidad' });
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
  const scrollTop = cont.scrollTop;
  const activo = cont.contains(document.activeElement) ? document.activeElement : null;
  const focoVigilar = activo?.closest?.('[data-vigilar]')?.dataset.vigilar;
  const restaurarInteraccion = () => {
    cont.scrollTop = scrollTop;
    if (focoVigilar) {
      [...cont.querySelectorAll('[data-vigilar]')]
        .find((button) => button.dataset.vigilar === focoVigilar)?.focus({ preventScroll: true });
    }
  };
  const equipos = [...estado.equipos.values()];
  document.getElementById('conteo').textContent = equipos.length;

  if (equipos.length === 0) {
    cont.innerHTML = '<div class="vacio">Todavía no hay unidades. En cuanto una se conecte aparece aquí sola.</div>';
    restaurarInteraccion();
    return;
  }

  const orden = { verde: 0, ambar: 1, rojo: 2, gris: 3 };
  equipos.sort((a, b) => orden[claseEstado(a)] - orden[claseEstado(b)] || nombre(a).localeCompare(nombre(b)));
  const filtro = estado.filtro.trim().toLocaleLowerCase('es');
  const visibles = filtro
    ? equipos.filter((d) => [d.alias, d.placa, d.imei].some((v) => String(v ?? '').toLocaleLowerCase('es').includes(filtro)))
    : equipos;

  if (visibles.length === 0) {
    cont.innerHTML = '<div class="vacio">Ninguna unidad coincide con la búsqueda.</div>';
    restaurarInteraccion();
    return;
  }

  cont.innerHTML = visibles
    .map((d) => {
      const p = d.last_position;
      const ref = d.last_seen_at ?? p?.server_time ?? p?.device_time;
      const clase = claseEstado(d);
      let tag = 'en_ruta';
      let tagTexto = 'EN_RUTA';
      if (!d.activo) { tag = 'sin_activar'; tagTexto = 'SIN_ACTIVAR'; }
      else if (!p || clase === 'rojo' || clase === 'gris') { tag = 'sin_senal'; tagTexto = 'SIN_SEÑAL'; }
      else if (estaParado(p)) { tag = 'parado'; tagTexto = 'PARADO'; }
      const velocidad = p?.speed_kmh === null || p?.speed_kmh === undefined ? '—' : num(p.speed_kmh, 0, ' km/h');
      const posicion = fmtCoord(p?.latitude, p?.longitude);
      const extras = [p?.satellites === null || p?.satellites === undefined ? '' : `${p.satellites} sat`, p?.protocol].filter(Boolean);
      return `
      <div class="unidad ${estado.seleccionado === d.imei ? 'seleccionada' : ''}" data-imei="${esc(d.imei)}">
        <span class="unidad-barra ${clase}"></span>
        <div class="unidad-cuerpo">
          <div class="unidad-l1">
            <span class="unidad-nombre">&gt; ${esc(nombre(d))}</span>
            <span class="unidad-tag tag-${tag}">[${tagTexto}]</span>
          </div>
          <div class="unidad-l2">VEL: ${esc(velocidad)} · POS: ${posicion === '—' ? 'sin fix' : esc(posicion)}</div>
          <div class="unidad-l3">últ: ${esc(desdeHace(ref))}${extras.length ? ` · ${esc(extras.join(' · '))}` : ''}</div>
        </div>
        <button class="vigilar ${estado.vigilados.has(d.imei) ? 'activo' : ''}" data-vigilar="${esc(d.imei)}"
          type="button" title="${estado.vigilados.has(d.imei) ? 'Quitar del mosaico' : 'Agregar al mosaico'}"
          aria-label="${estado.vigilados.has(d.imei) ? 'Quitar del mosaico' : 'Agregar al mosaico'}">${estado.vigilados.has(d.imei) ? '◉' : '◎'}</button>
      </div>`;
    })
    .join('');
  restaurarInteraccion();
}

function renderEstadoGlobal() {
  const devices = [...estado.equipos.values()];
  const positions = devices.map((d) => d.last_position).filter(Boolean);
  const sinSenal = devices.filter((d) => ['rojo', 'gris'].includes(claseEstado(d))).length;
  const velocidades = positions
    .filter((p) => p.speed_kmh !== null && p.speed_kmh !== undefined)
    .map((p) => Number(p.speed_kmh)).filter(Number.isFinite);
  const contactos = devices.map((d) => d.last_seen_at).filter((v) => v && Number.isFinite(new Date(v).getTime()));
  document.getElementById('gs-unidades').textContent = devices.length;
  document.getElementById('gs-linea').textContent = devices.filter((d) => claseEstado(d) === 'verde').length;
  document.getElementById('gs-movimiento').textContent = positions.filter((p) => !estaParado(p)).length;
  document.getElementById('gs-parados').textContent = positions.filter(estaParado).length;
  document.getElementById('gs-sin-senal').textContent = sinSenal;
  document.getElementById('gs-vel-max').textContent = velocidades.length ? num(Math.max(...velocidades), 0, ' km/h') : '—';
  document.getElementById('gs-ultimo').textContent = contactos.length
    ? desdeHace(new Date(Math.max(...contactos.map((v) => new Date(v).getTime()))).toISOString()) : '—';
  document.getElementById('gs-sin-senal').closest('.gs-celda')?.classList.toggle('critico', sinSenal > 0);
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
      ['Movimiento', estaParado(p)
        ? `<span class="texto-parado">● Parado (${p.stopped_pulses || '3+'} pulsos)</span>`
        : '<span style="color:var(--verde)">● En movimiento</span>'],
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
    } else filas.push(['Batería', '<span class="dato-pendiente">Esperando lectura del GPS</span>']);
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

function renderTelemetria() {
  const d = estado.equipos.get(estado.seleccionado);
  if (!d) return;
  const p = d.last_position;
  const attrs = p?.attributes ?? {};
  // La posición puede traer batería antes de que llegue/termine de persistirse
  // el evento de telemetría. Se usa como respaldo sin perder el último valor
  // guardado del dispositivo.
  const telemetria = { ...(attrs ?? {}), ...(d.telemetry ?? {}) };
  const protocolo = p?.protocol;
  const sub = [d.imei, d.placa, protocolo].filter(Boolean).join(' · ');
  const velocidad = p?.speed_kmh === null || p?.speed_kmh === undefined ? null : Number(p.speed_kmh);
  const referencia = Number(d.speed_limit_kmh) || 120;
  document.getElementById('tel-nombre').textContent = nombre(d);
  document.getElementById('tel-sub').textContent = sub || '—';
  document.getElementById('tel-velocidad').textContent = Number.isFinite(velocidad) ? velocidad.toFixed(0) : '—';
  document.getElementById('tel-vel-barra').style.width = `${Number.isFinite(velocidad) ? Math.min(100, Math.max(0, velocidad / referencia * 100)) : 0}%`;
  document.getElementById('tel-vel-limite').textContent = d.speed_limit_kmh
    ? `LÍMITE: ${num(d.speed_limit_kmh, 0, ' km/h')}` : 'LÍMITE: sin configurar';

  let aviso = '';
  if (d.speed_limit_kmh && Number.isFinite(velocidad) && velocidad > Number(d.speed_limit_kmh)) {
    aviso = `Velocidad sobre el límite configurado (${num(velocidad, 0)} / ${num(d.speed_limit_kmh, 0)} km/h)`;
  } else if (attrs.crc_invalido) {
    aviso = 'La última trama llegó con CRC inválido; los valores pueden no ser confiables';
  } else if (attrs.coordenadas_descartadas) {
    const motivo = typeof attrs.coordenadas_descartadas === 'object'
      ? attrs.coordenadas_descartadas.motivo : attrs.coordenadas_descartadas;
    aviso = `Se descartaron coordenadas imposibles${motivo ? ` (${motivo})` : ''}`;
  } else if (p && !p.valid) {
    aviso = 'La última trama llegó sin fix GPS';
  } else if (!d.activo) {
    aviso = 'Equipo sin activar: reporta pero no está dado de alta';
  }
  const avisoEl = document.getElementById('tel-aviso');
  avisoEl.hidden = !aviso;
  document.getElementById('tel-aviso-texto').textContent = aviso;

  const bateria = telemetria.bateria;
  const tarjetaBateria = document.getElementById('tel-tarjeta-bateria');
  tarjetaBateria.hidden = false;
  tarjetaBateria.classList.toggle('sin-dato', !bateria);
  if (bateria) {
    const porcentaje = Number(bateria.porcentaje_aprox);
    document.getElementById('tel-bateria-pct').textContent = Number.isFinite(porcentaje) ? `${porcentaje}%` : '—';
    document.getElementById('tel-bateria-barra').style.width = `${Number.isFinite(porcentaje) ? Math.min(100, Math.max(0, porcentaje)) : 0}%`;
    const age = bateria.actualizada_en ? ` · ${desdeHace(bateria.actualizada_en)}` : '';
    const charging = telemetria.terminal?.cargando ? ' · CARGANDO' : '';
    document.getElementById('tel-bateria-etiqueta').textContent = `${bateria.etiqueta ?? 'lectura'} · nivel ${bateria.nivel ?? '—'}/${bateria.escala_max ?? '—'}${age}${charging}`;
  } else {
    document.getElementById('tel-bateria-pct').textContent = '—';
    document.getElementById('tel-bateria-barra').style.width = '0%';
    document.getElementById('tel-bateria-etiqueta').textContent = telemetria.terminal?.cargando
      ? 'CARGANDO · esperando nivel de batería'
      : 'Esperando lectura del GPS';
  }

  const acc = telemetria.acc_encendido ?? telemetria.terminal?.acc_encendido;
  const odometro = telemetria.odometro?.kilometros_estimados;
  document.getElementById('tel-sat').textContent = p?.satellites ?? '—';
  document.getElementById('tel-rumbo').textContent = p?.course === null || p?.course === undefined ? '—' : num(p.course, 0, '°');
  document.getElementById('tel-altitud').textContent = p?.altitude === null || p?.altitude === undefined ? '—' : num(p.altitude, 0, ' m');
  document.getElementById('tel-senal').textContent = telemetria.gsm_signal === null || telemetria.gsm_signal === undefined ? '—' : `${telemetria.gsm_signal}/4`;
  document.getElementById('tel-acc').textContent = acc === undefined || acc === null ? '—' : acc ? 'ENCENDIDO' : 'APAGADO';
  document.getElementById('tel-odometro').textContent = odometro === undefined || odometro === null ? '—' : num(odometro, 3, ' km');
  document.getElementById('tel-movimiento').textContent = p ? (estaParado(p) ? 'PARADO' : 'EN MOVIMIENTO') : '—';
  document.getElementById('tel-intervalo').textContent = d.report_interval_seconds === null || d.report_interval_seconds === undefined ? '—' : `${d.report_interval_seconds} s`;
  const uplink = p?.device_time ?? p?.server_time;
  document.getElementById('tel-uplink').textContent = fmtHora(uplink);
  document.getElementById('tel-uplink-hace').textContent = uplink ? desdeHace(uplink) : '—';
}

function renderObjetivo() {
  // La ficha fija se eliminó para dejar el mapa despejado. La telemetría
  // completa sigue disponible en su panel plegable.
  if (!document.getElementById('objetivo-datos')) return;
  const d = estado.equipos.get(estado.seleccionado);
  const datos = document.getElementById('objetivo-datos');
  const vacio = document.getElementById('objetivo-vacio');
  datos.hidden = !d;
  vacio.hidden = Boolean(d);
  if (!d) return;
  const p = d.last_position;
  const clase = claseEstado(d);
  const estadoTexto = { verde: 'EN LÍNEA', ambar: 'RETRASO', rojo: 'SIN SEÑAL', gris: 'SIN DATOS' }[clase];
  document.getElementById('obj-nombre').textContent = nombre(d);
  document.getElementById('obj-imei').textContent = d.imei;
  document.getElementById('obj-placa').textContent = d.placa || '—';
  document.getElementById('obj-vel').textContent = p?.speed_kmh === null || p?.speed_kmh === undefined ? '—' : num(p.speed_kmh, 0, ' km/h');
  document.getElementById('obj-rumbo').textContent = p?.course === null || p?.course === undefined ? '—' : num(p.course, 0, '°');
  document.getElementById('obj-sat').textContent = p?.satellites ?? '—';
  document.getElementById('obj-altitud').textContent = p?.altitude === null || p?.altitude === undefined ? '—' : num(p.altitude, 0, ' m');
  document.getElementById('obj-coords').textContent = fmtCoord(p?.latitude, p?.longitude);
  document.getElementById('obj-protocolo').textContent = p?.protocol ?? '—';
  const ultimo = d.last_seen_at ?? p?.server_time ?? p?.device_time;
  document.getElementById('obj-ultimo').textContent = ultimo ? desdeHace(ultimo) : '—';
  document.getElementById('obj-movimiento').textContent = p ? (estaParado(p) ? 'Parado' : 'En movimiento') : '—';
  const estadoEl = document.getElementById('obj-estado');
  estadoEl.textContent = estadoTexto;
  estadoEl.className = `obj-estado ${clase}`;
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
  const color = colorUnidad(device.imei);
  const p = device.last_position;
  const rumbo = p?.course;
  return L.divIcon({
    className: '',
    html: `<div class="marcador ${estaParado(p) ? 'parado' : ''}" style="color:${color};position:relative">
             <i class="flecha" style="${rumbo === null || rumbo === undefined ? 'display:none' : `transform:rotate(${rumbo}deg) translateY(-17px)`}"></i><span class="cuerpo"></span>
             <span class="etiqueta" style="color:${color};border-color:${color}">${esc(nombre(device))}</span>
           </div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function actualizarAspectoMarcador(marker, device) {
  const p = device.last_position;
  if (!marker._atlyxVisual?.root) {
    const root = marker.getElement()?.querySelector('.marcador');
    marker._atlyxVisual = { root, flecha: root?.querySelector('.flecha'), etiqueta: root?.querySelector('.etiqueta') };
  }
  const visual = marker._atlyxVisual;
  const color = colorUnidad(device.imei);
  if (visual.root && visual.root.style.color !== color) visual.root.style.color = color;
  const parado = estaParado(p);
  if (visual.root && visual.root.classList.contains('parado') !== parado) visual.root.classList.toggle('parado', parado);
  const rumbo = p?.course;
  if (visual.flecha) {
    const sinRumbo = rumbo === null || rumbo === undefined;
    const display = sinRumbo ? 'none' : '';
    if (visual.flecha.style.display !== display) visual.flecha.style.display = display;
    const transform = sinRumbo ? '' : `rotate(${rumbo}deg) translateY(-17px)`;
    if (visual.flecha.style.transform !== transform) visual.flecha.style.transform = transform;
  }
  const etiqueta = nombre(device);
  if (visual.etiqueta && visual.etiqueta.textContent !== etiqueta) visual.etiqueta.textContent = etiqueta;
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

  const latlng = coordenadaVisual(p);
  let m = estado.marcadores.get(device.imei);
  if (m) {
    const actual = m.getLatLng();
    if (actual.lat !== Number(latlng[0]) || actual.lng !== Number(latlng[1])) m.setLatLng(latlng);
  } else {
    m = L.marker(latlng, { icon: iconoMarcador(device) }).addTo(mapa);
    m.on('click', () => seleccionar(device.imei, false));
    estado.marcadores.set(device.imei, m);
  }
  actualizarAspectoMarcador(m, device);
  const etiqueta = nombre(device);
  const popup = `<b>${esc(etiqueta)}</b><br>${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}<br>` +
    `${num(p.speed_kmh, 1, ' km/h')} · ${esc(fmtHora(p.device_time ?? p.server_time))}<br>${esc(textoMovimiento(p))}`;
  if (!m.getPopup?.()) m.bindPopup(popup);
  else if (m._atlyxPopup !== popup) m.setPopupContent(popup);
  m._atlyxPopup = popup;
  aplicarTooltipVelocidad(m, device);
  actualizarEstelaViva(device);

  if (estado.siguiendo && estado.seleccionado === device.imei && estado.modoVista === '2d') {
    mapa.panTo(latlng, { animate: true, duration: 0.8 });
  }
  actualizarGps3d(device);
  actualizarGpsMosaico(device);
}

function actualizarEstelaViva(device) {
  const p = device.last_position;
  if (!p || p.latitude === null || p.longitude === null) return;
  const point = coordenadaVisual(p).map(Number);
  const points = estado.estelasVivas.get(device.imei) || [];
  const last = points.at(-1);
  if (!last || last[0] !== point[0] || last[1] !== point[1]) points.push(point);
  if (points.length > 240) points.splice(0, points.length - 240);
  estado.estelasVivas.set(device.imei, points);
  let layer = estado.capasEstelasVivas.get(device.imei);
  if (!layer) {
    layer = L.polyline(points, { color: colorUnidad(device.imei), weight: 3, opacity: .78, dashArray: '8 7' }).addTo(mapa);
    estado.capasEstelasVivas.set(device.imei, layer);
  } else layer.setLatLngs(points);
  if (estado.modoVista === '3d') programarRender('estela');
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
  // Los minimapas conservan siempre la capa raster ligera para no consumir
  // un contexto WebGL por unidad vigilada.
  if (estado.mapa3d) {
    estado.mapa3d.setStyle(mapa3dStyle());
    estado.mapa3d.once('style.load', () => {
      estado.mapa3d.setProjection({ type: 'globe' });
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
      bearing: p.course ?? estado.mapa3d.getBearing(), pitch: 0, duration: 900 });
  } else if (estado.modoVista === '2d') {
    mapa.setView([p.latitude, p.longitude], Math.max(mapa.getZoom(), 16), { animate: true });
  }
}

function alternarVigilado(imei) {
  if (estado.vigilados.has(imei)) estado.vigilados.delete(imei);
  else estado.vigilados.add(imei);
  localStorage.setItem('atlyx_gps_vigilados', JSON.stringify([...estado.vigilados]));
  programarRender('lista');
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
  const vigilados = [...estado.vigilados].map((imei) => estado.equipos.get(imei)).filter(Boolean);
  const devices = vigilados.slice(0, 8);
  if (devices.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'mosaico-vacio';
    empty.innerHTML = '<div><b>Selecciona los GPS que quieres vigilar</b><br>Usa el botón ◎ junto a cada equipo.</div>';
    container.append(empty);
    return;
  }
  if (vigilados.length > 8) {
    const aviso = document.createElement('div');
    aviso.className = 'mosaico-vacio mosaico-aviso';
    aviso.textContent = `El mosaico muestra 8 de ${vigilados.length} unidades vigiladas. Quita alguna para ver otra.`;
    container.append(aviso);
  }
  for (const device of devices) {
    const card = document.createElement('article');
    card.className = 'mosaico-tarjeta';
    const mapElement = document.createElement('div');
    mapElement.className = 'mosaico-mapa';
    const label = document.createElement('div');
    label.className = 'mosaico-etiqueta';
    const tema = TEMAS_MOSAICO[estado.temasMosaico[device.imei]] ? estado.temasMosaico[device.imei] : estado.temaMapa;
    label.innerHTML = `<span><b style="color:${colorUnidad(device.imei)}">${esc(nombre(device))}</b></span>
      <select aria-label="Tema de ${esc(nombre(device))}">${Object.entries(TEMAS_MOSAICO).map(([key, def]) => `<option value="${key}"${key === tema ? ' selected' : ''}>${def.nombre}</option>`).join('')}</select>
      <span>${num(device.last_position?.speed_kmh, 0, ' km/h')}</span>`;
    card.append(mapElement, label);
    container.append(card);
    const p = device.last_position;
    const center = p && p.latitude !== null ? [p.latitude, p.longitude] : [20.3897, -99.9961];
    const miniMap = L.map(mapElement, { zoomControl: false, attributionControl: false, dragging: true }).setView(center, p ? 16 : 12);
    let tile = crearCapaMosaico(tema).addTo(miniMap);
    let marker = null;
    if (p && p.latitude !== null) {
      marker = L.marker(center, { icon: iconoMarcador(device) }).addTo(miniMap);
      aplicarTooltipVelocidad(marker, device);
    }
    const item = { map: miniMap, marker, tile, label };
    estado.mapasMosaico.set(device.imei, item);
    label.querySelector('select').addEventListener('change', (event) => {
      const next = event.currentTarget.value;
      item.map.removeLayer(item.tile);
      item.tile = crearCapaMosaico(next).addTo(item.map);
      item.tile.bringToBack?.();
      estado.temasMosaico[device.imei] = next;
      localStorage.setItem('atlyx_temas_mosaico', JSON.stringify(estado.temasMosaico));
    });
  }
}

function actualizarGpsMosaico(device) {
  const item = estado.mapasMosaico.get(device.imei);
  const p = device.last_position;
  if (!item || !p || p.latitude === null) return;
  const latlng = [p.latitude, p.longitude];
  let movio = true;
  if (item.marker) {
    const actual = item.marker.getLatLng();
    movio = actual.lat !== Number(latlng[0]) || actual.lng !== Number(latlng[1]);
    if (movio) item.marker.setLatLng(latlng);
  } else {
    item.marker = L.marker(latlng, { icon: iconoMarcador(device) }).addTo(item.map);
  }
  actualizarAspectoMarcador(item.marker, device);
  aplicarTooltipVelocidad(item.marker, device);
  if (movio) item.map.panTo(latlng, { animate: true, duration: 0.8 });
  const velocidad = num(p.speed_kmh, 0, ' km/h');
  if (item.label.lastElementChild.textContent !== velocidad) item.label.lastElementChild.textContent = velocidad;
}

function mapa3dStyle() {
  const def = TEMAS_MAPA[estado.temaMapa] ?? TEMAS_MAPA.fiord;
  if (def.type === 'vector') return def.style;
  return {
    version: 8,
    sources: {
      base: { type: 'raster', tiles: [def.url.replace('{s}', 'a').replace('{r}', '')], tileSize: 256,
        maxzoom: def.options.maxZoom, attribution: def.options.attribution },
    },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
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
    container: 'mapa-3d', style: mapa3dStyle(), center: [-99.9961, 20.3897], zoom: 1.35,
    pitch: 0, bearing: 0, maxPitch: 85, attributionControl: true,
  });
  estado.mapa3d.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  estado.mapa3d.on('load', () => {
    estado.mapa3d.setProjection({ type: 'globe' });
    sincronizarEstela3d();
    for (const device of estado.equipos.values()) actualizarGps3d(device);
  });
}

function sincronizarEstela3d() {
  const map3d = estado.mapa3d;
  if (!map3d?.isStyleLoaded()) return;
  const coordinates = estado.coordenadasRecorrido
    .filter((segment) => segment.length >= 2)
    .map((segment) => segment.map(([lat, lon]) => [lon, lat]));
  const features = [];
  if (coordinates.length) features.push({ type: 'Feature', properties: { color: colorUnidad(estado.seleccionado) }, geometry: { type: 'MultiLineString', coordinates } });
  for (const [imei, points] of estado.estelasVivas) {
    if (points.length < 2) continue;
    features.push({ type: 'Feature', properties: { color: colorUnidad(imei) },
      geometry: { type: 'LineString', coordinates: points.map(([lat, lon]) => [lon, lat]) } });
  }
  const geojson = { type: 'FeatureCollection', features };
  if (map3d.getSource('estela')) map3d.getSource('estela').setData(geojson);
  else {
    map3d.addSource('estela', { type: 'geojson', data: geojson });
    map3d.addLayer({ id: 'estela-halo', type: 'line', source: 'estela', paint: { 'line-color': '#06121f', 'line-width': 8, 'line-opacity': .65 } });
    map3d.addLayer({ id: 'estela-linea', type: 'line', source: 'estela', paint: { 'line-color': ['get', 'color'], 'line-width': 4 } });
  }

  const stops = gruposParados(estado.posicionesRecorrido);
  const stopLines = stops.map((group) => ({
    type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: group.map((p) => [
      Number(p.display_longitude ?? p.longitude), Number(p.display_latitude ?? p.latitude),
    ]) },
  }));
  const stopPoints = stops.map((group) => {
    const p = group.at(-1);
    return { type: 'Feature', properties: { pulses: p.stopped_pulses || group.length },
      geometry: { type: 'Point', coordinates: [
        Number(p.display_longitude ?? p.longitude), Number(p.display_latitude ?? p.latitude),
      ] } };
  });
  const stopGeojson = { type: 'FeatureCollection', features: [...stopLines, ...stopPoints] };
  if (map3d.getSource('paradas')) map3d.getSource('paradas').setData(stopGeojson);
  else {
    map3d.addSource('paradas', { type: 'geojson', data: stopGeojson });
    map3d.addLayer({ id: 'paradas-linea', type: 'line', source: 'paradas', filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': '#f59e0b', 'line-width': 7, 'line-opacity': .95 } });
    map3d.addLayer({ id: 'paradas-punto', type: 'circle', source: 'paradas', filter: ['==', '$type', 'Point'],
      paint: { 'circle-color': '#f59e0b', 'circle-radius': 7, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  }
}

function actualizarGps3d(device) {
  if (!device || estado.modoVista !== '3d' || !estado.mapa3d) return;
  const p = device.last_position;
  if (!p || p.latitude === null) return;
  const lngLat = [p.longitude, p.latitude];
  let item = estado.marcadores3d.get(device.imei);
  if (!item) {
    const el = document.createElement('div');
    el.className = 'marcador-3d';
    el.style.setProperty('--color-unidad', colorUnidad(device.imei));
    const popup = new maplibregl.Popup({ offset: 18, closeButton: false });
    const marker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).setPopup(popup).addTo(estado.mapa3d);
    el.addEventListener('click', () => seleccionar(device.imei, false));
    item = { marker, popup };
    estado.marcadores3d.set(device.imei, item);
  } else item.marker.setLngLat(lngLat);
  item.popup.setHTML(tooltipVelocidad(device));
  const element = item.marker.getElement();
  element.classList.toggle('parado', estaParado(p));
  element.title = `${nombre(device)} · ${num(p.speed_kmh, 1, ' km/h')} · ${textoMovimiento(p)}`;
  if (estado.siguiendo && estado.seleccionado === device.imei) estado.mapa3d.easeTo({ center: lngLat, zoom: Math.max(estado.mapa3d.getZoom(), 17),
    bearing: p.course ?? estado.mapa3d.getBearing(), pitch: 0, duration: 900 });
}

function destruirMapa3d() {
  for (const { marker, popup } of estado.marcadores3d.values()) { marker.remove(); popup.remove(); }
  estado.marcadores3d.clear();
  estado.mapa3d?.remove();
  estado.mapa3d = null;
}

function cambiarModoVista(mode) {
  if (mode === '3d' && !window.maplibregl) {
    document.getElementById('info-recorrido').textContent = 'La vista 3D no pudo cargar. Se mantiene el mapa 2D.';
    mode = '2d';
  }
  const anterior = estado.modoVista;
  estado.modoVista = mode;
  if (mode === '2d' || mode === '3d') localStorage.setItem('atlyx_proyeccion_mapa', mode);
  if (anterior === 'mosaico' && mode !== 'mosaico') destruirMosaico();
  if (mode === '3d') {
    clearTimeout(estado.timerLiberar3d);
    estado.timerLiberar3d = null;
  } else if (anterior === '3d' && estado.mapa3d) {
    clearTimeout(estado.timerLiberar3d);
    estado.timerLiberar3d = setTimeout(() => {
      if (estado.modoVista !== '3d') destruirMapa3d();
    }, 60000);
  }
  document.getElementById('mapa').hidden = mode !== '2d';
  document.getElementById('mapa-3d').hidden = mode !== '3d';
  document.getElementById('mosaico').hidden = mode !== 'mosaico';
  document.getElementById('vista-3d').classList.toggle('activo', mode === '3d');
  document.getElementById('vista-mosaico').classList.toggle('activo', mode === 'mosaico');
  document.getElementById('vista-3d').setAttribute('aria-pressed', String(mode === '3d'));
  document.getElementById('vista-3d').textContent = mode === '3d' ? '▱ Mapa plano' : '◎ Globo 3D';
  document.getElementById('vista-mosaico').setAttribute('aria-pressed', String(mode === 'mosaico'));
  if (mode === '2d') setTimeout(() => { mapa.invalidateSize(); centrarSeleccionado(); }, 0);
  if (mode === '3d') {
    asegurarMapa3d();
    programarRender('estela');
    setTimeout(() => { estado.mapa3d?.resize(); centrarSeleccionado(); }, 0);
  }
  if (mode === 'mosaico') renderMosaico();
}

// ── selección ────────────────────────────────────────────────────────────────
function textoAlerta(tipo, data = {}) {
  if (tipo === 'alerta:exceso_velocidad') {
    return `Velocidad ${data.velocidad_kmh ?? '—'} km/h sobre el límite ${data.limite_kmh ?? '—'} km/h`;
  }
  return tipo.replace(/^(?:alerta|alarma|aviso):/, '').replaceAll('_', ' ');
}

function integrarAlerta(alerta) {
  const id = String(alerta.id);
  if (estado.alertas.some((item) => String(item.id) === id)) return;
  estado.alertas.push({ ...alerta, id, reconocida: false });
  estado.alertas.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  estado.alertas.length = Math.min(estado.alertas.length, 60);
}

async function cargarAlertas(imei) {
  try {
    const data = await api(`/api/devices/${encodeURIComponent(imei)}/events?limit=50`);
    for (const evento of data.events ?? []) {
      if (!/^(alerta|alarma|aviso):/.test(evento.tipo)) continue;
      integrarAlerta({
        id: evento.id, imei, tipo: evento.tipo,
        texto: textoAlerta(evento.tipo, evento.raw ?? {}),
        nivel: evento.tipo.startsWith('aviso:') ? 'aviso' : 'critico',
        ts: evento.created_at,
      });
    }
    renderAlertas();
  } catch (err) {
    console.warn('no se pudieron traer las alertas:', err.message);
  }
}

function renderAlertas() {
  const cont = document.getElementById('lista-alertas');
  const sinReconocer = estado.alertas.filter((a) => !a.reconocida).length;
  renderIndicadorAlertas();
  document.getElementById('alertas-resumen').textContent = `${sinReconocer} sin reconocer · ${estado.alertas.length} registradas`;
  if (!estado.alertas.length) {
    cont.innerHTML = '<div class="vacio">Sin alertas registradas.</div>';
    return;
  }
  cont.innerHTML = estado.alertas.map((alerta) => {
    const d = estado.equipos.get(alerta.imei);
    const tipo = alerta.tipo.replace(/^(?:alerta|alarma|aviso):/, '').toUpperCase();
    return `<article class="alerta nivel-${esc(alerta.nivel)} ${alerta.reconocida ? 'reconocida' : ''}">
      <div class="alerta-cab">
        <span class="alerta-tipo">${esc(tipo)}</span>
        <span class="alerta-hora">${esc(desdeHace(alerta.ts))}</span>
      </div>
      <div class="alerta-unidad">${esc(nombre(d ?? { imei: alerta.imei }))} · ${esc(alerta.imei)}</div>
      <p class="alerta-texto">${esc(alerta.texto)}</p>
      <div class="alerta-acciones">
        <button class="btn pequeno" data-alerta-ver="${esc(alerta.imei)}" type="button">Ver unidad</button>
        ${alerta.reconocida ? '' : `<button class="btn pequeno" data-alerta-ack="${esc(alerta.id)}" type="button">Reconocer</button>`}
      </div>
    </article>`;
  }).join('');
}

function renderIndicadorAlertas() {
  const sinReconocer = estado.alertas.filter((a) => !a.reconocida).length;
  const conteo = document.getElementById('conteo-alertas');
  conteo.textContent = sinReconocer;
  conteo.hidden = sinReconocer === 0;
}

async function seleccionar(imei, centrar) {
  estado.seleccionado = imei;
  enviarSuscripcionWs();
  programarRender('lista', 'global');
  renderDetalle();
  renderTelemetria();
  renderObjetivo();
  renderDepuracion();
  document.getElementById('titulo-unidad').textContent = nombre(estado.equipos.get(imei) ?? { imei });
  document.getElementById('aviso-seleccion').hidden = true;
  if (esMovil()) cambiarVista('telemetria');
  mostrarVistaMovil('gps');

  const m = estado.marcadores.get(imei);
  if (centrar && m) mapa.setView(m.getLatLng(), Math.max(mapa.getZoom(), 15));
  const selectedDevice = estado.equipos.get(imei);
  if (estado.modoVista === '3d') {
    actualizarGps3d(selectedDevice);
    if (centrar && selectedDevice?.last_position && estado.mapa3d) {
      estado.mapa3d.easeTo({ center: [selectedDevice.last_position.longitude, selectedDevice.last_position.latitude],
        zoom: Math.max(estado.mapa3d.getZoom(), 17), pitch: 0, duration: 700 });
    }
  }
  if (estado.siguiendo) centrarSeleccionado();

  // Días con recorrido guardado de este equipo, para el selector de jornada.
  cargarDiasDisponibles();

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
  await cargarAlertas(imei);
  // La estela de las últimas seis horas aparece al seleccionar, sin exigir un
  // clic adicional. Los controles permiten ampliar o reducir el rango.
  const fin = new Date();
  // Arranca en el día en curso: al cruzar la medianoche el mapa amanece limpio
  // en lugar de seguir arrastrando las últimas horas de la jornada anterior.
  document.getElementById('hasta').value = fechaLocalAInput(fin);
  document.getElementById('desde').value = `${diaLocal(0)}T00:00`;
  document.getElementById('dia-ruta').value = diaLocal(0);
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

// ── rutas por día ───────────────────────────────────────────────────────────
// La jornada se mide por el día local del operador. Cambiar de día vacía el
// mapa y trae solo ese día: es lo que hace que al amanecer no siga colgando el
// recorrido de ayer.

function diaLocal(offsetDias = 0) {
  const base = new Date(Date.now() - offsetDias * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: estado.config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(base);
}

/** Límites 'datetime-local' de un día completo, para reusar el cargador de rango. */
function limitesDelDia(fecha) {
  return { desde: `${fecha}T00:00`, hasta: `${fecha}T23:59` };
}

function pintarResumenDia(ruta) {
  const caja = document.getElementById('resumen-dia');
  if (!ruta) {
    caja.textContent = '';
    return;
  }
  const km = Number(ruta.distancia_km ?? 0).toFixed(2);
  const cortes = ruta.resumen?.gaps ?? Math.max(0, (ruta.tramos ?? 1) - 1);
  // Los cortes son información operativa, no un error: cada uno es un tramo que
  // el equipo no reportó (apagado o sin señal) y que por eso no se dibuja.
  const detalleCortes = cortes
    ? ` · <span class="texto-parado">${cortes} corte(s) sin datos</span>`
    : '';
  caja.innerHTML =
    `<strong>${esc(ruta.fecha)}</strong> · ${km} km · ${ruta.puntos ?? 0} punto(s) · ` +
    `${ruta.paradas ?? 0} parada(s)${detalleCortes}` +
    (ruta.velocidad_max_kmh != null ? ` · máx ${Number(ruta.velocidad_max_kmh).toFixed(0)} km/h` : '') +
    (ruta.cerrada ? ' · <span title="Día cerrado y guardado">consolidado</span>' : ' · en curso');
}

async function cargarDiasDisponibles() {
  const imei = estado.seleccionado;
  const caja = document.getElementById('dias-ruta');
  if (!imei) { caja.innerHTML = ''; return; }
  try {
    const data = await api(`/api/devices/${encodeURIComponent(imei)}/rutas?limite=30`);
    if (imei !== estado.seleccionado) return;
    const filas = (data.dias ?? []).map((d) => {
      const km = d.distancia_km != null ? `${Number(d.distancia_km).toFixed(1)} km` : '—';
      const etiqueta = d.en_curso ? 'en curso' : `${km} · ${d.paradas ?? 0} par.`;
      return `<button class="btn pequeno" data-dia-exacto="${esc(d.fecha)}">${esc(d.fecha)} · ${esc(etiqueta)}</button>`;
    });
    caja.innerHTML = filas.length ? `<div class="atajos">${filas.join('')}</div>` : '';
  } catch {
    caja.innerHTML = '';
  }
}

async function cargarRutaDelDia(fecha, { ajustarVista = true } = {}) {
  const imei = estado.seleccionado;
  const info = document.getElementById('info-recorrido');
  if (!imei) { info.textContent = 'Selecciona primero un equipo.'; return; }
  if (!fecha) return;

  document.getElementById('dia-ruta').value = fecha;
  const { desde, hasta } = limitesDelDia(fecha);
  document.getElementById('desde').value = desde;
  document.getElementById('hasta').value = hasta;

  // El dibujo del mapa reutiliza el cargador de rango: ya recibe del servidor
  // los tramos separados, con sus puntos, paradas y perfil de velocidad.
  await cargarRecorrido({ ajustarVista });

  // El resumen del día viene del consolidador, que además deja la ruta guardada
  // en la base para poder consultarla después sin recalcular.
  try {
    const data = await api(`/api/devices/${encodeURIComponent(imei)}/rutas/${fecha}`);
    if (imei !== estado.seleccionado) return;
    pintarResumenDia(data.ruta);
    cargarDiasDisponibles();
  } catch {
    pintarResumenDia(null);
  }
}

async function cargarRecorrido({ ajustarVista = true, silencioso = false } = {}) {
  const imei = estado.seleccionado;
  const requestId = ++estado.recorridoRequestId;
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

  if (!silencioso) info.textContent = 'Cargando…';
  try {
    const data = await api(`/api/devices/${encodeURIComponent(imei)}/positions?${params}`);
    if (requestId !== estado.recorridoRequestId || imei !== estado.seleccionado) return;
    limpiarRecorrido();

    const puntos = data.positions
      .filter((p) => p.latitude !== null && p.longitude !== null)
      .map((p) => [p.latitude, p.longitude, p]);

    if (puntos.length === 0) {
      info.textContent = 'No hay posiciones con fix en ese rango.';
      return;
    }

    const snapped = new Map((data.trace?.snapped_points ?? []).map((p) => [String(p.id), p]));
    estado.posicionesRecorrido = puntos.map(([, , p]) => {
      const road = snapped.get(String(p.id));
      return road ? { ...p, display_latitude: road.latitude, display_longitude: road.longitude } : p;
    });
    const selected = estado.equipos.get(imei);
    const lastRoad = selected?.last_position && snapped.get(String(selected.last_position.id));
    if (selected?.last_position && lastRoad) {
      selected.last_position.display_latitude = lastRoad.latitude;
      selected.last_position.display_longitude = lastRoad.longitude;
      actualizarMarcador(selected);
    }

    const segmentos = data.trace?.segments?.some((segment) => segment.length >= 2)
      ? data.trace.segments
      : [puntos.map((p) => [p[0], p[1]])];
    estado.coordenadasRecorrido = segmentos;
    estado.recorrido = L.polyline(segmentos, {
      color: colorUnidad(imei),
      weight: 3,
      opacity: 0.85,
    }).addTo(mapa);
    renderParadasRecorrido();
    sincronizarEstela3d();

    estado.puntosRecorrido = L.layerGroup(
      estado.posicionesRecorrido.map((p) =>
        L.circleMarker(coordenadaVisual(p),
          { radius: 3, color: colorUnidad(imei), fillOpacity: 0.9, weight: 1 }).bindPopup(
          `${esc(fmtFecha(p.device_time ?? p.server_time))}<br>${num(p.speed_kmh, 1, ' km/h')} · ${p.satellites ?? '—'} sat`,
        ),
      ),
    ).addTo(mapa);

    if (ajustarVista) mapa.fitBounds(estado.recorrido.getBounds().pad(0.15));
    const calidad = data.trace
      ? data.trace.matched
        ? ` · ajustada a calles${data.trace.partial ? ' parcialmente' : ''}`
        : ` · GPS filtrado${data.trace.error ? ' (ajuste no disponible)' : ''}`
      : '';
    const paradas = gruposParados(estado.posicionesRecorrido).length;
    info.innerHTML = `${puntos.length} punto(s)${paradas ? ` · <span class="texto-parado">${paradas} parada(s)</span>` : ''}${calidad} · ${esc(fmtFecha(data.positions[0].device_time ?? data.positions[0].server_time))} → ${esc(fmtFecha(data.positions.at(-1).device_time ?? data.positions.at(-1).server_time))}`;
    renderPerfilVelocidad();
    renderRecorrido();
  } catch (err) {
    info.textContent = 'Error: ' + err.message;
  }
}

function gruposParados(positions) {
  const groups = [];
  let current = [];
  for (const p of positions) {
    if (estaParado(p) && Number.isFinite(Number(p.latitude)) && Number.isFinite(Number(p.longitude))) current.push(p);
    else if (current.length) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

function distanciaKm(a, b) {
  const lat1 = Number(a?.latitude);
  const lon1 = Number(a?.longitude);
  const lat2 = Number(b?.latitude);
  const lon2 = Number(b?.longitude);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return 0;
  const rad = (grados) => grados * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function duracionTexto(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutos = Math.floor(ms / 60000);
  const horas = Math.floor(minutos / 60);
  return horas ? `${horas} h ${minutos % 60} min` : `${minutos} min`;
}

function renderPerfilVelocidad() {
  const velocidades = estado.posicionesRecorrido
    .map((p) => p.speed_kmh === null || p.speed_kmh === undefined ? null : Number(p.speed_kmh))
    .filter(Number.isFinite);
  const area = document.getElementById('perfil-area');
  const linea = document.getElementById('perfil-linea');
  if (!velocidades.length) {
    area.setAttribute('points', '');
    linea.setAttribute('points', '');
    document.getElementById('perfil-max').textContent = '—';
    document.getElementById('perfil-muestras').textContent = '—';
    return;
  }
  const n = velocidades.length;
  const cantidad = Math.min(120, n);
  const muestras = Array.from({ length: cantidad }, (_, i) => velocidades[Math.round(i * (n - 1) / Math.max(1, cantidad - 1))]);
  const maxima = Math.max(...velocidades);
  const escala = Math.max(20, maxima);
  const puntos = muestras.map((v, i) => `${cantidad === 1 ? 0 : i * 100 / (cantidad - 1)},${32 - Math.max(0, v) / escala * 32}`).join(' ');
  linea.setAttribute('points', puntos);
  area.setAttribute('points', `0,32 ${puntos} 100,32`);
  document.getElementById('perfil-max').textContent = num(maxima, 0, ' km/h');
  document.getElementById('perfil-muestras').textContent = `${n} muestras`;
}

function renderRecorrido() {
  const puntos = estado.posicionesRecorrido;
  const velocidades = puntos.filter((p) => p.speed_kmh !== null && p.speed_kmh !== undefined && Number.isFinite(Number(p.speed_kmh)));
  const paradas = gruposParados(puntos);
  let distancia = 0;
  for (let i = 1; i < puntos.length; i += 1) distancia += distanciaKm(puntos[i - 1], puntos[i]);
  const primero = puntos[0];
  const ultimo = puntos.at(-1);
  const tiempo = (p) => p?.device_time ?? p?.server_time;
  const duracion = primero && ultimo ? new Date(tiempo(ultimo)).getTime() - new Date(tiempo(primero)).getTime() : NaN;
  const media = velocidades.length ? velocidades.reduce((suma, p) => suma + Number(p.speed_kmh), 0) / velocidades.length : null;
  const rapido = velocidades.reduce((max, p) => !max || Number(p.speed_kmh) > Number(max.speed_kmh) ? p : max, null);
  document.getElementById('rec-puntos').textContent = puntos.length;
  document.getElementById('rec-distancia').textContent = puntos.length ? num(distancia, 2, ' km') : '—';
  document.getElementById('rec-duracion').textContent = puntos.length ? duracionTexto(duracion) : '—';
  document.getElementById('rec-vel-media').textContent = media === null ? '—' : num(media, 0, ' km/h');
  document.getElementById('rec-vel-max').textContent = rapido ? num(rapido.speed_kmh, 0, ' km/h') : '—';
  document.getElementById('rec-paradas').textContent = paradas.length;

  const registro = document.getElementById('registro-recorrido');
  if (!puntos.length) {
    registro.innerHTML = '<div class="vacio">Carga un recorrido para ver su bitácora.</div>';
    return;
  }
  const eventos = [{ tipo: 'inicio', etiqueta: 'INICIO', ts: tiempo(primero), detalle: fmtCoord(primero.latitude, primero.longitude) }];
  for (const grupo of paradas) {
    const inicio = grupo[0];
    const fin = grupo.at(-1);
    const ms = new Date(tiempo(fin)).getTime() - new Date(tiempo(inicio)).getTime();
    const pulsos = fin.stopped_pulses ?? grupo.length;
    eventos.push({ tipo: 'parada', etiqueta: 'PARADA', ts: tiempo(inicio), detalle: `${duracionTexto(ms)} · ${pulsos} pulsos` });
  }
  if (rapido) eventos.push({ tipo: 'velmax', etiqueta: 'VEL_MÁX', ts: tiempo(rapido), detalle: num(rapido.speed_kmh, 0, ' km/h') });
  eventos.push({ tipo: 'fin', etiqueta: 'FIN', ts: tiempo(ultimo), detalle: fmtCoord(ultimo.latitude, ultimo.longitude) });
  eventos.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  registro.innerHTML = eventos.map((evento) => `<div class="evento ev-${evento.tipo}">
    <span class="evento-hora">${esc(fmtHora(evento.ts))}</span>
    <span class="evento-tipo">${esc(evento.etiqueta)}</span>
    <span class="evento-detalle">${esc(evento.detalle)}</span>
  </div>`).join('');
}

function renderParadasRecorrido() {
  if (estado.paradasRecorrido) mapa.removeLayer(estado.paradasRecorrido);
  const layers = [];
  for (const group of gruposParados(estado.posicionesRecorrido)) {
    const coordinates = group.map((p) => [
      Number(p.display_latitude ?? p.latitude), Number(p.display_longitude ?? p.longitude),
    ]);
    const last = group.at(-1);
    const detail = `<b>Parado</b><br>${last.stopped_pulses || group.length} pulsos<br>Desde ${esc(fmtFecha(last.stopped_since))}`;
    layers.push(L.polyline(coordinates, { color: '#f59e0b', weight: 7, opacity: .95 }).bindTooltip(detail));
    layers.push(L.circleMarker(coordinates.at(-1), { radius: 7, color: '#fff', weight: 2,
      fillColor: '#f59e0b', fillOpacity: 1 }).bindTooltip(detail));
  }
  estado.paradasRecorrido = L.layerGroup(layers).addTo(mapa);
}

function programarAjusteRecorridoVivo() {
  if (document.hidden) return;
  const imei = estado.seleccionado;
  clearTimeout(estado.timerAjusteVivo);
  estado.timerAjusteVivo = setTimeout(() => {
    if (document.hidden || !imei || estado.seleccionado !== imei || !estado.recorrido) return;
    document.getElementById('hasta').value = fechaLocalAInput(new Date());
    cargarRecorrido({ ajustarVista: false, silencioso: true });
  }, 4000);
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
  if (estado.paradasRecorrido) {
    mapa.removeLayer(estado.paradasRecorrido);
    estado.paradasRecorrido = null;
  }
  estado.posicionesRecorrido = [];
  estado.coordenadasRecorrido = [];
  sincronizarEstela3d();
  renderPerfilVelocidad();
  renderRecorrido();
  cambiarModoVista(estado.modoVista);
}

// ── WebSocket ────────────────────────────────────────────────────────────────
function enviarSuscripcionWs() {
  if (estado.ws?.readyState !== WebSocket.OPEN) return;
  estado.ws.send(JSON.stringify({ tipo: 'suscribir', imei: estado.seleccionado }));
}

function conectarWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  estado.ws = ws;

  const pastilla = document.getElementById('estado-ws');

  ws.addEventListener('open', () => {
    estado.reintentoWs = 1000;
    pastilla.textContent = 'en vivo';
    pastilla.className = 'pastilla viva';
    enviarSuscripcionWs();
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
        if (estado.seleccionado === m.imei) {
          estado.seleccionado = null;
          enviarSuscripcionWs();
        }
        programarRender('lista', 'global', 'detalle', 'telemetria', 'objetivo');
        document.getElementById('titulo-unidad').textContent = 'FLOTILLA';
        cambiarVista(estado.vista);
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
        estado.posicionesRecorrido.push(m.position);
        if (estado.posicionesRecorrido.length > 5000) {
          estado.posicionesRecorrido.splice(0, estado.posicionesRecorrido.length - 5000);
        }
        if (estaParado(m.position)) {
          const count = Math.min(m.position.stopped_pulses || 3, estado.posicionesRecorrido.length);
          const stoppedSince = estado.posicionesRecorrido.at(-count)?.device_time ??
            estado.posicionesRecorrido.at(-count)?.server_time ?? m.position.stopped_since;
          for (const point of estado.posicionesRecorrido.slice(-count)) {
            point.movement_state = 'stopped';
            point.stopped_pulses = m.position.stopped_pulses || count;
            point.stopped_since = stoppedSince;
          }
        }
        if (document.getElementById('ajustar-calles').checked) {
          // No agregamos el punto crudo a la estela: en breve se recarga ya
          // proyectado sobre la red vial y se conserva el zoom del operador.
          programarAjusteRecorridoVivo();
        } else {
          estado.recorrido.addLatLng(coordinate);
          if (!estado.coordenadasRecorrido.length) estado.coordenadasRecorrido.push([]);
          estado.coordenadasRecorrido.at(-1).push(coordinate);
          if (estado.coordenadasRecorrido.at(-1).length > 5000) {
            estado.coordenadasRecorrido.at(-1).splice(0, estado.coordenadasRecorrido.at(-1).length - 5000);
          }
        }
        programarRender('paradas', 'estela', 'perfil', 'recorrido');
      }
      programarRender('lista', 'global');
      if (estado.seleccionado === m.imei) {
        programarRender('detalle', 'telemetria', 'objetivo');
      }
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
        programarRender('lista', 'global');
        if (estado.seleccionado === m.imei) {
          programarRender('detalle', 'telemetria', 'objetivo');
        }
      }
    }

    if (m.tipo === 'alerta') {
      const d = estado.equipos.get(m.imei);
      const label = nombre(d ?? { imei: m.imei });
      const detalle = textoAlerta(m.alerta, m.data ?? {});
      const ts = m.position?.server_time ?? m.position?.device_time ?? new Date().toISOString();
      integrarAlerta({
        id: `ws:${m.imei}:${m.alerta}:${m.position?.id ?? ts}`,
        imei: m.imei, tipo: m.alerta, texto: detalle, nivel: 'critico', ts,
      });
      programarRender('indicador-alertas', 'alertas');
      if (estado.vista !== 'alertas') document.getElementById('info-recorrido').textContent = `⚠ ${label}: ${detalle}`;
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
      if (m.imei !== estado.seleccionado) return;
      const lista = estado.paquetes.get(m.imei) ?? [];
      lista.unshift(m.paquete);
      if (lista.length > 20) lista.length = 20;
      estado.paquetes.set(m.imei, lista);
      programarRender('depuracion');
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
  programarRender('lista', 'global');
  if (!estado.yaCentro && estado.marcadores.size > 0) {
    estado.yaCentro = true;
    encuadrarTodo();
  }
  if (estado.seleccionado) {
    programarRender('detalle', 'telemetria', 'objetivo');
  }
}

async function cerrarSesion() {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  location.href = '/login';
}

async function iniciar() {
  configurarInterfazMovil();
  document.querySelectorAll('button[data-vista]').forEach((button) => {
    button.addEventListener('click', () => {
      const sidebar = document.getElementById('sidebar');
      if (!esMovil() && button.dataset.vista === estado.vista && button.dataset.vista !== 'mapa' && sidebar.classList.contains('abierto')) {
        sidebar.classList.remove('abierto');
        document.getElementById('mostrar-panel').setAttribute('aria-expanded', 'false');
        programarResizeMapas();
        return;
      }
      cambiarVista(button.dataset.vista);
    });
  });
  cambiarVista(localStorage.getItem('atlyx_vista') || 'mapa');
  try {
    estado.config = await api('/api/config');
  } catch {
    /* se usan los valores por omisión */
  }

  const ahora = new Date();
  document.getElementById('hasta').value = fechaLocalAInput(ahora);
  document.getElementById('desde').value = `${diaLocal(0)}T00:00`;
  document.getElementById('dia-ruta').value = diaLocal(0);

  await cargarEquipos().catch((err) => {
    document.getElementById('lista').innerHTML = `<div class="vacio">Error al cargar: ${esc(err.message)}</div>`;
  });
  renderObjetivo();
  programarRender('alertas');
  renderPerfilVelocidad();
  renderRecorrido();

  conectarWs();

  // Refresco de respaldo: si el WebSocket se cae, la lista no se queda vieja.
  // También recalcula el semáforo de estado con el paso del tiempo.
  setInterval(() => {
    programarRender('lista', 'global', 'objetivo', 'alertas', 'detalle', 'telemetria');
  }, 15000);
  setInterval(() => {
    if (!estado.ws || estado.ws.readyState !== WebSocket.OPEN) cargarEquipos().catch(() => {});
  }, 60000);

  // ── eventos de la interfaz ──
  document.getElementById('lista').addEventListener('click', (event) => {
    const vigilar = event.target.closest('[data-vigilar]');
    if (vigilar) {
      event.stopPropagation();
      alternarVigilado(vigilar.dataset.vigilar);
      return;
    }
    const unidad = event.target.closest('.unidad[data-imei]');
    if (unidad) seleccionar(unidad.dataset.imei, true);
  });
  document.getElementById('cargar-recorrido').addEventListener('click', () => cargarRecorrido());
  document.getElementById('tema-mapa').value = estado.temaMapa;
  document.getElementById('tema-mapa').addEventListener('change', (e) => cambiarTemaMapa(e.currentTarget.value));
  document.getElementById('seguir-gps').addEventListener('click', alternarSeguimiento);
  document.getElementById('vista-3d').addEventListener('click', () => cambiarModoVista(estado.modoVista === '3d' ? '2d' : '3d'));
  document.getElementById('vista-mosaico').addEventListener('click', () => cambiarModoVista(estado.modoVista === 'mosaico' ? cargarModoMapa() : 'mosaico'));
  document.getElementById('ajustar-calles').addEventListener('change', () => {
    if (estado.seleccionado) cargarRecorrido();
  });
  document.getElementById('limpiar-recorrido').addEventListener('click', () => {
    limpiarRecorrido();
    document.getElementById('info-recorrido').textContent = '';
  });

  document.querySelectorAll('[data-dia]').forEach((b) => {
    b.addEventListener('click', () => cargarRutaDelDia(diaLocal(Number(b.dataset.dia))));
  });
  document.getElementById('cargar-dia').addEventListener('click', () => {
    cargarRutaDelDia(document.getElementById('dia-ruta').value);
  });
  document.getElementById('dia-ruta').addEventListener('change', (e) => cargarRutaDelDia(e.target.value));
  // La lista de días se arma en el servidor, así que se delega el clic.
  document.getElementById('dias-ruta').addEventListener('click', (e) => {
    const boton = e.target.closest('[data-dia-exacto]');
    if (boton) cargarRutaDelDia(boton.dataset.diaExacto);
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

  document.getElementById('salir').addEventListener('click', cerrarSesion);

  document.getElementById('buscar-equipo').addEventListener('input', (event) => {
    estado.filtro = event.currentTarget.value;
    programarRender('lista');
  });

  document.getElementById('iniciar-escaneo').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'ESCANEANDO…';
    try {
      await cargarEquipos();
      if (estado.seleccionado) await cargarRecorrido({ ajustarVista: false });
    } catch (err) {
      document.getElementById('info-recorrido').textContent = `Error: ${err.message}`;
    } finally {
      button.disabled = false;
      button.textContent = 'RESINCRONIZAR';
    }
  });

  document.getElementById('mostrar-panel').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    const open = !sidebar.classList.contains('abierto');
    sidebar.classList.toggle('abierto', open);
    document.getElementById('mostrar-panel').setAttribute('aria-expanded', String(open));
    programarResizeMapas();
  });

  document.getElementById('limpiar-alertas').addEventListener('click', () => {
    estado.alertas.forEach((alerta) => { alerta.reconocida = true; });
    renderAlertas();
  });
  document.getElementById('lista-alertas').addEventListener('click', (event) => {
    const ver = event.target.closest('[data-alerta-ver]');
    if (ver) {
      seleccionar(ver.dataset.alertaVer, true);
      cambiarVista('telemetria');
      return;
    }
    const ack = event.target.closest('[data-alerta-ack]');
    if (ack) {
      const alerta = estado.alertas.find((item) => String(item.id) === ack.dataset.alertaAck);
      if (alerta) alerta.reconocida = true;
      renderAlertas();
    }
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
    } else {
      sidebar.classList.remove('abierto');
      document.getElementById('mostrar-panel').setAttribute('aria-expanded', 'false');
      programarResizeMapas();
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
    enviarSuscripcionWs();
    const marker3d = estado.marcadores3d.get(imei);
    marker3d?.marker.remove();
    marker3d?.popup.remove();
    estado.marcadores3d.delete(imei);
    limpiarRecorrido();
    programarRender('lista', 'global', 'detalle', 'telemetria', 'objetivo', 'depuracion');
    document.getElementById('titulo-unidad').textContent = 'FLOTILLA';
    cambiarVista(estado.vista);
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
    renderDetalle();
    renderTelemetria();
    renderObjetivo();
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
