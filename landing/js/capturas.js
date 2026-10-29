// ============================================================================
//  capturas.js  —  pone las capturas de pantalla reales cuando existen.
//
//  Cada marco de telefono o de navegador tiene un data-captura="nombre" y,
//  adentro, un placeholder con la marca. Este archivo prueba cargar
//  img/capturas/<nombre>.png:
//    - si carga, cambia el placeholder por la imagen;
//    - si no existe, no hace nada: queda el placeholder (nunca una imagen rota).
//
//  Asi, para sumar las capturas alcanza con copiar los PNG a img/capturas/
//  con el nombre exacto. No hay que tocar el HTML ni este archivo.
//
//  Nombres que se esperan (contrato): app-feed, app-captura, app-chat,
//  app-seguimiento, panel-dashboard y panel-miembros.
//
//  Mientras falten, la consola del navegador muestra un 404 por cada una:
//  es esperado (el navegador avisa que pidio un archivo que no esta).
// ============================================================================

const CARPETA = 'img/capturas/';

// Solo nombres simples: letras, numeros y guiones. Si alguien escribe en el
// HTML algo como "../otra-cosa", no se arma ninguna ruta rara con eso.
const NOMBRE_VALIDO = /^[a-z0-9-]+$/;


export function iniciarCapturas() {
  const marcos = [...document.querySelectorAll('[data-captura]')];
  if (!marcos.length) return;

  // Sin IntersectionObserver (navegador viejo): las probamos todas ya.
  if (!('IntersectionObserver' in window)) {
    marcos.forEach(probar);
    return;
  }

  // Con IntersectionObserver, cada marco se prueba recien cuando se acerca a
  // la pantalla (400 px antes): las capturas de abajo no se bajan si nadie
  // llega hasta ahi. Es el mismo criterio que loading="lazy".
  const observador = new IntersectionObserver((entradas) => {
    for (const entrada of entradas) {
      if (entrada.isIntersecting) {
        observador.unobserve(entrada.target);
        probar(entrada.target);
      }
    }
  }, { rootMargin: '400px 0px' });

  marcos.forEach((marco) => observador.observe(marco));
}


function probar(marco) {
  const nombre = marco.dataset.captura;
  if (!NOMBRE_VALIDO.test(nombre || '')) {
    console.warn('[landing] data-captura con un nombre invalido:', nombre);
    return;
  }

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

  // Si no existe (404), no hacemos nada a proposito: queda el placeholder.
  imagen.addEventListener('error', () => {}, { once: true });

  imagen.src = CARPETA + nombre + '.png';
}
