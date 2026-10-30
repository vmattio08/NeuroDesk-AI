// ============================================================================
//  capturas.js  —  pone las capturas de pantalla reales cuando existen.
//
//  Cada marco de telefono o de navegador tiene un data-captura="nombre" y,
//  adentro, un placeholder con la marca. Si ese nombre esta en DISPONIBLES
//  (la lista de abajo), este archivo carga img/capturas/<nombre>.webp (la
//  version liviana) y, si no anda, img/capturas/<nombre>.png:
//    - si carga, cambia el placeholder por la imagen;
//    - si falla, no hace nada: queda el placeholder (nunca una imagen rota).
//
//  POR QUE UNA LISTA y no "probar a ver si existe": cada archivo que el
//  navegador pide y no esta deja un error 404 en la consola. Con la lista,
//  solo se piden las capturas que de verdad estan en img/capturas/.
//
//  PARA SUMAR UNA CAPTURA (por ejemplo la del panel en «Lo que falta»):
//    1. Copiar el PNG a img/capturas/ con el nombre del marco:
//       panel-lo-que-falta.png
//    2. Agregar el nombre aca abajo:  'panel-lo-que-falta': { webp: false },
//    3. (Opcional) Una version liviana con el mismo nombre,
//       panel-lo-que-falta.webp, y entonces poner webp: true.
//
//  Nombres que esperan los marcos del HTML: app-feed, app-captura, app-chat,
//  app-seguimiento, panel-lo-que-falta y panel-en-vivo.
// ============================================================================

const CARPETA = 'img/capturas/';

// Las capturas que YA estan en img/capturas/ (PNG original de 1080 x 2400, tal
// como sale del celular o del emulador, y su version .webp de 540 x 1200,
// unas 6 veces mas liviana). Las del chat y el seguimiento son de la vista del
// admin: por eso dicen "Como sos admin..." (lo mismo que la landing cuenta en
// "Privado quiere decir vos y el administrador").
const DISPONIBLES = {
  'app-feed':        { webp: true },
  'app-captura':     { webp: true },
  'app-chat':        { webp: true },
  'app-seguimiento': { webp: true },
};

// Solo nombres simples: letras, numeros y guiones. Si alguien escribe en el
// HTML algo como "../otra-cosa", no se arma ninguna ruta rara con eso.
const NOMBRE_VALIDO = /^[a-z0-9-]+$/;


export function iniciarCapturas() {
  const marcos = [...document.querySelectorAll('[data-captura]')].filter((marco) => {
    const nombre = marco.dataset.captura || '';
    if (!NOMBRE_VALIDO.test(nombre)) {
      console.warn('[landing] data-captura con un nombre invalido:', nombre);
      return false;
    }
    // hasOwnProperty y no "in": asi un nombre como "constructor" no cuela.
    return Object.prototype.hasOwnProperty.call(DISPONIBLES, nombre);
  });
  if (!marcos.length) return;

  // Sin IntersectionObserver (navegador viejo): las cargamos todas ya.
  if (!('IntersectionObserver' in window)) {
    marcos.forEach(cargar);
    return;
  }

  // Con IntersectionObserver, cada marco se carga recien cuando se acerca a
  // la pantalla (400 px antes): las capturas de abajo no se bajan si nadie
  // llega hasta ahi. Es el mismo criterio que loading="lazy".
  const observador = new IntersectionObserver((entradas) => {
    for (const entrada of entradas) {
      if (entrada.isIntersecting) {
        observador.unobserve(entrada.target);
        cargar(entrada.target);
      }
    }
  }, { rootMargin: '400px 0px' });

  marcos.forEach((marco) => observador.observe(marco));
}


function cargar(marco) {
  const nombre = marco.dataset.captura;
  const { webp } = DISPONIBLES[nombre];

  // Primero la liviana; si el navegador no sabe mostrar WebP (o el archivo
  // no esta), probamos con el PNG. Si tambien falla, queda el placeholder.
  const archivos = webp
    ? [`${CARPETA}${nombre}.webp`, `${CARPETA}${nombre}.png`]
    : [`${CARPETA}${nombre}.png`];
  let intento = 0;

  const imagen = new Image();
  imagen.className = 'captura-img';
  imagen.decoding = 'async';
  imagen.alt = marco.dataset.alt || '';

  // Recien cuando la imagen termino de cargar sacamos el placeholder: asi
  // nunca se ve un hueco ni el icono de "imagen rota".
  imagen.addEventListener('load', () => {
    marco.replaceChildren(imagen);
    marco.classList.add('tiene-captura');
  }, { once: true });

  imagen.addEventListener('error', () => {
    intento += 1;
    if (intento < archivos.length) imagen.src = archivos[intento];
  });

  imagen.src = archivos[0];
}
