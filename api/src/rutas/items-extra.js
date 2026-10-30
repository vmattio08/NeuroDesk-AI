// ============================================================================
//  NeuroDesk AI — api/src/rutas/items-extra.js
//  EL CANDADO EN VIVO: cambiar la visibilidad de un item ya cargado.
//
//    PATCH /v1/workspaces/:wsId/items/:itemId/visibilidad
//    body { visibilidad: 'equipo' | 'privado' }
//
//  Se monta en server.js con el mismo prefijo que items.js:
//      app.use('/v1/workspaces/:wsId/items', rutasDeItemsExtra);
//  Va en un archivo aparte para no mezclar esta ruta con las pesadas de
//  items.js (procesar, reprocesar, borrar), que no cambian.
//
//  POR QUE TIENE QUE PASAR POR EL SERVIDOR (y no alcanza con que la app
//  cambie el campo del item): cada chunk guarda una COPIA de la visibilidad
//  del item, y buscar.js la usa como segunda cerradura, con AND. Si se cambia
//  solo el item a 'equipo', la copia de los chunks sigue diciendo 'privado' y
//  la IA le sigue escondiendo la nota a los companeros: la demo falla en vivo
//  sin ningun error. Aca se cambian las dos cosas y queda anotado quien lo hizo.
//
//  NO SE REPROCESA NADA: el texto y los vectores de los chunks son los mismos.
//  Solo cambia el campo 'visibilidad' de cada uno. Desde la pregunta siguiente
//  el filtro de buscar.js (que lee los permisos EN VIVO en cada pregunta) ya
//  deja pasar (o frena) esos fragmentos.
//
//  QUIEN PUEDE QUE (contrato A):
//    - pasar a 'equipo' (compartir) ...... SOLO el autor del item. Ni el admin
//      puede publicar lo privado de otra persona.
//    - pasar a 'privado' (cerrar) ........ el autor o un admin.
//    - otro miembro ...................... 403 NO_SOS_EL_AUTOR.
//    - un item privado ajeno que el que pide no puede ver: 404
//      ITEM_NO_ENCONTRADO, el MISMO que si no existiera (no le confirmamos a
//      nadie que existe una nota privada de otro con ese id).
//    - item en 'procesando' .............. 409 PROCESO_EN_CURSO.
//    - si ya tiene esa visibilidad ....... 200 sin cambios ni evento.
//
//  EL ORDEN DE LAS ESCRITURAS: "primero cerrar, ultimo abrir". El item y sus
//  chunks (pueden ser cientos) se escriben en pasos separados, asi que el
//  orden decide que se ve en el medio:
//    - ABRIR (a 'equipo'): primero los chunks y despues el item. Mientras
//      tanto el item sigue 'privado' y la cerradura en vivo de buscar.js lo
//      sigue escondiendo.
//    - CERRAR (a 'privado'): primero el item y despues los chunks. Desde el
//      primer paso la cerradura en vivo ya lo esconde.
//  En los dos casos, si el proceso se corta a la mitad, lo peor que pasa es
//  que la IA esconda DE MAS. Nunca que muestre de mas.
// ============================================================================

import { Router } from 'express';

import { db, FieldValue } from '../firebase.js';
import { ErrorApi } from '../errores.js';
import { requireAuth, exigirMiembro } from '../middleware/auth.js';

// mergeParams: true, igual que items.js: el :wsId esta en la ruta de montaje.
export const rutasDeItemsExtra = Router({ mergeParams: true });

// Los dos valores del modelo. La comparacion es EXACTA: sin trim, sin
// toLowerCase y sin default. Un "Equipo" mal tipeado o un body vacio no puede
// caer en un valor por omision y abrir (o cerrar) algo que nadie pidio.
const VISIBILIDADES = new Set(['equipo', 'privado']);

// Un update no lleva datos (solo un campo de texto): 400 por lote deja aire
// debajo del techo de 500 operaciones de Firestore, como en items.js.
const ESCRITURAS_POR_LOTE = 400;

// Cuantas veces se vuelve a intentar copiar la visibilidad si un chunk
// desaparecio entre la consulta y la escritura (ver copiarALosChunks).
const MAX_CHOQUES = 3;

// ============================================================================
//  AYUDANTES (los mismos de items.js, copiados a proposito: ese archivo no
//  exporta nada mas que su router y no queremos tocarlo por esta ruta)
// ============================================================================

function refItem(wsId, itemId) {
  return db.collection('workspaces').doc(wsId).collection('items').doc(itemId);
}

function tituloDe(item) {
  return item?.titulo || '(sin título)';
}

// Quien hizo algo, para el resumen del feed. Sale del doc members (que ya leyo
// exigirMiembro) o del token: nunca del body.
function quienHizo(req) {
  return req.miembro?.nombre || req.usuario?.email || 'Alguien';
}

// El feed de auditoria del admin. Nunca rompe el flujo principal: si no se
// pudo anotar el evento, el cambio de visibilidad igual quedo hecho.
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

