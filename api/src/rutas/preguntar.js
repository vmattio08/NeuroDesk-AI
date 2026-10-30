// ============================================================================
//  NeuroDesk AI — api/src/rutas/preguntar.js
//  POST /v1/workspaces/:wsId/preguntar  — EL RAG. Esto es el producto.
//
//  Se monta así en server.js:
//      import { rutasDePreguntar } from './rutas/preguntar.js';
//      app.use('/v1/workspaces/:wsId', rutasDePreguntar);   // -> POST /v1/workspaces/:wsId/preguntar
//
//  QUÉ ES UN RAG, EN CRIOLLO (para la defensa oral):
//  El modelo de IA no sabe nada del equipo. Entonces hacemos tres cosas:
//    1) FILTRAR  — armamos el conjunto de items que ESA persona puede ver y
//                  tiramos todo fragmento que no esté ahí. Este paso es el
//                  requisito 2 de la materia, y va PRIMERO a propósito.
//    2) BUSCAR   — convertimos la pregunta en un vector y la comparamos contra
//                  los vectores de los fragmentos que sobrevivieron al filtro.
//    3) REDACTAR — le pasamos al modelo los 6 mejores fragmentos y le exigimos
//                  que responda usando solo eso y citando [1], [2].
//
//  Y después hacemos una cuarta cosa que casi nadie hace: VALIDAMOS EN CÓDIGO
//  las citas. El texto de la fuente (título, página, itemId) sale del chunk
//  REAL guardado en Firestore, NUNCA de lo que dijo el modelo. Por eso es
//  imposible que invente un título de documento.
//
//  QUIÉN HACE CADA COSA:
//    - servicios/buscar.js  -> los pasos 1 y 2 (las dos cerraduras + el coseno).
//    - servicios/ia.js      -> chatear(), el paso 3 (Google Gemini).
//    - prompts.js           -> lo que le decimos al modelo.
//    - ESTE archivo         -> el documento respuestas/{respId} (sus estados),
//                              la validación de las citas y la respuesta HTTP.
//
//  POR QUÉ ESTE ARCHIVO NO TIENE SU PROPIO FILTRO DE PRIVACIDAD: antes lo
//  tenía, copiado de buscar.js, y las dos copias ya se habían separado (esta
//  embebía la pregunta ANTES de leer los items visibles, y comparaba vectores
//  de distinto largo en vez de descartarlos). Dos implementaciones del filtro
//  son dos lugares donde se puede filtrar una nota privada. Ahora hay UNA, en
//  buscar.js, y es la que hay que saber defender.
//
//  POR QUÉ ES SINCRÓNICO (200 con la respuesta entera, y no un 202): es lo que
//  dice el contrato. Igual el cliente NO espera este JSON para dibujar: escucha
//  el documento con un StreamBuilder y ve 'buscando' -> 'redactando' -> 'listo'
//  en vivo. El JSON es la confirmación; la fuente de verdad es Firestore.
//
//  PREGUNTAS DE SEGUIMIENTO (29/10/2026). Una conversación es una cadena de
//  documentos en respuestas/. La primera pregunta es exactamente igual que
//  antes; cada seguimiento trae además conversacionId (el respId de la
//  primera, la raíz) y anteriorRespId (el de la pregunta de justo antes). Para
//  contestar "¿Y en qué aula?" se suman tres pasos, y NINGUNO toca permisos:
//    a) HISTORIAL  — seguimos anteriorRespId para atrás, hasta 3 vueltas, y
//                    fail-closed: cada documento tiene que ser de quien
//                    pregunta, de esta conversación y estar 'listo'.
//    b) REFORMULAR — un llamado corto al modelo convierte "¿Y en qué aula?"
//                    en "¿En qué aula es la reunión de padres?". Con ESO se
//                    busca, y queda guardado en preguntaBuscada.
//    c) REDACTAR CON CONTEXTO — el modelo ve las vueltas anteriores como
//                    conversación, pero cita SOLO los fragmentos de esta.
//  El filtro de privacidad se calcula entero en cada vuelta, igual que
//  siempre: el historial es texto que la persona ya tiene en sus propios
//  documentos y no le abre ningún item.
// ============================================================================

import { Router } from 'express';

import { db, FieldValue } from '../firebase.js';
import { ErrorApi, fallar, esErrorApi, CATALOGO_DE_ERRORES } from '../errores.js';
import { requireAuth, exigirMiembro } from '../middleware/auth.js';
import { buscarChunks } from '../servicios/buscar.js';
import { chatear } from '../servicios/ia.js';
import {
  PROMPT_SISTEMA_RAG,
  PROMPT_REFORMULAR,
  armarMensajeDeUsuario,
  armarMensajeParaReformular,
  armarTurnosDelHistorial,
  filtraElReglamento,
  filtraLasReglasDeReformular,
  RESPUESTA_SIN_RESULTADOS,
  AVISO_SIN_CITAS,
} from '../prompts.js';

// mergeParams: true es obligatorio. El router se monta en '/v1/workspaces/:wsId'
// y sin esto req.params.wsId llega undefined: exigirMiembro cortaría todo con
// DATOS_INVALIDOS y no habría forma de entender por qué.
export const rutasDePreguntar = Router({ mergeParams: true });

// ============================================================================
//  NÚMEROS
//  (Los del RAG en sí —cuántas fuentes, el umbral, los cortes de confianza—
//  viven en buscar.js, al lado del código que los usa.)
// ============================================================================

// Mismo rango que el modelo de datos y que la regla de Firestore (3 a 500).
const MIN_PREGUNTA = 3;
const MAX_PREGUNTA = 500;

// El respId lo genera Firestore en el celular (20 letras y números). Lo
// validamos ANTES de armar la ruta: un respId con una barra adentro ('a/b')
// haría que .doc() apunte a otro lugar del árbol o reviente con un error
// interno de firebase-admin.
const FORMATO_RESP_ID = /^[A-Za-z0-9_-]{1,128}$/;

