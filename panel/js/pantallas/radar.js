// ============================================================================
//  pantallas/radar.js  —  "Lo que falta": lo que el equipo pregunto y la IA
//  no pudo contestar, porque nadie lo habia cargado.
//  Panel web de NeuroDesk AI.
//
//  ES LA RESPUESTA A "¿QUE CAMBIA CON GEMINI?" (decirlo asi en la defensa):
//  en Gemini, y en cualquier chat personal, el historial es de cada persona.
//  Nadie junta lo que TODO el equipo pregunto y no encontro, ni te deja
//  completarlo para todos con un boton. NeuroDesk puede, porque guarda las
//  preguntas de todo el equipo, y el admin las puede leer (las reglas ya lo
//  permiten: respuestas -> allow list si esAdmin).
//
//  COMO FUNCIONA, EN UNA FRASE: UNA escucha en vivo sobre las respuestas
//  'listo' (las 200 mas nuevas), y todas las cuentas salen de recorrer ese
//  array en memoria con armarRadar() (radar-calculos.js, que no sabe nada de
//  Firebase y por eso se prueba con node). No toca el servidor, ni las reglas,
//  ni el modelo de datos, y no gasta Gemini para mostrarse.
//
//  Y EL CANDADO DE LO QUE SE CITO: una pregunta solo pasa a "Resuelta" si la
//  respuesta cito algo que HOY es del equipo. Si Martin repite la pregunta de
//  Camila y a el se le cita SU nota privada (o el admin, que busca en todo),
//  para Camila el hueco sigue abierto. Por eso, ademas, se escucha el candado
//  de cada item citado (un documento por item, ver seguirCandados): cuando
//  Martin comparte su nota con el equipo, la fila se tapa sola, y si la vuelve
//  a privada, se abre otra vez.
//
//  LA UNICA ESCRITURA: el boton "Cargar la respuesta para el equipo" crea una
//  nota con EXACTAMENTE los campos que deja la regla (datosDeLaNota) y despues
//  le pide al servidor que la procese (POST .../procesar), igual que la app.
//
//  Molde de siempre: mount() dibuja y escucha, unmount() CORTA todo.
// ============================================================================

import {
  db, collection, doc, query, where, orderBy, limit, onSnapshot,
  setDoc, serverTimestamp
} from '../firebase.js';

import { pedir } from '../api.js';
import { esc, fechaCorta, haceCuanto, plural } from '../util.js';
import { leerNombres } from '../nombres.js';
import { icono } from '../iconos.js';
import {
  armarRadar, ordenarGrupos, tituloSugerido, validarNota, datosDeLaNota,
  MAX_TITULO, DIAS_DE_LA_SEMANA
} from '../radar-calculos.js';


// ----------------------------------------------------------------------------
// Estado del modulo. unmount() lo deja todo en cero, salvo dos cosas que se
// guardan a proposito entre visitas: como se ve la lista (orden, esconder) y
// las notas que se cargaron desde aca (notasCargadas, sin sus escuchas).
// ----------------------------------------------------------------------------
let cortarEscucha = null;
let raiz = null;
let ctxPantalla = null;
let nombres = null;         // { nombreDe(uid) } de nombres.js
let respuestas = [];        // lo ultimo que llego de Firestore, crudo
let grupos = [];            // lo ultimo que dibujamos (para encontrar la fila del boton)
let desdeCache = false;
let relojito = null;        // redibuja cada minuto: "hace 3 min" y la semana se mueven solos
let trabajando = false;     // hay una nota guardandose
let grupoAbierto = null;    // la fila de la que se esta cargando la respuesta

// Como se ve la lista. El orden y "esconder las resueltas" se mantienen
// mientras la pagina este abierta (ir y volver no los pierde).
let orden = 'recientes';
let esconderResueltas = false;
// "Sin nombres por defecto": el radar es para ver QUE le falta al equipo, no
// QUIEN pregunto que. Proyectado en una reunion, una lista de "Camila
// pregunto..." parece vigilancia. Quien pregunto se ve solo si se pide, y
// unmount() lo vuelve a apagar: cada vez que se entra, arranca sin nombres.
let mostrarNombres = false;

// Las notas que se cargaron DESDE ESTA PANTALLA: clave de la fila -> nota
// ({ wsId, itemId, titulo, estado, ... }). Cada una tiene su propia escucha
// del item, para que la fila muestre sola "Pendiente -> Procesando -> Listo"
// sin ir a la pantalla de Contenido. Son una o dos por demo: no es un stream
// por fila de la lista.
// SOBREVIVEN AL UNMOUNT (solo se cortan sus escuchas, y mount() las vuelve a
// abrir): antes se borraban, y si el admin cargaba la respuesta, pasaba a En
// vivo o a Contenido y volvia antes de que alguien repreguntara, la fila
// perdia el "Cargaste «...»" y volvia a ofrecer el boton, como si no se
// hubiera hecho nada (un segundo clic creaba una nota repetida). Cada nota
// sabe de que espacio es: con el selector de espacios, una fila de otro
// espacio con la misma pregunta no la muestra.
const notasCargadas = new Map();

