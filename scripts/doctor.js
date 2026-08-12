#!/usr/bin/env node
/**
 * npm run doctor — diagnóstico de extremo a extremo.
 *
 * Lo importante: NO se conforma con "el proceso está escuchando". Comprueba que
 * el 5023 se alcanza DESDE INTERNET, porque en Google Cloud hay dos cortafuegos
 * independientes (ufw dentro de la VM y las reglas de VPC del proyecto) y el
 * puerto puede estar abierto en uno y cerrado en el otro.
 *
 * La comprobación externa usa check-host.net, un servicio público gratuito que
 * intenta la conexión TCP desde varios nodos repartidos por el mundo. Si no se
 * puede consultar, el resultado se reporta como DESCONOCIDO: nunca como éxito.
 */
import net from 'node:net';
import dns from 'node:dns/promises';
import 'dotenv/config';
import { config } from '../src/config.js';

const C = {
  reset: '\x1b[0m', rojo: '\x1b[31m', verde: '\x1b[32m', ambar: '\x1b[33m',
  azul: '\x1b[36m', gris: '\x1b[90m', negrita: '\x1b[1m',
};

const resultados = [];

function ok(titulo, detalle = '') {
  resultados.push({ estado: 'ok', titulo });
  console.log(`  ${C.verde}✔${C.reset} ${titulo}${detalle ? ` ${C.gris}${detalle}${C.reset}` : ''}`);
}
function fallo(titulo, detalle = '', arreglo = '') {
  resultados.push({ estado: 'fallo', titulo });
  console.log(`  ${C.rojo}✖${C.reset} ${titulo}${detalle ? ` ${C.gris}${detalle}${C.reset}` : ''}`);
  if (arreglo) console.log(`    ${C.ambar}→ ${arreglo}${C.reset}`);
}
function aviso(titulo, detalle = '', arreglo = '') {
  resultados.push({ estado: 'aviso', titulo });
  console.log(`  ${C.ambar}!${C.reset} ${titulo}${detalle ? ` ${C.gris}${detalle}${C.reset}` : ''}`);
  if (arreglo) console.log(`    ${C.ambar}→ ${arreglo}${C.reset}`);
}
function desconocido(titulo, detalle = '') {
  resultados.push({ estado: 'desconocido', titulo });
  console.log(`  ${C.azul}?${C.reset} ${titulo}${detalle ? ` ${C.gris}${detalle}${C.reset}` : ''}`);
}
function seccion(t) {
  console.log(`\n${C.negrita}${t}${C.reset}`);
}

// ── utilidades de red ────────────────────────────────────────────────────────

function conectarTcp(host, puerto, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: puerto });
    const t = setTimeout(() => {
      s.destroy();
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    s.on('connect', () => {
      clearTimeout(t);
      s.destroy();
      resolve({ ok: true });
    });
    s.on('error', (err) => {
      clearTimeout(t);
      resolve({ ok: false, error: err.code || err.message });
    });
  });
}

async function fetchConTimeout(url, opciones = {}, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opciones, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Rangos de Cloudflare. Se intentan bajar los oficiales; si no hay salida a
// internet se usa la copia local (puede quedar desactualizada, por eso se avisa).
const CF_RESPALDO = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];

async function rangosCloudflare() {
  try {
    const res = await fetchConTimeout('https://www.cloudflare.com/ips-v4', {}, 6000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const texto = await res.text();
    const lineas = texto.split('\n').map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(l));
    return lineas.length > 0 ? { rangos: lineas, oficial: true } : { rangos: CF_RESPALDO, oficial: false };
  } catch {
    return { rangos: CF_RESPALDO, oficial: false };
  }
}

function ipANumero(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function enRango(ip, cidr) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
  const [red, bits] = cidr.split('/');
  const mascara = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipANumero(ip) & mascara) === (ipANumero(red) & mascara);
}

const esCloudflare = (ip, rangos) => rangos.some((c) => enRango(ip, c));

/**
 * Comprobación de alcanzabilidad REAL desde internet, vía check-host.net.
 * Devuelve { estado: 'abierto'|'cerrado'|'desconocido', detalle }.
 */