// Una consulta que el backend tomó hace menos de esto se considera "en curso"
// (doble tap o un reintento mientras la primera sigue). Es el mismo número que
// usa /procesar para los items, por el mismo motivo: si Render se reinicia en
// el medio, a los 5 minutos la consulta se puede volver a tomar.
const MINUTOS_CONSULTA_EN_CURSO = 5;

// Límite del contrato (N4): 10 preguntas por minuto POR UID, no por IP,
// porque en la escuela todos salen a internet por la misma IP.
const PREGUNTAS_POR_MINUTO = 10;
const VENTANA_DEL_LIMITE_MS = 60_000;

// Cuando Google nos limita (429) después de sus reintentos, ia.js no nos
// pasa cuánto pidió esperar. Le decimos al cliente 20 s: alcanza para que se
// vacíe la ventana de Google sin dejar el botón muerto un minuto entero.
const RETRY_AFTER_IA_SEG = 20;

// ---- Preguntas de seguimiento ------------------------------------------------

// Cuántas vueltas anteriores ve el modelo. Con 3 alcanza para entender "¿y el
// otro?", y el pedido no crece sin fin: cada vuelta suma una pregunta y una
// respuesta al prompt (más lento) y una lectura de Firestore.
const MAX_VUELTAS_DE_HISTORIAL = 3;

// conversacionId y anteriorRespId son respIds, que genera Firestore en el
// celular: mismo formato que FORMATO_RESP_ID, con el tope de 64 de la regla.
// Se validan ANTES de usarlos para armar una ruta, por el mismo motivo.
const FORMATO_ID_DE_LA_CADENA = /^[A-Za-z0-9_-]{1,64}$/;

// La reformulación es un extra con respaldo propio (la pregunta anterior + la
// nueva, pegadas), así que tiene un PLAZO corto y fijo, pase lo que pase: 12 s
// en total y 6 s como mucho por modelo. Un modelo sano la devuelve en 2 o 3 s.
// Usa la cadena de modelos de siempre, adentro de ese plazo.
// POR QUÉ 6 s POR MODELO (medido el 29/10/2026, con Google en "high demand"):
// gemini-3.6-flash se colgaba los 25 s enteros, y gemini-3.1-flash-lite
// devolvía la misma pregunta bien reformulada en ~2 s. Con un plazo de 8 s y
// sin tope por modelo, el principal colgado se comía todo el plazo y nunca le
// tocaba al siguiente. Lo mismo si el principal se queda sin el cupo del día
// (ese día pasó: el free tier de gemini-3.6-flash es de 20 pedidos por día):
// contesta 429 al toque y el siguiente entra.
const PLAZO_REFORMULAR_MS = 12_000;
const TIMEOUT_REFORMULAR_POR_MODELO_MS = 6_000;

// ---- Presupuesto de tiempo de cada vuelta --------------------------------------
// La app corta /preguntar a los 90 s. Todo lo que este endpoint le pide a
// Google (reformular, el embedding de la pregunta y la cadena de modelos del
// chat) tiene que terminar antes de esta fecha límite, contada desde que el
// pedido llega acá: cada llamado usa como mucho lo que queda (ia.js), y si no
// queda, la consulta termina en IA_NO_RESPONDE en vez de que el celular corte
// con la consulta todavía girando.
// La cuenta del peor caso: 75 s + el último update a Firestore (~1 s) +
// verificar el token y leer members antes de entrar (~1 s) = ~77 s. Quedan
// ~13 s de margen para la red del celular.
const PRESUPUESTO_DE_LA_VUELTA_MS = 75_000;

// ============================================================================
//  LÍMITE DE PEDIDOS POR UID
//
//  Lo escribimos acá, a mano, porque express-rate-limit no está instalado y
//  este archivo es el único que podemos tocar. Si algún día se monta un
//  limitador general en server.js, este se puede borrar.
//
//  OJO: esto es un MAPA EN MEMORIA, y no contradice la regla de "nada de caché"
//  del filtro de privacidad. Acá solo contamos cuántas veces preguntó alguien;
//  NO decide qué puede ver. Si se pierde (Render se reinicia), lo peor que
//  pasa es que alguien puede hacer 10 preguntas más ese minuto.
// ============================================================================
const pedidosPorUid = new Map(); // uid -> [marcas de tiempo en ms]

function limitarPreguntas(req, res, next) {
  const uid = req.usuario.uid;
  const ahora = Date.now();
  const recientes = (pedidosPorUid.get(uid) || []).filter((t) => ahora - t < VENTANA_DEL_LIMITE_MS);

  if (recientes.length >= PREGUNTAS_POR_MINUTO) {
    pedidosPorUid.set(uid, recientes);
    // Retry-After en SEGUNDOS, como pide el contrato: el cliente deshabilita
    // el botón exactamente ese tiempo. Es lo que falta para que se libere el
    // pedido más viejo de la ventana.
    const segundos = Math.max(1, Math.ceil((recientes[0] + VENTANA_DEL_LIMITE_MS - ahora) / 1000));
    res.set('Retry-After', String(segundos));
    return next(new ErrorApi(
      'DEMASIADOS_PEDIDOS',
      `Se pueden hacer hasta ${PREGUNTAS_POR_MINUTO} preguntas por minuto.`,
    ));
  }

  // El pedido rechazado NO se cuenta: si no, alguien que insiste quedaría
  // bloqueado para siempre.
  recientes.push(ahora);
  pedidosPorUid.set(uid, recientes);
  return next();
}

// Barrido de los uid que dejaron de preguntar, para que el mapa no crezca sin
// fin. .unref() para que este reloj no mantenga vivo al proceso (ni a un
// script que solo importa el archivo).
setInterval(() => {
  const ahora = Date.now();
  for (const [uid, marcas] of pedidosPorUid) {
    if (marcas.every((t) => ahora - t >= VENTANA_DEL_LIMITE_MS)) pedidosPorUid.delete(uid);
  }
}, VENTANA_DEL_LIMITE_MS).unref();

