// ============================================================================
//  NeuroDesk AI — api/src/rutas/items.js
//  LAS RUTAS PESADAS DE LOS ITEMS (endpoints 7, 8, 9 y 10 del contrato)
//
//  Se monta así en server.js (el wsId sale del path, NUNCA del body):
//      import { rutasDeItems } from './rutas/items.js';
//      app.use('/v1/workspaces/:wsId/items', rutasDeItems);
//
//  Endpoints (las rutas de acá adentro son relativas a ese montaje):
//    POST   /:itemId/procesar     multipart, el archivo viene en la parte 'archivo'
//    POST   /:itemId/reprocesar   sin archivo, usa lo que ya está guardado en el doc
//    DELETE /:itemId              borra los chunks y después el item
//    DELETE /?estado=pendiente&antesDe=<ISO>   limpieza masiva, solo admin
//
//  LA REGLA DE ORO DE TODO EL PROYECTO:
//  el item YA EXISTE cuando llega este pedido. Lo creó el CLIENTE, directo
//  contra Firestore, en estado 'pendiente'. Por eso la fila aparece al instante
//  en el panel aunque Render esté dormido. El BACKEND NUNCA CREA UN ITEM:
//  solo lo mueve pendiente -> procesando -> listo | error.
//
//  POR QUÉ /procesar Y /reprocesar CONTESTAN RECIÉN CUANDO TERMINAN (200):
//  el contrato pide que la respuesta traiga el resultado real (cantChunks,
//  origen, tardoMs) y que, si algo falla, el HTTP devuelva EL MISMO error que
//  quedó escrito en errorMsg. Las dos cosas solo se pueden cumplir esperando.
//  La app corta a los 90 s (nota N7 del contrato); si corta, el trabajo sigue
//  igual acá —Express no frena el handler porque el cliente se haya ido— y la
//  pantalla se entera por el listener del documento, que es la fuente de verdad
//  de la UI. La respuesta HTTP es una confirmación, no la verdad.
// ============================================================================

import { Router } from 'express';
import multer from 'multer';

import { db, FieldValue, Timestamp } from '../firebase.js';
import { ErrorApi, esErrorApi } from '../errores.js';
import { requireAuth, exigirMiembro, exigirAdmin } from '../middleware/auth.js';
import { extraerDeArchivo } from '../servicios/extraer.js';
import { traerTextoDeUrl } from '../servicios/link.js';
import {
  limpiarTexto,
  recortarTexto,
  trocear,
  caracteresUtiles,
  quitarMarcasDePagina,
  TOPE_TEXTO_ITEM,
} from '../servicios/texto.js';
import { pedirEmbeddings } from '../servicios/ia.js';

// mergeParams: true es OBLIGATORIO. Sin eso, req.params.wsId llega undefined
// porque el :wsId está en la ruta donde montamos el router, no acá adentro.
export const rutasDeItems = Router({ mergeParams: true });

// ============================================================================
//  NÚMEROS DEL SISTEMA. Todos juntos y con nombre, para no dejar magia suelta
//  en el medio del código y para poder cambiarlos en un solo lugar.
// ============================================================================

// Tope del archivo: 10 MB, el mismo número del contrato (ARCHIVO_MUY_GRANDE) y
// el mismo que valida el cliente antes de subir para no gastar los datos del
// celular. Lo aplica multer MIENTRAS recibe: si el archivo se pasa, corta la
// subida y ni siquiera junta el buffer entero en memoria (Render free tiene
// 512 MB y un archivo gigante nos mata el proceso entero).
const TOPE_ARCHIVO_MB = 10;
const TOPE_ARCHIVO_BYTES = TOPE_ARCHIVO_MB * 1024 * 1024;

const TIPOS_MIME_OK = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

// Un item en 'procesando' con más de 5 minutos sin cambios está COLGADO
// (se reinició Render en el medio). Lo dejamos volver a procesar, si no
// quedaría muerto para siempre y el botón "Reintentar" no serviría de nada.
const MINUTOS_PARA_CONSIDERARLO_COLGADO = 5;
const MS_COLGADO = MINUTOS_PARA_CONSIDERARLO_COLGADO * 60 * 1000;

// Troceado: ~1500 caracteres con 200 de solapado, como dice el contrato. El
// solapado existe para que una frase partida al medio ("el service sale |
// $12.000") siga entera en al menos uno de los dos chunks. Sin solapado, esa
// respuesta se perdía.
// OJO: estos dos números se le pasan A MANO a trocear(). Si se lo llama sin
// opciones, el servicio usa 1600 de tamaño y el solape termina valiendo NaN
// (Number(undefined) ?? 200 da NaN, no 200), o sea que corta SIN solapar.
const TAM_CHUNK = 1500;
const SOLAPE_CHUNK = 200;

// Firestore admite hasta 500 escrituras por batch, pero cada chunk lleva 1024
// floats (~10 KB) y el pedido tiene un tope de tamaño. De a 80 nunca lo rozamos.
const CHUNKS_POR_LOTE = 80;

// Para BORRAR sí podemos ir de a muchos (un delete no lleva datos): 400, como
// pide el contrato, deja aire debajo del techo de 500 operaciones por batch.
const BORRADOS_POR_LOTE = 400;

// La limpieza masiva busca los chunks de varios items juntos con un 'in'. El
// contrato fija grupos de 10 ids por consulta.
const IDS_POR_CONSULTA_IN = 10;

// Plan free: 200 items PROCESADOS por workspace. Se controla acá y no al crear
// el item, porque crear no pasa por el backend.
const TOPE_ITEMS_PLAN_FREE = 200;

// Con la suscripción pausada o cancelada no se indexa contenido nuevo. Lo que
// ya está indexado se sigue pudiendo consultar: no le apagamos la luz a nadie
// por un pago atrasado, solo dejamos de gastar créditos de IA.
const ESTADOS_DE_PLAN_QUE_NO_INDEXAN = new Set(['pausada', 'cancelada']);

// Cuando Google nos frena (429 después de sus 3 reintentos), el contrato pide
// mandar Retry-After. 30 s alcanzan para que se libere el cupo por minuto.
const SEGUNDOS_PARA_REINTENTAR = 30;

// SIEMPRE el mismo texto, sin importar cuál de los chequeos anti-SSRF falló.
// Si dijéramos "resolvió a 10.0.0.5", cualquier miembro usaría nuestro backend
// como escáner de la red interna de Render. El motivo exacto va solo al log.
const DETALLE_URL_NO_PERMITIDA = 'la dirección no es pública';

