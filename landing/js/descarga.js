// ============================================================================
//  descarga.js  —  el boton para bajar la app de Android.
//
//  CONTRATO: el APK se publica en /descargas/neurodesk.apk SOLO si existe
//  (si no hay APK de release, no se copia). La landing no se puede romper
//  por eso, asi que el boton arranca en el HTML como "Pedí acceso a la beta"
//  (lleva al formulario) y este archivo lo convierte en descarga UNICAMENTE
//  si un pedido HEAD al APK contesta 200.
//
//  Por que HEAD y no GET: HEAD trae solo los encabezados (si existe, que
//  tipo es y cuanto pesa) sin bajar los MB del archivo.
// ============================================================================

const RUTA_APK = '/descargas/neurodesk.apk';

const NOTA_CON_APK =
  'Para Android. Si tu equipo todavía no usa NeuroDesk, pedí acceso primero: ' +
  'sin un equipo, la app no tiene nada para mostrarte.';


export async function iniciarDescarga() {
  const botones = [...document.querySelectorAll('[data-descarga]')];
  if (!botones.length) return;

  const apk = await consultarApk();
  if (!apk.existe) return;   // queda "Pedí acceso a la beta" -> #contacto

  const peso = apk.bytes > 0 ? ` · ${megas(apk.bytes)}` : '';

  for (const boton of botones) {
    boton.href = RUTA_APK;
    boton.setAttribute('download', 'neurodesk.apk');
    boton.replaceChildren(icono('i-bajar'), document.createTextNode(`Bajá la app para Android${peso}`));
  }

  for (const nota of document.querySelectorAll('[data-descarga-nota]')) {
    nota.textContent = NOTA_CON_APK;
  }
}


// ----------------------------------------------------------------------------
// consultarApk()  —  ¿esta publicado el APK? Nunca tira error: ante cualquier
// duda contesta que no, y el boton se queda en el formulario (mejor eso que
// un link a un archivo que no existe).
// ----------------------------------------------------------------------------
async function consultarApk() {
  try {
    const respuesta = await fetch(RUTA_APK, { method: 'HEAD', cache: 'no-store' });
    if (respuesta.status !== 200) return { existe: false };

    // Un hosting configurado como "aplicacion de una sola pagina" contesta
    // 200 con el index.html para CUALQUIER ruta inventada. Eso no es el APK:
    // si lo que vuelve es HTML, hacemos de cuenta que no existe.
    const tipo = respuesta.headers.get('content-type') || '';
    if (tipo.includes('text/html')) return { existe: false };

    const bytes = Number(respuesta.headers.get('content-length')) || 0;
    return { existe: true, bytes };
  } catch {
    return { existe: false };   // sin red, bloqueado, lo que sea
  }
}


// 48234567 -> "46 MB". Redondeado a entero: nadie necesita los decimales.
function megas(bytes) {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}


// El mismo icono del sprite del HTML, armado desde JS.
function icono(id) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'icono');
  svg.setAttribute('aria-hidden', 'true');
  const uso = document.createElementNS(NS, 'use');
  uso.setAttribute('href', `#${id}`);
  svg.append(uso);
  return svg;
}