// EL CANDADO DE CADA ITEM CITADO: itemId -> 'equipo' | 'privado' | 'borrado'
// | 'sin_acceso'. Lo llena una escucha por item (seguirCandados), y de aca sale
// esDelEquipo(), que armarRadar() usa para decidir "Resuelta" y el top 5.
// En vivo y no leido una vez: el candado cambia DURANTE la demo (Martin
// comparte su nota) y la fila tiene que enterarse sola.
// Son los items distintos citados en las 200 respuestas: en la demo, unos
// pocos. Cuando un item deja de aparecer citado, su escucha se corta.
const candados = new Map();
const escuchasDeCandados = new Map();   // itemId -> cortar()

// Cuenta los montajes. mount() espera los nombres antes de escuchar, y en ese
// rato el router puede volver a montar esta misma pantalla (En vivo -> Lo que
// falta -> En vivo, rapido): las variables de este archivo son UNA sola para
// los dos montajes. El que se quedo viejo lo nota al volver del await y no
// abre nada (ver mount). unmount() tambien suma: un montaje que estaba
// esperando cuando se desmonto la pantalla ya no vale.
let montajes = 0;

// Las 200 mas nuevas: el mismo tope que el resto del panel. Con mas preguntas
// que eso, los numeros hablan de las 200 ultimas y la pantalla lo dice.
const TOPE = 200;

// Si Firestore no confirma la nota en este tiempo, casi seguro no hay
// internet: la escritura queda en cola en el navegador y se sube sola despues.
// Mismo numero que la app (captura.dart).
const ESPERA_ESCRITURA_MS = 12000;


// ============================================================================
//  MOUNT
// ============================================================================
export async function mount(contenedor, ctx) {
  const mio = ++montajes;
  raiz = contenedor;
  ctxPantalla = ctx;

  raiz.innerHTML = plantilla();
  engancharControles();
  engancharLista();
  engancharDialogo();

  // Los nombres (members + exMiembros) se leen una vez. Hacen falta solo si
  // el admin pide ver quien pregunto, pero leerlos ahora deja ese tilde
  // instantaneo y son dos lecturas.
  const leidos = await leerNombres(ctx.wsId);

  // Si mientras se leian los nombres esta pantalla se volvio a montar (o se
  // desmonto), este montaje ya no vale: el estado del modulo es del otro.
  // Seguir aca abriria una escucha y un reloj que nadie corta, o leeria el
  // ctxPantalla que unmount() ya puso en null ("Cannot read properties of
  // null (reading 'wsId')"). Por eso se corta ANTES de tocar nada.
  if (mio !== montajes) return;
  nombres = leidos;

  escuchar();

  // Las notas cargadas en una visita anterior a este mismo espacio: se
  // vuelven a escuchar, asi la fila sigue diciendo "Cargaste «...»" y su
  // estado (ver notasCargadas).
  for (const nota of notasCargadas.values()) {
    if (nota.wsId === ctx.wsId) escucharNota(nota);
  }

  // "Hace 3 min", "esta semana" y las notas en proceso cambian con el reloj
  // aunque no llegue nada nuevo de Firestore. Un minuto alcanza.
  if (relojito) clearInterval(relojito);
  relojito = setInterval(dibujar, 60 * 1000);
}


// ============================================================================
//  UNMOUNT  —  cortar la escucha, el reloj y las escuchas de las notas.
// ============================================================================
export function unmount() {
  montajes++;   // un mount() que todavia esta esperando ya no vale (ver arriba)
  if (cortarEscucha) {
    cortarEscucha();
    cortarEscucha = null;
  }
  if (relojito) {
    clearInterval(relojito);
    relojito = null;
  }
  // De las notas cargadas se cortan SOLO las escuchas: las notas quedan
  // anotadas para la proxima visita (ver notasCargadas).
  for (const nota of notasCargadas.values()) {
    nota.cortar?.();
    nota.cortar = null;
  }
  for (const cortar of escuchasDeCandados.values()) cortar();
  escuchasDeCandados.clear();
  candados.clear();

  // Si el dialogo estaba abierto, se cierra: si no, al volver a otra pantalla
  // quedaria flotando un formulario de una pantalla que ya no existe.
  raiz?.querySelector('#dialogoNota')?.close?.();

  respuestas = [];
  grupos = [];
  nombres = null;
  grupoAbierto = null;
  trabajando = false;
  mostrarNombres = false;   // la proxima visita arranca sin nombres
  raiz = null;
  ctxPantalla = null;
}


// ============================================================================
//  LA UNICA ESCUCHA
// ============================================================================
function escuchar() {
  if (cortarEscucha) cortarEscucha();

  // where estado == 'listo' + orderBy creadoEn desc: usa el indice compuesto
  // (estado ASC, creadoEn DESC) de respuestas, que ya estaba en
  // firestore.indexes.json. El admin puede listar TODAS las respuestas sin
  // filtrar por autor porque la regla mira esAdmin() antes que el documento.
  // Un miembro comun no podria: le caeria la query entera (las reglas no
  // filtran), y por eso esta pantalla es solo del panel.
  const consulta = query(
    collection(db, 'workspaces', ctxPantalla.wsId, 'respuestas'),
    where('estado', '==', 'listo'),
    orderBy('creadoEn', 'desc'),
    limit(TOPE)
  );

  mostrarError(null);

  cortarEscucha = onSnapshot(
    consulta,
    // Para el badge "En vivo" / "Sin conexión" (mismo motivo que en items.js).
    { includeMetadataChanges: true },
    (foto) => {
      desdeCache = foto.metadata.fromCache;
      respuestas = foto.docs.map((d) => ({ id: d.id, ...d.data() }));
      seguirCandados();
      dibujar();
    },
    (e) => {
      console.error('[radar] se corto la escucha', e);
      mostrarError(explicarErrorFirestore(e));
    }
  );
}


