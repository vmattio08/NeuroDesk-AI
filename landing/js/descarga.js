// ============================================================================
//  descarga.js  —  los botones para bajar la app de Android.
//
//  CONTRATO: el APK se publica como release de GitHub y no en Hosting, porque
//  Hosting en el plan gratis (Spark) rechaza los archivos ejecutables. Los
//  botones (data-descarga) ya traen en el HTML el link del release, asi andan
//  aunque no corra el JavaScript; este archivo les pone el icono y el peso
//  ("Bajá la app para Android · 53 MB") y vuelve a escribir el link: si algun
//  dia cambia, se cambia ACA y lo toman todos. Los links de texto
//  (data-descarga-link, en el pie) solo reciben el link, sin icono ni peso.
//
//  El boton principal de la landing ya no es este: es "Probala gratis", que
//  abre la misma app en la web (/app/). El APK queda al lado, para el que
//  prefiere instalarla.
//
//  Por que no se pregunta con HEAD si el APK existe: GitHub no manda
//  encabezados CORS, asi que desde la landing el fetch falla siempre aunque
//  el archivo este. "releases/latest/download/..." siempre apunta al ultimo
//  release: para cambiar el APK alcanza con subir uno nuevo con el mismo nombre.
// ============================================================================

const RUTA_APK = 'https://github.com/vmattio08/NeuroDesk-AI/releases/latest/download/neurodesk.apk';

// Peso del APK del release 1.0 (52,6 MB). Si se sube uno muy distinto, actualizarlo.
const PESO_APK = '53 MB';

// La nota de al lado del boton ya no se toca desde aca (antes decia "pedí
// acceso primero: sin un equipo, la app no tiene nada para mostrarte", y con
// el registro directo al espacio de prueba eso dejo de ser verdad). Ahora es
// texto fijo del HTML, que es donde se lee y se corrige.


export async function iniciarDescarga() {
  const peso = ` · ${PESO_APK}`;

  for (const boton of document.querySelectorAll('[data-descarga]')) {
    boton.href = RUTA_APK;
    boton.replaceChildren(icono('i-bajar'), document.createTextNode(`Bajá la app para Android${peso}`));
  }

  for (const enlace of document.querySelectorAll('[data-descarga-link]')) {
    enlace.href = RUTA_APK;
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
