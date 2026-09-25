// ============================================================================
//  rutas/preguntar.js — EL RAG. Esto es el producto.
//
//  Se monta así en server.js:
//      import rutasPreguntar from './rutas/preguntar.js';
//      app.use('/v1/workspaces/:wsId', rutasPreguntar);   // -> POST /v1/workspaces/:wsId/preguntar
//
//  QUÉ ES UN RAG, EN CRIOLLO (para la defensa oral):
//  El modelo de IA no sabe nada del equipo. Entonces hacemos tres cosas:
//    1) BUSCAR   — convertimos la pregunta en un vector y la comparamos contra
//                  los vectores de todos los fragmentos indexados del workspace.
//    2) FILTRAR  — nos quedamos SOLO con los fragmentos que ESA persona puede
//                  ver. Este paso es el requisito 2 de la materia.
//    3) REDACTAR — le pasamos al modelo los 6 mejores fragmentos y le exigimos
//                  que responda usando solo eso y citando [1], [2].
//
//  Y después hacemos una cuarta cosa que casi nadie hace: VALIDAMOS EN CÓDIGO
//  las citas. El texto de la fuente (título, página, itemId) sale del chunk
//  REAL guardado en Firestore, NUNCA de lo que dijo el modelo. Por eso es
//  imposible que invente un título de documento.
// ============================================================================

import { Router } from 'express';

import { db, FieldValue } from '../lib/firebase.js';
import { ErrorApi } from '../lib/errores.js';
import { exigirToken, exigirMiembro } from '../middleware/auth.js';
import { embeber, chatear } from '../lib/nvidia.js';
import {
  PROMPT_SISTEMA_RAG,
  armarMensajeDeUsuario,
  RESPUESTA_SIN_RESULTADOS,
  AVISO_SIN_CITAS,
} from '../prompts.js';

const router = Router({ mergeParams: true });

// ============================================================================
//  NÚMEROS DEL RAG
// ============================================================================

// Cuántos fragmentos le mandamos al modelo. Con 6 alcanza y sobra: más
// fragmentos = más tokens = más plata y, encima, el modelo se dispersa.
const CUANTAS_FUENTES = 6;

// Similitud mínima para que un fragmento se considere "relacionado". Debajo de
// esto, el fragmento habla de otra cosa. VALOR A CALIBRAR con datos reales
// antes de la entrega: subirlo hace al asistente más callado pero más confiable.
const UMBRAL_MINIMO = 0.35;

// Cortes de confianza, según la similitud del MEJOR fragmento.
const UMBRAL_ALTA = 0.60;
const UMBRAL_MEDIA = 0.45;

// Largo del pedacito de texto que se muestra en la tarjeta de la fuente.
const LARGO_FRAGMENTO = 220;

const MIN_PREGUNTA = 3;
const MAX_PREGUNTA = 500;

// ============================================================================
//  AYUDANTES CHICOS
// ============================================================================

function refRespuesta(wsId, respId) {
  return db.collection('workspaces').doc(wsId).collection('respuestas').doc(respId);
}

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

// Similitud coseno entre dos vectores.
// Usamos la fórmula COMPLETA (dividiendo por las dos normas) aunque al indexar
// ya los normalizamos. Cuesta un poquito más, pero si algún chunk viejo quedó
// sin normalizar, el ranking sigue siendo correcto en vez de dar cualquier cosa.
function similitudCoseno(a, b) {
  const largo = Math.min(a.length, b.length);
  let punto = 0, normaA = 0, normaB = 0;

  for (let i = 0; i < largo; i++) {
    punto += a[i] * b[i];
    normaA += a[i] * a[i];
    normaB += b[i] * b[i];
  }
  if (normaA === 0 || normaB === 0) return 0;
  return punto / (Math.sqrt(normaA) * Math.sqrt(normaB));
}

function normalizarVector(vector) {
  let suma = 0;
  for (const x of vector) suma += x * x;
  const norma = Math.sqrt(suma);
  if (norma === 0) return vector;
  return vector.map((x) => x / norma);
}

