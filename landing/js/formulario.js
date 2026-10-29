// ============================================================================
//  formulario.js  —  el pedido de acceso a la beta.
//
//  Que hace: valida los campos en el navegador con los MISMOS limites que
//  van a tener las reglas de Firestore, y crea UN documento en la coleccion
//  raiz "contactos". No lee nada de la base: solo escribe ese documento.
//
//  CONTRATO (las reglas de "contactos" se escriben contra esto; no cambiar
//  un campo sin avisar):
//
//    contactos/{id automatico} = {
//      nombre:   string de 1 a 80
//      email:    string de 5 a 120, con @
//      empresa:  string de 0 a 80 ('' si no la completa)
//      plan:     'free' | 'equipo' | 'pyme' | 'empresa' | 'no-se'
//      mensaje:  string de 0 a 1000
//      origen:   'landing'
//      creadoEn: serverTimestamp()   (la hora la pone el servidor, no la compu)
//    }
//
//  MIENTRAS NO ESTEN LAS REGLAS de "contactos", Firestore contesta
//  permission-denied: en nuestras reglas todo lo que no esta permitido esta
//  denegado. No es un bug: mostramos un mensaje amable y los datos quedan
//  escritos en el formulario para volver a intentar.
//
//  POR QUE EL SDK DE FIREBASE SE BAJA RECIEN AL TOCAR EL FORMULARIO: son
//  mas de 500 KB de JavaScript que solo sirven para mandar este formulario.
//  Bajarlos con la pagina la haria lenta para todos los que no lo completan.
//  Con import() dinamico se piden la primera vez que alguien entra a un campo.
//
//  PRIVACIDAD: el formulario se manda con JavaScript (fetch interno del SDK),
//  nunca como un GET: los datos no viajan en la URL ni quedan en el historial.
//  Por eso el boton arranca deshabilitado en el HTML y lo habilitamos aca.
// ============================================================================

const VERSION_SDK = '12.9.0';   // la misma que el panel (panel/js/firebase.js)
const URL_SDK = `https://www.gstatic.com/firebasejs/${VERSION_SDK}`;

// La config web de Firebase, copiada tal cual de panel/js/firebase.js.
// NO es un secreto (y hay que saber contestarlo en la defensa): la config de
// una app web viaja SIEMPRE al navegador, cualquiera la ve con Ctrl+U. Es la
// direccion del proyecto, no una contraseña. Lo que protege los datos son las
// reglas de Firestore.
const CONFIG_FIREBASE = {
  apiKey:            'AIzaSyAar9DHKvZUxDnpUaDQhvfE3eojwTXvn20',
  authDomain:        'neurodesk-6to.firebaseapp.com',
  projectId:         'neurodesk-6to',
  storageBucket:     'neurodesk-6to.firebasestorage.app',
  messagingSenderId: '455226002826',
  appId:             '1:455226002826:web:6621104ade762da7d64c73'
};

const COLECCION = 'contactos';
const PLANES = ['free', 'equipo', 'pyme', 'empresa', 'no-se'];
const NOMBRE_DEL_PLAN = { free: 'Free', equipo: 'Equipo', pyme: 'Pyme', empresa: 'Empresa', 'no-se': 'Todavía no sé' };

// Los limites del contrato. Se usan en la validacion y en el contador.
const MAX = { nombre: 80, email: 120, empresa: 80, mensaje: 1000 };
const MIN_EMAIL = 5;

// Algo@algo.algo, sin espacios. Es mas estricto que "tiene un @" (lo que
// pide el contrato), asi que todo lo que pasa aca tambien pasa las reglas.
const FORMA_DE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Si en 15 segundos no contesto, avisamos en vez de dejar el boton girando.
const ESPERA_MAXIMA_MS = 15000;


