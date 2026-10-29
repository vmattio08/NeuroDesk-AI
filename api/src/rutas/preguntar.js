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
// ============================================================================

import { Router } from 'express';

import { db, FieldValue } from '../firebase.js';
import { ErrorApi, fallar, esErrorApi, CATALOGO_DE_ERRORES } from '../errores.js';
import { requireAuth, exigirMiembro } from '../middleware/auth.js';
import { buscarChunks } from '../servicios/buscar.js';
import { chatear } from '../servicios/ia.js';
import {
  PROMPT_SISTEMA_RAG,
  armarMensajeDeUsuario,
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
    // por las reglas.
    const pregunta = typeof doc.pregunta === 'string' ? doc.pregunta.trim() : '';
    let problema = null;
    if (pregunta.length < MIN_PREGUNTA || pregunta.length > MAX_PREGUNTA) {
      problema = `La pregunta de la consulta tiene que medir entre ${MIN_PREGUNTA} y ${MAX_PREGUNTA} caracteres.`;
    } else if (pregunta !== preguntaDelBody) {
      problema = 'La pregunta del pedido no coincide con la de la consulta.';
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
    return { pregunta };
  });
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
  const { respuestaLimpia, fuentes } = validarCitas(textoDelModelo, busqueda.fuentes);

  // Si después de sacar las citas inválidas no queda texto (el modelo contestó
  // solo "[7]"), no hay respuesta que mostrar.
  if (!respuestaLimpia) {
    throw new ErrorApi('IA_NO_RESPONDE', 'La IA devolvió una respuesta vacía.');
  }

  if (fuentes.length > 0) {
    // La confianza sale del MEJOR chunk que encontró la búsqueda. La calcula
    // buscar.js con los cortes calibrados con datos reales (>= 0.45 alta,
    // >= 0.30 media): el contrato pedía calibrarlos antes de la entrega.
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
// ============================================================================
async function responderLaConsulta({ wsId, ref, uid, esAdmin, pregunta }) {
  // ---- PASOS 3 a 7: filtrar y después rankear (buscar.js) ---------------
  // Adentro, y en este orden: (a) el conjunto de items visibles para ESTE uid,
  // leído EN VIVO y sin caché; (b) los chunks del workspace, descartando todo
  // lo que no esté en ese conjunto (fail-closed) Y lo que no permita la copia
  // de permisos del propio chunk; (c) recién ahí embeber la pregunta con
  // input_type 'query' y ordenar por coseno. Si la persona no puede ver ni un
  // chunk, ni siquiera se paga el embedding.
  const busqueda = await buscarChunks(wsId, pregunta, uid, esAdmin);

  // chunksMirados es el total del workspace. A un miembro común NO se lo
  // contamos: "miré 312 y viste 190" le dice que hay 122 fragmentos de
  // contenido privado ajeno. En el documento va null; en el JSON, ni aparece.
  const chunksMiradosParaGuardar = esAdmin ? busqueda.chunksMirados : null;

  // ---- 'buscando' -> 'redactando' ---------------------------------------
  // Pasamos SIEMPRE por 'redactando', incluso cuando no hay nada para
  // redactar: en el ciclo de vida del modelo de datos, a 'listo' se llega
  // únicamente desde 'redactando'. Es una escritura más y la pantalla no tiene
  // que conocer un atajo.
  await ref.update({
    estado: 'redactando',
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
    const textoDelModelo = await chatear([
      { role: 'system', content: PROMPT_SISTEMA_RAG },
      // Los fragmentos van numerados en el MISMO orden que busqueda.fuentes
      // (n = posición + 1): por eso el [2] del modelo es fuentes[1].
      { role: 'user', content: armarMensajeDeUsuario(pregunta, busqueda.fuentes) },
    ]);

    // ---- validar las citas EN CÓDIGO -------------------------------------
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
  const ref = refRespuesta(wsId, respId);
  const tomada = await tomarLaConsulta(ref, uid, preguntaDelBody);
  if (tomada.problema) fallar('DATOS_INVALIDOS', tomada.problema);
  const { pregunta } = tomada;

  // ---- 3 a 8. Buscar, redactar, validar, guardar -------------------------
  let resultado;
  try {
    resultado = await responderLaConsulta({ wsId, ref, uid, esAdmin, pregunta });
  } catch (err) {
    const errorApi = aErrorApi(err);
    // El error ORIGINAL (con su stack y su detalle) va al log de Render; al
    // cliente le llega la versión del catálogo.
    console.error(`[preguntar] ${respId} falló con ${errorApi.codigo}:`, err);

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
  const quien = req.miembro?.nombre || req.usuario.email || 'Alguien';
  await anotarEvento(wsId, {
    tipo: 'pregunta.hecha',
    actorUid: uid,
    resumen: `${quien} preguntó "${recortar(pregunta, 60)}" · ${resultado.fuentes.length} fuente(s), confianza ${resultado.confianza}`,
  });

  const tardoMs = Date.now() - arranque;

  // Al log NO va la pregunta: puede ser sobre una nota privada.
  console.log(`[preguntar] ${respId} listo en ${tardoMs} ms · ${resultado.fuentes.length} fuente(s) · ${resultado.chunksVisibles}/${resultado.chunksMirados} chunks visibles`);

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