async function comprobarPuertoDesdeInternet(ip, puerto) {
  const cabeceras = { Accept: 'application/json', 'User-Agent': 'atlyx-gps-doctor' };
  let peticion;
  try {
    const res = await fetchConTimeout(
      `https://check-host.net/check-tcp?host=${encodeURIComponent(`${ip}:${puerto}`)}&max_nodes=3`,
      { headers: cabeceras },
      12000,
    );
    if (!res.ok) return { estado: 'desconocido', detalle: `check-host.net respondió HTTP ${res.status}` };
    peticion = await res.json();
  } catch (err) {
    return { estado: 'desconocido', detalle: `no se pudo consultar check-host.net (${err.message})` };
  }

  if (!peticion?.request_id) {
    return { estado: 'desconocido', detalle: 'check-host.net no devolvió un identificador de petición' };
  }

  // Los nodos tardan unos segundos; se consulta el resultado varias veces.
  for (let intento = 0; intento < 8; intento++) {
    await new Promise((r) => setTimeout(r, 3000));
    let datos;
    try {
      const res = await fetchConTimeout(
        `https://check-host.net/check-result/${peticion.request_id}`,
        { headers: cabeceras },
        12000,
      );
      datos = await res.json();
    } catch {
      continue;
    }

    const entradas = Object.entries(datos ?? {});
    const listos = entradas.filter(([, v]) => v !== null);
    if (listos.length === 0) continue;

    const exitosos = listos.filter(([, v]) => Array.isArray(v) && v[0] && v[0].time !== undefined && !v[0].error);
    const fallidos = listos.filter(([, v]) => !Array.isArray(v) || !v[0] || v[0].error !== undefined);

    if (exitosos.length > 0) {
      const nodos = exitosos.map(([n, v]) => `${n.split('.')[0]} ${Math.round(v[0].time * 1000)}ms`).join(', ');
      return { estado: 'abierto', detalle: `conectaron ${exitosos.length}/${listos.length} nodos (${nodos})` };
    }
    if (listos.length >= Math.min(3, entradas.length) && fallidos.length === listos.length) {
      const motivo = fallidos[0][1]?.[0]?.error ?? 'sin respuesta';
      return { estado: 'cerrado', detalle: `ningún nodo pudo conectar (${motivo})`, permalink: peticion.permanent_link };
    }
  }

  return { estado: 'desconocido', detalle: 'check-host.net no entregó resultados a tiempo' };
}

async function ipPublicaPropia() {
  for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip']) {
    try {
      const res = await fetchConTimeout(url, {}, 6000);
      const ip = (await res.text()).trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    } catch {
      /* se intenta el siguiente */
    }
  }
  return null;
}

// ── comprobaciones ───────────────────────────────────────────────────────────

