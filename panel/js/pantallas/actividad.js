// ============================================================================
//  pantallas/actividad.js  —  "En vivo": lo que hace el equipo, contado en
//  castellano y en tiempo real.
//  Panel web de NeuroDesk AI.
//
//  Es el fondo de toda la demo: cada toque en un celular se escribe solo en
//  el proyector ("Martín subió...", "Camila preguntó...", "Valentino sacó a
//  Lucas del equipo"). Y hace verdad lo que promete la landing: "cada
//  movimiento queda registrado".
//
//  TRES ESCUCHAS, las tres cortadas en unmount():
//    1) eventos      -> el feed. orderBy creadoEn desc + limit 50. Lo escribe
//                       SOLO el servidor y SOLO lo lee el admin (la regla de
//                       eventos es "allow read: if esAdmin"): un miembro ni
//                       siquiera puede listar esta coleccion.
//    2) items        -> la franja "Ahora mismo": pendiente o procesando.
//    3) respuestas   -> la franja "Ahora mismo": buscando o redactando.
//  Las tres usan indices que ya estaban en firestore.indexes.json: eventos
//  ordena por un solo campo (Firestore crea ese indice solo) e items y
//  respuestas usan (estado ASC, creadoEn DESC). El 'in' de dos estados usa el
//  mismo indice que un '=='.
//
//  SEGURIDAD: el resumen de cada evento lo arma el servidor, pero adentro trae
//  titulos de items y preguntas que escribio cualquier miembro. Pasa SIEMPRE
//  por esc(), igual que el resto del panel. Un tipo de evento que el panel no
//  conoce se muestra igual, con un icono generico: el feed no esconde nada.
// ============================================================================

import {
  db, collection, query, where, orderBy, limit, onSnapshot
} from '../firebase.js';

import { aFecha, esc, fechaCorta, haceCuanto, plural } from '../util.js';
import { leerNombres } from '../nombres.js';
import { icono } from '../iconos.js';


let cortarEventos = null;
let cortarItems = null;
let cortarRespuestas = null;
let raiz = null;
let ctxPantalla = null;
let nombres = null;
let relojito = null;

let eventos = [];
let itemsEnCurso = [];
let respuestasEnCurso = [];
let desdeCache = false;

// Si una de las dos escuchas de "Ahora mismo" se corta (falta un indice, se
// vencio el token), la franja lo DICE en vez de quedar en "Nada en curso":
// eso seria mentir, porque no es que no pase nada, es que no lo podemos ver.
let errorItemsEnCurso = null;
let errorRespuestasEnCurso = null;

// Animacion de las filas nuevas: solo las que llegan DESPUES de la primera
// foto. Si animaramos la primera, al entrar a la pantalla se moverian las 50
// filas juntas, y eso no es "llego algo nuevo".
let primeraFoto = true;
let recienLlegados = new Set();

let filtro = 'todo';

// Cuenta los montajes. mount() espera los nombres antes de escuchar, y en ese
// rato el router puede volver a montar esta misma pantalla (En vivo -> Lo que
// falta -> En vivo, rapido): las variables de este archivo son UNA sola para
// los dos montajes. Sin este contador, el montaje viejo, al volver del await,
// abria escuchas y un reloj que nadie cortaba, o el unmount() del viejo le
// borraba el estado al nuevo y la pantalla quedaba en "No pudimos abrir esta
// pantalla: Cannot read properties of null (reading 'wsId')". Con el
// contador, el que se quedo viejo lo nota al volver y no abre nada.
// unmount() tambien suma: un montaje que estaba esperando ya no vale.
let montajes = 0;

// ¿Se esconde el texto de las preguntas? Por defecto NO: el contrato dice que
// el feed muestra siempre el resumen. Pero en el proyector se ve lo que
// pregunta cada uno, y eso lo decide el admin: tilda "Esconder el texto de
// las preguntas" y queda "Camila hizo una pregunta · 2 fuentes". Se recuerda
// en ESTE navegador (la compu del proyector), no en Firestore: es una
// comodidad de quien mira, no un dato del equipo.
const CLAVE_ESCONDER = 'neurodesk.panel.esconderPreguntas';
let esconderPreguntas = leerPreferencia();