// ============================================================================
//  EL CANDADO DE CADA ITEM CITADO
//
//  Una escucha por cada item distinto que aparece citado en las respuestas
//  (onSnapshot de UN documento: una lectura al empezar y otra por cada cambio).
//  El admin puede leer todos los items del espacio, privados incluidos, asi
//  que ninguna de estas lecturas choca con las reglas.
//  Lo que importa es solo 'visibilidad'. Un item sin ese campo cuenta como
//  privado (el mismo default que las reglas), y uno borrado no es del equipo.
// ============================================================================
function seguirCandados() {
  const wsId = ctxPantalla?.wsId;
  if (!wsId) return;

  const citados = new Set();
  for (const r of respuestas) {
    for (const f of Array.isArray(r.fuentes) ? r.fuentes : []) {
      const itemId = f?.itemId;
      // Un id con '/' armaria otra ruta: esa fuente no se puede comprobar y
      // queda como "no es del equipo" (no se escucha nada raro).
      if (typeof itemId === 'string' && itemId && !itemId.includes('/')) citados.add(itemId);
    }
  }

  // Los que ya no aparecen citados (salieron de las 200): se corta su escucha.
  for (const [itemId, cortar] of escuchasDeCandados) {
    if (!citados.has(itemId)) {
      cortar();
      escuchasDeCandados.delete(itemId);
      candados.delete(itemId);
    }
  }

  for (const itemId of citados) {
    if (escuchasDeCandados.has(itemId)) continue;
    const cortar = onSnapshot(
      doc(db, 'workspaces', wsId, 'items', itemId),
      (foto) => {
        if (foto.exists()) {
          candados.set(itemId, foto.data().visibilidad === 'equipo' ? 'equipo' : 'privado');
        } else if (!foto.metadata.fromCache) {
          // Solo si el SERVIDOR dice que no existe: sin internet, la cache
          // puede no tenerlo y eso no es "borrado". Mientras, queda sin saber.
          candados.set(itemId, 'borrado');
        }
        dibujar();
      },
      (e) => {
        // Sin permiso (por ejemplo, te bajaron el rol) no se puede saber:
        // cuenta como que NO es del equipo. Lo peor que pasa es que una fila
        // quede "Sin respuesta" de mas, nunca que se tape con algo privado.
        console.warn('[radar] no pude leer el candado de un item citado', e);
        candados.set(itemId, 'sin_acceso');
        dibujar();
      }
    );
    escuchasDeCandados.set(itemId, cortar);
  }
}

// true = el item hoy es del equipo; false = privado, borrado o sin acceso;
// null = todavia no llego su candado (la fila queda "Comprobando…").
function esDelEquipo(itemId) {
  if (!candados.has(itemId)) return null;
  return candados.get(itemId) === 'equipo';
}