// ----------------------------------------------------------------------------
// validar(campo, valor) -> el mensaje de error, o null si esta bien.
// Los mensajes dicen QUE hacer, no solo que esta mal.
// ----------------------------------------------------------------------------
function validar(campo, valor) {
  switch (campo) {
    case 'nombre':
      if (valor.length === 0) return 'Escribí tu nombre.';
      if (valor.length > MAX.nombre) return `El nombre puede tener hasta ${MAX.nombre} caracteres.`;
      return null;

    case 'email':
      if (valor.length === 0) return 'Escribí tu email.';
      if (valor.length > MAX.email) return `El email puede tener hasta ${MAX.email} caracteres.`;
      if (valor.length < MIN_EMAIL || !FORMA_DE_EMAIL.test(valor)) {
        return 'Revisá el email: tiene que ser como nombre@empresa.com.';
      }
      return null;

    case 'empresa':
      if (valor.length > MAX.empresa) return `Puede tener hasta ${MAX.empresa} caracteres.`;
      return null;

    case 'plan':
      if (!PLANES.includes(valor)) return 'Elegí un plan de la lista.';
      return null;

    case 'mensaje':
      if (valor.length > MAX.mensaje) return `El mensaje puede tener hasta ${MAX.mensaje} caracteres.`;
      return null;

    default:
      return null;
  }
}


// ----------------------------------------------------------------------------
// conectar()  —  baja el SDK y abre Firestore, UNA sola vez.
//
// Guarda la promesa: si dos cosas la piden a la vez (el "precalentado" al
// tocar un campo y el envio), se baja una sola vez. Si falla (por ejemplo,
// sin red), se olvida de la promesa fallida para que el proximo intento
// vuelva a probar en vez de fallar para siempre.
// ----------------------------------------------------------------------------
let conexion = null;

function conectar() {
  if (!conexion) {
    conexion = (async () => {
      let sdkApp;
      let sdkFirestore;
      try {
        [sdkApp, sdkFirestore] = await Promise.all([
          import(`${URL_SDK}/firebase-app.js`),
          import(`${URL_SDK}/firebase-firestore.js`)
        ]);
      } catch (causa) {
        const error = new Error('No se pudo bajar el SDK de Firebase');
        error.code = 'sdk-no-cargo';
        error.cause = causa;
        throw error;
      }

      // getApps(): si por algun motivo ya estaba inicializada, la reusamos
      // (inicializarla dos veces tira "Firebase App named DEFAULT already exists").
      const app = sdkApp.getApps().length ? sdkApp.getApp() : sdkApp.initializeApp(CONFIG_FIREBASE);
      return { db: sdkFirestore.getFirestore(app), sdk: sdkFirestore };
    })();

    conexion.catch(() => { conexion = null; });
  }
  return conexion;
}


// Promise.race contra un reloj: lo que tarde mas de "ms" se da por fallado.
// (Ojo: si la escritura igual llega despues, Firestore la guarda. En el peor
// caso queda un pedido duplicado, que es mucho mejor que uno perdido.)
function conTiempo(promesa, ms) {
  let reloj;
  const limite = new Promise((_, rechazar) => {
    reloj = setTimeout(() => {
      const error = new Error('Tiempo agotado');
      error.code = 'tiempo-agotado';
      rechazar(error);
    }, ms);
  });
  return Promise.race([promesa, limite]).finally(() => clearTimeout(reloj));
}


// Codigo de error -> mensaje para la persona. Los codigos crudos de Firebase
// ('permission-denied') no se le muestran nunca a nadie: van a la consola.
function mensajeDeError(error) {
  switch (error?.code) {
    case 'permission-denied':
      return 'Todavía estamos terminando de habilitar este formulario y tu pedido no se pudo guardar. Probá de nuevo en un rato: tus datos siguen acá.';
    case 'unavailable':
    case 'deadline-exceeded':
    case 'tiempo-agotado':
      return 'No pudimos conectarnos con el servidor. Revisá tu conexión y probá de nuevo: tus datos siguen acá.';
    case 'resource-exhausted':
      return 'Nos llegaron muchos pedidos juntos. Probá de nuevo en unos minutos.';
    case 'invalid-argument':
      return 'Algún dato no tiene el formato esperado. Revisalos y probá de nuevo.';
    case 'sdk-no-cargo':
      return 'No pudimos cargar el formulario. Revisá tu conexión (o el bloqueador de anuncios) y probá de nuevo.';
    default:
      return 'No pudimos mandar tu pedido. Probá de nuevo en un rato: tus datos siguen acá.';
  }
}