const TOPE_EVENTOS = 50;
const TOPE_EN_CURSO = 10;

// "Ahora mismo" es AHORA. Un item que quedo en 'pendiente' hace dos meses
// (se cerro la app antes de mandarlo a procesar) no se esta procesando: hay
// que mirarlo en Contenido, no aca. El servidor da por colgado un item en
// 'procesando' a los 5 minutos y la app da por perdida una pregunta a los 3:
// las ventanas tienen margen de sobra sobre esos numeros.
// En los items la ventana se mide desde el ULTIMO cambio (ver momentoDelItem):
// un reproceso de un item viejo tambien es "ahora".
const VENTANA_ITEMS_MS = 30 * 60 * 1000;
const VENTANA_RESPUESTAS_MS = 10 * 60 * 1000;


// ----------------------------------------------------------------------------
// Cada tipo de evento: su icono, su grupo (para el filtro), su color y una
// etiqueta corta. Es la MISMA lista de tipos del modelo y del contrato, mas
// 'item.visibilidad' (el candado en vivo).
// ----------------------------------------------------------------------------
const TIPOS = {
  'workspace.creado':  { icono: 'chispa',       grupo: 'equipo',    tono: 'marca',      etiqueta: 'Espacio creado' },
  'item.listo':        { icono: 'listo',        grupo: 'contenido', tono: 'listo',      etiqueta: 'Contenido listo' },
  'item.error':        { icono: 'alerta',       grupo: 'contenido', tono: 'error',      etiqueta: 'No se pudo procesar' },
  'item.eliminado':    { icono: 'tacho',        grupo: 'contenido', tono: 'neutro',     etiqueta: 'Contenido borrado' },
  'items.purgados':    { icono: 'limpieza',     grupo: 'contenido', tono: 'neutro',     etiqueta: 'Limpieza de pendientes' },
  'item.visibilidad':  { icono: 'candado',      grupo: 'contenido', tono: 'marca',      etiqueta: 'Cambio de candado' },
  'miembro.agregado':  { icono: 'personaMas',   grupo: 'equipo',    tono: 'marca',      etiqueta: 'Entró al equipo' },
  'miembro.eliminado': { icono: 'personaMenos', grupo: 'equipo',    tono: 'procesando', etiqueta: 'Salió del equipo' },
  'rol.cambiado':      { icono: 'escudo',       grupo: 'equipo',    tono: 'marca',      etiqueta: 'Cambio de rol' },
  'pregunta.hecha':    { icono: 'pregunta',     grupo: 'preguntas', tono: 'royal',      etiqueta: 'Pregunta a la IA' },
  'plan.cambiado':     { icono: 'plan',         grupo: 'otros',     tono: 'neutro',     etiqueta: 'Cambio de plan' }
};

// Para cualquier tipo que no este arriba (uno nuevo del servidor que el panel
// todavia no conoce): se muestra igual, con el icono generico.
const DESCONOCIDO = { icono: 'generico', grupo: 'otros', tono: 'neutro', etiqueta: 'Otro movimiento' };

function definicionDe(tipo) {
  // Object.hasOwn: un tipo raro como 'constructor' no tiene que encontrar
  // algo heredado del objeto.
  return Object.hasOwn(TIPOS, tipo) ? TIPOS[tipo] : DESCONOCIDO;
}