// exigirMiembro con la respuesta del contrato para un workspace inexistente
// (NO_ES_MIEMBRO, nunca un 404 que diga que wsId existen). Es el mismo
// envoltorio que usan las rutas de items.js.
function exigirMiembroSegunContrato(req, res, next) {
  exigirMiembro(req, res, (err) => {
    if (err && err.codigo === 'WORKSPACE_NO_ENCONTRADO') return next(new ErrorApi('NO_ES_MIEMBRO'));
    return next(err);
  });
}

// ============================================================================
//  LOS CHEQUEOS, en el orden del contrato y por el mismo motivo que en
//  items.js: existe -> es de este workspace -> lo podes ver -> te toca a vos
//  -> no se esta procesando. Quien no puede ver el item no se entera ni de si
//  existe; quien lo ve pero no es el dueno no se entera de en que estado esta.
//  Se usa dos veces: antes de tocar nada y adentro de la transaccion.
// ============================================================================
function validarElPedido(snap, { wsId, uid, esAdmin, nueva }) {
  if (!snap.exists) throw new ErrorApi('ITEM_NO_ENCONTRADO');
  const item = snap.data();

  // Igual que el DELETE de items.js: un item cuyo campo workspaceId no es el
  // del path esta apuntando a otro equipo. NO_ES_MIEMBRO, sin confirmar nada.
  if (item.workspaceId !== wsId) throw new ErrorApi('NO_ES_MIEMBRO');

  const esAutor = item.creadoPor === uid;

  // Si lo puede ver: las mismas tres condiciones que la regla de lectura de
  // Firestore. Un item sin 'visibilidad' (roto, cargado a mano) cuenta como
  // privado: fail-closed, nunca se vuelve publico por omision.
  const loPuedeVer = esAutor || esAdmin || item.visibilidad === 'equipo';
  if (!loPuedeVer) throw new ErrorApi('ITEM_NO_ENCONTRADO');

  // Si le toca: abrir es solo del autor. El admin puede ver lo privado de
  // todos, pero no publicarlo por ellos. Cerrar lo pueden el autor o un admin
  // (por ejemplo, si alguien subio al equipo algo que no tenia que subir).
  if (nueva === 'equipo' && !esAutor) {
    throw new ErrorApi('NO_SOS_EL_AUTOR', 'Solo quien lo cargó lo puede compartir con el equipo.');
  }
  if (nueva === 'privado' && !esAutor && !esAdmin) {
    throw new ErrorApi('NO_SOS_EL_AUTOR');
  }

  // Mientras se procesa, el candado no se toca. El procesamiento lee la
  // visibilidad del item al EMPEZAR y se la copia a cada chunk nuevo al
  // TERMINAR: un cambio en el medio quedaria pisado por la copia vieja.
  // Va para cualquier 'procesando', aunque este colgado: el barrido de
  // server.js lo pasa a 'error' y ahi se puede volver a pedir.
  if (item.estado === 'procesando') throw new ErrorApi('PROCESO_EN_CURSO');

  return item;
}

// ============================================================================
//  EL ITEM, EN UNA TRANSACCION
//
//  Leer, volver a chequear y escribir son UN solo paso. Si justo alguien toco
//  "Reintentar" y /procesar paso el item a 'procesando' (tambien con una
//  transaccion sobre este mismo documento), Firestore ordena las dos: o este
//  cambio entra antes y el procesamiento ya copia la visibilidad nueva, o el
//  procesamiento entra antes y aca se ve 'procesando' y se corta con 409.
//
//  Devuelve { item, cambio }: cambio = false si ya tenia esa visibilidad.
// ============================================================================
async function cambiarElItem(ref, contexto) {
  return db.runTransaction(async (tx) => {
    const item = validarElPedido(await tx.get(ref), contexto);
    if (item.visibilidad === contexto.nueva) return { item, cambio: false };

    tx.update(ref, {
      visibilidad: contexto.nueva,
      actualizadoEn: FieldValue.serverTimestamp(),
    });
    return { item, cambio: true };
  });
}

// ============================================================================
//  LA COPIA DE LOS CHUNKS
//
//  Pone 'visibilidad' en TODOS los chunks del item que son de ESTE workspace.
//  - Solo los de este workspace: la coleccion chunks es plana y un itemId solo
//    es unico ADENTRO de su workspace (el cliente elige el id). Sin el filtro,
//    alguien de otro equipo con un item del mismo id nos haria abrir o cerrar
//    SUS fragmentos. Los ajenos no se tocan: se cuentan para el log.
//  - Solo los que tienen OTRA visibilidad: asi volver a mandar el mismo pedido
//    no gasta escrituras, y si un intento anterior se corto a la mitad, este
//    termina el trabajo.
//  - .select() trae dos campos y no los 1024 numeros del vector de cada chunk.
//  - Si un chunk desaparece entre la consulta y la escritura (lo borro un
//    DELETE o un reproceso en ese mismo momento), el lote entero falla con
//    NOT_FOUND: se vuelve a consultar y se sigue con lo que haya.
// ============================================================================
async function copiarUnaVez(wsId, itemId, visibilidad) {
  const snap = await db.collection('chunks').where('itemId', '==', itemId).select('workspaceId', 'visibilidad').get();

  const aCambiar = [];
  let ajenos = 0;
  for (const doc of snap.docs) {
    if (doc.get('workspaceId') !== wsId) {
      ajenos += 1;
      continue;
    }
    if (doc.get('visibilidad') !== visibilidad) aCambiar.push(doc.ref);
  }

  for (let i = 0; i < aCambiar.length; i += ESCRITURAS_POR_LOTE) {
    const lote = db.batch();
    // update() y no set(): si el chunk ya no existe, que falle, en vez de
    // resucitarlo como un documento a medias con un solo campo.
    for (const ref of aCambiar.slice(i, i + ESCRITURAS_POR_LOTE)) lote.update(ref, { visibilidad });
    await lote.commit();
  }

  if (ajenos > 0) {
    console.error(`[items] SEGURIDAD: ${ajenos} chunk(s) de OTRO workspace comparten itemId con ${itemId} de ${wsId}. No se tocaron.`);
  }
  return { total: snap.size - ajenos, cambiados: aCambiar.length };
}

