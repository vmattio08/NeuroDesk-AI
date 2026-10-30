// ============================================================================
//  radar-calculos.js  —  las cuentas del Radar "Lo que falta", SIN Firebase.
//  Panel web de NeuroDesk AI.
//
//  POR QUE ESTA SEPARADO DE pantallas/radar.js: la pantalla importa el SDK de
//  Firebase desde gstatic (una URL https), y node no puede importar eso. Aca
//  vive solo la logica (agrupar, contar, decidir "Resuelta", los porcentajes y
//  los campos de la nota), sin red y sin DOM, asi se prueba con un test de node
//  igual que en el navegador. La pantalla solo escucha Firestore y dibuja.
//
//  QUE ES "LO QUE FALTA" (para la defensa oral, en una frase):
//  una respuesta 'listo' con el array 'fuentes' VACIO es una pregunta del
//  equipo que la IA no pudo contestar con lo que hay cargado. Las juntamos por
//  texto, las contamos y le avisamos al dueño. Un chat personal no puede hacer
//  esto: no sabe que pregunto el resto del equipo.
// ============================================================================

import { aFecha, normalizar } from './util.js';


// "La semana" son los ULTIMOS 7 DIAS contados desde ahora, no la semana del
// calendario: un lunes a la mañana, "esta semana" del calendario estaria casi
// vacia y el porcentaje no diria nada.
export const DIAS_DE_LA_SEMANA = 7;
const MS_POR_DIA = 24 * 60 * 60 * 1000;

// Los mismos topes que la regla de items en firestore.rules. Si el titulo pasa
// de 140 o el texto de 50.000, la regla rechaza la nota entera
// (permission-denied): por eso se validan ANTES de mandar nada.
export const MAX_TITULO = 140;
export const MAX_TEXTO = 50000;

// Cuantos documentos se muestran en "los que mas preguntas respondieron".
export const TOP_DOCUMENTOS = 5;


// ----------------------------------------------------------------------------
// textoDeLaPregunta(r)  —  con que texto se muestra y se agrupa una respuesta.
//
// En una pregunta de SEGUIMIENTO ("¿Y en que aula?") el texto suelto no dice
// de que se habla. El servidor guarda en 'preguntaBuscada' la version que se
// entiende sola ("¿En que aula es la mesa de Programacion II?"): si esta, se
// usa esa. Si no esta (Gemini no contesto la reformulacion y el servidor uso
// el respaldo), queda la pregunta tal cual y se marca, para que el admin sepa
// que le falta el contexto.
// ----------------------------------------------------------------------------
export function textoDeLaPregunta(r) {
  const buscada = typeof r?.preguntaBuscada === 'string' ? r.preguntaBuscada.trim() : '';
  if (buscada) return { texto: buscada, sinContexto: false };

  const esSeguimiento = typeof r?.conversacionId === 'string' && r.conversacionId !== '';
  return {
    texto: String(r?.pregunta ?? '').trim(),
    sinContexto: esSeguimiento
  };
}


// ----------------------------------------------------------------------------
// claveDePregunta(texto)  —  la "huella" con la que se juntan dos preguntas.
//
// normalizar() (de util.js) ya pasa a minusculas y saca los acentos. Aca
// ademas se sacan los signos y los espacios de mas, asi
//     "¿Cuándo es la reunión de padres?"   y   "cuando es la reunion de padres"
// caen en la misma fila.
// LIMITE CONOCIDO (y dicho en el plan): agrupar por texto es tosco.
// "¿Cuando es la reunion?" y "fecha de la reunion" quedan en dos filas. Para
// juntarlas haria falta comparar los vectores de las preguntas, y eso no lo
// puede hacer el panel (no tiene los embeddings, que viven en el servidor).
// ----------------------------------------------------------------------------
export function claveDePregunta(texto) {
  return normalizar(texto)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')   // todo lo que no es letra ni numero
    .replace(/\s+/g, ' ')
    .trim();
}


