// ============================================================================
//  rutas/items.js — LAS RUTAS PESADAS DE LOS ITEMS
//
//  Se monta así en server.js (el wsId sale del path, NUNCA del body):
//      import rutasItems from './rutas/items.js';
//      app.use('/v1/workspaces/:wsId/items', rutasItems);
//
//  Endpoints:
//    POST   /:itemId/procesar     multipart, el archivo viene en la parte 'archivo'
//    POST   /:itemId/reprocesar   sin archivo, usa lo que ya está guardado en el doc
//    DELETE /:itemId              borra los chunks y después el item
//
//  LA REGLA DE ORO DE TODO EL PROYECTO:
//  el item YA EXISTE cuando llega este pedido. Lo creó el CLIENTE, directo
//  contra Firestore, en estado 'pendiente'. Por eso la fila aparece al instante
//  en el panel aunque Render esté dormido. El BACKEND NUNCA CREA UN ITEM:
//  solo lo mueve pendiente -> procesando -> listo | error.
// ============================================================================

import { Router } from 'express';
import multer from 'multer';

import { db, FieldValue } from '../lib/firebase.js';
import { ErrorApi } from '../lib/errores.js';
import { exigirToken, exigirMiembro } from '../middleware/auth.js';
import {
  extraerTextoDePdf,
  extraerTextoDeImagen,
  traerTextoDeUrl,
  normalizarTexto,
} from '../lib/extraccion.js';
import { embeber } from '../lib/nvidia.js';

// mergeParams: true es OBLIGATORIO. Sin eso, req.params.wsId llega undefined
// porque el :wsId está en la ruta donde montamos el router, no acá adentro.
const router = Router({ mergeParams: true });

// ============================================================================
//  NÚMEROS DEL SISTEMA. Todos juntos y con nombre, para no dejar magia suelta
//  en el medio del código y para poder cambiarlos en un solo lugar.
// ============================================================================

// Tope DURO de multer: si el archivo lo pasa, multer corta la subida y ni
// siquiera guardamos el buffer en memoria (Render free tiene 512 MB, un
// archivo gigante nos mata el proceso entero).
const TOPE_DURO_MB = 15;
const TOPE_DURO_BYTES = TOPE_DURO_MB * 1024 * 1024;

// Tope de NEGOCIO, el que le prometemos al usuario y el que valida el cliente
// antes de subir. Es más chico que el duro a propósito: así el error normal
// ("no puede pesar más de 10 MB") lo damos nosotros con un mensaje lindo, y el
// tope de multer queda solo como red de contención contra un cliente hecho a mano.
const TOPE_ARCHIVO_MB = 10;
const TOPE_ARCHIVO_BYTES = TOPE_ARCHIVO_MB * 1024 * 1024;

const TIPOS_MIME_OK = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

// Un item en 'procesando' con más de 5 minutos sin cambios está COLGADO
// (se reinició Render en el medio). Lo dejamos volver a procesar, si no
// quedaría muerto para siempre y el botón "Reintentar" no serviría de nada.
const MINUTOS_PARA_CONSIDERARLO_COLGADO = 5;
const MS_COLGADO = MINUTOS_PARA_CONSIDERARLO_COLGADO * 60 * 1000;

// Un doc de Firestore no puede pasar de 1 MiB. 300.000 caracteres deja lugar
// de sobra para el resto de los campos. Si el texto es más largo, lo recortamos
// y marcamos recortado:true para que el panel avise en vez de mentir.
const TOPE_TEXTO_CARACTERES = 300_000;

// Troceado: ~1500 caracteres con 200 de solapado. El solapado existe para que
// una frase partida al medio ("el service sale | $12.000") siga entera en al
// menos uno de los dos chunks. Sin solapado, esa respuesta se perdía.
const TAM_CHUNK = 1500;
const SOLAPE_CHUNK = 200;

// NVIDIA acepta varios textos por pedido. De a 32 anda bien y baja muchísimo
// la cantidad de llamadas (un PDF de 6 páginas son ~14 chunks = 1 sola llamada).
const LOTE_EMBEDDINGS = 32;

// Dimensión del vector. El modelo puede devolver más; nos quedamos con las
// primeras 1024 y RENORMALIZAMOS, porque cortar un vector normalizado lo deja
// sin norma 1 y el coseno daría cualquier cosa.
const DIMENSIONES = 1024;

// Firestore admite hasta 500 escrituras por batch, pero cada chunk lleva 1024
// floats y el pedido tiene un tope de tamaño. De a 80 nunca lo rozamos.
const CHUNKS_POR_LOTE = 80;
const BORRADOS_POR_LOTE = 400;