async function copiarALosChunks(wsId, itemId, visibilidad) {
  for (let intento = 1; ; intento++) {
    try {
      return await copiarUnaVez(wsId, itemId, visibilidad);
    } catch (err) {
      // 5 = NOT_FOUND: el choque de arriba.
      if (err?.code === 5 && intento < MAX_CHOQUES) {
        console.warn(`[items] ${itemId}: un chunk cambio mientras copiabamos la visibilidad, vuelvo a consultar (${intento})`);
        continue;
      }
      throw err;
    }
  }
}

// ============================================================================
//  PATCH /:itemId/visibilidad
// ============================================================================
rutasDeItemsExtra.patch('/:itemId/visibilidad', requireAuth, exigirMiembroSegunContrato, async (req, res) => {
  const { wsId, itemId } = req.params; // de la RUTA, nunca del body
  const { uid } = req.usuario;         // del token verificado
  const nueva = req.body?.visibilidad;

  // ---- 1. El body, antes de leer nada de Firestore ----------------------
  if (typeof nueva !== 'string' || !VISIBILIDADES.has(nueva)) {
    throw new ErrorApi('DATOS_INVALIDOS', "La visibilidad solo puede ser 'equipo' o 'privado'.");
  }

  const ref = refItem(wsId, itemId);
  const contexto = { wsId, uid, esAdmin: req.esAdmin === true, nueva };
  let resultado;
  let chunks;

  if (nueva === 'equipo') {
    // ---- 2a. ABRIR: primero los chunks, despues el item ------------------
    // Chequeo previo, sin escribir: si el pedido no corresponde (no existe,
    // no es tuyo, se esta procesando), no se toca ni un chunk.
    const antes = validarElPedido(await ref.get(), contexto);
    chunks = await copiarALosChunks(wsId, itemId, 'equipo');
    try {
      resultado = await cambiarElItem(ref, contexto);
    } catch (err) {
      // El ultimo paso fallo (justo empezo un reproceso, lo borraron, se
      // corto la red): los chunks que acabamos de abrir vuelven a cerrarse.
      // Ante la duda, esconder de mas. Si esto tambien falla, igual queda
      // tapado por la cerradura en vivo, porque el item sigue privado.
      if (antes.visibilidad !== 'equipo') {
        await copiarALosChunks(wsId, itemId, 'privado').catch((otro) =>
          console.error(`[items] ${itemId}: no se pudieron volver a cerrar los chunks:`, otro));
      }
      throw err;
    }
  } else {
    // ---- 2b. CERRAR: primero el item, despues los chunks -----------------
    resultado = await cambiarElItem(ref, contexto);
  }

  // ---- 3. El evento, apenas cambio el item -------------------------------
  // Va ANTES de copiar los chunks del cierre a proposito: desde que el item
  // dice 'privado' el cambio ya es un hecho (la cerradura en vivo lo frena).
  // Si la copia de los chunks fallara despues, el feed igual lo cuenta, y el
  // reintento (que ya no cambia el item) solo termina de copiar.
  const { item, cambio } = resultado;
  if (cambio) {
    const quien = quienHizo(req);
    await anotarEvento(wsId, {
      tipo: 'item.visibilidad',
      actorUid: uid,
      itemId,
      resumen: nueva === 'equipo'
        ? `${quien} compartió «${tituloDe(item)}» con el equipo`
        : `${quien} pasó «${tituloDe(item)}» a privado`,
    });
  }

  if (nueva === 'privado') {
    // Tambien corre si el item ya era privado ("sin cambios"): si un intento
    // anterior se corto antes de esta copia, o alguien cambio la visibilidad
    // directo en Firestore, aca se emparejan los chunks. Sin evento.
    chunks = await copiarALosChunks(wsId, itemId, 'privado');
  }

  // Al log van ids y numeros, nunca el titulo: puede ser de una nota privada.
  console.log(`[items] ${itemId}: visibilidad ${cambio ? `${item.visibilidad ?? '(sin valor)'} -> ${nueva}` : `sin cambios (${nueva})`} · ${chunks.cambiados} de ${chunks.total} chunks actualizados`);

  return res.status(200).json({ ok: true, visibilidad: nueva });
});