// ============================================================================
//  MOUNT
// ============================================================================
export async function mount(contenedor, ctx) {
  const mio = ++montajes;
  raiz = contenedor;
  ctxPantalla = ctx;
  primeraFoto = true;
  recienLlegados = new Set();

  raiz.innerHTML = plantilla();
  engancharControles();

  // Hacen falta para "Ahora mismo" (de quien es lo que se esta procesando) y
  // para el texto de las preguntas escondidas.
  const leidos = await leerNombres(ctx.wsId);

  // Si mientras se leian los nombres esta pantalla se volvio a montar (o se
  // desmonto), este montaje ya no vale: no se abre nada (ver 'montajes').
  if (mio !== montajes) return;
  nombres = leidos;

  // Por las dudas, lo que hubiera quedado abierto se corta ANTES de abrir lo
  // nuevo: nunca dos escuchas del feed ni dos relojes a la vez.
  cortarEscuchasYReloj();
  escucharEventos();
  escucharEnCurso();

  // Los "hace 3 min" y la ventana de "Ahora mismo" se mueven con el reloj.
  relojito = setInterval(() => {
    dibujarAhora();
    dibujarFeed();
  }, 30 * 1000);
}


// ============================================================================
//  UNMOUNT  —  las tres escuchas y el reloj.
// ============================================================================
export function unmount() {
  montajes++;   // un mount() que todavia esta esperando ya no vale
  cortarEscuchasYReloj();

  eventos = [];
  itemsEnCurso = [];
  respuestasEnCurso = [];
  errorItemsEnCurso = null;
  errorRespuestasEnCurso = null;
  recienLlegados = new Set();
  nombres = null;
  raiz = null;
  ctxPantalla = null;
}

function cortarEscuchasYReloj() {
  for (const cortar of [cortarEventos, cortarItems, cortarRespuestas]) {
    if (cortar) cortar();
  }
  cortarEventos = cortarItems = cortarRespuestas = null;

  if (relojito) {
    clearInterval(relojito);
    relojito = null;
  }
}


// ============================================================================
//  LAS ESCUCHAS
// ============================================================================
function escucharEventos() {
  const consulta = query(
    collection(db, 'workspaces', ctxPantalla.wsId, 'eventos'),
    orderBy('creadoEn', 'desc'),
    limit(TOPE_EVENTOS)
  );

  cortarEventos = onSnapshot(
    consulta,
    { includeMetadataChanges: true },   // para el badge, como en items.js
    (foto) => {
      desdeCache = foto.metadata.fromCache;

      if (primeraFoto) {
        primeraFoto = false;
        recienLlegados = new Set();
      } else {
        // docChanges() dice que cambio desde la foto anterior. 'added' = un
        // evento nuevo (los eventos nunca se editan: son append-only). Con
        // el limit(50), cuando entra uno nuevo el mas viejo sale con
        // 'removed', y no hay que hacer nada con eso.
        recienLlegados = new Set(
          foto.docChanges().filter((c) => c.type === 'added').map((c) => c.doc.id)
        );
      }

      eventos = foto.docs.map((d) => ({ id: d.id, ...d.data() }));
      dibujarBadge();
      dibujarFeed();
    },
    (e) => {
      console.error('[actividad] se corto la escucha de eventos', e);
      mostrarError(explicarErrorFirestore(e));
    }
  );
}


function escucharEnCurso() {
  const wsId = ctxPantalla.wsId;

  cortarItems = onSnapshot(
    query(
      collection(db, 'workspaces', wsId, 'items'),
      where('estado', 'in', ['pendiente', 'procesando']),
      orderBy('creadoEn', 'desc'),
      limit(TOPE_EN_CURSO)
    ),
    (foto) => {
      itemsEnCurso = foto.docs.map((d) => ({ id: d.id, ...d.data() }));
      errorItemsEnCurso = null;
      dibujarAhora();
    },
    (e) => {
      console.warn('[actividad] se corto la escucha de items en curso', e);
      errorItemsEnCurso = explicarErrorFirestore(e);
      dibujarAhora();
    }
  );

  // El admin puede listar todas las respuestas (la regla mira esAdmin antes
  // que el autor). Igual que en el Radar.
  cortarRespuestas = onSnapshot(
    query(
      collection(db, 'workspaces', wsId, 'respuestas'),
      where('estado', 'in', ['buscando', 'redactando']),
      orderBy('creadoEn', 'desc'),
      limit(TOPE_EN_CURSO)
    ),
    (foto) => {
      respuestasEnCurso = foto.docs.map((d) => ({ id: d.id, ...d.data() }));
      errorRespuestasEnCurso = null;
      dibujarAhora();
    },
    (e) => {
      console.warn('[actividad] se corto la escucha de preguntas en curso', e);
      errorRespuestasEnCurso = explicarErrorFirestore(e);
      dibujarAhora();
    }
  );
}