// El enum CERRADO de 'origen' del modelo de datos. Un valor fuera de esta lista
// rompe el switch del cliente, así que nunca se escribe otro.
const ORIGENES_DEL_MODELO = new Set(['nota', 'pdf-texto', 'ocr-space', 'link']);

// Cuántas veces reintenta la limpieza masiva un lote que chocó con alguien que
// justo tocó uno de esos items (ver el DELETE masivo, abajo de todo).
const MAX_CHOQUES_EN_PURGA = 3;

// ============================================================================
//  MULTER: el archivo se guarda EN MEMORIA, nunca en disco.
//  Motivo: el disco de Render free es efímero y encima no queremos que un PDF
//  privado quede tirado en el filesystem del servidor. Lo leemos, sacamos el
//  texto y el buffer se muere cuando termina el request.
// ============================================================================
const subidor = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: TOPE_ARCHIVO_BYTES,
    files: 1,       // el contrato: 'archivo' es la ÚNICA parte con binario
    fields: 5,      // campos de texto sueltos se ignoran, pero no infinitos
    fieldSize: 1024,
    parts: 6,
  },
});

// Envolvemos multer a mano para traducir SUS errores a NUESTRA forma de error.
// Si no, un archivo grande devolvía un HTML de Express y el cliente mostraba
// una pantalla roja en vez de "El archivo no puede pesar más de 10 MB".
// Cualquier otro problema del multipart (parte con otro nombre, dos archivos,
// subida cortada a la mitad) se responde ARCHIVO_FALTANTE: en todos esos casos
// lo que pasó, visto desde la persona, es que el archivo no llegó bien. Y es un
// código de la lista del endpoint 7; DATOS_INVALIDOS no lo es.
//
// Va DESPUÉS de requireAuth y exigirMiembro a propósito: alguien sin token o de
// otro equipo no llega a ocuparnos 10 MB de memoria con su subida.
function recibirArchivo(req, res, next) {
  subidor.single('archivo')(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(new ErrorApi('ARCHIVO_MUY_GRANDE', `el archivo supera los ${TOPE_ARCHIVO_MB} MB`));
    }
    console.warn('[items] multipart rechazado:', err.code || err.message);
    return next(new ErrorApi('ARCHIVO_FALTANTE', "el multipart tiene que traer una sola parte, llamada 'archivo'"));
  });
}

// ============================================================================
//  AYUDANTES CHICOS
// ============================================================================

function refItem(wsId, itemId) {
  return db.collection('workspaces').doc(wsId).collection('items').doc(itemId);
}

function tituloDe(item) {
  return item?.titulo || '(sin título)';
}