async function main() {
  console.log(`${C.negrita}atlyx-gps · doctor${C.reset}`);
  console.log(`${C.gris}Comprueba configuración, DNS, base de datos y alcanzabilidad real del puerto de ingesta.${C.reset}`);

  const ipVps = config.deploy.vpsIp;
  const dominioGps = config.deploy.gpsDomain;
  const dominioView = config.deploy.viewDomain;
  const puerto = config.tcp.port;

  // ── 1. configuración ──
  seccion('1. Configuración');
  if (config.auth.passwordHash) ok('AUTH_PASSWORD_HASH definido');
  else if (config.auth.passwordPlain && config.auth.passwordPlain !== 'cambiame')
    aviso('Contraseña en texto plano', 'AUTH_PASSWORD_HASH está vacío', 'npm run hash-password -- \'tu-password\'');
  else fallo('Sin contraseña utilizable', 'AUTH_PASSWORD sigue en el valor de ejemplo o vacío', 'npm run hash-password -- \'tu-password\'');

  if (config.auth.sessionSecretProvided) ok('SESSION_SECRET definido');
  else aviso('SESSION_SECRET vacío', 'las sesiones se pierden en cada reinicio', 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');

  if (ipVps) ok('VPS_PUBLIC_IP definido', ipVps);
  else fallo('VPS_PUBLIC_IP vacío', '', 'defínelo en .env para poder comprobar DNS y alcanzabilidad');

  ok('Zona horaria de la interfaz', config.ui.timezone);

  // ── 2. DNS y Cloudflare ──
  seccion('2. DNS en Cloudflare');
  const { rangos, oficial } = await rangosCloudflare();
  if (!oficial) aviso('Rangos de Cloudflare desde copia local', 'no se pudo bajar cloudflare.com/ips-v4');

  // gps.atlyx.online DEBE ir en gris (sin proxy): el tracker habla TCP crudo.
  try {
    const ips = await dns.resolve4(dominioGps);
    const proxeado = ips.some((ip) => esCloudflare(ip, rangos));
    if (proxeado) {
      fallo(
        `${dominioGps} está detrás del proxy de Cloudflare (NUBE NARANJA)`,
        ips.join(', '),
        'Ponlo en NUBE GRIS. El proxy solo maneja HTTP/HTTPS; con la nube naranja el dominio ' +
          'resuelve a IPs de Cloudflare y el rastreador NUNCA va a conectar por TCP.',
      );
    } else if (ipVps && ips.includes(ipVps)) {
      ok(`${dominioGps} → ${ipVps}`, 'nube gris, apunta al VPS');
    } else if (ipVps) {
      fallo(`${dominioGps} no apunta al VPS`, `resuelve a ${ips.join(', ')}, se esperaba ${ipVps}`, 'corrige el registro A en Cloudflare');
    } else {
      aviso(`${dominioGps} → ${ips.join(', ')}`, 'sin VPS_PUBLIC_IP no se puede confirmar');
    }
  } catch (err) {
    fallo(`No se pudo resolver ${dominioGps}`, err.code ?? err.message, 'crea el registro A en Cloudflare (proxy DESACTIVADO)');
  }

  // view.atlyx.online SÍ conviene en naranja: TLS gratis y oculta la IP origen.
  try {
    const ips = await dns.resolve4(dominioView);
    const proxeado = ips.some((ip) => esCloudflare(ip, rangos));
    if (proxeado) ok(`${dominioView} está detrás del proxy de Cloudflare`, 'nube naranja, como debe ser');
    else if (ipVps && ips.includes(ipVps))
      aviso(
        `${dominioView} apunta directo al VPS (NUBE GRIS)`,
        ips.join(', '),
        'Funciona, pero expone la IP del servidor. Si lo pones en naranja, activa el modo SSL "Full (strict)" en Cloudflare.',
      );
    else aviso(`${dominioView} → ${ips.join(', ')}`, 'no coincide ni con Cloudflare ni con el VPS');
  } catch (err) {
    fallo(`No se pudo resolver ${dominioView}`, err.code ?? err.message, 'crea el registro A en Cloudflare (proxy ACTIVADO)');
  }

  // ── 3. servicios locales ──
  seccion('3. Servicios locales');
  const local = await conectarTcp('127.0.0.1', puerto, 3000);
  if (local.ok) ok(`Algo escucha en 127.0.0.1:${puerto}`, 'ojo: esto NO prueba que se alcance desde internet');
  else fallo(`Nada escucha en 127.0.0.1:${puerto}`, local.error, 'docker compose up -d  (o revisa los logs del servicio node)');

  const httpLocal = await conectarTcp('127.0.0.1', config.http.port, 3000);
  if (httpLocal.ok) ok(`El servidor web escucha en 127.0.0.1:${config.http.port}`);
  else aviso(`Nada escucha en 127.0.0.1:${config.http.port}`, httpLocal.error, 'normal si corres el doctor fuera del servidor');

  try {
    const pg = await import('../src/db/pool.js');
    const { rows } = await pg.pool.query('SELECT postgis_version() AS v');
    ok('PostgreSQL + PostGIS responden', rows[0].v.split(' ')[0]);
    const mig = await pg.pool.query('SELECT count(*)::int AS n FROM schema_migrations').catch(() => null);
    if (mig) ok('Migraciones aplicadas', `${mig.rows[0].n}`);
    else aviso('La tabla schema_migrations no existe', '', 'npm run migrate');
    await pg.closePool();
  } catch (err) {
    aviso('No se pudo consultar la base de datos', err.message, 'normal si corres el doctor fuera del servidor o del contenedor');
  }

  // ── 4. alcanzabilidad REAL desde internet ──
  seccion(`4. Alcanzabilidad del puerto ${puerto} DESDE INTERNET`);
  if (!ipVps) {
    desconocido('No se puede comprobar', 'falta VPS_PUBLIC_IP');
  } else {
    const miIp = await ipPublicaPropia();

    // Si el doctor corre en la propia VM, conectarse a su IP pública no prueba
    // nada: Google Cloud no hace hairpin del tráfico a la IP externa propia.
    const dentroDelVps = miIp === ipVps;
    if (dentroDelVps) {
      console.log(`  ${C.gris}Corriendo dentro del propio VPS: la prueba local a la IP pública no sirve, se usa un nodo externo.${C.reset}`);
    } else if (miIp) {
      const directo = await conectarTcp(ipVps, puerto, 8000);
      if (directo.ok) ok(`Conexión directa desde esta máquina (${miIp}) a ${ipVps}:${puerto}`);
      else fallo(`Esta máquina (${miIp}) NO alcanza ${ipVps}:${puerto}`, directo.error);
    }

    const externo = await comprobarPuertoDesdeInternet(ipVps, puerto);
    if (externo.estado === 'abierto') {
      ok(`${ipVps}:${puerto} SE ALCANZA desde internet`, externo.detalle);
    } else if (externo.estado === 'cerrado') {
      fallo(
        `${ipVps}:${puerto} NO se alcanza desde internet`,
        externo.detalle,
        'Revisa LAS DOS capas de cortafuegos (ver el recordatorio de abajo). ' +
          (externo.permalink ? `Detalle: ${externo.permalink}` : ''),
      );
    } else {
      desconocido(`No se pudo verificar ${ipVps}:${puerto} desde internet`, externo.detalle);
    }

    // Y de paso, el dominio: es lo que el equipo va a resolver de verdad.
    const porDominio = await conectarTcp(dominioGps, puerto, 8000);
    if (porDominio.ok) ok(`${dominioGps}:${puerto} acepta conexiones`, 'que es exactamente lo que hace el rastreador');
    else aviso(`No se pudo conectar a ${dominioGps}:${puerto} desde aquí`, porDominio.error);
  }

  // ── 5. interfaz web pública ──
  seccion('5. Interfaz web');
  try {
    const res = await fetchConTimeout(`https://${dominioView}/api/health`, {}, 12000);
    const cuerpo = await res.json().catch(() => ({}));
    if (res.ok && cuerpo.ok) ok(`https://${dominioView}/api/health responde correcto`, `postgis ${cuerpo.postgis ?? '?'}`);
    else fallo(`https://${dominioView}/api/health respondió HTTP ${res.status}`, JSON.stringify(cuerpo).slice(0, 120));
  } catch (err) {
    aviso(`No se pudo consultar https://${dominioView}/api/health`, err.message, 'revisa Caddy, el DNS y el puerto 443');
  }

  // ── recordatorio de la doble capa de cortafuegos ──
  console.log(`\n${C.ambar}${C.negrita}${'═'.repeat(74)}${C.reset}`);
  console.log(`${C.ambar}${C.negrita}  GOOGLE CLOUD TIENE DOS CORTAFUEGOS INDEPENDIENTES${C.reset}`);
  console.log(`${C.ambar}${'═'.repeat(74)}${C.reset}`);
  console.log(`  a) ${C.negrita}ufw${C.reset}, dentro de la VM        → lo configura deploy.sh`);
  console.log(`  b) ${C.negrita}reglas de VPC${C.reset} del proyecto  → hay que crearlas con gcloud, NO las hace deploy.sh`);
  console.log(`\n  Si falta (b), el puerto queda bloqueado aunque ufw esté abierto:\n`);
  console.log(`${C.azul}  gcloud compute firewall-rules create allow-gps-tcp \\`);
  console.log(`    --allow tcp:5023 --source-ranges 0.0.0.0/0 --description "Ingesta GPS GT06"`);
  console.log(`  gcloud compute firewall-rules create allow-http-https \\`);
  console.log(`    --allow tcp:80,tcp:443 --source-ranges 0.0.0.0/0${C.reset}`);
  console.log(`\n  Para ver las reglas actuales:`);
  console.log(`${C.azul}  gcloud compute firewall-rules list --format="table(name,allowed[].map().firewall_rule().list(),sourceRanges.list())"${C.reset}`);

  // ── resumen ──
  const fallos = resultados.filter((r) => r.estado === 'fallo').length;
  const avisos = resultados.filter((r) => r.estado === 'aviso').length;
  const dudas = resultados.filter((r) => r.estado === 'desconocido').length;

  console.log(`\n${C.negrita}Resumen:${C.reset} ${C.verde}${resultados.filter((r) => r.estado === 'ok').length} bien${C.reset}, ` +
    `${C.ambar}${avisos} aviso(s)${C.reset}, ${C.rojo}${fallos} fallo(s)${C.reset}, ${C.azul}${dudas} sin determinar${C.reset}\n`);

  process.exit(fallos > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`${C.rojo}El doctor falló: ${err.message}${C.reset}`);
  process.exit(2);
});