function calcularConfianza(mejorSimilitud) {
  if (mejorSimilitud >= UMBRAL_ALTA) return 'alta';
  if (mejorSimilitud >= UMBRAL_MEDIA) return 'media';
  return 'baja';
}

// ============================================================================
//  EL FILTRO DE PRIVACIDAD  —  la parte más importante del proyecto entero.
//
//  Devuelve el CONJUNTO de itemIds que ESTE uid puede ver, leído EN VIVO.
//
//  ¿Por qué en vivo y SIN NINGUNA CACHÉ entre pedidos?
//  Porque si lo cacheáramos, alguien podría pasar una nota de 'equipo' a
//  'privado' y durante todo lo que dure la caché la IA se la seguiría mostrando
//  al resto del equipo. Una caché acá no es una optimización: es un agujero.
//  Dentro de un mismo pedido sí reusamos el conjunto (lo calculamos una sola
//  vez), pero no sobrevive al pedido.
//
//  .select() sin argumentos trae SOLO los ids de los documentos, sin los campos.
//  Es muchísimo más barato en ancho de banda que traer los items enteros.
// ============================================================================
async function itemIdsQuePuedeVer(wsId, uid, esAdmin) {
  const items = db.collection('workspaces').doc(wsId).collection('items');

  // El admin ve todo el workspace, incluidos los items privados de los demás.
  // Es la diferencia de rol que se muestra en vivo en la demo: la misma
  // pregunta, hecha por el admin, encuentra más fuentes.
  if (esAdmin) {
    const snap = await items.select().get();
    return new Set(snap.docs.map((d) => d.id));
  }

  // Un miembro común ve dos cosas: lo compartido con el equipo, y lo suyo.
  // Van en DOS queries separadas porque Firestore no tiene OR entre campos
  // distintos de forma barata, y porque es exactamente lo mismo que hace la app
  // con sus dos pestañas ("Del equipo" y "Mis notas").
  const [delEquipo, mios] = await Promise.all([
    items.where('visibilidad', '==', 'equipo').select().get(),
    items.where('creadoPor', '==', uid).select().get(),
  ]);

  const visibles = new Set();
  delEquipo.docs.forEach((d) => visibles.add(d.id));
  mios.docs.forEach((d) => visibles.add(d.id));
  return visibles;
}

