// ============================================================================
//  main.js  —  el arranque de la landing de NeuroDesk AI.
//
//  Es el unico <script> del HTML. Importa las piezas y las prende de a una.
//  Cada pieza vive en su archivo y hace UNA cosa:
//
//    capturas.js    pone las capturas de pantalla si existen los PNG
//    descarga.js    convierte el boton en "Bajá la app" si existe el APK
//    video.js       muestra el video de YouTube si hay un link cargado
//    demo.js        la demo "la misma pregunta, dos personas"
//    formulario.js  el pedido de acceso a la beta (el unico que usa Firebase)
//
//  Y aca mismo, porque son cortitas: el menu del celular y la aparicion de
//  los bloques al hacer scroll.
//
//  POR QUE CADA PIEZA VA EN SU PROPIO try/catch: si una falla (por ejemplo,
//  el video no carga), las demas siguen andando y la pagina no se rompe.
//  El error queda en la consola para nosotros, nunca en la cara del visitante.
// ============================================================================

import { iniciarCapturas } from './capturas.js';
import { iniciarDescarga } from './descarga.js';
import { iniciarVideo } from './video.js';
import { iniciarDemo } from './demo.js';
import { iniciarFormulario } from './formulario.js';


function prender(nombre, funcion) {
  try {
    const resultado = funcion();
    // Si la pieza es asincronica (devuelve una promesa), sus errores llegan
    // despues del try: los atajamos tambien.
    if (resultado && typeof resultado.catch === 'function') {
      resultado.catch((e) => console.error(`[landing] fallo ${nombre}:`, e));
    }
  } catch (e) {
    console.error(`[landing] fallo ${nombre}:`, e);
  }
}

prender('el menu', iniciarMenu);
prender('la aparicion al hacer scroll', iniciarRevelado);
prender('las capturas', iniciarCapturas);
prender('el boton de descarga', iniciarDescarga);
prender('el video', iniciarVideo);
prender('la demo', iniciarDemo);
prender('el formulario', iniciarFormulario);


// ----------------------------------------------------------------------------
// iniciarMenu()  —  el desplegable del celular.
//
// La lista de links ya esta en el HTML; en la compu se ve en la cabecera y en
// el celular queda escondida hasta tocar el boton. Lo unico que hace este
// codigo es poner y sacar la clase .menu-abierto y mantener aria-expanded al
// dia (eso es lo que le dice al lector de pantalla si el menu esta abierto).
// ----------------------------------------------------------------------------
function iniciarMenu() {
  const cabecera = document.getElementById('cabecera');
  const boton = cabecera?.querySelector('.boton-menu');
  const lista = document.getElementById('nav-lista');
  if (!cabecera || !boton || !lista) return;

  const estaAbierto = () => boton.getAttribute('aria-expanded') === 'true';
  const abrir = (abierto) => {
    boton.setAttribute('aria-expanded', String(abierto));
    cabecera.classList.toggle('menu-abierto', abierto);
  };

  boton.addEventListener('click', () => abrir(!estaAbierto()));

  // Elegir una seccion cierra el menu: si no, queda tapando lo que la persona
  // queria ver.
  lista.addEventListener('click', (e) => {
    if (e.target.closest('a')) abrir(false);
  });

  // Tocar afuera de la cabecera tambien lo cierra.
  document.addEventListener('click', (e) => {
    if (estaAbierto() && !cabecera.contains(e.target)) abrir(false);
  });

  // Escape cierra y devuelve el foco al boton: lo que se espera con teclado.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && estaAbierto()) {
      abrir(false);
      boton.focus();
    }
  });

  // Si la ventana se agranda a tamaño compu con el menu abierto, lo cerramos
  // para que no quede "abierto" escondido.
  matchMedia('(min-width: 960px)').addEventListener('change', (m) => {
    if (m.matches) abrir(false);
  });
}


// ----------------------------------------------------------------------------
// iniciarRevelado()  —  los bloques aparecen suave cuando entran en pantalla.
//
// Es puro adorno, asi que se apaga solo en tres casos: si la persona pidio
// "reducir movimiento" en su sistema, si el navegador no tiene
// IntersectionObserver, o si no corre el JavaScript. En los tres se ve todo
// quieto desde el principio (el CSS solo esconde con .js-revelar puesto).
// ----------------------------------------------------------------------------
function iniciarRevelado() {
  const bloques = [...document.querySelectorAll('[data-revelar]')];
  if (!bloques.length) return;

  const sinMovimiento = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (sinMovimiento || !('IntersectionObserver' in window)) return;

  // Lo que YA esta en pantalla se marca visible ANTES de prender el efecto.
  // Si no, al entrar directo a /#precios esos bloques parpadean: se ven, se
  // esconden y vuelven a aparecer.
  const alto = window.innerHeight;
  for (const bloque of bloques) {
    const caja = bloque.getBoundingClientRect();
    if (caja.top < alto && caja.bottom > 0) bloque.classList.add('visible');
  }

  document.documentElement.classList.add('js-revelar');

  const observador = new IntersectionObserver((entradas) => {
    for (const entrada of entradas) {
      if (entrada.isIntersecting) {
        entrada.target.classList.add('visible');
        observador.unobserve(entrada.target);   // aparece una vez y listo
      }
    }
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });

  for (const bloque of bloques) {
    if (!bloque.classList.contains('visible')) observador.observe(bloque);
  }
}