// De que conversacion es una respuesta: la de su raiz si es un seguimiento, o
// ella misma si es una primera pregunta (la raiz es su propia conversacion).
function conversacionDe(r) {
  if (typeof r?.conversacionId === 'string' && r.conversacionId) return r.conversacionId;
  return typeof r?.id === 'string' ? r.id : '';
}


// "Respondida con fuente" = el servidor dejo al menos una cita valida.
// Es EXACTAMENTE la definicion del contrato: fuentes vacio = sin respuesta.
// (Incluye el caso en que el modelo contesto algo pero sin citar nada valido:
// el servidor lo guarda con fuentes [] y para nosotros tambien es un hueco.)
export function tieneFuentes(r) {
  return Array.isArray(r?.fuentes) && r.fuentes.length > 0;
}


// ----------------------------------------------------------------------------
// fuentesDelEquipo(fuentes, esDelEquipo)  —  de las citas de una respuesta,
// las que HOY son de un item del equipo. Devuelve { delEquipo, sinSaber }:
//   delEquipo -> las fuentes cuyo item hoy es 'equipo' (en orden de cita)
//   sinSaber  -> true si alguna todavia no se sabe (el panel esta leyendo el
//                candado de ese item)
//
// POR QUE HACE FALTA: la IA busca en lo que puede ver QUIEN PREGUNTA. Si
// Martin repite la pregunta que Camila no pudo contestar y a el se le cita SU
// nota privada, la pregunta tuvo fuente... pero para Camila y el resto del
// equipo el hueco sigue abierto. Lo mismo con el admin, que busca en todo el
// espacio, incluido lo privado de cada uno. Por eso una respuesta solo tapa un
// hueco si cita algo que hoy es del equipo, y los titulos privados no se
// muestran en el proyector.
//
// esDelEquipo(itemId) devuelve true (el item hoy es del equipo), false
// (privado, borrado o no se pudo leer) o null (todavia no se sabe). Una
// fuente sin itemId no se puede comprobar: no cuenta.
// ----------------------------------------------------------------------------
export function fuentesDelEquipo(fuentes, esDelEquipo) {
  const delEquipo = [];
  let sinSaber = false;
  for (const f of Array.isArray(fuentes) ? fuentes : []) {
    const itemId = typeof f?.itemId === 'string' ? f.itemId : '';
    if (!itemId) continue;
    const candado = esDelEquipo(itemId);
    if (candado === true) delEquipo.push(f);
    else if (candado === null || candado === undefined) sinSaber = true;
  }
  return { delEquipo, sinSaber };
}

// Sin informacion de candados (por ejemplo, un test que no la pasa) todo
// cuenta como del equipo, que es como funcionaba antes. La pantalla del panel
// SIEMPRE pasa la de verdad (ver radar.js).
const TODO_DEL_EQUIPO = () => true;


