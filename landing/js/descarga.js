// ============================================================================
//  descarga.js  —  el boton para bajar la app de Android.
//
//  CONTRATO: el APK se publica como release de GitHub y no en Hosting, porque
//  Hosting en el plan gratis (Spark) rechaza los archivos ejecutables. El
//  boton arranca en el HTML como "Pedí acceso a la beta" (lleva al
//  formulario) y este archivo lo convierte en descarga.
//
//  Por que ya no se pregunta con HEAD si el APK existe: GitHub no manda
//  encabezados CORS, asi que desde la landing el fetch falla siempre aunque
//  el archivo este. "releases/latest/download/..." siempre apunta al ultimo
//  release: para cambiar el APK alcanza con subir uno nuevo con el mismo nombre.
// ============================================================================

const RUTA_APK = 'https://github.com/vmattio08/NeuroDesk-AI/releases/latest/download/neurodesk.apk';

// Peso del APK del release 1.0 (52,6 MB). Si se sube uno muy distinto, actualizarlo.
const PESO_APK = '53 MB';

const NOTA_CON_APK =
  'Para Android. Si tu equipo todavía no usa NeuroDesk, pedí acceso primero: ' +
  'sin un equipo, la app no tiene nada para mostrarte.';


export async function iniciarDescarga() {
  const botones = [...document.querySelectorAll('[data-descarga]')];
  if (!botones.length) return;

  const peso = ` · ${PESO_APK}`;

  for (const boton of botones) {
    boton.href = RUTA_APK;
    boton.replaceChildren(icono('i-bajar'), document.createTextNode(`Bajá la app para Android${peso}`));
  }

  for (const nota of document.querySelectorAll('[data-descarga-nota]')) {
    nota.textContent = NOTA_CON_APK;
  }
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