// ============================================================================
//  DIBUJO
// ============================================================================
function plantilla() {
  return `
    <div class="encabezado">
      <div>
        <h1>En vivo</h1>
        <p class="apagado chico">
          Lo que hace el equipo, en tiempo real: los últimos ${TOPE_EVENTOS}
          movimientos que pasaron por el servidor.
        </p>
      </div>
      <div id="badgeActividad"></div>
    </div>

    <div id="errorActividad"></div>

    <section class="tarjeta ahora" aria-labelledby="tituloAhora">
      <h2 id="tituloAhora"><span class="ahora__punto" aria-hidden="true"></span> Ahora mismo</h2>
      <ul class="ahora__lista" id="ahoraLista" aria-live="polite"></ul>
    </section>

    <div class="filtros">
      <div class="campo">
        <label for="filtroActividad">Mostrar</label>
        <select id="filtroActividad">
          <option value="todo">Todo</option>
          <option value="contenido">Contenido</option>
          <option value="preguntas">Preguntas a la IA</option>
          <option value="equipo">Equipo y roles</option>
          <option value="otros">Otros</option>
        </select>
      </div>
      <label class="tilde">
        <input type="checkbox" id="esconderPreguntas">
        Esconder el texto de las preguntas (para proyectar)
      </label>
    </div>

    <ol class="feed" id="feed" aria-live="polite"></ol>
    <p class="resumen-filtro" id="resumenActividad"></p>
    <p class="resumen-filtro">
      El servidor anota lo que pasa por él: lo que se procesa, se borra o
      cambia de candado, las preguntas a la IA y los cambios del equipo.
    </p>
  `;
}


function dibujarBadge() {
  const caja = raiz?.querySelector('#badgeActividad');
  if (!caja) return;
  caja.innerHTML = desdeCache
    ? `<span class="badge-vivo cache" title="Estos datos salieron de la memoria del navegador. Puede que no haya internet.">
         <span class="punto"></span> Sin conexión
       </span>`
    : `<span class="badge-vivo vivo" title="Escuchando Firestore: lo nuevo aparece solo.">
         <span class="punto"></span> En vivo
       </span>`;
}