// ----------------------------------------------------------------------------
// armarRadar(respuestas, ahora, esDelEquipo)  —  TODA la pantalla sale de aca.
//
// Recibe las respuestas 'listo' tal cual vienen de Firestore (con su id) y
// devuelve:
//   grupos       -> una fila por pregunta sin respuesta (ver abajo)
//   semana       -> { total, conFuente, porcentaje }   (ultimos 7 dias)
//   masCitados   -> los 5 documentos DEL EQUIPO que mas preguntas respondieron
//   total        -> cuantas respuestas se miraron
//
// Cada grupo:
//   { clave, texto, sinContexto, veces, vecesSemana, primeraVez, ultimaVez,
//     autores: [{ uid, veces }], resuelta, resueltaEn, resueltaCon: [titulos],
//     verificando }
//
// CUANDO UNA FILA ESTA "RESUELTA": cuando la MISMA pregunta (misma clave) se
// volvio a hacer DESPUES de la ultima vez que fallo, y esa vez se le cito al
// menos un item que HOY es del equipo (ver fuentesDelEquipo: si solo se cito
// algo privado, para el resto del equipo sigue faltando). "La misma" tambien
// vale si la persona la repitio TAL CUAL en la caja de abajo de su
// conversacion, aunque Gemini la haya reescrito con otras palabras (ver
// fallidasPorConversacion, mas abajo). Si despues de eso
// alguien la pregunta otra vez y vuelve a fallar (por ejemplo, borraron la
// nota), la fila vuelve a "sin resolver": manda lo ultimo que paso, no lo
// primero. Y como el candado se lee EN VIVO, si la unica fuente pasa a
// privada la fila vuelve a abrirse, y si una nota privada se comparte con el
// equipo, la respuesta que ya la citaba tapa el hueco.
// 'verificando' = todavia no se sabe: hubo una respuesta posterior con
// fuentes, pero el panel esta leyendo el candado de esos items. La pantalla
// no muestra ni "Resuelta" ni el boton de cargar hasta saberlo (un instante).
//
// 'ahora' es un parametro (y no Date.now() adentro) para que el test pueda
// fijar el reloj y probar "esta semana" sin depender del dia en que se corre.
// 'esDelEquipo' tambien, para que este archivo no lea Firestore.
// ----------------------------------------------------------------------------
export function armarRadar(respuestas, ahora = Date.now(), esDelEquipo = TODO_DEL_EQUIPO) {
  const lista = Array.isArray(respuestas) ? respuestas : [];
  const desde = ahora - DIAS_DE_LA_SEMANA * MS_POR_DIA;

  // Map y no un objeto {}: las claves salen de texto que escribio una
  // persona, y una pregunta que se normalice a "constructor" o "__proto__"
  // romperia un objeto comun.
  const grupos = new Map();
  const respondidasPorClave = new Map();   // clave -> [{ fecha, fuentes }]
  const citas = new Map();                 // itemId -> { itemId, titulo, preguntas, ultima }

  let totalSemana = 0;
  let conFuenteSemana = 0;

  // Las claves de las preguntas que FALLARON, por conversacion (una raiz es
  // su propia conversacion). Hace falta para el caso de la demo: Camila
  // pregunta, no encuentra nada, el admin carga la respuesta y Camila repite
  // la pregunta en la caja de abajo de ESA conversacion. La app la manda como
  // seguimiento, el servidor la reformula, y si Gemini le cambia una palabra
  // ("...de padres del curso") la clave de arriba ya no coincide con la de la
  // fila: quedaba "Sin respuesta" aunque se citara la nota nueva.
  const fallidasPorConversacion = new Map();   // conversacion -> Set de claves
  for (const x of lista) {
    if (x?.estado !== undefined && x.estado !== 'listo') continue;
    if (tieneFuentes(x)) continue;
    const conv = conversacionDe(x);
    if (!conv) continue;
    if (!fallidasPorConversacion.has(conv)) fallidasPorConversacion.set(conv, new Set());
    fallidasPorConversacion.get(conv).add(claveDePregunta(textoDeLaPregunta(x).texto));
  }

  for (const r of lista) {
    // Solo miramos 'listo'. La query ya filtra, pero si alguien llama a esta
    // funcion con otra cosa, una respuesta en 'error' no es "sin fuente": es
    // un fallo de la IA, y no es algo que el equipo tenga que cargar.
    if (r?.estado !== undefined && r.estado !== 'listo') continue;

    // creadoEn siempre esta en una respuesta 'listo' (la query ordena por ese
    // campo, y Firestore deja afuera los docs que no lo tienen). Si algun dia
    // llega sin fecha, la tratamos como "recien", que es lo unico que puede
    // ser: un serverTimestamp todavia sin confirmar.
    const fecha = (aFecha(r.creadoEn) ?? new Date(ahora)).getTime();
    const deLaSemana = fecha >= desde;
    const { texto, sinContexto } = textoDeLaPregunta(r);
    const clave = claveDePregunta(texto);
    const conFuente = tieneFuentes(r);

    if (deLaSemana) {
      totalSemana++;
      if (conFuente) conFuenteSemana++;
    }

    if (conFuente) {
      // ---- Para "Resuelta": las respondidas, por clave ----
      if (clave) {
        if (!respondidasPorClave.has(clave)) respondidasPorClave.set(clave, []);
        respondidasPorClave.get(clave).push({ fecha, fuentes: r.fuentes });
      }
      // En un seguimiento la clave de arriba sale de lo que reescribio Gemini.
      // Si la persona repitio TAL CUAL, en su misma conversacion, una pregunta
      // que habia fallado ahi, se anota tambien con lo que escribio: asi tapa
      // ese hueco aunque Gemini le cambie una palabra. Solo en SU
      // conversacion: un "¿Y en que aula?" de otra charla habla de otra cosa
      // y no puede dar por resuelta una fila ajena.
      const escrita = claveDePregunta(String(r?.pregunta ?? ''));
      const conv = conversacionDe(r);
      if (escrita && escrita !== clave && conv && fallidasPorConversacion.get(conv)?.has(escrita)) {
        if (!respondidasPorClave.has(escrita)) respondidasPorClave.set(escrita, []);
        respondidasPorClave.get(escrita).push({ fecha, fuentes: r.fuentes });
      }

      // ---- Para "los documentos mas utiles" ----
      // Se cuenta UNA vez por pregunta aunque el mismo documento aparezca en
      // varias citas ([1] y [2] pueden ser dos fragmentos del mismo PDF): lo
      // que medimos es cuantas PREGUNTAS ayudo a contestar, no cuantos
      // fragmentos se citaron.
      const yaContados = new Set();
      for (const f of r.fuentes) {
        const itemId = typeof f?.itemId === 'string' ? f.itemId : '';
        if (!itemId || yaContados.has(itemId)) continue;
        yaContados.add(itemId);

        const previo = citas.get(itemId);
        if (!previo) {
          citas.set(itemId, { itemId, titulo: f.titulo || '(sin título)', preguntas: 1, ultima: fecha });
        } else {
          previo.preguntas++;
          // El titulo que se muestra es el de la cita MAS NUEVA: si le
          // cambiaron el nombre al item, gana el ultimo.
          if (fecha >= previo.ultima) {
            previo.ultima = fecha;
            if (f.titulo) previo.titulo = f.titulo;
          }
        }
      }
      continue;
    }

    // ---- Sin fuentes: es un hueco ----
    if (!clave) continue;   // una pregunta hecha solo de signos no se puede agrupar

    let g = grupos.get(clave);
    if (!g) {
      g = {
        clave,
        texto,
        sinContexto,
        veces: 0,
        vecesSemana: 0,
        primeraVez: fecha,
        ultimaVez: fecha,
        autoresMapa: new Map(),
        ids: []
      };
      grupos.set(clave, g);
    }

    g.veces++;
    if (deLaSemana) g.vecesSemana++;
    if (r.id) g.ids.push(r.id);
    if (fecha < g.primeraVez) g.primeraVez = fecha;
    if (fecha >= g.ultimaVez) {
      // El texto que se muestra es el de la vez MAS NUEVA: es como lo esta
      // preguntando el equipo hoy.
      g.ultimaVez = fecha;
      g.texto = texto;
      g.sinContexto = sinContexto;
    }

    const uid = typeof r.autorUid === 'string' ? r.autorUid : '';
    if (uid) g.autoresMapa.set(uid, (g.autoresMapa.get(uid) ?? 0) + 1);
  }

  // ---- Resuelta o no, grupo por grupo ----
  const salida = [];
  for (const g of grupos.values()) {
    const respondidas = respondidasPorClave.get(g.clave) ?? [];

    // La PRIMERA vez que se respondio con una fuente DEL EQUIPO despues de la
    // ultima falla. Estrictamente despues (>): con la misma marca de tiempo
    // no se puede decir cual fue antes. Las respuestas que solo citaron algo
    // privado no tapan el hueco; las que citan items de los que todavia no
    // sabemos el candado dejan la fila "verificando".
    let resolucion = null;
    let porVerificar = false;
    for (const resp of respondidas) {
      if (resp.fecha <= g.ultimaVez) continue;
      const { delEquipo, sinSaber } = fuentesDelEquipo(resp.fuentes, esDelEquipo);
      if (delEquipo.length > 0) {
        if (!resolucion || resp.fecha < resolucion.fecha) resolucion = { fecha: resp.fecha, fuentes: delEquipo };
      } else if (sinSaber) {
        porVerificar = true;
      }
    }

    salida.push({
      clave: g.clave,
      texto: g.texto,
      sinContexto: g.sinContexto,
      veces: g.veces,
      vecesSemana: g.vecesSemana,
      primeraVez: g.primeraVez,
      ultimaVez: g.ultimaVez,
      ids: g.ids,
      autores: [...g.autoresMapa.entries()]
        .map(([uid, veces]) => ({ uid, veces }))
        .sort((a, b) => b.veces - a.veces || a.uid.localeCompare(b.uid)),
      resuelta: resolucion !== null,
      resueltaEn: resolucion ? resolucion.fecha : null,
      // Solo titulos de items del equipo: el de una nota privada no se
      // proyecta, aunque haya sido la fuente de quien pregunto.
      resueltaCon: resolucion ? titulosDistintos(resolucion.fuentes, 3) : [],
      verificando: resolucion === null && porVerificar
    });
  }

  // Solo documentos que HOY son del equipo: una nota privada puede haberle
  // contestado algo a su autor (o al admin), pero no es un documento del
  // equipo y su titulo no va al proyector. Los que todavia no se sabe, tampoco
  // (aparecen apenas llega su candado).
  const masCitados = [...citas.values()]
    .filter((c) => esDelEquipo(c.itemId) === true)
    .sort((a, b) => b.preguntas - a.preguntas || b.ultima - a.ultima)
    .slice(0, TOP_DOCUMENTOS)
    .map(({ itemId, titulo, preguntas }) => ({ itemId, titulo, preguntas }));

  return {
    grupos: ordenarGrupos(salida, 'recientes'),
    semana: {
      total: totalSemana,
      conFuente: conFuenteSemana,
      // null y no 0 cuando no hubo preguntas: "0 %" diria que la IA fallo en
      // todo, y en realidad no le preguntaron nada.
      porcentaje: totalSemana > 0 ? Math.round((conFuenteSemana * 100) / totalSemana) : null
    },
    masCitados,
    total: lista.length
  };
}