// Quién hizo algo, para el resumen del feed. Sale del doc members (que ya leyó
// exigirMiembro) o del token: nunca del body.
function quienHizo(req) {
  return req.miembro?.nombre || req.usuario?.email || 'Alguien';
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
// SU archivo: el item queda con el título de uno y el contenido del otro, y
// los chunks se indexan con la autoría y la visibilidad de la víctima.
function exigirAutorOAdmin(item, uid, esAdmin) {
  if (item.creadoPor !== uid && !esAdmin) {
    throw new ErrorApi('NO_SOS_EL_AUTOR');
  }
}

// exigirMiembro, pero con la respuesta que pide el contrato cuando el
// workspace no existe. El middleware tira WORKSPACE_NO_ENCONTRADO (404), un
// código que el contrato v3 dio de baja: para un wsId inexistente hay que
// responder NO_ES_MIEMBRO (403). Además, contestar distinto según exista o no
// le deja a cualquiera averiguar qué wsId existen probando al azar.
function exigirMiembroSegunContrato(req, res, next) {
  exigirMiembro(req, res, (err) => {
    if (err && err.codigo === 'WORKSPACE_NO_ENCONTRADO') return next(new ErrorApi('NO_ES_MIEMBRO'));
    return next(err);
  });
}

// ============================================================================
//  TRADUCCIÓN DE ERRORES AL CONTRATO
//
//  Los servicios (extraer, link, ia) tiran errores con la forma
//  { codigo, mensaje, http, detalle }. El codigo es del catálogo, pero el
//  detalle a veces trae cosas que el contrato NO deja mandarle al cliente:
//    - URL_NO_PERMITIDA trae el motivo exacto ("apunta a 10.0.0.0/8").
//    - ERROR_INTERNO trae cosas como "Falta OCR_SPACE_API_KEY en el entorno".
//    - Los de Google/OCR nombran al proveedor y cuentan HTTP internos.
//  Acá se arma el ErrorApi que de verdad viaja. El detalle original no se
//  pierde: se loguea en Render antes de llegar acá.
// ============================================================================

// Códigos donde el detalle del servicio habla del ARCHIVO o la PÁGINA de la
// persona ("el PDF viene encriptado") y no de nuestra infraestructura.
const CODIGOS_QUE_CONSERVAN_DETALLE = new Set([
  'NO_SE_PUDO_EXTRAER_TEXTO',
  'ARCHIVO_FALTANTE',
  'ARCHIVO_MUY_GRANDE',
  'TIPO_NO_SOPORTADO',
]);

function alContrato(err) {
  // Cualquier cosa que no sea nuestra (un error de firebase-admin, un bug) es
  // ERROR_INTERNO con detalle null, hardcodeado. Nunca err.message.
  if (!esErrorApi(err)) return new ErrorApi('ERROR_INTERNO');
  if (err.codigo === 'ERROR_INTERNO') return new ErrorApi('ERROR_INTERNO');
  if (err.codigo === 'URL_NO_PERMITIDA') return new ErrorApi('URL_NO_PERMITIDA', DETALLE_URL_NO_PERMITIDA);

  // Los ErrorApi que tiramos en este archivo ya traen un detalle escrito acá.
  if (err instanceof ErrorApi) return err;

  const detalle = CODIGOS_QUE_CONSERVAN_DETALLE.has(err.codigo) ? (err.detalle ?? null) : null;
  return new ErrorApi(err.codigo, detalle);
}

// El contrato pide Retry-After en DEMASIADOS_PEDIDOS. El middleware final no lo
// pone, así que lo agregamos acá antes de dejar seguir el error.
async function avisandoCuandoReintentar(res, trabajo) {
  try {
    return await trabajo();
  } catch (err) {
    if (err?.codigo === 'DEMASIADOS_PEDIDOS' && !res.headersSent) {
      res.setHeader('Retry-After', String(SEGUNDOS_PARA_REINTENTAR));
    }
    throw err;
  }
}

// ============================================================================
//  VALIDACIÓN DEL ARCHIVO
// ============================================================================

// El tipo REAL del archivo, mirando sus primeros bytes ("números mágicos").
// No le creemos al Content-Type de la parte: lo escribe el cliente y puede
// decir cualquier cosa. Además la app Flutter arma la parte con
// MultipartFile.fromPath sin contentType, y eso la manda como
// application/octet-stream: si solo miráramos el mimetype declarado,
// rechazaríamos TODOS los archivos que sube la app.
function tipoRealDelArchivo(buffer) {
  if (!buffer || buffer.length < 4) return null;
  // Las imágenes primero: su firma está SIEMPRE en el byte 0 y es exacta.
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  // La norma de PDF permite basura antes del encabezado: lo buscamos en el
  // primer KB y no solo en el byte 0.
  if (buffer.subarray(0, 1024).indexOf('%PDF-') !== -1) return 'application/pdf';
  return null;
}

// Valida el archivo contra el TIPO del item y devuelve el mimetype con el que
// hay que extraerlo (o null si el item no lleva archivo).
// Corre ADENTRO de la transacción, después del chequeo de autoría: así un
// archivo equivocado se rechaza sin haber tocado el estado del documento, y
// nadie se entera de qué tipo es el item de otro.
function validarArchivoDelItem(item, archivo) {
  const llevaArchivo = item.tipo === 'pdf' || item.tipo === 'foto';

  // Nota y link: el backend lee todo del documento. Si igual vino un archivo,
  // se ignora (el contrato no tiene un error para eso).
  if (!llevaArchivo) return null;

  if (!archivo || !archivo.buffer || archivo.buffer.length === 0) {
    throw new ErrorApi('ARCHIVO_FALTANTE');
  }

  let declarado = String(archivo.mimetype || '').toLowerCase();
  if (declarado === 'image/jpg') declarado = 'image/jpeg'; // el alias que mandan algunos celulares
  const generico = declarado === '' || declarado === 'application/octet-stream';
  const real = tipoRealDelArchivo(archivo.buffer);

  // Las dos condiciones del contrato: lo declarado (si declara algo concreto)
  // y lo que el archivo ES tienen que estar en la lista. Si declara png y en
  // realidad es un jpg, los dos están permitidos y se extrae según lo REAL.
  // El detalle NO repite lo que declaró el cliente: es texto que no escribimos
  // nosotros, y el contrato no deja eco de datos ajenos en 'detalle'.
  if (!generico && !TIPOS_MIME_OK.includes(declarado)) {
    throw new ErrorApi('TIPO_NO_SOPORTADO', 'el archivo no es PDF, JPG, PNG ni WEBP');
  }
  if (!real) {
    throw new ErrorApi('TIPO_NO_SOPORTADO', 'el contenido del archivo no es PDF, JPG, PNG ni WEBP');
  }

  // Que el archivo case con el tipo declarado en el item: un item 'pdf' con
  // un JPG adentro dejaría el doc mintiendo sobre su propio contenido.
  if (item.tipo === 'pdf' && real !== 'application/pdf') {
    throw new ErrorApi('TIPO_NO_SOPORTADO', 'el item es un PDF pero llegó una imagen');
  }
  if (item.tipo === 'foto' && real === 'application/pdf') {
    throw new ErrorApi('TIPO_NO_SOPORTADO', 'el item es una foto pero llegó un PDF');
  }
  return real;
}

// ============================================================================
//  LÍMITES DEL PLAN (solo /procesar: el contrato no le pone LIMITE_PLAN a
//  /reprocesar, que no agrega nada nuevo; si el workspace está justo en el
//  tope, bloquearlo dejaría al equipo sin poder ni arreglar un item roto).
// ============================================================================

// count() es una consulta de AGREGACIÓN: Firestore devuelve el número sin
// traernos los 200 documentos. Cuesta muchísimo menos que un .get() entero.
// Va ANTES de la transacción porque una agregación no se lee con tx.get().
async function contarItemsListos(wsId, workspace) {
  if ((workspace?.plan || 'free') !== 'free') return 0; // el plan pago no tiene tope
  const conteo = await db
    .collection('workspaces').doc(wsId).collection('items')
    .where('estado', '==', 'listo')
    .count().get();
  return conteo.data().count;
}

// Corre adentro de la transacción, ya con el item en la mano.
// req.workspace lo leyó exigirMiembro: no gastamos otra lectura.
function exigirCupoDelPlan(workspace, item, listos) {
  if (ESTADOS_DE_PLAN_QUE_NO_INDEXAN.has(workspace?.planStatus)) {
    throw new ErrorApi('LIMITE_PLAN', `la suscripción está ${workspace.planStatus}`);
  }
  // Un item que YA está 'listo' no suma uno nuevo al volver a subirlo: ya está
  // contado adentro de 'listos'. Bloquearlo sería castigar una corrección.
  const sumaUnoNuevo = item.estado !== 'listo';
  if ((workspace?.plan || 'free') === 'free' && sumaUnoNuevo && listos >= TOPE_ITEMS_PLAN_FREE) {
    throw new ErrorApi('LIMITE_PLAN', `el plan gratuito permite ${TOPE_ITEMS_PLAN_FREE} items indexados`);
  }
}

// /reprocesar de un pdf o una foto necesita el texto ya extraído: el archivo no
// se guarda en ningún lado (Storage está descartado porque pide tarjeta). Ese,
// y solo ese, es el caso de ESTADO_INVALIDO.
function exigirTextoGuardadoSiEsArchivo(item) {
  const esArchivo = item.tipo === 'pdf' || item.tipo === 'foto';
  if (esArchivo && caracteresUtiles(quitarMarcasDePagina(item.texto ?? '')) === 0) {
    throw new ErrorApi('ESTADO_INVALIDO', 'no hay texto guardado y el archivo no se conserva en el servidor: hay que volver a elegirlo');
  }
}

// ============================================================================
//  LA TRANSACCIÓN. Este es el pedazo de código más importante del archivo.
//
//  El problema real: en la demo alguien toca "Subir" dos veces. Llegan dos
//  requests casi juntos. Sin transacción, los dos leen 'pendiente', los dos
//  dicen "puedo", y el archivo se procesa DOS VECES: el doble de créditos de
//  la IA, el doble de OCR y dos tandas de chunks pisándose.
//
//  Con runTransaction(), leer el estado y escribir 'procesando' son UN SOLO
//  paso atómico. El segundo request lee un 'procesando' recién puesto y se va
//  con PROCESO_EN_CURSO 409. Recién DESPUÉS de que esto termina bien se empieza
//  a gastar plata.
//
//  El orden de los chequeos es el del contrato y no es casual: existe ->
//  es de este workspace -> sos el autor o admin -> no está corriendo. La
//  autoría va ANTES de mirar el estado, así nadie averigua en qué estado está
//  el item de otro. 'validar' corre al final, con el item ya autorizado.
//
//  Si algo tira adentro del callback, Firestore hace rollback y no escribe
//  nada: el item queda exactamente como estaba.
// ============================================================================
async function tomarElItem({ wsId, itemId, uid, esAdmin, validar }) {
  const ref = refItem(wsId, itemId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ErrorApi('ITEM_NO_ENCONTRADO');

    const item = snap.data();

    // El campo workspaceId del doc tiene que coincidir con el wsId del path.
    // Si no coincide, alguien está apuntando a un item de otro equipo: se
    // responde NO_ES_MIEMBRO a propósito, para no confirmar que ese item existe.
    if (item.workspaceId !== wsId) throw new ErrorApi('NO_ES_MIEMBRO');

    exigirAutorOAdmin(item, uid, esAdmin);

    if (item.estado === 'procesando' && !estaColgado(item)) {
      // ESTE es el doble tap. Tiene código propio para que el cliente pueda
      // mostrar "esperá" en vez de "error".
      throw new ErrorApi('PROCESO_EN_CURSO');
    }

    // Estados que se aceptan: 'pendiente', 'error', 'listo' (volver a subir el
    // archivo o volver a indexar una nota editada es legítimo) y 'procesando'
    // colgado. O sea: todo menos un 'procesando' fresco, que ya cortamos arriba.
    const validado = validar ? validar(item) : null;

    // Invariante 8: actualizadoEn va EN LA MISMA transacción que 'procesando'.
    // Sin esa marca, el barrido de colgados no lo encuentra nunca.
    tx.update(ref, {
      estado: 'procesando',
      errorMsg: null,
      actualizadoEn: FieldValue.serverTimestamp(),
    });

    return { item, validado }; // el item TAL COMO ESTABA, para usarlo abajo
  });
}