// ============================================================================
//  DIBUJO
// ============================================================================
function plantilla() {
  return `
    <div class="encabezado">
      <div>
        <h1>Lo que falta</h1>
        <p class="apagado chico">
          Lo que el equipo preguntó y la IA no pudo contestar, porque nadie lo
          había cargado. Cargá la respuesta y la próxima vez la encuentra.
        </p>
      </div>
      <div id="badgeRadar"></div>
    </div>

    <div id="errorRadar"></div>
    <div id="avisoRadar" aria-live="polite"></div>

    <div class="grilla-radar">
      <div class="radar-kpis">
        <div class="tarjeta kpi kpi-marca">
          <div class="etiqueta-kpi">Respondidas con fuente</div>
          <div class="valor" id="kpiPorcentaje">—</div>
          <div class="pie-kpi" id="piePorcentaje">esta semana</div>
        </div>

        <div class="tarjeta kpi kpi-falta">
          <div class="etiqueta-kpi">Sin resolver</div>
          <div class="valor" id="kpiSinResolver">—</div>
          <div class="pie-kpi" id="pieSinResolver">preguntas que nadie pudo contestar</div>
        </div>
      </div>

      <div class="tarjeta top-docs">
        <h2>Los documentos que más preguntas respondieron</h2>
        <ol class="top-docs__lista" id="topDocs"></ol>
        <p class="apagado chico" id="pieTopDocs"></p>
      </div>
    </div>

    <div class="filtros">
      <div class="campo">
        <label for="ordenRadar">Ordenar</label>
        <select id="ordenRadar">
          <option value="recientes">Lo más reciente primero</option>
          <option value="repetidas">Lo más preguntado primero</option>
        </select>
      </div>
      <label class="tilde"><input type="checkbox" id="esconderResueltas"> Esconder las resueltas</label>
      <label class="tilde"><input type="checkbox" id="mostrarNombres"> Mostrar quién preguntó</label>
    </div>

    <ul class="lista-huecos" id="listaRadar" aria-live="polite"></ul>

    <p class="resumen-filtro">
      Ojo: una pregunta puede aparecer acá aunque el dato exista, si está en
      algo <b>privado</b> de otra persona y quien preguntó no lo puede ver. Por
      eso la respuesta se carga <b>para el equipo</b>. Y por lo mismo, una
      pregunta pasa a «Resuelta» solo cuando a alguien se le citó algo que hoy
      es <b>del equipo</b>: si la única fuente fue algo privado, para el resto
      sigue faltando.
    </p>
    <p class="resumen-filtro" id="resumenRadar"></p>

    <dialog id="dialogoNota" class="dialogo" aria-labelledby="tituloDialogoNota">
      <form id="formNota" novalidate>
        <h2 id="tituloDialogoNota">Cargar la respuesta para el equipo</h2>
        <p class="apagado chico">
          Se guarda como una <b>nota del equipo</b> a tu nombre (la ve todo el
          equipo) y se procesa en el momento. La próxima vez que alguien
          pregunte lo mismo, la IA la va a encontrar y la va a citar.
        </p>

        <div class="campo">
          <label for="tituloNota">Título <span class="apagado">(la pregunta, así la encuentra el buscador)</span></label>
          <input type="text" id="tituloNota" maxlength="${MAX_TITULO}" required autocomplete="off">
          <div class="contador" id="contadorTitulo" aria-live="polite"></div>
        </div>

        <div class="campo">
          <label for="textoNota">La respuesta</label>
          <textarea id="textoNota" rows="4" maxlength="50000" required
                    placeholder="Ej: Jueves 12/11 a las 18 en el SUM."></textarea>
        </div>

        <div id="avisoNota" aria-live="assertive"></div>

        <div class="dialogo__botones">
          <button type="button" class="boton-suave" id="cancelarNota">Cancelar</button>
          <button type="submit" class="boton-principal" id="guardarNota">Guardar y procesar</button>
        </div>
      </form>
    </dialog>
  `;
}


// Todo junto: se llama en cada foto de Firestore, al cambiar un filtro y cada
// minuto. Recalcular 200 respuestas en memoria es instantaneo.
function dibujar() {
  if (!raiz) return;
  const radar = armarRadar(respuestas, Date.now(), esDelEquipo);
  grupos = radar.grupos;

  dibujarBadge();
  dibujarKpis(radar);
  dibujarLista();

  const resumen = raiz.querySelector('#resumenRadar');
  if (resumen) {
    resumen.textContent =
      `${sobreCuantas(radar.total)}` +
      (radar.total >= TOPE ? ` (se miran solo las ${TOPE} más nuevas)` : '') +
      `. "Esta semana" son los últimos ${DIAS_DE_LA_SEMANA} días.`;
  }
}

// "Sobre la última pregunta respondida" / "Sobre las últimas 9 preguntas
// respondidas". Con una sola, "las 1 últimas" se lee mal.
function sobreCuantas(n) {
  if (n === 0) return 'Todavía no hay preguntas respondidas';
  if (n === 1) return 'Sobre la última pregunta respondida';
  return `Sobre las últimas ${n} preguntas respondidas`;
}


function dibujarBadge() {
  const caja = raiz?.querySelector('#badgeRadar');
  if (!caja) return;
  caja.innerHTML = desdeCache
    ? `<span class="badge-vivo cache" title="Estos datos salieron de la memoria del navegador. Puede que no haya internet.">
         <span class="punto"></span> Sin conexión
       </span>`
    : `<span class="badge-vivo vivo" title="Escuchando Firestore: las preguntas nuevas aparecen solas.">
         <span class="punto"></span> En vivo
       </span>`;
}


function dibujarKpis(radar) {
  const poner = (id, texto) => {
    const nodo = raiz?.querySelector('#' + id);
    if (nodo) nodo.textContent = texto;
  };

  // --- % de la semana ---
  const { total, conFuente, porcentaje } = radar.semana;
  if (porcentaje === null) {
    poner('kpiPorcentaje', '—');
    poner('piePorcentaje', 'Todavía no hubo preguntas esta semana');
  } else {
    poner('kpiPorcentaje', `${porcentaje} %`);
    poner('piePorcentaje', `${conFuente} de ${plural(total, 'pregunta', 'preguntas')} de esta semana`);
  }

  // --- sin resolver ---
  // Las que estan "Comprobando…" (un instante, mientras llega el candado de
  // lo que se cito) no se cuentan todavia: no se sabe si se taparon.
  const pendientes = radar.grupos.filter((g) => !g.resuelta && !g.verificando);
  const vecesSemana = pendientes.reduce((suma, g) => suma + g.vecesSemana, 0);
  poner('kpiSinResolver', String(pendientes.length));
  poner('pieSinResolver', pendientes.length === 0
    ? 'el equipo encontró todo lo que buscó'
    : `${plural(pendientes.length, 'pregunta distinta', 'preguntas distintas')}` +
      (vecesSemana > 0 ? ` · ${plural(vecesSemana, 'vez', 'veces')} esta semana` : ''));

  // --- los 5 documentos mas utiles ---
  // esc() en el titulo: lo escribio una persona desde la app.
  const lista = raiz?.querySelector('#topDocs');
  if (lista) {
    lista.innerHTML = radar.masCitados.length === 0
      ? '<li class="apagado">Todavía ninguna pregunta citó un documento del equipo.</li>'
      : radar.masCitados.map((d) => `
          <li>
            <span class="top-docs__titulo">${esc(d.titulo)}</span>
            <span class="top-docs__n">${esc(plural(d.preguntas, 'pregunta', 'preguntas'))}</span>
          </li>`).join('');
  }
  poner('pieTopDocs', radar.total > 0
    ? `Cada documento cuenta una vez por pregunta, y solo entran los que hoy son del equipo. ${sobreCuantas(radar.total)}.`
    : '');
}