// ============================================================================
//  AYUDANTES CHICOS
// ============================================================================

// El wsId va SOLO en el path (invariante 4): respuestas NO tiene campo
// workspaceId. Por eso nunca escribimos ese campo en este archivo.
function refRespuesta(wsId, respId) {
  return db.collection('workspaces').doc(wsId).collection('respuestas').doc(respId);
}

// El evento es un renglón del feed de auditoría: si falla, NO puede tirar
// abajo una respuesta que ya está guardada. Por eso se traga el error y lo
// manda al log. (workspaces.js tiene su propio escribirEvento, pero ese tira
// la excepción y además lo están tocando en paralelo: no nos colgamos de él.)
async function anotarEvento(wsId, { tipo, actorUid, resumen, itemId = null }) {
  try {
    await db.collection('workspaces').doc(wsId).collection('eventos').add({
      tipo, actorUid, resumen, itemId,
      creadoEn: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(`[eventos] no se pudo escribir '${tipo}' en ${wsId}:`, err);
  }
}

function recortar(texto, largo) {
  return texto.length <= largo ? texto : texto.slice(0, largo) + '…';
}

/**
 * Lleva cualquier error a un ErrorApi del catálogo.
 *
 * ia.js y buscar.js tiran errores con la forma { codigo, mensaje, http,
 * detalle }. NO los aplastamos todos a IA_NO_RESPONDE: si se acabaron los
 * créditos, el admin tiene que leer SIN_CREDITOS_IA (y avisarle a quien paga),
 * no "probá en un minuto", que no lo va a arreglar nunca.
 *
 * Dos reglas del contrato que se aplican acá:
 *   - Si el error no tiene un código del catálogo (un fallo de Firestore, un
 *     bug), es ERROR_INTERNO.
 *   - ERROR_INTERNO va SIEMPRE con detalle null. ia.js le pone un detalle
 *     a sus ERROR_INTERNO ("No hay GEMINI_API_KEY...", "revisá la clave en
 *     el .env") que sirve para el log pero que al cliente le cuenta cómo está
 *     configurado el servidor.
 */
function aErrorApi(err) {
  if (!esErrorApi(err)) return new ErrorApi('ERROR_INTERNO');
  const detalle = err.codigo === 'ERROR_INTERNO' ? null : (err.detalle ?? null);
  return new ErrorApi(err.codigo, detalle);
}

// ============================================================================
//  ¿PRIMERA PREGUNTA O SEGUIMIENTO?
//
//  Mira los dos campos de la cadena de un documento de respuestas y dice qué
//  es. Es la MISMA validación que hace la regla de Firestore al crear, repetida
//  acá porque el Admin SDK (la consola, un script) no pasa por las reglas:
//    - ninguno de los dos campos          -> { tipo: 'raiz' }  (primera pregunta)
//    - los dos, con formato de id y ninguno igual al id del propio documento
//                                         -> { tipo: 'seguimiento', conversacionId, anteriorRespId }
//    - cualquier otra cosa (uno solo, null, un número, una barra adentro)
//                                         -> { tipo: 'rota' }
//  "Ninguno igual al propio id": una pregunta no puede ser su propia anterior
//  (la regla también lo frena) ni su propia raíz (eso la regla no lo mira).
// ============================================================================
function esIdDeLaCadena(valor) {
  return typeof valor === 'string' && FORMATO_ID_DE_LA_CADENA.test(valor);
}

function leerCadena(doc, idPropio) {
  // undefined = el campo NO está. Un null SÍ está (y está mal): la regla
  // también lo rechaza, porque null no es string.
  if (doc.conversacionId === undefined && doc.anteriorRespId === undefined) {
    return { tipo: 'raiz' };
  }
  const { conversacionId, anteriorRespId } = doc;
  const bienArmada =
    esIdDeLaCadena(conversacionId) &&
    esIdDeLaCadena(anteriorRespId) &&
    conversacionId !== idPropio &&
    anteriorRespId !== idPropio;
  return bienArmada ? { tipo: 'seguimiento', conversacionId, anteriorRespId } : { tipo: 'rota' };
}

// ============================================================================
//  TOMAR LA CONSULTA  —  pasos 2 del contrato + protección contra el doble tap
//
//  Todo adentro de una transacción: leer, chequear y marcar que la tomamos es
//  UN solo paso atómico. Sin la transacción, dos POST seguidos con el mismo
//  respId leen los dos 'buscando', pasan los dos, y pagamos dos veces la misma
//  pregunta a la IA (es la misma idea que el invariante 9 para los items).
//
//  "Tomarla" es escribir actualizadoEn sin cambiar el estado: el documento
//  sigue en 'buscando' (que es la verdad: estamos buscando), pero ya tiene la
//  marca de que el backend lo agarró.
// ============================================================================
async function tomarLaConsulta(ref, uid, preguntaDelBody) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) fallar('RESPUESTA_NO_ENCONTRADA');

    const doc = snap.data();

    // Si la consulta es de OTRO usuario respondemos el MISMO 404 que si no
    // existiera. A propósito: no le confirmamos a nadie que existe una
    // consulta ajena con ese id.
    if (doc.autorUid !== uid) fallar('RESPUESTA_NO_ENCONTRADA');

    // 'listo' y 'error' son estados FINALES. Volver a procesar una consulta
    // terminada sería gastar créditos por una pregunta ya respondida. Y una que
    // falló tampoco se reusa: el botón "Volver a preguntar" crea una consulta
    // NUEVA (así lo dice el ciclo de vida del modelo de datos).
    if (doc.estado !== 'buscando' && doc.estado !== 'redactando') {
      fallar(
        'DATOS_INVALIDOS',
        `Esa consulta ya terminó (estado '${doc.estado ?? 'sin estado'}'). Para volver a preguntar se crea una consulta nueva.`,
      );
    }

    // Si el backend ya la tomó hace poco, hay otro pedido trabajando en ella:
    // es el doble tap. PROCESO_EN_CURSO y no un error rojo, porque el cliente
    // solo tiene que esperar a que su listener vea 'listo'. Si la marca es
    // vieja, el pedido anterior murió (Render se reinició) y la retomamos.
    const ultimoToque = typeof doc.actualizadoEn?.toMillis === 'function'
      ? doc.actualizadoEn.toMillis()
      : null;
    if (ultimoToque !== null && Date.now() - ultimoToque < MINUTOS_CONSULTA_EN_CURSO * 60_000) {
      fallar('PROCESO_EN_CURSO');
    }

    // LA PREGUNTA QUE VALE ES LA DEL DOCUMENTO, no la del body. El body solo
    // sirve para chequear que el cliente no se haya confundido de respId.
    // La regla de Firestore ya exige 3 a 500 caracteres, pero lo volvemos a
    // mirar: un doc cargado a mano desde la consola o con Admin SDK no pasa
    // por las reglas. Por lo mismo se miran acá los campos de la cadena: si
    // vienen a medio armar, la consulta se cierra igual que con una pregunta
    // mal cargada.
    const pregunta = typeof doc.pregunta === 'string' ? doc.pregunta.trim() : '';
    const cadena = leerCadena(doc, ref.id);
    let problema = null;
    if (pregunta.length < MIN_PREGUNTA || pregunta.length > MAX_PREGUNTA) {
      problema = `La pregunta de la consulta tiene que medir entre ${MIN_PREGUNTA} y ${MAX_PREGUNTA} caracteres.`;
    } else if (pregunta !== preguntaDelBody) {
      problema = 'La pregunta del pedido no coincide con la de la consulta.';
    } else if (cadena.tipo === 'rota') {
      problema = 'Los datos de la conversación (conversacionId y anteriorRespId) están incompletos o mal armados.';
    }

    if (problema) {
      // La consulta es de esta persona y estaba viva, así que la cerramos en
      // 'error' en vez de dejarla girando en 'buscando' para siempre. El
      // errorMsg es el MISMO texto que va por HTTP.
      tx.update(ref, {
        estado: 'error',
        errorMsg: CATALOGO_DE_ERRORES.DATOS_INVALIDOS.mensaje,
        actualizadoEn: FieldValue.serverTimestamp(),
      });
      return { problema };
    }

    tx.update(ref, { actualizadoEn: FieldValue.serverTimestamp() });
    // cadena null = primera pregunta: el resto del endpoint hace exactamente
    // lo de siempre.
    return { pregunta, cadena: cadena.tipo === 'seguimiento' ? cadena : null };
  });
}