// ============================================================================
//  EL TEXTO A GUARDAR, SEGÚN EL TIPO.
//
//  Todas las funciones de abajo devuelven la misma forma, que es exactamente
//  lo que después se escribe en el item:
//    { texto, paginas, origen, caracteres, recortado }
//
//  SOBRE LAS MARCAS <<<PAGINA:n>>> (decisión a propósito, hay que saber
//  defenderla): extraer.js pega las páginas del PDF con esas marcas, y
//  trocear() las usa para saber de qué página sale cada chunk ("pág. 3").
//  En item.texto guardamos el texto CON las marcas, por dos motivos:
//    1. item.texto es "lo único que se trocea" (invariante 2): lo guardado y
//       lo indexado son el mismo string, no dos que se pueden desincronizar.
//    2. /reprocesar vuelve a trocear item.texto. Si lo guardáramos limpio, un
//       PDF reprocesado perdería todas sus citas de página y cambiaría su
//       cantidad de chunks. Con las marcas, reprocesar diez veces da lo mismo.
//  Ninguna pantalla muestra item.texto, así que las marcas no las ve nadie.
//  'caracteres', en cambio, se cuenta SIN marcas: es el largo real del texto.
// ============================================================================

function armarTextoParaGuardar(textoLimpio, { paginas, origen, caracteres, recortado }) {
  const sinMarcas = quitarMarcasDePagina(textoLimpio);
  if (caracteresUtiles(sinMarcas) === 0) throw new ErrorApi('NO_SE_PUDO_EXTRAER_TEXTO');

  // Un doc de Firestore no puede pasar de 1 MiB: recortamos a TOPE_TEXTO_ITEM
  // (300.000) y marcamos recortado:true para que el panel avise en vez de
  // mentir. Se indexa lo recortado, que es lo que queda guardado.
  const recorte = recortarTexto(textoLimpio, TOPE_TEXTO_ITEM);
  // Si el corte cayó en el medio de una marca ("<<<PAGI"), la sacamos: si no,
  // queda como basura al final del último chunk.
  const texto = recorte.recortado
    ? recorte.texto.replace(/\n?<<<[PAGINA:\d>]*$/, '').trimEnd()
    : recorte.texto;

  return {
    texto,
    paginas: paginas ?? null, // null EXPLÍCITO: firebase.js no ignora undefined
    origen,
    caracteres: caracteres ?? sinMarcas.length, // largo REAL, antes de recortar
    recortado: recortado ?? recorte.recortado,
  };
}

// extraer.js puede devolver 'ocr-tesseract' (el OCR local de último recurso),
// que NO está en el enum del modelo. Manda el modelo: en el modelo 'ocr-space'
// quiere decir "el texto salió de un OCR", y eso es verdad. Cuál de los dos
// fue queda en el log de Render.
function origenDelModelo(origen, tipo) {
  if (ORIGENES_DEL_MODELO.has(origen)) return origen;
  if (origen === 'ocr-tesseract') return 'ocr-space';
  if (tipo === 'pdf') return 'pdf-texto';
  if (tipo === 'foto') return 'ocr-space';
  return tipo; // 'nota' | 'link'
}

// --- NOTA: el texto ya está en el documento, lo escribió la persona --------
// quitarMarcasDePagina también acá: si alguien escribe "<<<PAGINA:9>>>" en
// su nota, no queremos que trocear() se lo crea y cite una "pág. 9" falsa.
function textoDeNota(item) {
  const texto = quitarMarcasDePagina(limpiarTexto(item.textoOriginal ?? ''));
  if (caracteresUtiles(texto) === 0) throw new ErrorApi('NO_SE_PUDO_EXTRAER_TEXTO', 'la nota está vacía');
  return armarTextoParaGuardar(texto, { paginas: null, origen: 'nota' });
}