function dibujarLista() {
  const lista = raiz?.querySelector('#listaRadar');
  if (!lista) return;

  let visibles = ordenarGrupos(grupos, orden);
  if (esconderResueltas) visibles = visibles.filter((g) => !g.resuelta);

  if (visibles.length === 0) {
    lista.innerHTML = `
      <li class="vacio tarjeta">
        ${grupos.length === 0
          ? 'Por ahora el equipo encontró todo lo que buscó. Cuando alguien pregunte algo que nadie cargó, aparece acá solo.'
          : 'No hay preguntas sin resolver. Destildá "Esconder las resueltas" para ver las que ya se taparon.'}
      </li>`;
    return;
  }

  // Un solo innerHTML con todas las filas (ver el porque en items.js).
  lista.innerHTML = visibles.map(fila).join('');
}


// ----------------------------------------------------------------------------
// UNA FILA (una pregunta, con todas las veces que se hizo).
// Todo lo que sale de Firestore pasa por esc(): el texto de la pregunta lo
// escribio una persona, y los titulos de las fuentes tambien.
// ----------------------------------------------------------------------------
function fila(g) {
  const nota = notaDeLaFila(g.clave);

  const veces = g.vecesSemana > 0
    ? `${plural(g.vecesSemana, 'vez', 'veces')} esta semana`
    : 'esta semana no se preguntó';

  const total = g.veces > g.vecesSemana ? ` · ${g.veces} en total` : '';

  const contexto = g.sinContexto
    ? ` · <span title="Es una pregunta de seguimiento y el servidor no llegó a reformularla: puede faltarle de qué se hablaba.">pregunta de seguimiento</span>`
    : '';

  let quien = '';
  if (mostrarNombres && g.autores.length > 0) {
    const nombresDeAutores = g.autores
      .map((a) => esc(nombreDe(a.uid)) + (a.veces > 1 ? ` (${a.veces})` : ''))
      .join(', ');
    quien = `<p class="hueco__meta">${g.autores.length === 1 ? 'Lo preguntó' : 'Lo preguntaron'}: ${nombresDeAutores}</p>`;
  }

  const resuelta = g.resuelta
    ? `<p class="hueco__resuelta">${icono('listo')}
         <span>Se respondió <span title="${esc(fechaCorta(g.resueltaEn))}">${esc(haceCuanto(g.resueltaEn))}</span>
         ${g.resueltaCon.length ? `con ${g.resueltaCon.map((t) => `«${esc(t)}»`).join(', ')}` : ''}</span>
       </p>`
    : '';

  const lineaNota = nota ? lineaDeNota(nota) : '';

  // El boton aparece mientras la fila no este resuelta y no haya una nota en
  // camino para ella (si la nota fallo, vuelve a aparecer). Mientras se
  // comprueba el candado de lo que se cito, tampoco: en un instante se sabe
  // si hace falta.
  const puedeCargar = !g.resuelta && !g.verificando &&
    (!nota || nota.estado === 'error' || nota.estado === 'borrada');

  const chip = g.resuelta
    ? '<span class="chip chip-listo">Resuelta</span>'
    : g.verificando
      ? '<span class="chip chip-desconocido" title="Alguien la volvió a preguntar y tuvo fuentes: estamos viendo si alguna es del equipo.">Comprobando…</span>'
      : '<span class="chip chip-falta">Sin respuesta</span>';
  const boton = puedeCargar
    ? `<button class="boton-principal chico" data-cargar="${esc(g.clave)}">
         ${icono('mas')} Cargar la respuesta para el equipo
       </button>`
    : '';

  return `
    <li class="hueco ${g.resuelta ? 'hueco--resuelto' : ''}">
      <div class="hueco__cuerpo">
        <div class="hueco__cabeza">
          ${chip}
          <span class="hueco__veces">${esc(veces)}</span>
        </div>
        <p class="hueco__pregunta">${esc(g.texto)}</p>
        <p class="hueco__meta">
          Última vez <span title="${esc(fechaCorta(g.ultimaVez))}">${esc(haceCuanto(g.ultimaVez))}</span>${esc(total)}${contexto}
        </p>
        ${quien}
        ${resuelta}
        ${lineaNota}
      </div>
      ${boton ? `<div class="hueco__accion">${boton}</div>` : ''}
    </li>
  `;
}