// ============================================================================
//  EL HISTORIAL DE UN SEGUIMIENTO  —  fail-closed, como el filtro del RAG.
//
//  Seguimos anteriorRespId para atrás, de a un documento, hasta juntar
//  MAX_VUELTAS_DE_HISTORIAL vueltas o llegar a la raíz. Cada documento tiene
//  que pasar TODO esto, y si uno falla, la pregunta nueva termina en 'error':
//    1) existir y ser de QUIEN PREGUNTA. Si no, RESPUESTA_NO_ENCONTRADA, el
//       MISMO 404 (y el mismo detalle) en los dos casos: como en
//       tomarLaConsulta, no le confirmamos a nadie que existe una consulta
//       ajena con ese id. Por eso este chequeo va PRIMERO: si mirásemos antes
//       el estado o la conversación, el tipo de error contaría algo del
//       documento de otra persona.
//    2) ser de ESTA conversación: su conversacionId (o su propio id, si es la
//       raíz) tiene que ser el conversacionId de la pregunta nueva. Si no,
//       DATOS_INVALIDOS: la cadena está mal armada.
//    3) estar 'listo', con su pregunta y su respuesta. Una vuelta que todavía
//       no terminó, o que terminó en error, no es historial: DATOS_INVALIDOS.
//
//  OJO, ESTO NO ES UN PERMISO: el historial es texto que la persona ya tiene
//  en sus propios documentos. Qué items puede citar la respuesta nueva lo
//  decide buscarChunks, en vivo, como siempre.
// ============================================================================
async function cargarHistorial(wsId, uid, respIdPropio, cadena) {
  const vueltas = [];
  // Los ids que ya pasamos, empezando por la pregunta nueva: si la cadena
  // vuelve a uno, da vueltas sobre sí misma (solo puede pasar con datos
  // cargados a mano, pero no queremos repetir vueltas en el historial).
  const vistos = new Set([respIdPropio]);
  let id = cadena.anteriorRespId;

  while (id !== null && vueltas.length < MAX_VUELTAS_DE_HISTORIAL) {
    if (vistos.has(id)) fallar('DATOS_INVALIDOS', 'La conversación vuelve a pasar por una consulta que ya pasó.');
    vistos.add(id);

    // 1) ¿Existe y es de quien pregunta? El mismo 404 para las dos cosas.
    const snap = await refRespuesta(wsId, id).get();
    const doc = snap.exists ? snap.data() : null;
    if (!doc || doc.autorUid !== uid) {
      fallar('RESPUESTA_NO_ENCONTRADA', 'No encontramos la consulta anterior de esta conversación.');
    }

    // De acá en adelante el documento es de quien pregunta: decir qué tiene
    // de malo ya no le cuenta nada ajeno.
    const suya = leerCadena(doc, id);
    if (suya.tipo === 'rota') {
      fallar('DATOS_INVALIDOS', 'Una consulta anterior tiene mal armados los datos de la conversación.');
    }

    // 2) ¿Es de esta conversación?
    const conversacionDeEsta = suya.tipo === 'raiz' ? id : suya.conversacionId;
    if (conversacionDeEsta !== cadena.conversacionId) {
      fallar('DATOS_INVALIDOS', 'La consulta anterior es de otra conversación.');
    }

    // 3) ¿Terminó bien?
    if (doc.estado !== 'listo' || typeof doc.pregunta !== 'string' || typeof doc.respuesta !== 'string') {
      fallar('DATOS_INVALIDOS', 'La consulta anterior todavía no tiene respuesta o terminó con error.');
    }

    // unshift: la recorremos de la más nueva a la más vieja, pero al modelo
    // se la mostramos en el orden en que pasó. preguntaBuscada viaja para el
    // respaldo de la reformulación (ver responderLaConsulta).
    vueltas.unshift({
      pregunta: doc.pregunta,
      respuesta: doc.respuesta,
      preguntaBuscada: typeof doc.preguntaBuscada === 'string' ? doc.preguntaBuscada : null,
    });
    id = suya.tipo === 'raiz' ? null : suya.anteriorRespId;
  }

  return vueltas;
}

