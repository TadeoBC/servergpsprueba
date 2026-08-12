/* atlyx GPS — interfaz. Sin paso de compilación: JS de navegador a secas. */
'use strict';

// ── estado ───────────────────────────────────────────────────────────────────
const estado = {
  config: { timezone: 'America/Mexico_City', umbrales: { verde_min: 5, ambar_min: 30 } },
  equipos: new Map(), // imei -> device (con last_position)
  paquetes: new Map(), // imei -> [paquete] (los últimos, para depuración)
  seleccionado: null,
  marcadores: new Map(), // imei -> L.Marker
  recorrido: null, // L.Polyline
  puntosRecorrido: null, // L.LayerGroup
  ws: null,
  reintentoWs: 1000,
  yaCentro: false,
};

// ── mapa ─────────────────────────────────────────────────────────────────────
// Centro inicial: San Juan del Río, Querétaro. Se reencuadra en cuanto llega
// la primera posición real.
const mapa = L.map('mapa', { zoomControl: true, attributionControl: true }).setView([20.3897, -99.9961], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; colaboradores de OpenStreetMap',
}).addTo(mapa);

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
  const ref = device.last_position?.server_time ?? device.last_seen_at;
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
      const ref = p?.device_time ?? p?.server_time ?? d.last_seen_at;
      return `
      <div class="equipo ${estado.seleccionado === d.imei ? 'seleccionado' : ''}" data-imei="${esc(d.imei)}">
        <span class="punto ${claseEstado(d)}"></span>
        <div class="datos">
          <div class="nombre">${esc(nombre(d))}${d.activo ? '' : '<span class="inactivo-tag">sin activar</span>'}</div>
          <div class="sub">${esc(desdeHace(ref))}${p && !p.valid ? ' · sin fix' : ''}</div>
        </div>
        <div class="vel">${p ? num(p.speed_kmh, 0, ' km/h') : '—'}</div>
      </div>`;
    })
    .join('');

  cont.querySelectorAll('.equipo').forEach((el) => {
    el.addEventListener('click', () => seleccionar(el.dataset.imei, true));
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
  const bateria = attrs.bateria;

  const filas = [
    ['IMEI', esc(d.imei)],
    ['Placa', esc(d.placa || '—')],
    ['Estado', d.activo ? 'activo' : '<span style="color:var(--ambar)">sin activar</span>'],
  ];

  if (p) {
    filas.push(
      ['Último reporte', `${esc(fmtFecha(p.device_time ?? p.server_time))}<br><span style="color:var(--texto-2)">${esc(desdeHace(p.device_time ?? p.server_time))}</span>`],
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
           <span>${esc(bateria.etiqueta)} (${bateria.nivel}/6)</span>
         </div>`,
      ]);
    }
    if (attrs.gsm_signal !== undefined) filas.push(['Señal GSM', `${attrs.gsm_signal}/4`]);
    if (attrs.terminal?.acc_encendido !== undefined) filas.push(['ACC', attrs.terminal.acc_encendido ? 'encendido' : 'apagado']);
    if (attrs.acc_encendido !== undefined) filas.push(['ACC', attrs.acc_encendido ? 'encendido' : 'apagado']);
    if (attrs.extras?.kilometraje_km !== undefined) filas.push(['Kilometraje', num(attrs.extras.kilometraje_km, 1, ' km')]);
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
}

function encuadrarTodo() {
  const puntos = [...estado.marcadores.values()].map((m) => m.getLatLng());
  if (puntos.length === 0) return;
  if (puntos.length === 1) mapa.setView(puntos[0], 15);
  else mapa.fitBounds(L.latLngBounds(puntos).pad(0.2));
}

// ── selección ────────────────────────────────────────────────────────────────
async function seleccionar(imei, centrar) {
  estado.seleccionado = imei;
  renderLista();
  renderDetalle();
  renderDepuracion();

  const m = estado.marcadores.get(imei);
  if (centrar && m) mapa.setView(m.getLatLng(), Math.max(mapa.getZoom(), 15));

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

    estado.recorrido = L.polyline(puntos.map((p) => [p[0], p[1]]), {
      color: '#3fa7ff',
      weight: 3,
      opacity: 0.85,
    }).addTo(mapa);

    estado.puntosRecorrido = L.layerGroup(
      puntos.map(([lat, lon, p]) =>
        L.circleMarker([lat, lon], { radius: 3, color: '#3fa7ff', fillOpacity: 0.9, weight: 1 }).bindPopup(
          `${esc(fmtFecha(p.device_time ?? p.server_time))}<br>${num(p.speed_kmh, 1, ' km/h')} · ${p.satellites ?? '—'} sat`,
        ),
      ),
    ).addTo(mapa);

    mapa.fitBounds(estado.recorrido.getBounds().pad(0.15));
    info.innerHTML = `${puntos.length} punto(s) · ${esc(fmtFecha(data.positions[0].device_time ?? data.positions[0].server_time))} → ${esc(fmtFecha(data.positions.at(-1).device_time ?? data.positions.at(-1).server_time))}`;
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
      const previo = estado.equipos.get(m.imei) ?? m.device;
      const device = { ...previo, ...m.device, last_position: m.position };
      estado.equipos.set(m.imei, device);
      actualizarMarcador(device);
      renderLista();
      if (estado.seleccionado === m.imei) renderDetalle();
      if (!estado.yaCentro) {
        estado.yaCentro = true;
        encuadrarTodo();
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

  const sidebar = document.getElementById('sidebar');
  document.getElementById('alternar-panel').addEventListener('click', (e) => {
    sidebar.classList.toggle('abierto');
    e.currentTarget.textContent = sidebar.classList.contains('abierto') ? '▼' : '▲';
  });
}

iniciar();