// ----------------------------------------------------------------------------
// El feed.
//
// NO se rearma con un innerHTML de toda la lista, a diferencia de las tablas:
// si se reemplazaran todas las filas, la animacion de la fila nueva se
// cortaria cada vez que llega otra foto o pasa el reloj de 30 segundos. Aca
// las filas que ya estaban SE QUEDAN (solo se les actualiza el texto) y las
// nuevas se insertan en su lugar. Como los eventos nunca se editan y siempre
// llegan ordenados del mas nuevo al mas viejo, nunca hay que mover una fila.
// ----------------------------------------------------------------------------
function dibujarFeed() {
  const lista = raiz?.querySelector('#feed');
  if (!lista) return;

  const visibles = eventos.filter((ev) => filtro === 'todo' || definicionDe(ev.tipo).grupo === filtro);

  const resumen = raiz.querySelector('#resumenActividad');
  if (resumen) {
    resumen.textContent = eventos.length === 0
      ? ''
      : `Mostrando ${visibles.length} de los últimos ${plural(eventos.length, 'movimiento', 'movimientos')}.`;
  }

  if (visibles.length === 0) {
    lista.innerHTML = `<li class="vacio">${eventos.length === 0
      ? 'Todavía no hay movimientos. Cuando alguien suba algo o le pregunte a la IA, aparece acá solo.'
      : 'No hay movimientos de este tipo entre los últimos.'}</li>`;
    return;
  }

  // Si estaba el cartel de "no hay nada", se va.
  lista.querySelectorAll(':scope > li:not([data-id])').forEach((n) => n.remove());

  // 1) Sacar las filas que ya no van (salieron del limit o del filtro).
  const quedan = new Set(visibles.map((ev) => ev.id));
  for (const nodo of [...lista.children]) {
    if (!quedan.has(nodo.dataset.id)) nodo.remove();
  }

  // 2) Recorrer en orden: reusar la fila si esta, crearla si no.
  const existentes = new Map([...lista.children].map((n) => [n.dataset.id, n]));
  visibles.forEach((ev, i) => {
    let nodo = existentes.get(ev.id);
    if (!nodo) {
      nodo = document.createElement('li');
      nodo.dataset.id = ev.id;
      if (recienLlegados.has(ev.id)) nodo.classList.add('fila-nueva');
      lista.insertBefore(nodo, lista.children[i] ?? null);
    } else if (lista.children[i] !== nodo) {
      // No deberia pasar (los eventos no cambian de fecha), pero si alguna vez
      // el orden no coincide, manda Firestore: se mueve la fila a su lugar.
      lista.insertBefore(nodo, lista.children[i] ?? null);
    }
    const def = definicionDe(ev.tipo);
    nodo.className = `evento tono-${def.tono}${nodo.classList.contains('fila-nueva') ? ' fila-nueva' : ''}`;
    nodo.innerHTML = filaDeEvento(ev, def);
  });

  // La animacion es de una sola vez: lo que llego en esta foto ya no es nuevo
  // para el proximo dibujo (un cambio de filtro no vuelve a animar nada).
  recienLlegados = new Set();
}


// El contenido de UNA fila. Todo lo de Firestore, por esc().
function filaDeEvento(ev, def) {
  // Para un tipo desconocido, el valor crudo va en el title (escapado): sirve
  // para que el equipo sepa que tipo nuevo esta mandando el servidor.
  const etiqueta = def === DESCONOCIDO
    ? `<span title="${esc(ev.tipo)}">${esc(def.etiqueta)}</span>`
    : esc(def.etiqueta);

  return `
    <span class="evento__icono">${icono(def.icono)}</span>
    <div class="evento__cuerpo">
      <p class="evento__texto">${esc(textoDelEvento(ev))}</p>
      <p class="evento__meta">${etiqueta} · <span title="${esc(fechaCorta(ev.creadoEn))}">${esc(haceCuanto(ev.creadoEn))}</span></p>
    </div>
  `;
}