// --- LINK: se lee la url DEL DOCUMENTO, nunca una que venga en el body -----
// Toda la validación anti-SSRF (esquema, puerto, IPs privadas resueltas por
// DNS, redirects revalidados, timeout, tope de 2 MB, Content-Type) vive
// adentro de traerTextoDeUrl y tira URL_NO_PERMITIDA. Se corre OTRA VEZ en
// cada reproceso, porque la página (y adónde apunta) pudo cambiar.
async function textoDeLink(item) {
  const r = await traerTextoDeUrl(item.url ?? '');
  const texto = quitarMarcasDePagina(limpiarTexto(r.texto));
  return armarTextoParaGuardar(texto, { paginas: null, origen: 'link' });
}

// --- PDF y FOTO con archivo: la cascada de extraer.js ----------------------
// pdf -> pdf-parse y, solo para las hojas vacías, OCR.space; foto -> OCR.space
// y, si falla, tesseract local. Ya devuelve el texto limpio y con marcas.
async function textoDeArchivo(item, archivo, tipoMime) {
  const r = await extraerDeArchivo({
    buffer: archivo.buffer,
    tipoMime,
    nombreArchivo: item.nombreArchivo || archivo.originalname || undefined,
  });
  if (r.origen !== origenDelModelo(r.origen, item.tipo)) {
    console.log(`[items] origen '${r.origen}' se guarda como '${origenDelModelo(r.origen, item.tipo)}' (enum del modelo)`);
  }
  return armarTextoParaGuardar(limpiarTexto(r.texto), {
    // El modelo: 'paginas' es la cantidad de páginas del PDF y null para la foto.
    paginas: item.tipo === 'pdf' ? (r.paginas ?? null) : null,
    origen: origenDelModelo(r.origen, item.tipo),
  });
}

// --- PDF y FOTO sin archivo (/reprocesar): el texto que ya habíamos sacado --
// 'caracteres' y 'recortado' se conservan del doc: el texto guardado ya está
// recortado, y recalcularlos sobre él borraría el dato real ("el PDF tenía
// 800.000 caracteres") que el panel usa para avisar.
function textoYaExtraido(item) {
  return armarTextoParaGuardar(limpiarTexto(item.texto ?? ''), {
    paginas: item.tipo === 'pdf' ? (item.paginas ?? null) : null,
    origen: origenDelModelo(item.origen, item.tipo),
    caracteres: Number.isFinite(item.caracteres) ? item.caracteres : undefined,
    recortado: typeof item.recortado === 'boolean' ? item.recortado : undefined,
  });
}

function tipoDesconocido(item) {
  // Las reglas no dejan crear un tipo fuera del enum; si pasa, es un doc roto
  // (cargado a mano desde la consola) y es un problema nuestro, no de la persona.
  console.error(`[items] tipo de item desconocido: '${item.tipo}'`);
  return new ErrorApi('ERROR_INTERNO');
}

function textoParaProcesar(item, archivo, tipoMime) {
  switch (item.tipo) {
    case 'nota': return textoDeNota(item);
    case 'link': return textoDeLink(item);
    case 'pdf':
    case 'foto': return textoDeArchivo(item, archivo, tipoMime);
    default: throw tipoDesconocido(item);
  }
}

function textoParaReprocesar(item) {
  switch (item.tipo) {
    case 'nota': return textoDeNota(item);
    case 'link': return textoDeLink(item);
    case 'pdf':
    case 'foto': return textoYaExtraido(item);
    default: throw tipoDesconocido(item);
  }
}

// ============================================================================
//  BORRAR CHUNKS (en lotes, porque pueden ser cientos)
//
//  Se llama SIEMPRE antes de reindexar. Es obligatorio: si el intento anterior
//  escribió 9 chunks y este escribe 7, sin el borrado previo sobrevivirían el
//  chunk 8 y el 9 con texto VIEJO, y la IA podría citar algo que ya no existe
//  en el documento. Ese fue un bug real de la v1.
//
//  SOLO SE BORRAN LOS CHUNKS DE ESTE WORKSPACE. La colección chunks es plana y
//  su id es itemId_idx, pero un itemId solo es único ADENTRO de su workspace:
//  el cliente puede crear su item con el id que quiera. Sin este filtro, alguien
//  que conoce el itemId de un item de OTRO equipo crea uno con el mismo id en
//  el suyo y, al procesarlo o borrarlo, nos hace borrar los chunks del otro
//  equipo. Los ajenos no se tocan: se cuentan, para que indexar() se niegue.
//
//  .select('workspaceId') trae solo ese campo: para borrar no hace falta bajar
//  los 1024 floats de cada chunk. Y se pagina con startAfter porque los
//  ajenos no se borran: si volviéramos a pedir desde el principio, los
//  veríamos otra vez y el bucle no terminaría nunca.
// ============================================================================
async function borrarChunksDeLaConsulta(wsId, consulta) {
  let borrados = 0;
  let ajenos = 0;
  let ultimo = null;

  while (true) {
    let pagina = consulta.select('workspaceId').limit(BORRADOS_POR_LOTE);
    if (ultimo) pagina = pagina.startAfter(ultimo);
    const snap = await pagina.get();
    if (snap.empty) break;

    const lote = db.batch();
    let enEsteLote = 0;
    for (const doc of snap.docs) {
      if (doc.get('workspaceId') === wsId) {
        lote.delete(doc.ref);
        enEsteLote += 1;
      } else {
        ajenos += 1;
      }
    }
    if (enEsteLote > 0) await lote.commit();
    borrados += enEsteLote;

    if (snap.size < BORRADOS_POR_LOTE) break;
    ultimo = snap.docs[snap.docs.length - 1];
  }

  if (ajenos > 0) {
    console.error(`[items] SEGURIDAD: ${ajenos} chunk(s) de OTRO workspace comparten itemId con items de ${wsId}. No se tocaron.`);
  }
  return { borrados, ajenos };
}

function borrarChunksDelItem(wsId, itemId) {
  return borrarChunksDeLaConsulta(wsId, db.collection('chunks').where('itemId', '==', itemId));
}