// "Cargaste «...» · [Procesando]" debajo de la fila. El estado viene de la
// escucha del item (seguirNota), asi se ve pasar de Pendiente a Listo.
function lineaDeNota(nota) {
  const textos = {
    pendiente:  'Pendiente',
    procesando: 'Procesando',
    listo:      'Lista: la IA ya la puede usar',
    error:      'Error'
  };
  // Object.hasOwn: un estado raro ('constructor') no encuentra nada heredado.
  // Uno que no conocemos se muestra crudo y escapado, como en items.js.
  const conocido = Object.hasOwn(textos, nota.estado);
  const clase = conocido ? `chip-${nota.estado}` : 'chip-desconocido';

  const estado = nota.estado === 'borrada'
    ? '<span class="chip chip-desconocido">Ya no existe</span>'
    : `<span class="chip ${clase}">${esc(conocido ? textos[nota.estado] : (nota.estado || '—'))}</span>`;

  // Si quedo en 'pendiente' (el pedido al servidor fallo) o en 'error', se
  // ofrece reintentar ahi mismo, sin ir a la app.
  const reintentar = !nota.enviando &&
    ((nota.fallo && nota.estado === 'pendiente') || nota.estado === 'error')
    ? ` <button class="boton-suave chico" data-reintentar="${esc(nota.itemId)}">Reintentar</button>`
    : '';

  const error = nota.estado === 'error' && nota.errorMsg
    ? `<div class="celda-error">${esc(nota.errorMsg)}</div>`
    : '';

  return `<p class="hueco__nota">Cargaste «${esc(nota.titulo)}» ${estado}${reintentar}</p>${error}`;
}


function nombreDe(uid) {
  return nombres ? nombres.nombreDe(uid) : 'Ex integrante';
}


// ============================================================================
//  CONTROLES
// ============================================================================
function engancharControles() {
  const $ = (id) => raiz.querySelector('#' + id);

  $('ordenRadar').value = orden;
  $('esconderResueltas').checked = esconderResueltas;
  $('mostrarNombres').checked = mostrarNombres;

  // Ninguno toca Firestore: solo redibujan lo que ya esta en memoria.
  $('ordenRadar').addEventListener('change', (e) => { orden = e.target.value; dibujarLista(); });
  $('esconderResueltas').addEventListener('change', (e) => { esconderResueltas = e.target.checked; dibujarLista(); });
  $('mostrarNombres').addEventListener('change', (e) => { mostrarNombres = e.target.checked; dibujarLista(); });
}


// Delegacion de eventos en la lista (ver el porque en miembros.js): la lista
// se redibuja entera en cada foto, el <ul> no.
function engancharLista() {
  raiz.querySelector('#listaRadar').addEventListener('click', (evento) => {
    const cargar = evento.target.closest('[data-cargar]');
    if (cargar) {
      const g = grupos.find((x) => x.clave === cargar.dataset.cargar);
      if (g) abrirDialogo(g);
      return;
    }

    const reintentar = evento.target.closest('[data-reintentar]');
    if (reintentar) {
      const nota = [...notasCargadas.values()]
        .find((n) => n.wsId === ctxPantalla.wsId && n.itemId === reintentar.dataset.reintentar);
      if (nota && !nota.enviando) mandarAProcesar(ctxPantalla.wsId, nota);
    }
  });
}


// ============================================================================
//  "CARGAR LA RESPUESTA PARA EL EQUIPO"
//
//  Un <dialog> nativo y no un formulario adentro de la fila: la lista se
//  redibuja entera cada vez que alguien pregunta algo, y un formulario
//  adentro perderia lo que el admin esta escribiendo. El dialogo vive afuera
//  de la lista y no lo toca nadie.
// ============================================================================
function engancharDialogo() {
  const dialogo = raiz.querySelector('#dialogoNota');
  const form = raiz.querySelector('#formNota');
  const titulo = raiz.querySelector('#tituloNota');

  titulo.addEventListener('input', actualizarContador);
  raiz.querySelector('#cancelarNota').addEventListener('click', () => dialogo.close());
  form.addEventListener('submit', guardarNota);

  // Escape cierra el dialogo solo (es nativo). Mientras se guarda, no: si se
  // cierra a mitad de camino, el admin no se entera de como termino.
  dialogo.addEventListener('cancel', (e) => { if (trabajando) e.preventDefault(); });
}


function abrirDialogo(g) {
  const dialogo = raiz.querySelector('#dialogoNota');
  // showModal() sobre un dialogo ya abierto tira InvalidStateError (doble clic).
  if (dialogo.open) return;
  grupoAbierto = { clave: g.clave, texto: g.texto };

  raiz.querySelector('#tituloNota').value = tituloSugerido(g.texto);
  raiz.querySelector('#textoNota').value = '';
  avisarEnDialogo(null);
  actualizarContador();

  dialogo.showModal();
  // El titulo ya viene escrito: el foco va directo a la respuesta.
  raiz.querySelector('#textoNota').focus();
}


function actualizarContador() {
  const titulo = raiz?.querySelector('#tituloNota');
  const contador = raiz?.querySelector('#contadorTitulo');
  if (titulo && contador) contador.textContent = `${titulo.value.length}/${MAX_TITULO}`;
}