// ----------------------------------------------------------------------------
// Todo lo que tenga forma de email adentro de un resumen. Esta pantalla se
// proyecta en la demo y el feed va con NOMBRES, pero hay dos caminos por los
// que un email puede llegar igual: los eventos de antes del 29/10 (el
// servidor escribia "x@gmail.com agregó a y@gmail.com como admin") y el
// respaldo del servidor cuando una ficha de members no tiene nombre
// (quienHizo -> email del token). En vez de confiar en que eso no pase, se
// tapa aca. La parte de antes de la @ no admite espacios, comillas, « » ni
// parentesis: asi "(juan@x.com)" conserva sus parentesis, y un "@Override" o
// "usuario@localhost" (sin punto en el dominio) no se tocan.
// ----------------------------------------------------------------------------
const EMAIL_EN_TEXTO = /[^\s@«»"'()<>[\]]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

function taparEmails(texto) {
  return String(texto).replace(EMAIL_EN_TEXTO, '(email oculto)');
}


// ----------------------------------------------------------------------------
// El texto de un evento: el resumen que escribio el servidor, con los emails
// tapados (ver EMAIL_EN_TEXTO)... salvo que el admin haya pedido esconder el
// texto de las preguntas.
//
// En ese caso NO se recorta el resumen "a ojo" (si el formato cambiara, se
// colaria un pedazo de la pregunta): se arma la frase de cero, con el nombre
// del que pregunto (actorUid) y, solo si la cola del resumen tiene EXACTAMENTE
// la forma que escribe el servidor (" · 2 fuentes, confianza alta"), esos
// dos datos. Si el formato no coincide, se muestra menos, nunca de mas.
// La cola acepta "fuente" o "fuentes" (como escribe el servidor desde el
// 29/10) y tambien "fuente(s)" (como quedaron escritos los eventos de antes):
// un cambio de redaccion del otro lado no tiene que hacer perder el dato aca.
// ----------------------------------------------------------------------------
function textoDelEvento(ev) {
  const crudo = typeof ev.resumen === 'string' && ev.resumen.trim() ? ev.resumen : '(sin detalle)';
  const resumen = taparEmails(crudo);
  if (ev.tipo !== 'pregunta.hecha' || !esconderPreguntas) return resumen;

  const quien = nombreDe(ev.actorUid);
  const corte = resumen.lastIndexOf(' · ');
  const cola = corte >= 0 ? resumen.slice(corte + 3) : '';
  const datos = /^(\d+) fuentes?(?:\(s\))?, confianza (alta|media|baja)$/.exec(cola);
  const esSeguimiento = corte >= 0 && resumen.slice(0, corte).endsWith(' (seguimiento)');

  let frase = `${quien} hizo una pregunta${esSeguimiento ? ' de seguimiento' : ''}`;
  if (datos) {
    const n = Number(datos[1]);
    frase += ` · ${n === 0 ? 'sin fuentes' : plural(n, 'fuente', 'fuentes')}, confianza ${datos[2]}`;
  }
  return frase;
}


// ----------------------------------------------------------------------------
// "Ahora mismo": lo que se esta procesando o preguntando en este momento.
// ----------------------------------------------------------------------------
function dibujarAhora() {
  const lista = raiz?.querySelector('#ahoraLista');
  if (!lista) return;

  const ahora = Date.now();
  // Sin fecha = recien creado (el serverTimestamp todavia no volvio): cuenta
  // como "ahora", que es exactamente lo que es.
  const reciente = (valor, ventana) => {
    const f = aFecha(valor);
    return !f || ahora - f.getTime() <= ventana;
  };

  const items = itemsEnCurso.filter((x) => reciente(momentoDelItem(x), VENTANA_ITEMS_MS));
  const preguntas = respuestasEnCurso.filter((x) => reciente(x.creadoEn, VENTANA_RESPUESTAS_MS));

  // Los errores de las escuchas van arriba de todo (el texto es nuestro, pero
  // pasa por esc() igual: la regla no tiene excepciones). Si las dos fallan
  // por lo mismo, el cartel sale una sola vez.
  const filasError = [...new Set([errorItemsEnCurso, errorRespuestasEnCurso].filter(Boolean))]
    .map((texto) => `<li class="ahora__error">${esc(texto)}</li>`);

  if (items.length === 0 && preguntas.length === 0) {
    lista.innerHTML = filasError.length > 0
      ? filasError.join('')
      : `<li class="ahora__vacio">Nada en curso. Cuando alguien suba algo o le pregunte a la IA, aparece acá.</li>`;
    return;
  }

  const filasItems = items.map((x) => {
    const procesando = x.estado === 'procesando';
    const cuando = momentoDelItem(x);
    return `
      <li class="en-curso">
        <span class="chip ${procesando ? 'chip-procesando' : 'chip-pendiente'}">${procesando ? 'Procesando' : 'Pendiente'}</span>
        <span class="en-curso__texto">«${esc(taparEmails(x.titulo || '(sin título)'))}» <span class="apagado">de ${esc(nombreDe(x.creadoPor))}</span></span>
        <span class="en-curso__cuando apagado" title="${esc(fechaCorta(cuando))}">${esc(haceCuanto(cuando))}</span>
      </li>`;
  });

  const filasPreguntas = preguntas.map((r) => {
    const redactando = r.estado === 'redactando';
    const texto = esconderPreguntas || typeof r.pregunta !== 'string'
      ? ''
      : ` <span class="apagado">«${esc(recortar(taparEmails(r.pregunta), 80))}»</span>`;
    return `
      <li class="en-curso">
        <span class="chip chip-buscando">${redactando ? 'Redactando' : 'Buscando'}</span>
        <span class="en-curso__texto">${esc(nombreDe(r.autorUid))} está preguntando${texto}</span>
        <span class="en-curso__cuando apagado" title="${esc(fechaCorta(r.creadoEn))}">${esc(haceCuanto(r.creadoEn))}</span>
      </li>`;
  });

  lista.innerHTML = [...filasError, ...filasPreguntas, ...filasItems].join('');
}


// ----------------------------------------------------------------------------
// La hora que cuenta para "ahora" en un item: la del ULTIMO cambio si la hay, y
// si no, la de creacion.
//   - actualizadoEn lo escribe el servidor en la misma transaccion que lo pasa
//     a 'procesando' (invariante 8 del modelo): un REPROCESO de un item de hace
//     un mes tambien se esta procesando ahora, y con creadoEn quedaria afuera.
//   - Un 'pendiente' recien subido todavia no tiene actualizadoEn (la app crea
//     el item sin ese campo): cuenta su creadoEn.
//   - Los dos pendientes viejos del seed tampoco lo tienen: siguen afuera.
// ----------------------------------------------------------------------------
function momentoDelItem(x) {
  return x.actualizadoEn ?? x.creadoEn;
}


function recortar(texto, largo) {
  return texto.length <= largo ? texto : texto.slice(0, largo - 1) + '…';
}

function nombreDe(uid) {
  return nombres ? nombres.nombreDe(uid) : 'Ex integrante';
}


// ============================================================================
//  CONTROLES
// ============================================================================
function engancharControles() {
  const selector = raiz.querySelector('#filtroActividad');
  const esconder = raiz.querySelector('#esconderPreguntas');

  selector.value = filtro;
  esconder.checked = esconderPreguntas;

  // Ninguno toca Firestore: filtran lo que ya esta en memoria.
  selector.addEventListener('change', (e) => {
    filtro = e.target.value;
    recienLlegados = new Set();   // cambiar el filtro no es "llego algo"
    dibujarFeed();
  });

  esconder.addEventListener('change', (e) => {
    esconderPreguntas = e.target.checked;
    guardarPreferencia(esconderPreguntas);
    dibujarFeed();
    dibujarAhora();
  });
}


// localStorage puede no estar (ventana privada, almacenamiento bloqueado): en
// ese caso la pantalla anda igual, solo que no se acuerda del tilde.
function leerPreferencia() {
  try {
    return localStorage.getItem(CLAVE_ESCONDER) === '1';
  } catch {
    return false;
  }
}

function guardarPreferencia(valor) {
  try {
    localStorage.setItem(CLAVE_ESCONDER, valor ? '1' : '0');
  } catch {
    // sin almacenamiento: no pasa nada, es solo una comodidad
  }
}


// ============================================================================
//  ERRORES
// ============================================================================
function mostrarError(texto) {
  const caja = raiz?.querySelector('#errorActividad');
  if (!caja) return;
  caja.innerHTML = texto ? `<div class="aviso aviso-error">${esc(texto)}</div>` : '';
}

function explicarErrorFirestore(e) {
  if (e.code === 'permission-denied') {
    // eventos es SOLO del admin. Si te bajaron el rol, esto es lo primero que
    // se cae (el shell igual te saca del panel en unos segundos).
    return 'Firestore no te deja leer los movimientos del equipo: solo el administrador ' +
           'puede. Si recién te cambiaron el rol, cerrá sesión y volvé a entrar.';
  }
  if (e.code === 'failed-precondition') {
    return 'Falta un índice en Firestore para esta lista. Miralo en la consola del ' +
           'navegador: el error trae el link para crearlo.';
  }
  if (e.code === 'unavailable') {
    return 'No hay conexión con Firestore. Se muestra lo último que quedó guardado.';
  }
  return 'No pudimos cargar los movimientos. Probá recargar la página.';
}