// ============================================================================
//  indexar() — LA MISMA FUNCIÓN PARA /procesar Y /reprocesar
//  Pasos del contrato, en este orden: borrar los viejos -> trocear ->
//  embeber ('passage') -> escribir chunks/{itemId_idx}.
// ============================================================================
async function indexar({ wsId, itemId, item, texto, origen }) {
  // ---- 1. PRIMERO borrar los chunks viejos (invariante 5) -------------------
  const { borrados, ajenos } = await borrarChunksDelItem(wsId, itemId);
  if (ajenos > 0) {
    // Escribir itemId_idx PISARÍA los chunks del otro equipo. Cortamos antes de
    // gastar un peso en IA, con ERROR_INTERNO: un error más específico le
    // confirmaría al que está probando que ese itemId existe en otro lado.
    throw new ErrorApi('ERROR_INTERNO');
  }

  // ---- 2. Trocear -------------------------------------------------------------
  // trocear() respeta las marcas de página: cada chunk sabe de qué hoja salió.
  const trozos = trocear(texto, { tamano: TAM_CHUNK, solape: SOLAPE_CHUNK });
  if (trozos.length === 0) throw new ErrorApi('NO_SE_PUDO_EXTRAER_TEXTO', 'el texto extraído quedó vacío');

  // ---- 3. Embeddings ----------------------------------------------------------
  // input_type 'passage' porque estamos INDEXANDO. Al preguntar se usa
  // 'query'. Es asimétrico y OBLIGATORIO: el modelo entrena los dos lados
  // distinto, y mezclarlos baja la similitud de las respuestas correctas.
  // pedirEmbeddings ya hace los lotes de 32 con pausa, los reintentos, el orden
  // por 'index' y el recorte a 1024 dimensiones con renormalización L2: acá no
  // se repite nada de eso.
  const vectores = await pedirEmbeddings(trozos.map((t) => t.texto), 'passage');
  if (vectores.length !== trozos.length) {
    throw new ErrorApi('IA_NO_RESPONDE');
  }

  // ---- 4. Escribir los chunks -------------------------------------------------
  // El id es DETERMINÍSTICO: itemId_idx, idx desde 0 y sin huecos. Así
  // reprocesar nunca duplica: siempre son los mismos ids. Va con create() y no
  // con set(): como ya borramos los nuestros, si un id existe es de otro
  // workspace, y create() hace fallar el lote entero en vez de pisarlo.
  for (let i = 0; i < trozos.length; i += CHUNKS_POR_LOTE) {
    const lote = db.batch();
    for (const trozo of trozos.slice(i, i + CHUNKS_POR_LOTE)) {
      lote.create(db.collection('chunks').doc(`${itemId}_${trozo.idx}`), {
        workspaceId: wsId,
        itemId,
        titulo: tituloDe(item),
        idx: trozo.idx,
        // El modelo: página del PDF para citar "pág. 3"; null en notas, links
        // y fotos (una foto es "una página" para trocear, pero no tiene pág.).
        pagina: item.tipo === 'pdf' ? (trozo.pagina ?? null) : null,
        origen,
        texto: trozo.texto,
        embedding: vectores[trozo.idx],
        // COPIA de los permisos del item. Es la SEGUNDA cerradura del
        // filtro de privacidad (defensa en profundidad). Puede quedar
        // vieja hasta el próximo reproceso, por eso NUNCA es la que manda:
        // en /preguntar se aplica con AND junto a la lectura en vivo de los
        // items, así una copia vieja solo puede esconder de más.
        visibilidad: item.visibilidad,
        creadoPor: item.creadoPor,
        creadoEn: FieldValue.serverTimestamp(),
      });
    }
    await lote.commit();
  }

  return { cantChunks: trozos.length, chunksBorrados: borrados };
}

// ============================================================================
//  EL TRABAJO PESADO: sacar el texto, indexar y dejar el item 'listo'.
//
//  Cada falla, en cualquier paso, termina en dejarEnError() y recién después
//  se responde el error: así el HTTP y el errorMsg del documento dicen
//  LITERALMENTE lo mismo (el mensaje del catálogo). Nunca, jamás, un stack
//  trace en errorMsg: eso lo lee una persona.
// ============================================================================
async function procesarYDejarListo({ wsId, itemId, uid, quien, item, sacarTexto, verbo }) {
  const arranque = Date.now();
  const ref = refItem(wsId, itemId);
  let paso = 'extraer';
  let extraido = null;

  try {
    // ---- PASO 1: el texto, según el tipo ----------------------------------
    extraido = await sacarTexto();

    // ---- PASO 2: borrar viejos, trocear, embeber, escribir ----------------
    paso = 'indexar';
    const { cantChunks, chunksBorrados } = await indexar({
      wsId, itemId, item, texto: extraido.texto, origen: extraido.origen,
    });

    // ---- PASO 3: el item queda 'listo' ------------------------------------
    paso = 'guardar';
    const campos = {
      estado: 'listo',
      texto: extraido.texto,
      cantChunks,
      paginas: extraido.paginas,
      origen: extraido.origen,
      caracteres: extraido.caracteres,
      recortado: extraido.recortado,
      errorMsg: null,
      actualizadoEn: FieldValue.serverTimestamp(),
    };
    try {
      await ref.update(campos);
    } catch (err) {
      // 5 = NOT_FOUND: lo borraron (DELETE) mientras lo procesábamos. El catch
      // de abajo limpia los chunks que acabamos de escribir: no quedan huérfanos.
      if (err?.code === 5) throw new ErrorApi('ITEM_NO_ENCONTRADO');
      throw err;
    }

    await anotarEvento(wsId, {
      tipo: 'item.listo',
      actorUid: uid,
      itemId,
      resumen: `${quien} ${verbo} "${tituloDe(item)}" (${cantChunks} fragmentos)`,
    });

    console.log(`[items] ${itemId} listo en ${Date.now() - arranque} ms · ${cantChunks} chunks · borrados ${chunksBorrados}`);

    return {
      item: {
        itemId,
        estado: 'listo',
        cantChunks,
        origen: extraido.origen,
        paginas: extraido.paginas,
        caracteres: extraido.caracteres,
        recortado: extraido.recortado,
      },
      chunksBorrados,
    };
  } catch (err) {
    // El motivo COMPLETO (el detalle del servicio, el stack) va al log de
    // Render, NUNCA al documento ni al cliente: trae rutas del servidor y a
    // veces pedazos de configuración.
    console.error(`[items] ${itemId} falló en '${paso}':`, err?.codigo ?? '', err?.detalle ?? '', err);
    const errorApi = alContrato(err);
    await dejarEnError({ ref, wsId, itemId, uid, quien, item, errorApi, extraido });
    throw errorApi;
  }
}

