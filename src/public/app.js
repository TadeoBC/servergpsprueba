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
      if (usable && estado.seleccionado === m.imei && estado.recorrido) estado.recorrido.addLatLng([m.position.latitude, m.position.longitude]);
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
    sidebar.classList.toggle('abierto');
    e.currentTarget.textContent = sidebar.classList.contains('abierto') ? '▼' : '▲';
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
    limpiarRecorrido();
    renderLista();
    renderDetalle();
    renderDepuracion();
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