// ============================================================================
//  buscarChunks()
//
//  Trae los chunks del workspace, los FILTRA por privacidad y los ordena por
//  parecido con la pregunta.
//
//  Sobre traer TODOS los chunks: el plan Spark de Firestore no tiene búsqueda
//  vectorial, así que el coseno lo calculamos nosotros en Node. Con 200 items
//  indexados son ~2.800 lecturas por pregunta. Está medido y asumido: es la
//  limitación conocida del MVP y hay que saber decirla.
// ============================================================================
async function buscarChunks({ wsId, uid, esAdmin, vectorPregunta }) {
  // (a) LA CERRADURA QUE MANDA: los items visibles, leídos recién ahora.
  const visibles = await itemIdsQuePuedeVer(wsId, uid, esAdmin);

  const snap = await db.collection('chunks').where('workspaceId', '==', wsId).get();
  const chunksMirados = snap.size;

  const candidatos = [];

  for (const doc of snap.docs) {
    const c = doc.data();

    // (a) FAIL-CLOSED. Si el itemId del chunk NO está en el conjunto que
    // acabamos de leer, el chunk se descarta. Y si el item no existe —porque
    // lo borraron y quedó un chunk suelto— tampoco está en el conjunto, así
    // que también se descarta. Nunca al revés: jamás "no lo encontré, lo dejo
    // pasar". Ante la duda, se esconde.
    if (!visibles.has(c.itemId)) continue;

    // (b) SEGUNDA CERRADURA, con AND. La copia de permisos que vive en el
    // propio chunk. Es una foto del item al momento de indexar y PUEDE ESTAR
    // VIEJA, por eso nunca es la que manda. Como va con AND contra (a), una
    // copia vieja solo puede esconder de más, nunca mostrar de más.
    const puedeVerElChunk = esAdmin || c.visibilidad === 'equipo' || c.creadoPor === uid;
    if (!puedeVerElChunk) continue;

    if (!Array.isArray(c.embedding) || c.embedding.length === 0) continue;

    candidatos.push({
      itemId: c.itemId,
      titulo: c.titulo ?? '(sin título)',
      pagina: c.pagina ?? null,
      texto: c.texto ?? '',
      similitud: similitudCoseno(vectorPregunta, c.embedding),
    });
  }

  const chunksVisibles = candidatos.length;

  // De mayor a menor parecido, nos quedamos con los mejores y tiramos los que
  // no llegan al umbral (hablan de otra cosa y solo ensuciarían el prompt).
  candidatos.sort((x, y) => y.similitud - x.similitud);
  const mejores = candidatos.slice(0, CUANTAS_FUENTES).filter((c) => c.similitud >= UMBRAL_MINIMO);

  return { mejores, chunksMirados, chunksVisibles };
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
// ============================================================================
function validarCitas(textoDelModelo, candidatos) {
  const citados = new Set();

  // Primera pasada: qué números usó y cuáles son válidos.
  for (const m of textoDelModelo.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= candidatos.length) citados.add(n);
  }

  // Segunda pasada: sacamos del texto las citas que apuntan a la nada.
  const respuestaLimpia = textoDelModelo
    .replace(/\[(\d{1,2})\]/g, (todo, num) => {
      const n = Number(num);
      return (n >= 1 && n <= candidatos.length) ? todo : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  // Las fuentes salen del chunk real, en el orden en que aparecen los números.
  const fuentes = [...citados].sort((a, b) => a - b).map((n) => {
    const c = candidatos[n - 1];
    return {
      n,
      itemId: c.itemId,
      titulo: c.titulo,
      pagina: c.pagina,
      fragmento: c.texto.slice(0, LARGO_FRAGMENTO).trim(),
      // Redondeamos para que el panel no muestre 0.8312499999999999.
      similitud: Math.round(c.similitud * 1000) / 1000,
    };
  });

  return { respuestaLimpia, fuentes };
}

// ============================================================================
//  EL TRABAJO PESADO, EN SEGUNDO PLANO.
//  Igual que en items.js: el endpoint ya respondió y el cliente sigue el
//  progreso con su listener sobre el documento (buscando -> redactando -> listo).
// ============================================================================
async function responderEnSegundoPlano({ wsId, respId, uid, esAdmin, pregunta }) {
  const arranque = Date.now();
  const ref = refRespuesta(wsId, respId);

  try {
    // ---- PASO 1: embeber la pregunta -------------------------------------
    // input_type 'query'. DISTINTO del 'passage' que usamos al indexar, y no es
    // un capricho: el modelo de embeddings está entrenado de forma ASIMÉTRICA
    // (una pregunta y el párrafo que la responde no se escriben igual). Si acá
    // pusiéramos 'passage', las similitudes bajan y respuestas correctas se
    // caen debajo del umbral. Es el error más difícil de encontrar del RAG,
    // porque no rompe nada: simplemente contesta peor.
    let vectorPregunta;
    try {
      const vectores = await embeber([pregunta], 'query');
      vectorPregunta = normalizarVector(vectores[0]);
    } catch (err) {
      throw comoErrorApi(err, 'IA_NO_RESPONDE');
    }

    // ---- PASO 2: buscar y filtrar ----------------------------------------
    const { mejores, chunksMirados, chunksVisibles } = await buscarChunks({
      wsId, uid, esAdmin, vectorPregunta,
    });

    // ---- PASO 3: ¿no encontramos nada? Cortamos ACÁ. ---------------------
    // NI SIQUIERA llamamos al modelo. Dos motivos, los dos importantes:
    //   - plata: una llamada de chat que ya sabemos que va a decir "no sé".
    //   - honestidad: sin fragmentos, el modelo inventa. Si no hay con qué
    //     responder, la respuesta la escribimos nosotros y no hay alucinación
    //     posible.
    if (mejores.length === 0) {
      await ref.update({
        estado: 'listo',
        respuesta: RESPUESTA_SIN_RESULTADOS,
        fuentes: [],
        confianza: 'baja',
        chunksMirados,
        chunksVisibles,
        errorMsg: null,
        actualizadoEn: FieldValue.serverTimestamp(),
      });
      await anotarEvento(wsId, {
        tipo: 'pregunta.hecha',
        actorUid: uid,
        resumen: `Preguntó "${recortar(pregunta, 60)}" · sin resultados`,
      });
      console.log(`[preguntar] ${respId} sin resultados en ${Date.now() - arranque} ms (${chunksVisibles}/${chunksMirados} chunks visibles)`);
      return;
    }

    // ---- PASO 4: pasamos a 'redactando' y ya guardamos las fuentes -------
    // Guardar las fuentes ACÁ, antes de llamar al modelo, tiene una gracia: si
    // la IA se cae en el paso siguiente, la persona igual ve QUÉ documentos
    // encontramos, aunque no tenga el texto redactado.
    const fuentesPreliminares = mejores.map((c, i) => ({
      n: i + 1,
      itemId: c.itemId,
      titulo: c.titulo,
      pagina: c.pagina,
      fragmento: c.texto.slice(0, LARGO_FRAGMENTO).trim(),
      similitud: Math.round(c.similitud * 1000) / 1000,
    }));

    await ref.update({
      estado: 'redactando',
      fuentes: fuentesPreliminares,
      chunksMirados,
      chunksVisibles,
      actualizadoEn: FieldValue.serverTimestamp(),
    });

    // ---- PASO 5: que redacte el modelo -----------------------------------
    let textoDelModelo;
    try {
      textoDelModelo = await chatear({
        sistema: PROMPT_SISTEMA_RAG,
        usuario: armarMensajeDeUsuario(pregunta, mejores),
      });
    } catch (err) {
      throw comoErrorApi(err, 'IA_NO_RESPONDE');
    }

    if (!textoDelModelo || !textoDelModelo.trim()) {
      throw new ErrorApi('IA_NO_RESPONDE', 'la IA devolvió una respuesta vacía');
    }

    // ---- PASO 6: validar las citas EN CÓDIGO -----------------------------
    let { respuestaLimpia, fuentes } = validarCitas(textoDelModelo, mejores);

    // Si el modelo no citó NADA válido, no lo escondemos: el producto es
    // "respuesta con fuente", así que una respuesta sin fuente tiene que
    // verse rara. Se avisa arriba y la confianza queda en 'baja'.
    let confianza = calcularConfianza(mejores[0].similitud);
    if (fuentes.length === 0) {
      respuestaLimpia = AVISO_SIN_CITAS + respuestaLimpia;
      confianza = 'baja';
    }

    // ---- PASO 7: guardar la respuesta final ------------------------------
    await ref.update({
      estado: 'listo',
      respuesta: respuestaLimpia,
      fuentes,
      confianza,
      chunksMirados,
      chunksVisibles,
      errorMsg: null,
      actualizadoEn: FieldValue.serverTimestamp(),
    });

    await anotarEvento(wsId, {
      tipo: 'pregunta.hecha',
      actorUid: uid,
      resumen: `Preguntó "${recortar(pregunta, 60)}" · ${fuentes.length} fuente(s), confianza ${confianza}`,
    });

    console.log(`[preguntar] ${respId} listo en ${Date.now() - arranque} ms · ${fuentes.length} fuentes · ${chunksVisibles}/${chunksMirados} chunks visibles`);
  } catch (err) {
    // Igual que con los items: la respuesta NO puede quedar colgada en
    // 'buscando' o 'redactando' para siempre. Mensaje legible, stack al log.
    const mensaje = err instanceof ErrorApi
      ? err.mensaje
      : 'Algo salió mal buscando la respuesta. Volvé a preguntar.';

    console.error(`[preguntar] ${respId} falló:`, err);

    try {
      await ref.update({
        estado: 'error',
        errorMsg: mensaje,
        actualizadoEn: FieldValue.serverTimestamp(),
      });
    } catch (err2) {
      console.error(`[preguntar] ${respId}: tampoco se pudo marcar el error:`, err2);
    }
  }
}

function comoErrorApi(err, codigoPorDefecto) {
  return err instanceof ErrorApi ? err : new ErrorApi(codigoPorDefecto);
}

function recortar(texto, largo) {
  return texto.length <= largo ? texto : texto.slice(0, largo) + '…';
}

// ============================================================================
//  POST /preguntar
// ============================================================================
router.post('/preguntar', exigirToken, exigirMiembro, async (req, res) => {
  const { wsId } = req.params;
  const { uid } = req.auth;
  const esAdmin = req.miembro.rol === 'admin';

  const respIdPedido = typeof req.body?.respId === 'string' ? req.body.respId.trim() : '';
  const preguntaDelBody = typeof req.body?.pregunta === 'string' ? req.body.pregunta.trim() : '';

  let respId;
  let pregunta;

  if (respIdPedido) {
    // --- CAMINO NORMAL: el documento lo creó el CLIENTE -------------------
    // Es lo que dice el contrato y lo que permiten las reglas: el cliente crea
    // respuestas/{respId} con estado 'buscando' ANTES de este POST, así la
    // pregunta y el spinner aparecen al instante aunque Render esté dormido.
    const snap = await refRespuesta(wsId, respIdPedido).get();
    if (!snap.exists) throw new ErrorApi('RESPUESTA_NO_ENCONTRADA');

    const doc = snap.data();

    // Si la consulta es de OTRO usuario respondemos el MISMO 404 que si no
    // existiera. A propósito: no le confirmamos a nadie que existe una
    // consulta ajena con ese id.
    if (doc.autorUid !== uid) throw new ErrorApi('RESPUESTA_NO_ENCONTRADA');

    // Solo se procesa una consulta recién creada (o una que falló y se
    // reintenta). Si ya está 'listo' o 'redactando', dos taps volverían a
    // gastar créditos por la misma pregunta.
    if (doc.estado !== 'buscando' && doc.estado !== 'error') {
      throw new ErrorApi('DATOS_INVALIDOS', `esa consulta ya está en estado '${doc.estado}'`);
    }

    // LA PREGUNTA QUE VALE ES LA DEL DOCUMENTO, no la del body. El body solo
    // sirve para chequear que el cliente no se haya confundido de respId.
    pregunta = (doc.pregunta ?? '').trim();
    if (preguntaDelBody && preguntaDelBody !== pregunta) {
      throw new ErrorApi('DATOS_INVALIDOS', 'la pregunta del body no coincide con la del documento');
    }

    respId = respIdPedido;
  } else {
    // --- CAMINO DE RESPALDO: no vino respId, lo creamos nosotros ----------
    // Sirve para probar el endpoint con curl o desde un cliente que todavía no
    // sabe crear el documento. El camino normal sigue siendo el de arriba.
    pregunta = preguntaDelBody;
    if (pregunta.length < MIN_PREGUNTA || pregunta.length > MAX_PREGUNTA) {
      throw new ErrorApi('DATOS_INVALIDOS', `la pregunta va de ${MIN_PREGUNTA} a ${MAX_PREGUNTA} caracteres`);
    }

    const nuevo = await db.collection('workspaces').doc(wsId).collection('respuestas').add({
      pregunta,
      autorUid: uid,
      estado: 'buscando',
      creadoEn: FieldValue.serverTimestamp(),
    });
    respId = nuevo.id;
  }

  if (pregunta.length < MIN_PREGUNTA || pregunta.length > MAX_PREGUNTA) {
    throw new ErrorApi('DATOS_INVALIDOS', `la pregunta va de ${MIN_PREGUNTA} a ${MAX_PREGUNTA} caracteres`);
  }

  // --- Respondemos YA, con el id. El resto sigue solo. --------------------
  // El cliente ya tiene el respId y está escuchando ese documento: va a ver
  // 'buscando' -> 'redactando' -> 'listo' en vivo, sin hacer polling.
  res.status(202).json({
    ok: true,
    respId,
    estado: 'buscando',
    aviso: 'Estamos buscando en el conocimiento del equipo.',
  });

  responderEnSegundoPlano({ wsId, respId, uid, esAdmin, pregunta })
    .catch((err) => console.error(`[preguntar] ${respId} rompió el segundo plano:`, err));
});

export default router;
