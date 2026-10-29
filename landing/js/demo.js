// ============================================================================
//  demo.js  —  "La misma pregunta, dos personas".
//
//  Que demuestra: lo mismo que se prueba en la defensa con la app de verdad.
//  Lucia (admin) y Tomas (miembro) hacen la misma pregunta; la nota privada
//  de Lucia entra en la respuesta de ella y NO en la de el, porque el backend
//  arma la lista de lo que cada persona puede ver ANTES de buscar
//  (CONTRATO.md, endpoint 11, "El orden es la seguridad").
//
//  Los textos de las dos versiones ya estan en el HTML (los [data-para]).
//  Este archivo solo decide cual se ve: no inventa ni arma texto.
//  Las lineas que conectan cada cita con su fuente son CSS puro.
// ============================================================================

export function iniciarDemo() {
  const demo = document.getElementById('demo');
  if (!demo) return;

  // --- 1. El selector "Ver la respuesta como" -------------------------------
  const opciones = demo.querySelectorAll('input[name="vista"]');

  function mostrar(vista) {
    demo.dataset.vista = vista;          // el CSS dibuja la pista cortada con esto
    for (const bloque of demo.querySelectorAll('[data-para]')) {
      // hidden (y no solo CSS) para que el lector de pantalla tampoco lea la
      // version que no corresponde.
      bloque.hidden = bloque.dataset.para !== vista;
    }
  }

  for (const opcion of opciones) {
    opcion.addEventListener('change', () => {
      if (opcion.checked) mostrar(opcion.value);
    });
  }

  // Arranca con la que este marcada: al volver "atras", el navegador puede
  // haber recordado que la persona habia elegido a Tomas.
  const marcada = demo.querySelector('input[name="vista"]:checked');
  mostrar(marcada ? marcada.value : 'admin');


  // --- 2. Pasar por una cita [n] ilumina su fuente --------------------------
  // Con el mouse (pointerover) y con el teclado (focusin), para que nadie se
  // quede afuera.
  const encender = (evento) => {
    const cita = evento.target.closest?.('.cita');
    if (cita) demo.dataset.activa = cita.dataset.n;
  };
  const apagar = (evento) => {
    if (evento.target.closest?.('.cita')) delete demo.dataset.activa;
  };

  demo.addEventListener('pointerover', encender);
  demo.addEventListener('pointerout', apagar);
  demo.addEventListener('focusin', encender);
  demo.addEventListener('focusout', apagar);


  // --- 3. Tocar una cita ----------------------------------------------------
  // En el celular la fuente esta mas abajo: el link salta hasta ella (es un
  // href="#fuente-n" comun). En la compu la fuente ya esta a la vista, al
  // lado: ahi no saltamos (seria un movimiento innecesario) y solo la
  // iluminamos un momento.
  demo.addEventListener('click', (evento) => {
    const cita = evento.target.closest('.cita');
    if (!cita) return;

    const fuente = document.getElementById(`fuente-${cita.dataset.n}`);
    if (!fuente) return;

    const caja = fuente.getBoundingClientRect();
    const seVeEntera = caja.top >= 0 && caja.bottom <= window.innerHeight;
    if (seVeEntera) {
      evento.preventDefault();
      demo.dataset.activa = cita.dataset.n;
      setTimeout(() => {
        if (demo.dataset.activa === cita.dataset.n && document.activeElement !== cita) {
          delete demo.dataset.activa;
        }
      }, 1600);
    }
  });
}