// El item NO puede quedar en 'procesando' para siempre: eso deja al usuario
// mirando un spinner eterno y sin botón para reintentar.
async function dejarEnError({ ref, wsId, itemId, uid, quien, item, errorApi, extraido }) {
  // 1) Invariante 6: un item en 'error' tiene cantChunks == 0. Para que ese 0
  //    sea verdad hay que borrar sus chunks: los viejos (si ya estaba 'listo')
  //    y los nuevos que hayan llegado a escribirse antes de la falla. Si no,
  //    la IA seguiría citando un item que dice no tener contenido.
  try {
    await borrarChunksDelItem(wsId, itemId);
  } catch (err) {
    console.error(`[items] ${itemId}: no se pudieron limpiar los chunks después de la falla:`, err);
  }

  const campos = {
    estado: 'error',
    errorMsg: errorApi.mensajeParaLaPersona, // el MISMO texto que viaja por HTTP
    cantChunks: 0,
    actualizadoEn: FieldValue.serverTimestamp(),
  };
  // 2) Si el texto llegó a extraerse y lo que falló vino después (casi siempre
  //    la IA: sin créditos, caída, 429), lo guardamos igual. Así "Reintentar"
  //    funciona con /reprocesar SIN volver a subir el PDF ni gastar otra vez
  //    el cupo de OCR, que es justo el caso más común de la demo.
  if (extraido) {
    Object.assign(campos, {
      texto: extraido.texto,
      paginas: extraido.paginas,
      origen: extraido.origen,
      caracteres: extraido.caracteres,
      recortado: extraido.recortado,
    });
  }

  try {
    await ref.update(campos);
  } catch (err) {
    // Si el item ya no existe (lo borraron en el medio) no hay nada que marcar
    // ni evento que escribir sobre él.
    console.error(`[items] ${itemId}: tampoco se pudo marcar el error:`, err?.code ?? err);
    return;
  }

  await anotarEvento(wsId, {
    tipo: 'item.error',
    actorUid: uid,
    itemId,
    resumen: `Falló "${tituloDe(item)}" (${quien}): ${errorApi.mensajeParaLaPersona}`,
  });
}

// ============================================================================
//  POST /:itemId/procesar   (multipart)   — endpoint 7 del contrato
// ============================================================================
rutasDeItems.post('/:itemId/procesar', requireAuth, exigirMiembroSegunContrato, recibirArchivo, async (req, res) => {
  const arranque = Date.now();
  const { wsId, itemId } = req.params;
  const { uid } = req.usuario;
  const archivo = req.file ?? null;

  // Antes de la transacción solo lo que no se puede leer adentro (la agregación).
  const listos = await contarItemsListos(wsId, req.workspace);

  // --- LA TRANSACCIÓN: acá se corta el doble tap, y adentro de ella (con el
  //     item ya autorizado) se valida el archivo y el cupo del plan. Si algo de
  //     eso falla, el item queda como estaba: no se gastó nada.
  const { item, validado: tipoMime } = await tomarElItem({
    wsId,
    itemId,
    uid,
    esAdmin: req.esAdmin,
    validar: (it) => {
      const tipo = validarArchivoDelItem(it, archivo);
      exigirCupoDelPlan(req.workspace, it, listos);
      return tipo;
    },
  });

  if (archivo && !tipoMime) {
    console.warn(`[items] ${itemId} es '${item.tipo}': se ignora el archivo que vino en el multipart`);
  }

  // --- Recién ahora se gasta plata en IA. --------------------------------
  const resultado = await avisandoCuandoReintentar(res, () => procesarYDejarListo({
    wsId,
    itemId,
    uid,
    quien: quienHizo(req),
    item,
    verbo: 'subió',
    sacarTexto: () => textoParaProcesar(item, archivo, tipoMime),
  }));

  return res.status(200).json({
    ok: true,
    item: resultado.item,
    chunksBorrados: resultado.chunksBorrados,
    tardoMs: Date.now() - arranque,
  });
});

// ============================================================================
//  POST /:itemId/reprocesar   (sin archivo)   — endpoint 8 del contrato
//
//  Reintentar SIN volver a subir nada, usando lo que ya está en el documento.
//  Casos de uso: el botón "Reintentar" de un item en error o pendiente, y el
//  "Volver a indexar" después de editar el textoOriginal de una nota.
//  Misma transacción, mismo chequeo de autoría y mismo indexar() que
//  /procesar: la ÚNICA diferencia es de dónde sale el texto.
// ============================================================================
rutasDeItems.post('/:itemId/reprocesar', requireAuth, exigirMiembroSegunContrato, async (req, res) => {
  const arranque = Date.now();
  const { wsId, itemId } = req.params;
  const { uid } = req.usuario;

  // Acepta 'listo' a propósito: "edité la nota y quiero que la IA la vuelva a
  // leer" es justamente el caso de reprocesar un item que ya funcionaba.
  const { item } = await tomarElItem({
    wsId,
    itemId,
    uid,
    esAdmin: req.esAdmin,
    validar: exigirTextoGuardadoSiEsArchivo,
  });

  const resultado = await avisandoCuandoReintentar(res, () => procesarYDejarListo({
    wsId,
    itemId,
    uid,
    quien: quienHizo(req),
    item,
    verbo: 'volvió a indexar',
    sacarTexto: () => textoParaReprocesar(item),
  }));

  return res.status(200).json({
    ok: true,
    item: resultado.item,
    chunksBorrados: resultado.chunksBorrados,
    tardoMs: Date.now() - arranque,
  });
});

// ============================================================================
//  DELETE /:itemId   — endpoint 9 del contrato
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
//  Si justo se estaba procesando, el procesamiento se da cuenta al querer
//  marcarlo 'listo' y limpia los chunks que haya escrito.
// ============================================================================
rutasDeItems.delete('/:itemId', requireAuth, exigirMiembroSegunContrato, async (req, res) => {
  const { wsId, itemId } = req.params;
  const { uid } = req.usuario;
  const ref = refItem(wsId, itemId);

  const snap = await ref.get();
  if (!snap.exists) throw new ErrorApi('ITEM_NO_ENCONTRADO');
  const item = snap.data();
  if (item.workspaceId !== wsId) throw new ErrorApi('NO_ES_MIEMBRO');

  // Contrato v3: NO_SOS_EL_AUTOR. (La v2 devolvía ACCION_NO_PERMITIDA, cuyo
  // mensaje habla del dueño del espacio y no se entendía nada.)
  exigirAutorOAdmin(item, uid, req.esAdmin);

  const { borrados: chunksBorrados } = await borrarChunksDelItem(wsId, itemId); // PRIMERO los chunks
  await ref.delete();                                                            // DESPUÉS el item

  await anotarEvento(wsId, {
    tipo: 'item.eliminado',
    actorUid: uid,
    itemId,
    resumen: `${quienHizo(req)} borró "${tituloDe(item)}" (${chunksBorrados} fragmentos)`,
  });

  return res.status(200).json({
    ok: true,
    borrado: { itemId, titulo: item.titulo ?? '', chunksBorrados },
  });
});