// ----------------------------------------------------------------------------
// ordenarGrupos(grupos, criterio)  —  devuelve una COPIA ordenada.
//
//   'recientes' (el de entrada): lo ultimo que paso arriba, contando tanto la
//       ultima falla como la resolucion. Es el que sirve en la demo: la
//       pregunta nueva aparece sola arriba de todo, y cuando se resuelve NO
//       salta al fondo de la lista: se queda arriba y cambia a "Resuelta".
//   'repetidas': primero lo que falta resolver, y adentro, lo que mas se
//       pregunto esta semana. Es la vista del dueño un lunes a la mañana.
// ----------------------------------------------------------------------------
export function ordenarGrupos(grupos, criterio = 'recientes') {
  const copia = [...grupos];
  const actividad = (g) => Math.max(g.ultimaVez, g.resueltaEn ?? 0);

  if (criterio === 'repetidas') {
    return copia.sort((a, b) =>
      Number(a.resuelta) - Number(b.resuelta) ||
      b.vecesSemana - a.vecesSemana ||
      b.veces - a.veces ||
      b.ultimaVez - a.ultimaVez);
  }

  return copia.sort((a, b) => actividad(b) - actividad(a) || b.veces - a.veces);
}


// Hasta 'tope' titulos distintos de un array de fuentes, en orden de cita.
function titulosDistintos(fuentes, tope) {
  const vistos = new Set();
  const titulos = [];
  for (const f of Array.isArray(fuentes) ? fuentes : []) {
    const clave = f?.itemId || f?.titulo;
    if (!clave || vistos.has(clave)) continue;
    vistos.add(clave);
    titulos.push(f.titulo || '(sin título)');
    if (titulos.length >= tope) break;
  }
  return titulos;
}