// Plan free: 200 items PROCESADOS por workspace. Se controla acá y no al crear
// el item, porque crear no pasa por el backend.
const TOPE_ITEMS_PLAN_FREE = 200;

// ============================================================================
//  MULTER: el archivo se guarda EN MEMORIA, nunca en disco.
//  Motivo: el disco de Render free es efímero y encima no queremos que un PDF
//  privado quede tirado en el filesystem del servidor. Lo leemos, sacamos el
//  texto y el buffer se muere cuando termina el request.
// ============================================================================
const subidor = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TOPE_DURO_BYTES, files: 1, fields: 4 },
});

// Envolvemos multer a mano para traducir SUS errores a NUESTRA forma de error.
// Si no, un archivo grande devolvía un HTML de Express y el cliente mostraba
// una pantalla roja en vez de "El archivo no puede pesar más de 10 MB".
function recibirArchivo(req, res, next) {
  subidor.single('archivo')(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new ErrorApi('ARCHIVO_MUY_GRANDE', `el tope del servidor es de ${TOPE_DURO_MB} MB`));
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        return next(new ErrorApi('DATOS_INVALIDOS', "la única parte permitida del multipart se llama 'archivo'"));
      }
      return next(new ErrorApi('DATOS_INVALIDOS', 'el multipart llegó mal armado'));
    }
    return next(err);
  });
}

// ============================================================================
//  AYUDANTES CHICOS
// ============================================================================

function refItem(wsId, itemId) {
  return db.collection('workspaces').doc(wsId).collection('items').doc(itemId);
}