// ============================================================================
//  DELETE /?estado=pendiente&antesDe=<ISO>   — endpoint 10, LIMPIEZA MASIVA
//
//  Después de una demo quedan decenas de items 'pendiente' que nunca se
//  procesaron (se cerró la app, se cayó la conexión, Render dormía). Borrarlos
//  de a uno son decenas de clicks y decenas de eventos tapando el feed.
//
//  POR QUÉ TAN CERRADO: solo estado=pendiente y los dos parámetros
//  obligatorios. Un estado=listo borraría todo el conocimiento del equipo de un
//  pedido, y un parámetro opcional que borra en masa es exactamente lo que
//  alguien ejecuta sin querer el día de la entrega.
// ============================================================================

// ISO 8601: fecha sola (2026-10-01) o fecha y hora CON zona (Z o -03:00). Una
// hora sin zona es ambigua (¿hora de Render o de Argentina?), así que no entra.
const FECHA_ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

function leerFiltroDePurga(query) {
  const { estado, antesDe } = query ?? {};

  // Comparar contra el string exacto también descarta un ?estado=a&estado=b
  // (Express lo entrega como array).
  if (estado !== 'pendiente') {
    throw new ErrorApi('DATOS_INVALIDOS', "el único estado que se puede limpiar es 'pendiente'");
  }
  if (typeof antesDe !== 'string' || !FECHA_ISO.test(antesDe)) {
    throw new ErrorApi('DATOS_INVALIDOS', "'antesDe' tiene que ser una fecha ISO, por ejemplo 2026-10-01T00:00:00.000Z");
  }
  const fecha = new Date(antesDe);
  if (Number.isNaN(fecha.getTime())) {
    throw new ErrorApi('DATOS_INVALIDOS', "'antesDe' no es una fecha válida");
  }
  if (fecha.getTime() >= Date.now()) {
    throw new ErrorApi('DATOS_INVALIDOS', "'antesDe' tiene que ser una fecha pasada");
  }
  return fecha;
}

// 01/10/2026, en UTC, que es la zona en la que viene el antesDe del ejemplo.
function fechaCorta(fecha) {
  const dd = String(fecha.getUTCDate()).padStart(2, '0');
  const mm = String(fecha.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${fecha.getUTCFullYear()}`;
}

rutasDeItems.delete('/', requireAuth, exigirMiembroSegunContrato, exigirAdmin, async (req, res) => {
  const { wsId } = req.params;
  const { uid } = req.usuario;
  const fecha = leerFiltroDePurga(req.query);

  const refItems = db.collection('workspaces').doc(wsId).collection('items');
  // El orderBy('creadoEn','desc') no es por gusto: hace que la consulta use
  // tal cual el índice (estado ASC, creadoEn DESC) que ya está en
  // firestore.indexes.json. Para borrar, el orden da lo mismo.
  const consulta = refItems
    .where('estado', '==', 'pendiente')
    .where('creadoEn', '<', Timestamp.fromDate(fecha))
    .orderBy('creadoEn', 'desc')
    .limit(BORRADOS_POR_LOTE);

  let itemsBorrados = 0;
  let chunksBorrados = 0;
  let lotes = 0;
  let choques = 0;

  // Se repite mientras el lote vuelva lleno. Como cada vuelta BORRA lo que
  // encontró, volver a consultar desde el principio trae los siguientes.
  while (true) {
    const snap = await consulta.get();
    if (snap.empty) break;

    // 1) PRIMERO los chunks de esos items, de a 10 ids por consulta. Un item
    //    'pendiente' casi nunca tiene, pero si un procesamiento se cortó a la
    //    mitad puede tenerlos. Mismo invariante de orden que el DELETE de uno.
    const ids = snap.docs.map((d) => d.id);
    for (let i = 0; i < ids.length; i += IDS_POR_CONSULTA_IN) {
      const grupo = ids.slice(i, i + IDS_POR_CONSULTA_IN);
      const { borrados } = await borrarChunksDeLaConsulta(wsId, db.collection('chunks').where('itemId', 'in', grupo));
      chunksBorrados += borrados;
    }

    // 2) DESPUÉS los items. Cada delete lleva la precondición "que nadie lo
    //    haya tocado desde que lo leí": si entre la consulta y el borrado
    //    alguien tocó Reintentar, el item ya no es 'pendiente' y NO lo
    //    borramos. Firestore rechaza el lote entero; volvemos a consultar y
    //    esa vuelta ya no lo trae.
    const lote = db.batch();
    for (const doc of snap.docs) lote.delete(doc.ref, { lastUpdateTime: doc.updateTime });
    try {
      await lote.commit();
    } catch (err) {
      // 9 = FAILED_PRECONDITION, 10 = ABORTED: el choque de arriba.
      if ((err?.code === 9 || err?.code === 10) && choques < MAX_CHOQUES_EN_PURGA) {
        choques += 1;
        console.warn(`[items] limpieza de ${wsId}: un item cambió mientras borrábamos, reintento el lote (${choques})`);
        continue;
      }
      throw err;
    }

    itemsBorrados += snap.size;
    lotes += 1;
    choques = 0;
    if (snap.size < BORRADOS_POR_LOTE) break;
  }

  // UN SOLO evento con el total, no uno por item: 37 'item.eliminado' tapan el
  // feed de auditoría y hacen inútil justo la pantalla que demuestra el rol de
  // admin. Si no se borró nada, no se cambió nada y no hay nada que auditar.
  if (itemsBorrados > 0) {
    const resumen = itemsBorrados === 1
      ? `Se limpió 1 item pendiente anterior al ${fechaCorta(fecha)}`
      : `Se limpiaron ${itemsBorrados} items pendientes anteriores al ${fechaCorta(fecha)}`;
    await anotarEvento(wsId, { tipo: 'items.purgados', actorUid: uid, resumen, itemId: null });
  }

  console.log(`[items] limpieza de ${wsId}: ${itemsBorrados} items y ${chunksBorrados} chunks en ${lotes} lote(s)`);

  // Borrar cero cosas no es un error: 200 con itemsBorrados: 0.
  return res.status(200).json({
    ok: true,
    filtro: { estado: 'pendiente', antesDe: fecha.toISOString() },
    itemsBorrados,
    chunksBorrados,
    lotes,
  });
});