// ----------------------------------------------------------------------------
// tituloSugerido(pregunta)  —  el titulo de la nota sale de la pregunta.
//
// POR QUE EL TITULO ES LA PREGUNTA: el servidor arma el vector de cada
// fragmento con el TITULO del item al lado del texto (ver items.js). Si la
// nota se llama "¿Cuando es la reunion de padres?" y adentro dice "Jueves
// 12/11 a las 18 en el SUM", la proxima vez que alguien pregunte lo mismo el
// buscador la encuentra aunque el texto no repita ninguna palabra.
//
// Si la pregunta pasa de 140 caracteres (puede tener hasta 500), se corta en
// 139 y se le pone "…", que suma 1: quedan 140 justos, el tope de la regla.
// Se cuenta igual que la app (Dart) y que el maxlength del navegador: en
// unidades de JavaScript (.length). Un emoji ocupa DOS de esas unidades, asi
// que si el corte cae justo en el medio de uno, se saca la mitad que sobra:
// media letra rota no es un texto valido.
// ----------------------------------------------------------------------------
export function tituloSugerido(pregunta) {
  const limpio = String(pregunta ?? '').replace(/\s+/g, ' ').trim();
  if (limpio.length <= MAX_TITULO) return limpio;
  let corte = limpio.slice(0, MAX_TITULO - 1);
  const ultima = corte.charCodeAt(corte.length - 1);
  if (ultima >= 0xD800 && ultima <= 0xDBFF) corte = corte.slice(0, -1);
  return corte.trimEnd() + '…';
}