async function guardarNota(evento) {
  evento.preventDefault();
  if (trabajando || !grupoAbierto) return;

  const v = validarNota({
    titulo: raiz.querySelector('#tituloNota').value,
    texto: raiz.querySelector('#textoNota').value
  });
  if (!v.ok) {
    avisarEnDialogo(v.error);
    return;
  }

  const boton = raiz.querySelector('#guardarNota');
  const cancelar = raiz.querySelector('#cancelarNota');
  trabajando = true;
  boton.disabled = true;
  cancelar.disabled = true;
  boton.textContent = 'Guardando…';
  avisarEnDialogo(null);

  // Se copian ANTES del primer await: si el admin se va de la pantalla en el
  // medio, unmount() pone ctxPantalla en null y el resto tiene que seguir.
  const { wsId, uid } = ctxPantalla;
  const clave = grupoAbierto.clave;

  // El id se genera en el navegador (doc() sin id, no va a la red), como en
  // la app: hace falta ANTES de escribir para mandarlo despues a /procesar.
  const ref = doc(collection(db, 'workspaces', wsId, 'items'));
  const datos = datosDeLaNota({
    titulo: v.titulo,
    texto: v.texto,
    wsId,
    uid,
    marcaDelServidor: serverTimestamp()
  });

  // --- PASO 1: crear la nota en Firestore -----------------------------------
  // Con la cache persistente, setDoc no termina hasta que el servidor
  // confirma: sin internet, se quedaria esperando para siempre. Por eso el
  // tiempo maximo (el mismo de la app).
  const escritura = setDoc(ref, datos);
  let llego;
  try {
    llego = await conTiempo(escritura, ESPERA_ESCRITURA_MS);
  } catch (e) {
    // Lo tipico aca es permission-denied: el token viejo (cerrar sesion y
    // volver a entrar lo arregla) o un campo de mas en datosDeLaNota.
    console.error('[radar] no se pudo crear la nota', e);
    avisarEnDialogo(e.code === 'permission-denied'
      ? 'Firestore no dejó guardar la nota. Probá cerrar sesión y volver a entrar.'
      : 'No pudimos guardar la nota. Probá de nuevo en un rato.');
    terminarDialogo(false);
    return;
  }

  // El admin se pudo ir de la pantalla durante el await de arriba (el dialogo
  // es modal, pero el boton Atras del navegador anda igual). La nota se anota
  // igual, asi al volver la fila dice "Cargaste «...»"; su escucha se abre
  // solo si la pantalla sigue montada en este espacio (si no, la abre el
  // proximo mount). Antes se abria siempre, y quedaba viva en las otras
  // pantallas. Y se manda a procesar igual, este donde este el admin.
  const nota = anotarNota(wsId, clave, ref.id, v.titulo);
  terminarDialogo(true);

  if (!llego) {
    avisar('Sin conexión con Firestore: la nota quedó guardada en este navegador y se sube sola cuando vuelva internet. Cuando llegue, la mandamos a procesar.', 'aviso-info');
    escritura
      .then(() => mandarAProcesar(wsId, nota))
      .catch((e) => {
        console.error('[radar] la nota en cola no se pudo subir', e);
        avisar('La nota no se pudo subir. Probá cargarla de nuevo.', 'aviso-error');
      });
    return;
  }

  // --- PASO 2: que el servidor la procese -----------------------------------
  await mandarAProcesar(wsId, nota);
}


// POST /v1/workspaces/:wsId/items/:itemId/procesar  (sin archivo: es una nota).
// La fila ya muestra el estado en vivo; aca solo avisamos como termino.
async function mandarAProcesar(wsId, nota) {
  nota.enviando = true;
  nota.fallo = false;
  avisar(`Guardaste «${nota.titulo}». Se está procesando…`, 'aviso-info');
  dibujarLista();

  try {
    // 90 segundos: con Render dormido, el primer pedido tarda hasta un minuto,
    // y despues hay que sacar los vectores con Gemini.
    await pedir('POST', `/v1/workspaces/${wsId}/items/${nota.itemId}/procesar`, null, { segundos: 90 });
    avisar(`Listo: la IA ya puede usar «${nota.titulo}». Cuando alguien vuelva a preguntar lo mismo, la fila pasa a «Resuelta».`, 'aviso-ok');
  } catch (e) {
    // SIN_CONEXION sin codigo HTTP = no llego ninguna respuesta: se corto la
    // espera (Render despertandose, o los 90 s) o la red. Eso NO quiere decir
    // que el servidor no la este procesando: lo que pasa de verdad lo dice la
    // escucha del item (seguirNota). Decir "no se pudo procesar" mientras la
    // fila pasa sola a "Lista" seria mentir justo en la demo.
    // Con un error que SI contesto el servidor (http > 0), el item ya quedo en
    // 'error' o en 'pendiente', y ahi si se ofrece reintentar.
    const seCortoLaEspera = e.codigo === 'SIN_CONEXION' && !e.http;
    if (seCortoLaEspera && nota.estado === 'listo') {
      avisar(`Listo: la IA ya puede usar «${nota.titulo}». Cuando alguien vuelva a preguntar lo mismo, la fila pasa a «Resuelta».`, 'aviso-ok');
    } else if ((seCortoLaEspera && nota.estado === 'procesando') || e.codigo === 'PROCESO_EN_CURSO') {
      avisar(`Está tardando, pero «${nota.titulo}» se está procesando: el estado se ve en la fila.`, 'aviso-info');
    } else {
      nota.fallo = true;
      // La nota YA esta guardada (queda en 'pendiente' o en 'error'): no se
      // perdio nada. Se puede reintentar desde la fila.
      avisar(`La nota «${nota.titulo}» quedó guardada, pero no se pudo procesar: ${e.mensaje || 'error desconocido.'} Podés reintentar desde la fila.`, 'aviso-error');
    }
  } finally {
    nota.enviando = false;
    dibujarLista();
  }
}