// ============================================================================
//  EL FORMULARIO
// ============================================================================
export function iniciarFormulario() {
  const form = document.getElementById('formulario');
  if (!form) return;

  const campos = {
    nombre:  form.elements.namedItem('nombre'),
    email:   form.elements.namedItem('email'),
    empresa: form.elements.namedItem('empresa'),
    plan:    form.elements.namedItem('plan'),
    mensaje: form.elements.namedItem('mensaje')
  };
  const trampa       = form.elements.namedItem('nd-trampa');
  const boton        = document.getElementById('formulario-enviar');
  const estado       = document.getElementById('formulario-estado');
  const errorGeneral = document.getElementById('formulario-error');
  const listo        = document.getElementById('formulario-listo');
  const listoTitulo  = document.getElementById('formulario-listo-titulo');
  const listoTexto   = document.getElementById('formulario-listo-texto');
  const otro         = document.getElementById('formulario-otro');
  const contador     = form.querySelector('[data-contador]');

  let enviando = false;

  // --- Leer y validar -------------------------------------------------------
  // trim() en todo: "  Juan  " se guarda "Juan", y un nombre hecho solo de
  // espacios cuenta como vacio.
  const leer = (campo) => (campos[campo]?.value ?? '').trim();

  function mostrarErrorDe(campo, mensaje) {
    const input = campos[campo];
    const caja = document.getElementById(`f-${campo}-error`);
    if (!input || !caja) return;
    if (mensaje) {
      input.setAttribute('aria-invalid', 'true');
      caja.textContent = mensaje;
      caja.hidden = false;
    } else {
      input.removeAttribute('aria-invalid');
      caja.textContent = '';
      caja.hidden = true;
    }
  }

  function revisar(campo) {
    const mensaje = validar(campo, leer(campo));
    mostrarErrorDe(campo, mensaje);
    return mensaje === null;
  }

  // Al salir de un campo se valida (no mientras escribe: que te marque error
  // a la segunda letra es molesto). Si ya tenia un error, se re-valida con
  // cada tecla, asi el rojo se va apenas queda bien.
  for (const [campo, input] of Object.entries(campos)) {
    if (!input) continue;
    input.addEventListener('blur', () => {
      if (input.value !== '' || input.getAttribute('aria-invalid') === 'true') revisar(campo);
    });
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') revisar(campo);
    });
  }

  // --- Contador del mensaje -------------------------------------------------
  function contar() {
    if (!contador) return;
    const largo = campos.mensaje.value.length;
    contador.textContent = `${largo} / ${MAX.mensaje}`;
    contador.classList.toggle('cerca', largo > MAX.mensaje * 0.9);
  }
  campos.mensaje?.addEventListener('input', contar);
  contar();

  // --- Precalentado: el primer foco en el formulario empieza a bajar el SDK --
  form.addEventListener('focusin', () => { conectar().catch(() => {}); }, { once: true });

  // --- Estados del boton ----------------------------------------------------
  function ponerEnviando(si) {
    enviando = si;
    boton.disabled = si;
    form.setAttribute('aria-busy', String(si));
    if (si) {
      const giro = document.createElement('span');
      giro.className = 'boton__giro';
      giro.setAttribute('aria-hidden', 'true');
      boton.replaceChildren(giro, document.createTextNode('Enviando…'));
      estado.textContent = 'Enviando tu pedido…';
    } else {
      boton.textContent = 'Pedir acceso';
    }
  }

  function mostrarErrorGeneral(texto) {
    errorGeneral.textContent = texto;
    errorGeneral.hidden = false;
    estado.textContent = '';
  }

  function mostrarListo(datos) {
    const primerNombre = datos.nombre.split(/\s+/)[0];
    // textContent y no innerHTML: el nombre lo escribio el visitante, y asi
    // nunca se interpreta como HTML (no hay forma de inyectar nada).
    listoTitulo.textContent = `¡Listo, ${primerNombre}!`;
    listoTexto.textContent = `Recibimos tu pedido. Te vamos a escribir a ${datos.email}.`;
    form.hidden = true;
    listo.hidden = false;
    listo.focus();             // el lector de pantalla anuncia el resultado
  }

  // enfocar: false cuando lo llama un boton de plan, que despues ubica el
  // foco el mismo (si enfocaramos aca, la pagina saltaria dos veces).
  function otroPedido({ enfocar = true } = {}) {
    form.reset();
    for (const campo of Object.keys(campos)) mostrarErrorDe(campo, null);
    errorGeneral.hidden = true;
    estado.textContent = '';
    contar();
    listo.hidden = true;
    form.hidden = false;
    if (enfocar) campos.nombre.focus();
  }
  otro?.addEventListener('click', () => otroPedido());

  // --- El envio -------------------------------------------------------------
  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();               // que no recargue ni mande nada por la URL
    if (enviando) return;                  // el doble clic, el error numero uno de las demos

    errorGeneral.hidden = true;

    // Validamos TODO y llevamos el foco al primer campo con problemas.
    const orden = ['nombre', 'email', 'empresa', 'plan', 'mensaje'];
    const conError = orden.filter((campo) => !revisar(campo));
    if (conError.length) {
      estado.textContent = '';
      campos[conError[0]].focus();
      return;
    }

    const datos = {
      nombre:  leer('nombre'),
      email:   leer('email'),
      empresa: leer('empresa'),          // '' si no la completo: el contrato lo pide asi
      plan:    leer('plan'),
      mensaje: leer('mensaje')
    };

    // La trampa para bots: una persona nunca ve ese campo. Si vino con algo,
    // hacemos de cuenta que salio bien y no guardamos nada.
    if (trampa && trampa.value) {
      mostrarListo(datos);
      return;
    }

    if (!navigator.onLine) {
      mostrarErrorGeneral('No hay conexión a internet. Revisá tu conexión y probá de nuevo: tus datos siguen acá.');
      return;
    }

    ponerEnviando(true);
    try {
      const { db, sdk } = await conTiempo(conectar(), ESPERA_MAXIMA_MS);

      // EXACTAMENTE los campos del contrato, ni uno mas ni uno menos.
      await conTiempo(
        sdk.addDoc(sdk.collection(db, COLECCION), {
          nombre:   datos.nombre,
          email:    datos.email,
          empresa:  datos.empresa,
          plan:     datos.plan,
          mensaje:  datos.mensaje,
          origen:   'landing',
          creadoEn: sdk.serverTimestamp()
        }),
        ESPERA_MAXIMA_MS
      );

      ponerEnviando(false);
      mostrarListo(datos);
    } catch (error) {
      console.warn('[landing] no se pudo guardar el pedido de acceso:', error?.code || error);
      ponerEnviando(false);
      mostrarErrorGeneral(mensajeDeError(error));
    }
  });

  // --- Los botones de los planes --------------------------------------------
  // "Quiero el plan Equipo" lleva a #contacto (un link comun, que sin JS
  // tambien anda) y aca le sumamos dos cosas: deja el plan elegido en el
  // select y pone el foco en el primer campo vacio. El plan NO viaja en la URL.
  for (const link of document.querySelectorAll('[data-plan]')) {
    link.addEventListener('click', () => {
      const plan = link.dataset.plan;
      if (!PLANES.includes(plan)) return;

      if (!listo.hidden) otroPedido({ enfocar: false });   // si ya habia mandado uno, vuelve el formulario
      campos.plan.value = plan;
      mostrarErrorDe('plan', null);
      estado.textContent = `Elegiste el plan ${NOMBRE_DEL_PLAN[plan]}.`;

      // Despues del salto (que lo hace el link), el foco va al primer campo
      // vacio. preventScroll: el salto ya lo hizo el link, no queremos otro.
      setTimeout(() => {
        const vacio = ['nombre', 'email'].map((c) => campos[c]).find((input) => !input.value.trim());
        (vacio || campos.mensaje).focus({ preventScroll: true });
      }, 0);
    });
  }

  // Recien ahora, con todo conectado, el formulario se puede mandar.
  boton.disabled = false;
}