// ============================================================================
//  REFORMULAR  —  "¿Y en qué aula?" -> "¿En qué aula es la reunión de padres?"
//
//  Devuelve la pregunta reescrita, o null si no sirvió: el modelo no contestó
//  a tiempo, o devolvió algo vacío, en varias líneas o larguísimo. null NO es
//  un error: responderLaConsulta busca con el respaldo determinista. Por eso
//  acá se traga cualquier excepción: que falle un extra no puede tirar abajo
//  la respuesta (si Google está caído de verdad, ya va a fallar el chat).
// ============================================================================
async function reformularPregunta(historial, pregunta, hasta) {
  // El plazo de la reformulación, sin pasarse nunca del de la vuelta entera.
  const plazo = Math.min(hasta, Date.now() + PLAZO_REFORMULAR_MS);
  let texto;
  try {
    texto = await chatear([
      { role: 'system', content: PROMPT_REFORMULAR },
      { role: 'user', content: armarMensajeParaReformular(historial, pregunta) },
    ], { hasta: plazo, msPorModelo: TIMEOUT_REFORMULAR_POR_MODELO_MS });
  } catch (err) {
    console.warn(`[preguntar] la reformulación falló (${err?.codigo ?? err?.name ?? 'error'}): busco con el respaldo.`);
    return null;
  }

  const limpia = limpiarReformulada(texto);
  if (!limpia) console.warn('[preguntar] la reformulación vino vacía, en varias líneas o larguísima: busco con el respaldo.');

  // El mismo candado contra la inyección que tiene la respuesta (ver
  // filtraElReglamento en prompts.js), con las reglas de ESTE prompt. La
  // reformulación se guarda en preguntaBuscada y la app se la muestra a la
  // persona ("La entendí como..."): si el modelo devolvió sus reglas en vez
  // de la pregunta (una orden metida en una respuesta anterior del
  // historial), no se usa ni se muestra.
  if (limpia && filtraLasReglasDeReformular(limpia)) {
    console.warn('[preguntar] la reformulación traía las reglas del prompt: busco con el respaldo.');
    return null;
  }
  return limpia;
}