// ----------------------------------------------------------------------------
// validarNota({ titulo, texto })  —  lo mismo que va a mirar la regla, antes
// de gastar una escritura. Devuelve { ok: true, titulo, texto } ya recortados,
// o { ok: false, error } con un mensaje para la persona.
// ----------------------------------------------------------------------------
export function validarNota({ titulo, texto }) {
  const t = String(titulo ?? '').trim();
  const x = String(texto ?? '').trim();

  if (!t) return { ok: false, error: 'Poné un título para la nota.' };
  if (t.length > MAX_TITULO) {
    return { ok: false, error: `El título no puede pasar de ${MAX_TITULO} caracteres.` };
  }
  if (!x) return { ok: false, error: 'Escribí la respuesta para el equipo.' };
  if (x.length > MAX_TEXTO) {
    return { ok: false, error: 'La respuesta no puede pasar de 50.000 caracteres.' };
  }
  return { ok: true, titulo: t, texto: x };
}


// ----------------------------------------------------------------------------
// datosDeLaNota(...)  —  EXACTAMENTE los campos que la regla deja crear.
//
// Es la misma lista que arma la app en captura.dart para una nota, y la que
// pide firestore.rules (camposQuePuedeCrearElCliente + camposObligatorios):
//   titulo, tipo, visibilidad, workspaceId, creadoPor, creadoEn, estado,
//   textoOriginal
// UN CAMPO DE MAS Y LA REGLA RECHAZA TODO (hasOnly). Por eso no hay 'texto'
// (lo escribe el servidor), ni 'url' (solo links), ni 'nombreArchivo'.
//
//   visibilidad: 'equipo'  -> el boton dice "para el equipo": la respuesta la
//                             tiene que poder encontrar cualquiera.
//   estado: 'pendiente'    -> la regla no deja que nazca 'listo'.
//   creadoEn               -> serverTimestamp(): la regla exige la hora del
//                             servidor (request.time), no la de la compu.
//
// 'marcaDelServidor' se recibe de afuera (la pantalla le pasa serverTimestamp()
// del SDK) para que este archivo no importe Firebase y se pueda probar igual.
// ----------------------------------------------------------------------------
export function datosDeLaNota({ titulo, texto, wsId, uid, marcaDelServidor }) {
  return {
    titulo,
    tipo: 'nota',
    visibilidad: 'equipo',
    workspaceId: wsId,       // tiene que coincidir con el del path
    creadoPor: uid,          // la regla exige que sea request.auth.uid
    creadoEn: marcaDelServidor,
    estado: 'pendiente',
    textoOriginal: texto     // lo que escribio la persona; 'texto' lo saca el servidor
  };
}