// El feed de auditoría del admin. Va en su propio try/catch y NUNCA rompe el
// flujo principal: si no se pudo anotar el evento, el item igual se procesó.
// Que falle el log no puede hacer fallar el trabajo.
async function anotarEvento(wsId, { tipo, actorUid, resumen, itemId = null }) {
  try {
    await db.collection('workspaces').doc(wsId).collection('eventos').add({
      tipo,
      actorUid,
      resumen,
      itemId,
      creadoEn: FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error(`[eventos] no se pudo escribir '${tipo}' en ${wsId}:`, err);
  }
}

// ¿Está colgado un item en 'procesando'? Miramos actualizadoEn (y si por algún
// motivo no está, creadoEn). Si no hay ninguna marca de tiempo lo damos por
// colgado: preferimos dejar reintentar de más que dejar un item muerto.
function estaColgado(item) {
  if (item.estado !== 'procesando') return false;
  const marca = item.actualizadoEn ?? item.creadoEn;
  if (!marca || typeof marca.toMillis !== 'function') return true;
  return Date.now() - marca.toMillis() > MS_COLGADO;
}

// ¿El que llama puede tocar este item? Solo el AUTOR o un admin del workspace.
// SIN esto, cualquier miembro le pega /procesar al item de otro y le adjunta
// SU archivo: el item queda con el título de uno y el contenido del otro.
function exigirAutorOAdmin(item, uid, esAdmin) {
  if (item.creadoPor !== uid && !esAdmin) {
    throw new ErrorApi('NO_SOS_EL_AUTOR');
  }
}

// ============================================================================
//  LÍMITES DEL PLAN
//  Se chequea ANTES de la transacción y antes de gastar un peso en IA.
// ============================================================================
//  contarItems: en /reprocesar va en false. Motivo: reprocesar no agrega un
//  item nuevo, y si el workspace está justo en el tope, bloquearlo dejaría al
//  equipo sin poder ni siquiera arreglar un item roto. El tope es para crecer,
//  no para castigar.
async function chequearLimitesDelPlan(wsId, { contarItems = true } = {}) {
  const snapWs = await db.collection('workspaces').doc(wsId).get();
  if (!snapWs.exists) throw new ErrorApi('WORKSPACE_NO_ENCONTRADO');
  const ws = snapWs.data();

  // Con la suscripción pausada o cancelada no se indexa más contenido nuevo.
  // Lo que ya está indexado se sigue pudiendo consultar: no le apagamos la luz
  // a nadie por un pago atrasado, solo dejamos de gastar créditos de IA.
  if (ws.planStatus === 'pausada' || ws.planStatus === 'cancelada') {
    throw new ErrorApi('LIMITE_PLAN', `la suscripción está ${ws.planStatus}`);
  }

  if (!contarItems) return;
  if (ws.plan !== 'free') return; // el plan pago no tiene tope de items

  // count() es una consulta de AGREGACIÓN: Firestore devuelve el número sin
  // traernos los 200 documentos. Cuesta muchísimo menos que un .get() entero.
  const conteo = await db
    .collection('workspaces').doc(wsId).collection('items')
    .where('estado', '==', 'listo')
    .count().get();

  if (conteo.data().count >= TOPE_ITEMS_PLAN_FREE) {
    throw new ErrorApi('LIMITE_PLAN', `el plan gratuito permite ${TOPE_ITEMS_PLAN_FREE} items indexados`);
  }
}

// ============================================================================
//  LA TRANSACCIÓN. Este es el pedazo de código más importante del archivo.
//
//  El problema real: en la demo alguien toca "Subir" dos veces. Llegan dos
//  requests casi juntos. Sin transacción, los dos leen 'pendiente', los dos
//  dicen "puedo", y el archivo se procesa DOS VECES: el doble de créditos de
//  NVIDIA, el doble de OCR y dos tandas de chunks pisándose.
//
//  Con runTransaction(), leer el estado y escribir 'procesando' son UN SOLO
//  paso atómico. El segundo request lee un 'procesando' recién puesto y se va
//  con PROCESO_EN_CURSO 409. Recién DESPUÉS de que esto termina bien se empieza
//  a gastar plata.
// ============================================================================
async function tomarElItem({ wsId, itemId, uid, esAdmin, aceptaListo }) {
  const ref = refItem(wsId, itemId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ErrorApi('ITEM_NO_ENCONTRADO');

    const item = snap.data();

    // El campo workspaceId del doc tiene que coincidir con el wsId del path.
    // Si no coincide, alguien está apuntando a un item de otro equipo: se
    // responde NO_ES_MIEMBRO a propósito, para no confirmar que ese item existe.
    if (item.workspaceId !== wsId) throw new ErrorApi('NO_ES_MIEMBRO');

    // El chequeo de autor va TAMBIÉN acá adentro, aunque ya lo hicimos afuera:
    // entre las dos lecturas alguien pudo cambiar el item. Es una lectura que
    // ya estábamos haciendo igual, así que no cuesta nada.
    exigirAutorOAdmin(item, uid, esAdmin);

    const colgado = estaColgado(item);
    const estado = item.estado;

    if (estado === 'procesando' && !colgado) {
      // ESTE es el doble tap. Tiene código propio para que el cliente pueda
      // mostrar "esperá" en vez de "error".
      throw new ErrorApi('PROCESO_EN_CURSO');
    }

    const procesable =
      estado === 'pendiente' ||
      estado === 'error' ||
      colgado ||
      (estado === 'listo' && aceptaListo);

    if (!procesable) {
      // El caso típico: /procesar sobre un item que ya está 'listo'. Para eso
      // está /reprocesar; no reindexamos por accidente algo que ya funciona.
      throw new ErrorApi('ESTADO_INVALIDO', `el item está en estado '${estado}'`);
    }

    tx.update(ref, {
      estado: 'procesando',
      errorMsg: null,
      actualizadoEn: FieldValue.serverTimestamp(),
    });

    return item; // devolvemos el item TAL COMO ESTABA, para usarlo abajo
  });
}

// ============================================================================
//  EXTRACCIÓN DEL TEXTO, SEGÚN EL TIPO.
//
//  Devuelve siempre la misma forma:
//    { bloques: [{ pagina, texto }], paginas: number|null, origen: string }
//
//  Los "bloques" son pedazos con página conocida (una página del PDF = un
//  bloque). Sirven para poder citar "pág. 3" de verdad. Si la cascada de
//  extracción no nos da bloques (OCR de una foto, texto de un link), armamos
//  uno solo con pagina null.
// ============================================================================
async function extraerElTexto({ item, archivo }) {
  // --- NOTA: el texto ya está en el documento, lo escribió la persona ---------
  if (item.tipo === 'nota') {
    const texto = normalizarTexto(item.textoOriginal ?? '');
    if (!texto.trim()) throw new ErrorApi('NO_SE_PUDO_EXTRAER_TEXTO', 'la nota está vacía');
    return { bloques: [{ pagina: null, texto }], paginas: null, origen: 'nota' };
  }

  // --- LINK: se lee la url DEL DOCUMENTO, nunca una que venga en el body -----
  // Toda la validación anti-SSRF (esquema, IPs privadas, redirects, tamaño,
  // Content-Type) vive adentro de traerTextoDeUrl y tira URL_NO_PERMITIDA.
  if (item.tipo === 'link') {
    if (!item.url) throw new ErrorApi('ESTADO_INVALIDO', 'el item es un link pero no tiene url guardada');
    const r = await traerTextoDeUrl(item.url);
    const texto = normalizarTexto(r?.texto ?? '');
    if (!texto.trim()) throw new ErrorApi('NO_SE_PUDO_EXTRAER_TEXTO', 'la página no tenía texto');
    return { bloques: [{ pagina: null, texto }], paginas: null, origen: 'link' };
  }

  // --- PDF y FOTO -----------------------------------------------------------
  // Si vino archivo, va a la cascada de extracción.
  // Si NO vino (o sea, es un /reprocesar), reusamos el texto que ya habíamos
  // extraído. El archivo NO se guarda en ningún lado: Firebase Storage está
  // descartado porque pide tarjeta. Por eso un pdf sin texto guardado NO se
  // puede reprocesar y hay que volver a elegir el archivo.
  if (item.tipo === 'pdf' || item.tipo === 'foto') {
    if (!archivo) {
      const guardado = normalizarTexto(item.texto ?? '');
      if (!guardado.trim()) {
        throw new ErrorApi('ESTADO_INVALIDO', 'no hay texto guardado y el archivo no se conserva en el servidor');
      }
      return {
        bloques: [{ pagina: null, texto: guardado }],
        paginas: item.paginas ?? null,
        origen: item.origen ?? (item.tipo === 'pdf' ? 'pdf-texto' : 'ocr-space'),
      };
    }

    const r = item.tipo === 'pdf'
      ? await extraerTextoDePdf(archivo.buffer)              // unpdf y, si viene vacío, OCR.space
      : await extraerTextoDeImagen(archivo.buffer, archivo.mimetype); // OCR.space directo

    // La cascada puede devolvernos bloques por página (lo ideal) o solo el
    // texto entero. Aceptamos las dos formas para no acoplarnos de más.
    const bloques = Array.isArray(r?.bloques) && r.bloques.length > 0
      ? r.bloques.map((b) => ({ pagina: b.pagina ?? null, texto: normalizarTexto(b.texto ?? '') }))
      : [{ pagina: null, texto: normalizarTexto(r?.texto ?? '') }];

    const hayTexto = bloques.some((b) => b.texto.trim().length > 0);
    if (!hayTexto) throw new ErrorApi('NO_SE_PUDO_EXTRAER_TEXTO');

    return { bloques, paginas: r?.paginas ?? null, origen: r?.origen ?? 'ocr-space' };
  }

  throw new ErrorApi('DATOS_INVALIDOS', `tipo de item desconocido: '${item.tipo}'`);
}

// ============================================================================
//  ARMADO DEL TEXTO + MAPA DE PÁGINAS
//
//  Pegamos todos los bloques en un solo string y anotamos en qué posición
//  arranca cada página. Después, cuando troceamos, miramos en qué posición
//  arranca cada chunk y sabemos de qué página salió. Es la forma más simple de
//  poder decir "pág. 3" sin trocear página por página (que dejaría chunks
//  ridículamente cortos en las páginas con dos líneas).
// ============================================================================
function pegarBloques(bloques) {
  let texto = '';
  const marcas = []; // [{ desde, pagina }]

  for (const b of bloques) {
    if (!b.texto || !b.texto.trim()) continue;
    if (texto.length > 0) texto += '\n\n';
    marcas.push({ desde: texto.length, pagina: b.pagina });
    texto += b.texto;
  }
  return { texto, marcas };
}

function paginaDeLaPosicion(marcas, posicion) {
  let pagina = null;
  for (const m of marcas) {
    if (m.desde <= posicion) pagina = m.pagina;
    else break;
  }
  return pagina;
}

// ============================================================================
//  TROCEADO
//  Cortamos de a TAM_CHUNK caracteres avanzando (TAM_CHUNK - SOLAPE_CHUNK), así
//  cada trozo repite el final del anterior. Devolvemos también la posición de
//  arranque para poder averiguar la página.
// ============================================================================
function trocear(texto) {
  const trozos = [];
  const paso = TAM_CHUNK - SOLAPE_CHUNK;

  for (let desde = 0; desde < texto.length; desde += paso) {
    const pedazo = texto.slice(desde, desde + TAM_CHUNK).trim();
    // Un trozo de 5 caracteres (basura del OCR, un pie de página suelto) no
    // aporta nada y encima cuesta un embedding. Lo tiramos.
    if (pedazo.length >= 30) trozos.push({ desde, texto: pedazo });
    if (desde + TAM_CHUNK >= texto.length) break;
  }

  // Caso borde real: una nota cortita ("Reunión el lunes 9 hs") mide menos de
  // 30 caracteres y el filtro de arriba la tiraba entera, dejando el item en
  // error. Si no quedó ningún trozo pero SÍ hay texto, va todo como un chunk.
  if (trozos.length === 0 && texto.trim().length > 0) {
    trozos.push({ desde: 0, texto: texto.trim() });
  }
  return trozos;
}

// ============================================================================
//  VECTORES
//  Recortamos a 1024 dimensiones y renormalizamos a norma 1. Renormalizar es
//  obligatorio DESPUÉS de recortar: un vector normalizado al que le sacás
//  dimensiones deja de tener norma 1, y el coseno daría valores torcidos.
// ============================================================================
function recortarYNormalizar(vector) {
  const v = vector.slice(0, DIMENSIONES);
  let suma = 0;
  for (const x of v) suma += x * x;
  const norma = Math.sqrt(suma);
  if (norma === 0) return v; // vector nulo: no se puede normalizar, lo dejamos
  return v.map((x) => x / norma);
}

// ============================================================================
//  BORRAR LOS CHUNKS DE UN ITEM (en lotes, porque pueden ser cientos)
//
//  Se llama SIEMPRE antes de reindexar. Es obligatorio: si el intento anterior
//  escribió 9 chunks y este escribe 7, sin el borrado previo sobrevivirían el
//  chunk 8 y el 9 con texto VIEJO, y la IA podría citar algo que ya no existe
//  en el documento. Ese fue un bug real de la v1.
// ============================================================================
async function borrarChunksDelItem(itemId) {
  let borrados = 0;

  while (true) {
    const snap = await db.collection('chunks')
      .where('itemId', '==', itemId)
      .limit(BORRADOS_POR_LOTE)
      .get();

    if (snap.empty) break;

    const lote = db.batch();
    snap.docs.forEach((d) => lote.delete(d.ref));
    await lote.commit();

    borrados += snap.size;
    if (snap.size < BORRADOS_POR_LOTE) break;
  }
  return borrados;
}

// ============================================================================
//  EL TRABAJO PESADO, EN SEGUNDO PLANO.
//
//  Ojo con esto en la defensa: el endpoint ya respondió 202 cuando esta función
//  arranca. Un PDF escaneado de 20 páginas puede tardar minutos en OCR.space, y
//  si lo hiciéramos adentro del request, el proxy de Render nos cortaría la
//  conexión a los ~100 segundos y el cliente vería un error aunque el trabajo
//  hubiera salido bien.
//
//  Como el cliente escucha el documento con un StreamBuilder, ve el progreso en
//  tiempo real: procesando -> listo | error. La fuente de verdad es Firestore,
//  no la respuesta HTTP.
//
//  Cada paso tiene su try/catch y traduce lo que pasó a un mensaje LEGIBLE.
//  Nunca, jamás, un stack trace en errorMsg: eso lo lee una persona.
// ============================================================================
async function trabajarEnSegundoPlano({ wsId, itemId, uid, item, archivo }) {
  const arranque = Date.now();
  const ref = refItem(wsId, itemId);

  try {
    // ---- PASO 1: sacar el texto ------------------------------------------
    let extraido;
    try {
      extraido = await extraerElTexto({ item, archivo });
    } catch (err) {
      throw comoErrorApi(err, 'NO_SE_PUDO_EXTRAER_TEXTO');
    }

    // ---- PASO 2: pegar los bloques y recortar -----------------------------
    const { texto: textoCompleto, marcas } = pegarBloques(extraido.bloques);
    const caracteres = textoCompleto.length; // largo REAL, antes de recortar
    const recortado = caracteres > TOPE_TEXTO_CARACTERES;
    const texto = recortado ? textoCompleto.slice(0, TOPE_TEXTO_CARACTERES) : textoCompleto;

    if (!texto.trim()) throw new ErrorApi('NO_SE_PUDO_EXTRAER_TEXTO');

    // ---- PASO 3: borrar los chunks viejos ---------------------------------
    let chunksBorrados = 0;
    try {
      chunksBorrados = await borrarChunksDelItem(itemId);
    } catch (err) {
      throw comoErrorApi(err, 'ERROR_INTERNO', 'No pudimos limpiar la versión anterior. Probá de nuevo.');
    }

    // ---- PASO 4: trocear ---------------------------------------------------
    const trozos = trocear(texto);
    if (trozos.length === 0) {
      throw new ErrorApi('NO_SE_PUDO_EXTRAER_TEXTO', 'el texto extraído era demasiado corto');
    }

    // ---- PASO 5: embeddings, de a lotes -----------------------------------
    // input_type 'passage' porque estamos INDEXANDO. Al preguntar se usa
    // 'query'. Es asimétrico y OBLIGATORIO: el modelo entrena los dos lados
    // distinto, y mezclarlos baja la similitud de las respuestas correctas.
    const vectores = [];
    try {
      for (let i = 0; i < trozos.length; i += LOTE_EMBEDDINGS) {
        const lote = trozos.slice(i, i + LOTE_EMBEDDINGS).map((t) => t.texto);
        const respuesta = await embeber(lote, 'passage');
        for (const v of respuesta) vectores.push(recortarYNormalizar(v));
      }
    } catch (err) {
      throw comoErrorApi(err, 'IA_NO_RESPONDE');
    }

    if (vectores.length !== trozos.length) {
      throw new ErrorApi('IA_NO_RESPONDE', 'la IA devolvió menos vectores que trozos');
    }

    // ---- PASO 6: escribir los chunks --------------------------------------
    // El id es DETERMINÍSTICO: itemId_idx. Así reprocesar pisa exactamente los
    // mismos documentos en vez de duplicarlos, y el borrado del paso 3 es lo
    // único que hace falta para que no queden sobras.
    try {
      for (let i = 0; i < trozos.length; i += CHUNKS_POR_LOTE) {
        const lote = db.batch();

        trozos.slice(i, i + CHUNKS_POR_LOTE).forEach((trozo, j) => {
          const idx = i + j;
          const chunkRef = db.collection('chunks').doc(`${itemId}_${idx}`);

          lote.set(chunkRef, {
            workspaceId: wsId,
            itemId,
            titulo: item.titulo ?? '(sin título)',
            idx,
            pagina: paginaDeLaPosicion(marcas, trozo.desde),
            origen: extraido.origen,
            texto: trozo.texto,
            embedding: vectores[idx],
            // COPIA de los permisos del item. Es la SEGUNDA cerradura del
            // filtro de privacidad (defensa en profundidad). Puede quedar
            // vieja hasta el próximo reproceso, por eso NUNCA es la que manda:
            // en /preguntar se aplica con AND junto a la lectura en vivo de los
            // items, así una copia vieja solo puede esconder de más.
            visibilidad: item.visibilidad,
            creadoPor: item.creadoPor,
            creadoEn: FieldValue.serverTimestamp(),
          });
        });

        await lote.commit();
      }
    } catch (err) {
      throw comoErrorApi(err, 'ERROR_INTERNO', 'No pudimos guardar el contenido indexado. Probá de nuevo.');
    }

    // ---- PASO 7: el item queda 'listo' ------------------------------------
    await ref.update({
      estado: 'listo',
      texto,
      cantChunks: trozos.length,
      paginas: extraido.paginas,
      origen: extraido.origen,
      caracteres,
      recortado,
      errorMsg: null,
      actualizadoEn: FieldValue.serverTimestamp(),
    });

    await anotarEvento(wsId, {
      tipo: 'item.listo',
      actorUid: uid,
      itemId,
      resumen: `Se indexó "${item.titulo}" (${trozos.length} fragmentos)`,
    });

    console.log(`[items] ${itemId} listo en ${Date.now() - arranque} ms · ${trozos.length} chunks · borrados ${chunksBorrados}`);
  } catch (err) {
    // ---- CUALQUIER FALLA CAE ACÁ -----------------------------------------
    // El item NO puede quedar en 'procesando' para siempre: eso deja al usuario
    // mirando un spinner eterno y sin botón para reintentar.
    const mensaje = err instanceof ErrorApi
      ? err.mensaje
      : 'Algo salió mal procesando este contenido. Tocá Reintentar.';

    // El stack completo va al log de Render, NUNCA al documento ni al cliente:
    // trae rutas del servidor y a veces pedazos de configuración.
    console.error(`[items] ${itemId} falló:`, err);

    try {
      await ref.update({
        estado: 'error',
        errorMsg: mensaje,
        cantChunks: 0,
        actualizadoEn: FieldValue.serverTimestamp(),
      });
      await anotarEvento(wsId, {
        tipo: 'item.error',
        actorUid: uid,
        itemId,
        resumen: `Falló "${item.titulo}": ${mensaje}`,
      });
    } catch (err2) {
      console.error(`[items] ${itemId}: tampoco se pudo marcar el error:`, err2);
    }
  }
}

// Traduce un error cualquiera a un ErrorApi. Si ya venía siendo uno (por
// ejemplo URL_NO_PERMITIDA o SIN_CREDITOS_IA que tiran las librerías), lo
// dejamos pasar tal cual, porque su mensaje ya está escrito para la persona.
function comoErrorApi(err, codigoPorDefecto, mensajeAMano = null) {
  if (err instanceof ErrorApi) return err;
  const e = new ErrorApi(codigoPorDefecto);
  if (mensajeAMano) e.mensaje = mensajeAMano;
  return e;
}

// ============================================================================
//  POST /:itemId/procesar   (multipart)
// ============================================================================
router.post('/:itemId/procesar', exigirToken, exigirMiembro, recibirArchivo, async (req, res) => {
  const { wsId, itemId } = req.params;
  const { uid } = req.auth;
  const esAdmin = req.miembro.rol === 'admin';
  const archivo = req.file ?? null;

  // --- Leemos el item ANTES de la transacción para poder validar el archivo
  //     contra el TIPO del item. Es una lectura de más, pero permite rechazar
  //     un archivo equivocado sin haber tocado el estado del documento.
  const snap = await refItem(wsId, itemId).get();
  if (!snap.exists) throw new ErrorApi('ITEM_NO_ENCONTRADO');
  const itemPrevio = snap.data();
  if (itemPrevio.workspaceId !== wsId) throw new ErrorApi('NO_ES_MIEMBRO');

  // EL CHEQUEO QUE MÁS IMPORTA: solo el autor o un admin.
  exigirAutorOAdmin(itemPrevio, uid, esAdmin);

  // --- Validación del archivo según el tipo del item ---------------------
  const necesitaArchivo = itemPrevio.tipo === 'pdf' || itemPrevio.tipo === 'foto';

  if (necesitaArchivo && !archivo) throw new ErrorApi('ARCHIVO_FALTANTE');

  if (archivo) {
    if (!necesitaArchivo) {
      throw new ErrorApi('DATOS_INVALIDOS', `un item de tipo '${itemPrevio.tipo}' no lleva archivo`);
    }
    if (archivo.size > TOPE_ARCHIVO_BYTES) {
      const mb = (archivo.size / 1024 / 1024).toFixed(1);
      throw new ErrorApi('ARCHIVO_MUY_GRANDE', `el archivo pesa ${mb} MB`);
    }
    if (!TIPOS_MIME_OK.includes(archivo.mimetype)) {
      throw new ErrorApi('TIPO_NO_SOPORTADO', `llegó un archivo ${archivo.mimetype}`);
    }
    // Que el archivo case con el tipo declarado en el item: un item 'pdf' con
    // un JPG adentro dejaría el doc mintiendo sobre su propio contenido.
    const esPdf = archivo.mimetype === 'application/pdf';
    if (itemPrevio.tipo === 'pdf' && !esPdf) {
      throw new ErrorApi('TIPO_NO_SOPORTADO', 'el item es un PDF pero llegó una imagen');
    }
    if (itemPrevio.tipo === 'foto' && esPdf) {
      throw new ErrorApi('TIPO_NO_SOPORTADO', 'el item es una foto pero llegó un PDF');
    }
  }

  // --- Límites del plan, antes de gastar un peso -------------------------
  await chequearLimitesDelPlan(wsId);

  // --- LA TRANSACCIÓN: acá se corta el doble tap -------------------------
  // /procesar NO acepta 'listo': para reindexar algo que ya funciona está
  // /reprocesar. Así nadie borra un índice bueno por tocar el botón de más.
  const item = await tomarElItem({ wsId, itemId, uid, esAdmin, aceptaListo: false });

  // --- Respondemos YA. El trabajo pesado sigue solo. ---------------------
  res.status(202).json({
    ok: true,
    item: { itemId, estado: 'procesando' },
    aviso: 'Lo estamos procesando. Mirá el item: cuando pase a "listo" ya se puede preguntar.',
  });

  // Sin await a propósito: el request ya terminó. El .catch() final es una red
  // de seguridad para que una promesa rechazada no tire el proceso de Node.
  trabajarEnSegundoPlano({ wsId, itemId, uid, item, archivo })
    .catch((err) => console.error(`[items] ${itemId} rompió el segundo plano:`, err));
});

// ============================================================================
//  POST /:itemId/reprocesar   (sin archivo)
//
//  Reintentar SIN volver a subir nada, usando lo que ya está en el documento.
//  Casos de uso: el botón "Reintentar" de un item en error, y el "Volver a
//  indexar" después de editar el textoOriginal de una nota.
// ============================================================================
router.post('/:itemId/reprocesar', exigirToken, exigirMiembro, async (req, res) => {
  const { wsId, itemId } = req.params;
  const { uid } = req.auth;
  const esAdmin = req.miembro.rol === 'admin';

  const snap = await refItem(wsId, itemId).get();
  if (!snap.exists) throw new ErrorApi('ITEM_NO_ENCONTRADO');
  const itemPrevio = snap.data();
  if (itemPrevio.workspaceId !== wsId) throw new ErrorApi('NO_ES_MIEMBRO');

  exigirAutorOAdmin(itemPrevio, uid, esAdmin);

  // --- ¿Hay de dónde sacar el texto? --------------------------------------
  // Esta es la ÚNICA diferencia de fondo con /procesar. Como el archivo no se
  // guarda en ningún lado, un pdf o una foto sin texto ya extraído no se pueden
  // reprocesar: hay que elegir el archivo de nuevo y llamar a /procesar.
  const hayFuente =
    (itemPrevio.tipo === 'nota' && (itemPrevio.textoOriginal ?? '').trim().length > 0) ||
    (itemPrevio.tipo === 'link' && (itemPrevio.url ?? '').trim().length > 0) ||
    ((itemPrevio.tipo === 'pdf' || itemPrevio.tipo === 'foto') && (itemPrevio.texto ?? '').trim().length > 0);

  if (!hayFuente) {
    throw new ErrorApi('ESTADO_INVALIDO', 'no hay texto guardado para reprocesar: volvé a subir el archivo');
  }

  await chequearLimitesDelPlan(wsId, { contarItems: false });

  // aceptaListo: true — a propósito. "Edité la nota y quiero que la IA la
  // vuelva a leer" es justamente el caso de reprocesar un item ya 'listo'.
  const item = await tomarElItem({ wsId, itemId, uid, esAdmin, aceptaListo: true });

  res.status(202).json({
    ok: true,
    item: { itemId, estado: 'procesando' },
    aviso: 'Lo estamos volviendo a indexar. En unos segundos vuelve a "listo".',
  });

  trabajarEnSegundoPlano({ wsId, itemId, uid, item, archivo: null })
    .catch((err) => console.error(`[items] ${itemId} rompió el segundo plano:`, err));
});

// ============================================================================
//  DELETE /:itemId
//
//  El único camino para borrar de verdad. En las reglas de Firestore el item
//  tiene 'allow delete: if false', así que el cliente NO puede borrarlo solo.
//
//  Por qué existe este endpoint: antes el cliente borraba el item directo y los
//  chunks quedaban vivos en la colección plana /chunks. El texto de una nota
//  privada seguía en la base, sin ningún item al cual preguntarle los permisos,
//  y la IA lo podía seguir citando. La persona creía que lo había borrado y no.
//
//  EL ORDEN IMPORTA: primero los chunks, después el item. Si el proceso se corta
//  en el medio quedan chunks de un item que TODAVÍA existe (inofensivo: se
//  limpia reintentando), y nunca chunks huérfanos de un item que ya no está.
//  Este endpoint SÍ es sincrónico: borrar es rápido y la persona quiere ver que
//  pasó de verdad.
// ============================================================================
router.delete('/:itemId', exigirToken, exigirMiembro, async (req, res) => {
  const { wsId, itemId } = req.params;
  const { uid } = req.auth;
  const esAdmin = req.miembro.rol === 'admin';

  const snap = await refItem(wsId, itemId).get();
  if (!snap.exists) throw new ErrorApi('ITEM_NO_ENCONTRADO');
  const item = snap.data();
  if (item.workspaceId !== wsId) throw new ErrorApi('NO_ES_MIEMBRO');

  // Para borrar, el contrato usa ACCION_NO_PERMITIDA (no NO_SOS_EL_AUTOR).
  if (item.creadoPor !== uid && !esAdmin) {
    throw new ErrorApi('ACCION_NO_PERMITIDA', 'solo el autor o un administrador pueden borrar este item');
  }

  const chunksBorrados = await borrarChunksDelItem(itemId); // PRIMERO los chunks
  await refItem(wsId, itemId).delete();                     // DESPUÉS el item

  await anotarEvento(wsId, {
    tipo: 'item.eliminado',
    actorUid: uid,
    itemId,
    resumen: `Se borró "${item.titulo}" (${chunksBorrados} fragmentos)`,
  });

  res.status(200).json({
    ok: true,
    borrado: { itemId, titulo: item.titulo, chunksBorrados },
  });
});

export default router;