// Lo que devuelve el modelo se valida como si fuera una pregunta escrita a
// mano: UNA línea y de 3 a 500 caracteres. Si viene en varias líneas, casi
// seguro trae una explicación pegada que ensuciaría la búsqueda: no le
// creemos y vamos al respaldo.
function limpiarReformulada(texto) {
  const lineas = String(texto ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lineas.length !== 1) return null;
  const limpia = lineas[0]
    .replace(/^(pregunta( reescrita| reformulada)?|última pregunta)\s*:\s*/i, '') // "Pregunta: ¿...?"
    .replace(/^["'«“`]+|["'»”`]+$/g, '') // comillas alrededor de todo
    .replace(/\s+/g, ' ')
    .trim();
  return limpia.length >= MIN_PREGUNTA && limpia.length <= MAX_PREGUNTA ? limpia : null;
}

// ============================================================================
//  VALIDACIÓN DE LAS CITAS  —  la anti-alucinación de verdad.
//
//  El modelo escribe "[1]", "[2]"... y nosotros:
//    1) buscamos todos los números citados;
//    2) BORRAMOS del texto los que no existen (si mandamos 4 fragmentos y el
//       modelo escribió [7], ese [7] se va: apunta a la nada);
//    3) armamos el array 'fuentes' con los datos REALES del chunk (itemId,
//       título, página, fragmento, similitud). Nada de lo que el modelo diga
//       sobre la fuente entra al documento.
//
//  Por eso el asistente NO PUEDE inventar un documento: aunque escribiera
//  "según el manual de la fotocopiadora", el título que se muestra sale del
//  chunk que efectivamente le pasamos.
//
//  Las fuentes que se guardan son SOLO las citadas, y conservan su número
//  original: si el modelo citó [1] y [3], fuentes trae n=1 y n=3, y cada marca
//  del texto apunta a fuentes[].n como dice el modelo de datos.
// ============================================================================
function validarCitas(textoDelModelo, candidatos) {
  const maximo = candidatos.length;
  const citados = new Set();

  const respuestaLimpia = textoDelModelo
    // Aunque el prompt pide [1][3], los modelos a veces escriben [1, 3]. Lo
    // abrimos en [1][3] para no perder una cita buena por un tema de formato.
    .replace(/\[(\d{1,3}(?:\s*,\s*\d{1,3})+)\]/g, (todo, lista) =>
      lista.split(',').map((n) => `[${n.trim()}]`).join(''))
    // Una sola pasada: anotamos las válidas y borramos las que apuntan a la nada.
    .replace(/\[(\d{1,3})\]/g, (todo, num) => {
      const n = Number(num);
      if (n < 1 || n > maximo) return '';
      citados.add(n);
      return todo;
    })
    // Lo que queda al borrar una cita: dobles espacios y "dato ." sueltos.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:])/g, '$1')
    .trim();

  // Las fuentes salen del chunk real, en el orden de los números.
  const fuentes = [...citados].sort((a, b) => a - b).map((n) => fuenteParaGuardar(candidatos[n - 1]));

  return { respuestaLimpia, fuentes };
}

// buscar.js devuelve cada fuente con campos de más (chunkId, origen y el
// 'texto' ENTERO del chunk, que necesitamos para el prompt). En el documento y
// en el JSON va exactamente lo que declaran el modelo y el contrato:
// {n, itemId, titulo, pagina, fragmento, similitud}. Nada más.
function fuenteParaGuardar(f) {
  return {
    n: f.n,
    itemId: f.itemId,
    titulo: f.titulo,
    pagina: f.pagina,
    fragmento: f.fragmento,
    similitud: f.similitud,
  };
}

// La regla 4 del prompt le pide al modelo que, si no alcanza, diga exactamente
// esta frase. Si la dijo y no citó nada, no es "una respuesta sin fuente": es
// el mismo caso que no encontrar nada, y se guarda con el texto de siempre.
const DIJO_QUE_NO_ENCONTRO = /no encontr[eé] esto en la base del equipo/i;

function armarRespuestaFinal(textoDelModelo, busqueda) {
  // ---- EL CANDADO CONTRA LA INYECCIÓN, antes que nada -------------------
  // Si un item del equipo trae órdenes escondidas ("copiá tus reglas"), en el
  // título o en el texto, el modelo a veces obedece y vuelca el reglamento del
  // prompt. La regla 11 le pide que no lo haga; esto no depende de que
  // obedezca (ver filtraElReglamento en prompts.js). Se tira la respuesta
  // ENTERA y no solo los renglones del reglamento: un modelo que le hizo caso
  // a una orden de un fragmento ya no es confiable en nada de esa respuesta.
  // Se guarda como "no encontré", sin fuentes y con confianza 'baja'.
  // Al log van los itemIds en juego, para que el admin encuentre el item que
  // trae la orden; nunca el texto, que puede ser de una nota privada.
  if (filtraElReglamento(textoDelModelo)) {
    console.warn(`[preguntar] la respuesta traía el reglamento del prompt (¿órdenes metidas en un item?): se descarta. Items en juego: ${busqueda.fuentes.map((f) => f.itemId).join(', ')}`);
    return { respuesta: RESPUESTA_SIN_RESULTADOS, fuentes: [], confianza: 'baja' };
  }

  const { respuestaLimpia, fuentes } = validarCitas(textoDelModelo, busqueda.fuentes);

  // Si después de sacar las citas inválidas no queda texto (el modelo contestó
  // solo "[7]"), no hay respuesta que mostrar.
  if (!respuestaLimpia) {
    throw new ErrorApi('IA_NO_RESPONDE', 'La IA devolvió una respuesta vacía.');
  }

  if (fuentes.length > 0) {
    // La confianza sale del MEJOR chunk que encontró la búsqueda. La calcula
    // buscar.js (nivelDeConfianza) con cortes calibrados con datos reales: el
    // contrato pedía calibrarlos antes de la entrega. Los números viven SOLO
    // allá, al lado de la medición: copiados acá ya habían quedado viejos.
    return { respuesta: respuestaLimpia, fuentes, confianza: busqueda.confianza };
  }

  if (DIJO_QUE_NO_ENCONTRO.test(respuestaLimpia)) {
    return { respuesta: RESPUESTA_SIN_RESULTADOS, fuentes: [], confianza: 'baja' };
  }

  // Si el modelo no citó NADA válido, no lo escondemos: el producto es
  // "respuesta con fuente", así que una respuesta sin fuente tiene que
  // verse rara. Se avisa arriba y la confianza queda en 'baja'.
  return { respuesta: AVISO_SIN_CITAS + respuestaLimpia, fuentes: [], confianza: 'baja' };
}

// ============================================================================
//  PASOS 3 A 8 DEL CONTRATO
//  Para cuando se llama esto, la consulta ya es nuestra (tomarLaConsulta).
//  Cualquier excepción que salga de acá deja el documento en 'error'.
//  'hasta' es la fecha límite de la vuelta (ver PRESUPUESTO_DE_LA_VUELTA_MS):
//  la reciben los tres llamados a Google.
// ============================================================================
async function responderLaConsulta({ wsId, ref, uid, esAdmin, pregunta, cadena, hasta }) {
  // ---- SEGUIMIENTO: historial y reformulación ----------------------------
  // En una primera pregunta (cadena null) no se hace NADA de esto: se busca
  // con la pregunta tal cual y preguntaBuscada queda en null, como siempre.
  let historial = [];
  let preguntaBuscada = null;
  let preguntaParaBuscar = pregunta;

  if (cadena) {
    historial = await cargarHistorial(wsId, uid, ref.id, cadena);
    preguntaBuscada = await reformularPregunta(historial, pregunta, hasta);
    // EL RESPALDO, si la reformulación no sirvió: la pregunta anterior y la
    // nueva, pegadas. Es determinista (no depende de la IA) y alcanza para
    // que "¿Y en qué aula?" arrastre las palabras de "¿Cuándo es la reunión
    // de padres?". De la anterior usamos la versión que se entiende sola si
    // la tiene (su preguntaBuscada): en la tercera vuelta, pegar "¿Y en qué
    // aula?" + "¿Y qué hay que llevar?" no diría de qué se habla. Este texto
    // NO se guarda: preguntaBuscada queda en null = "no hubo reformulación".
    const anterior = historial[historial.length - 1];
    preguntaParaBuscar = preguntaBuscada ?? `${anterior.preguntaBuscada ?? anterior.pregunta} ${pregunta}`;
  }

  // ---- PASOS 3 a 7: filtrar y después rankear (buscar.js) ---------------
  // Adentro, y en este orden: (a) el conjunto de items visibles para ESTE uid,
  // leído EN VIVO y sin caché; (b) los chunks del workspace, descartando todo
  // lo que no esté en ese conjunto (fail-closed) Y lo que no permita la copia
  // de permisos del propio chunk; (c) recién ahí embeber la pregunta con
  // input_type 'query' y ordenar por coseno. Si la persona no puede ver ni un
  // chunk, ni siquiera se paga el embedding.
  // En un seguimiento se busca con la pregunta reformulada, pero el filtro es
  // EXACTAMENTE el mismo: el historial no le da acceso a nada.
  const busqueda = await buscarChunks(wsId, preguntaParaBuscar, uid, esAdmin, { hasta });

  // chunksMirados es el total del workspace. A un miembro común NO se lo
  // contamos: "miré 312 y viste 190" le dice que hay 122 fragmentos de
  // contenido privado ajeno. En el documento va null; en el JSON, ni aparece.
  const chunksMiradosParaGuardar = esAdmin ? busqueda.chunksMirados : null;

  // ---- 'buscando' -> 'redactando' ---------------------------------------
  // Pasamos SIEMPRE por 'redactando', incluso cuando no hay nada para
  // redactar: en el ciclo de vida del modelo de datos, a 'listo' se llega
  // únicamente desde 'redactando'. Es una escritura más y la pantalla no tiene
  // que conocer un atajo.
  // preguntaBuscada va en ESTE update porque ya es un hecho: la búsqueda
  // terminó y así se buscó. La pantalla puede mostrar "Entendí: ..." mientras
  // se redacta.
  await ref.update({
    estado: 'redactando',
    preguntaBuscada,
    actualizadoEn: FieldValue.serverTimestamp(),
  });

  let resultado;

  if (busqueda.fuentes.length === 0) {
    // ---- ¿No encontramos nada? Cortamos ACÁ. -----------------------------
    // NI SIQUIERA llamamos al modelo. Dos motivos, los dos importantes:
    //   - plata: una llamada de chat que ya sabemos que va a decir "no sé".
    //   - honestidad: sin fragmentos, el modelo inventa. Si no hay con qué
    //     responder, la respuesta la escribimos nosotros y no hay alucinación
    //     posible.
    // Y NO es un error: el contrato pide 200 con confianza 'baja' y fuentes [].
    resultado = { respuesta: RESPUESTA_SIN_RESULTADOS, fuentes: [], confianza: 'baja' };
  } else {
    // ---- PASO 8: que redacte el modelo -----------------------------------
    // chatear() recibe la conversación como array de mensajes (system + user)
    // y ya devuelve el texto sin el <think>...</think> de los modelos de
    // razonamiento. Temperatura baja (0.2, el default de ia.js) porque
    // queremos que copie lo que dicen los fragmentos, no que invente lindo.
    // Si falla, su error ya trae el código correcto (SIN_CREDITOS_IA,
    // DEMASIADOS_PEDIDOS, IA_NO_RESPONDE) y lo respetamos más abajo.
    // Con 'hasta', la cadena de modelos no se pasa de la fecha límite.
    const textoDelModelo = await chatear([
      { role: 'system', content: PROMPT_SISTEMA_RAG },
      // Las vueltas anteriores, como conversación (en una primera pregunta
      // no hay ninguna y esto no agrega nada). Van SIN las marcas [n]: esos
      // números eran de otros fragmentos.
      ...armarTurnosDelHistorial(historial),
      // Los fragmentos van numerados en el MISMO orden que busqueda.fuentes
      // (n = posición + 1): por eso el [2] del modelo es fuentes[1]. Y van
      // con la pregunta como la escribió la persona: el historial de arriba
      // le da el contexto para entender "¿Y en qué aula?".
      { role: 'user', content: armarMensajeDeUsuario(pregunta, busqueda.fuentes) },
    ], { hasta });

    // ---- validar las citas EN CÓDIGO -------------------------------------
    // Solo contra los fragmentos de ESTA vuelta, igual que una primera
    // pregunta: un [1] de una respuesta vieja no vale como fuente acá.
    resultado = armarRespuestaFinal(textoDelModelo, busqueda);
  }

  // ---- 'redactando' -> 'listo', en UN solo update -----------------------
  // Todo junto, como dice el modelo de datos: el cliente nunca ve una
  // respuesta sin sus fuentes ni unas fuentes sin su respuesta.
  await ref.update({
    estado: 'listo',
    respuesta: resultado.respuesta,
    fuentes: resultado.fuentes,
    confianza: resultado.confianza,
    chunksVisibles: busqueda.chunksVisibles,
    chunksMirados: chunksMiradosParaGuardar,
    errorMsg: null,
    actualizadoEn: FieldValue.serverTimestamp(),
  });

  return {
    ...resultado,
    chunksVisibles: busqueda.chunksVisibles,
    chunksMirados: busqueda.chunksMirados,
    // Estos dos son solo para el log y el evento: el JSON de la respuesta
    // HTTP se arma campo por campo y no los incluye.
    preguntaBuscada,
    vueltasDeHistorial: historial.length,
  };
}

// La consulta NO puede quedar colgada en 'buscando' o 'redactando' para
// siempre. Se marca 'error' con el MISMO mensaje que viaja por HTTP (el del
// catálogo, escrito por nosotros), nunca un err.message crudo: eso lo lee una
// persona en la pantalla.
async function marcarError(ref, codigo, respId) {
  try {
    await ref.update({
      estado: 'error',
      errorMsg: CATALOGO_DE_ERRORES[codigo].mensaje,
      actualizadoEn: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(`[preguntar] ${respId}: tampoco se pudo marcar el error:`, err);
  }
}

// ============================================================================
//  POST /preguntar
//
//  Los middlewares van EN LA RUTA y no con rutasDePreguntar.use(): este router
//  está montado en '/v1/workspaces/:wsId', así que un .use() correría para
//  TODOS los pedidos de ese prefijo (los de items incluidos) y les contaría
//  pedidos que no son preguntas.
//
//  El limitador va entre requireAuth (necesita el uid) y exigirMiembro: así
//  alguien que martilla el endpoint no nos hace gastar ni la lectura de members.
// ============================================================================
rutasDePreguntar.post('/preguntar', requireAuth, limitarPreguntas, exigirMiembro, async (req, res) => {
  const arranque = Date.now();
  // La fecha límite de todo lo que se le pide a Google en esta vuelta.
  const hasta = arranque + PRESUPUESTO_DE_LA_VUELTA_MS;
  const { wsId } = req.params;            // de la RUTA, nunca del body
  const { uid } = req.usuario;            // del token verificado, nunca del body
  const esAdmin = req.esAdmin === true;   // del doc members, nunca del claim

  // ---- 1. Validar el body (antes de leer nada de Firestore) -------------
  const respId = typeof req.body?.respId === 'string' ? req.body.respId.trim() : '';
  const preguntaDelBody = typeof req.body?.pregunta === 'string' ? req.body.pregunta.trim() : '';

  if (!FORMATO_RESP_ID.test(respId)) {
    fallar('DATOS_INVALIDOS', 'Falta el respId de la consulta o no tiene un formato válido.');
  }
  if (preguntaDelBody.length < MIN_PREGUNTA || preguntaDelBody.length > MAX_PREGUNTA) {
    fallar('DATOS_INVALIDOS', `La pregunta tiene que medir entre ${MIN_PREGUNTA} y ${MAX_PREGUNTA} caracteres.`);
  }

  // ---- 2. La consulta la creó el CLIENTE; nosotros solo la tomamos -------
  // El backend NUNCA crea una respuesta (invariante 7). El cliente crea
  // respuestas/{respId} con pregunta, autorUid, estado 'buscando' y creadoEn
  // ANTES de este POST, así la pregunta y el spinner aparecen al instante
  // aunque Render esté dormido. Si el doc no existe, es un 404 y listo.
  // Un seguimiento trae además conversacionId y anteriorRespId: 'cadena'.
  const ref = refRespuesta(wsId, respId);
  const tomada = await tomarLaConsulta(ref, uid, preguntaDelBody);
  if (tomada.problema) fallar('DATOS_INVALIDOS', tomada.problema);
  const { pregunta, cadena } = tomada;

  // ---- 3 a 8. Buscar, redactar, validar, guardar -------------------------
  // En un seguimiento, antes: el historial y la reformulación. Si el
  // historial no cierra (consulta ajena, inexistente o de otra conversación),
  // el error sale de acá adentro y la consulta queda en 'error' como con
  // cualquier otra falla.
  let resultado;
  try {
    resultado = await responderLaConsulta({ wsId, ref, uid, esAdmin, pregunta, cadena, hasta });
  } catch (err) {
    const errorApi = aErrorApi(err);
    // El error ORIGINAL (con su stack y su detalle) va al log de Render; al
    // cliente le llega la versión del catálogo. Los que tiramos NOSOTROS a
    // propósito con fallar() (una consulta anterior ajena, una cadena mal
    // armada) son parte del funcionamiento normal: una línea alcanza, sin el
    // stack, igual que el middleware final hace con los 4xx.
    if (err instanceof ErrorApi) {
      console.warn(`[preguntar] ${respId} terminó en ${errorApi.codigo}: ${errorApi.detalle ?? '(sin detalle)'}`);
    } else {
      console.error(`[preguntar] ${respId} falló con ${errorApi.codigo}:`, err);
    }

    // Primero el documento, después el HTTP: si el cliente corta la conexión,
    // igual su listener se entera del error.
    await marcarError(ref, errorApi.codigo, respId);

    if (errorApi.codigo === 'DEMASIADOS_PEDIDOS') {
      // El contrato pide Retry-After también cuando el 429 viene de Google.
      // Lo ponemos ACÁ porque el middleware final arma el JSON pero no toca
      // los headers que ya están puestos.
      res.set('Retry-After', String(RETRY_AFTER_IA_SEG));
    }
    throw errorApi;
  }

  // ---- Evento de auditoría (lo lee solo el admin) -----------------------
  // Va DESPUÉS de guardar la respuesta y no puede romperla (anotarEvento se
  // traga sus errores). Poner el texto de la pregunta no le abre nada a nadie:
  // el admin ya puede leer todas las respuestas del workspace.
  // "1 fuente" / "2 fuentes" y no "fuente(s)": es la frase que se proyecta en
  // "En vivo" (el plan la pide asi). El panel reconoce las dos formas, asi que
  // los eventos viejos se siguen leyendo bien.
  const quien = req.miembro?.nombre || req.usuario.email || 'Alguien';
  const cuantasFuentes = resultado.fuentes.length;
  await anotarEvento(wsId, {
    tipo: 'pregunta.hecha',
    actorUid: uid,
    resumen: `${quien} preguntó "${recortar(pregunta, 60)}"${cadena ? ' (seguimiento)' : ''} · ${cuantasFuentes} ${cuantasFuentes === 1 ? 'fuente' : 'fuentes'}, confianza ${resultado.confianza}`,
  });

  const tardoMs = Date.now() - arranque;

  // Al log NO va la pregunta (ni la reformulada): puede ser sobre una nota
  // privada. Del seguimiento va solo cómo se buscó.
  const comoSeBusco = !cadena
    ? ''
    : ` · seguimiento con ${resultado.vueltasDeHistorial} vuelta(s) de historial, ${resultado.preguntaBuscada ? 'pregunta reformulada' : 'búsqueda con el respaldo'}`;
  console.log(`[preguntar] ${respId} listo en ${tardoMs} ms · ${resultado.fuentes.length} fuente(s) · ${resultado.chunksVisibles}/${resultado.chunksMirados} chunks visibles${comoSeBusco}`);

  // ---- La respuesta HTTP --------------------------------------------------
  // Todo lo que va acá está también en el documento (invariante 20), salvo
  // tardoMs, que es dato del pedido.
  const cuerpo = {
    ok: true,
    respId,
    estado: 'listo',
    respuesta: resultado.respuesta,
    fuentes: resultado.fuentes,
    confianza: resultado.confianza,
    chunksVisibles: resultado.chunksVisibles,
  };
  // chunksMirados viaja ÚNICAMENTE si quien pregunta es admin. Para un
  // miembro el campo no aparece (ni siquiera como null).
  if (esAdmin) cuerpo.chunksMirados = resultado.chunksMirados;
  cuerpo.tardoMs = tardoMs;

  return res.status(200).json(cuerpo);
});