// Anota la nota recien creada en la fila de su pregunta (si esa fila ya tenia
// otra, se reemplaza) y, si la pantalla esta montada en ese espacio, abre su
// escucha (ver guardarNota).
function anotarNota(wsId, clave, itemId, titulo) {
  const vieja = notasCargadas.get(clave);
  vieja?.cortar?.();

  const nota = { wsId, itemId, titulo, estado: 'pendiente', errorMsg: null, fallo: false, enviando: false, cortar: null };
  notasCargadas.set(clave, nota);
  if (raiz && ctxPantalla?.wsId === wsId) escucharNota(nota);
  return nota;
}

// Escucha UN item (una nota cargada desde aca) para que la fila muestre su
// estado. Si ya tenia una escucha, primero la corta: nunca dos por nota.
// Se corta en unmount(), con todas las demas.
function escucharNota(nota) {
  nota.cortar?.();
  nota.cortar = onSnapshot(
    doc(db, 'workspaces', nota.wsId, 'items', nota.itemId),
    (foto) => {
      if (foto.exists()) {
        nota.estado = foto.data().estado ?? 'pendiente';
        nota.errorMsg = foto.data().errorMsg ?? null;
      } else if (!foto.metadata.hasPendingWrites) {
        // Solo si de verdad no existe en el servidor: mientras la escritura
        // esta en cola, la primera foto puede llegar vacia.
        nota.estado = 'borrada';
      }
      dibujarLista();
    },
    (e) => console.warn('[radar] se corto la escucha de la nota', e)
  );
}

// La nota de una fila, solo si es de ESTE espacio.
function notaDeLaFila(clave) {
  const nota = notasCargadas.get(clave);
  return nota && nota.wsId === ctxPantalla?.wsId ? nota : null;
}


function terminarDialogo(cerrar) {
  trabajando = false;
  const boton = raiz?.querySelector('#guardarNota');
  const cancelar = raiz?.querySelector('#cancelarNota');
  if (boton) {
    boton.disabled = false;
    boton.textContent = 'Guardar y procesar';
  }
  if (cancelar) cancelar.disabled = false;
  if (cerrar) {
    raiz?.querySelector('#dialogoNota')?.close();
    grupoAbierto = null;
  }
}


// true si la promesa termino antes de 'ms', false si se paso de tiempo.
// Si la promesa falla antes de tiempo, el error sube (lo atrapa el que llama).
function conTiempo(promesa, ms) {
  let reloj;
  const limite = new Promise((resolver) => { reloj = setTimeout(() => resolver(false), ms); });
  return Promise.race([promesa.then(() => true), limite])
    .finally(() => clearTimeout(reloj));
}


// ============================================================================
//  AVISOS Y ERRORES
// ============================================================================
function avisar(texto, tipo = 'aviso-info') {
  const caja = raiz?.querySelector('#avisoRadar');
  if (!caja) return;
  caja.innerHTML = texto ? `<div class="aviso ${tipo}">${esc(texto)}</div>` : '';
}

function avisarEnDialogo(texto) {
  const caja = raiz?.querySelector('#avisoNota');
  if (!caja) return;
  caja.innerHTML = texto ? `<div class="aviso aviso-error">${esc(texto)}</div>` : '';
}

function mostrarError(texto) {
  const caja = raiz?.querySelector('#errorRadar');
  if (!caja) return;
  caja.innerHTML = texto ? `<div class="aviso aviso-error">${esc(texto)}</div>` : '';
}

function explicarErrorFirestore(e) {
  if (e.code === 'permission-denied') {
    return 'Firestore no te deja leer las preguntas del equipo. Suele ser el token viejo: ' +
           'cerrá sesión y volvé a entrar. Si sigue, revisá que sigas siendo administrador.';
  }
  if (e.code === 'failed-precondition') {
    // Falta el indice (estado + creadoEn) de respuestas: el error de la
    // consola trae el link para crearlo, o se publica firestore.indexes.json.
    return 'Falta un índice en Firestore para esta lista. Miralo en la consola del ' +
           'navegador: el error trae el link para crearlo.';
  }
  if (e.code === 'unavailable') {
    return 'No hay conexión con Firestore. Se muestra lo último que quedó guardado.';
  }
  return 'No pudimos cargar las preguntas. Probá recargar la página.';
}
