// ============================================================================
//  NeuroDesk AI — api/src/server.js
//  El arranque del backend: middlewares, montaje de rutas, /salud, el barrido
//  de items colgados y el manejo de errores global.
//
//  TRES COSAS DE ESTE ARCHIVO QUE HAY QUE SABER EXPLICAR:
//
//  1) app.listen(PORT, '0.0.0.0'). En Render el contenedor no expone
//     localhost: si escuchamos en 127.0.0.1 el health check externo nunca
//     conecta, el deploy se queda en "in progress" PARA SIEMPRE y no da ningun
//     error (es el fallo mas frustrante de todos, porque el log dice
//     "servidor escuchando" y sin embargo no anda). Y el puerto lo elige
//     Render con process.env.PORT: hardcodearlo tiene el mismo efecto.
//
//  2) EL BARRIDO DE ITEMS COLGADOS. Si Render se reinicia justo mientras un
//     item se estaba procesando, ese item queda en 'procesando' PARA SIEMPRE:
//     el backend murio y el cliente no puede tocar el campo 'estado' (las
//     reglas no se lo permiten). Al arrancar, y despues cada 10 minutos,
//     buscamos esos items y los pasamos a 'error' con un mensaje que la
//     persona entienda y un boton Reintentar.
//
//  3) EL MIDDLEWARE DE ERROR FINAL. Sin el, una excepcion cualquiera hace que
//     Express responda una pagina HTML con el stack trace adentro: rutas del
//     disco del servidor, hostnames internos y a veces pedazos de la
//     configuracion, todo servido al celular de cualquiera. Aca cae TODO y
//     sale con la forma unica de error, con detalle en null.
// ============================================================================

import express from 'express';

import { db, FieldValue, Timestamp, proyectoId } from './firebase.js';
import { cuerpoDeError, esErrorApi, CATALOGO_DE_ERRORES } from './errores.js';
import { rutasDeAuth } from './rutas/auth.js';
import { rutasDeWorkspaces } from './rutas/workspaces.js';

const VERSION = '2.0.0';
const PORT = Number(process.env.PORT) || 8080;

// Cuantos minutos sin novedades tiene que llevar un item en 'procesando' para
// que el barrido lo de por colgado. Va como constante con nombre y no como un
// numero suelto en la query.
// OJO CON LOS DOS NUMEROS: el barrido usa 10 minutos y /procesar acepta como
// "reprocesable" un item con mas de 5. No es una contradiccion, es a proposito:
// el boton Reintentar tiene que funcionar ANTES de que pase el barrido. Si
// fuera al reves (barrido mas agresivo que el endpoint), el barrido podria
// marcar como 'error' un item que se esta procesando de verdad.
const MINUTOS_ITEM_COLGADO = Number(process.env.MINUTOS_ITEM_COLGADO) || 10;
const CADA_CUANTO_BARRE_MS = 10 * 60 * 1000; // 10 minutos

// Datos que informa GET /salud.
const arrancoEn = Date.now();
let itemsColgadosBarridos = 0;

const app = express();

// Render pone un proxy adelante. Sin esto, req.ip devuelve la IP del proxy
// (util cuando agreguemos el limitador de pedidos) y req.protocol dice 'http'
// aunque el pedido haya llegado por https.
app.set('trust proxy', 1);

// Express manda por defecto un header X-Powered-By: Express. Es informacion
// gratis para alguien que quiera buscar vulnerabilidades conocidas.
app.disable('x-powered-by');

// ---------------------------------------------------------------------------
// CORS, escrito a mano y con lista blanca.
//
// Nada de cors() abierto: con Access-Control-Allow-Origin: * cualquier pagina
// de internet podria hacerle pedidos a nuestra API desde el navegador de un
// usuario logueado. La app de Flutter NO manda header Origin (no es un
// navegador), asi que pasa igual; el que se controla es el panel web.
// ---------------------------------------------------------------------------
const ORIGENES_PERMITIDOS = (
  process.env.CORS_ORIGENES ||
  'http://localhost:5500,http://127.0.0.1:5500,http://localhost:8080,http://127.0.0.1:8080'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origen = req.headers.origin;

  if (origen && ORIGENES_PERMITIDOS.includes(origen)) {
    res.setHeader('Access-Control-Allow-Origin', origen);
    // Vary: Origin le avisa a las caches que la respuesta cambia segun quien
    // pregunte. Sin esto, un proxy puede cachear la respuesta de un origen
    // permitido y devolversela a otro.
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  // El preflight se contesta y se corta: no tiene sentido que siga hasta las
  // rutas, porque no lleva token y fallaria con FALTA_TOKEN.
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

// El body JSON con tope: sin limite, alguien manda 50 MB de JSON y se come la
// memoria de un contenedor de 512 MB. Los archivos NO pasan por aca: van por
// multipart y los maneja multer en la ruta de /procesar.
app.use(express.json({ limit: '1mb' }));

// Log minimo de cada pedido, con la duracion. Es lo que vamos a mirar en Render
// cuando algo falle en la demo. NO logueamos ni el token ni el body: el token
// deja entrar a la cuenta de la persona y el body puede tener el texto de una
// nota privada.
app.use((req, res, next) => {
  const empezo = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - empezo} ms)`);
  });
  next();
});

// ===========================================================================
//  GET /salud
//  Publico y sin token, a proposito: lo llama UptimeRobot y lo llaman la app y
//  el panel apenas arrancan, en segundo plano, para DESPERTAR a Render (el
//  plan free duerme a los 15 minutos y el primer pedido tarda hasta 60 s).
//  Va suelto y no bajo /v1/ para que el ping sea lo mas simple posible.
// ===========================================================================
app.get('/salud', async (req, res) => {
  let estadoFirestore = 'ok';

  try {
    // Una lectura chiquita de verdad: si Firestore esta caido o la credencial
    // esta mal, esto falla. Un endpoint de salud que solo devuelve 200 sin
    // tocar nada miente: dice "verde" con la base inaccesible.
    await conTiempoLimite(db.collection('_salud').doc('ping').get(), 5000);
  } catch (err) {
    console.error('[salud] Firestore no responde:', err);
    estadoFirestore = 'caido';
  }

  if (estadoFirestore === 'caido') {
    // Forma unica de error + el dato extra que pide el contrato. El 'detalle'
    // sigue en null: el err.message de firebase-admin trae hostnames internos.
    return res.status(500).json({
      ...cuerpoDeError('ERROR_INTERNO'),
      firestore: 'caido',
    });
  }

  return res.status(200).json({
    ok: true,
    servicio: 'neurodesk-api',
    version: VERSION,
    hora: new Date().toISOString(),
    firestore: estadoFirestore,
    // Cuantos segundos hace que este proceso esta vivo. Si el numero es chico,
    // Render acaba de despertar y por eso el pedido tardo.
    despiertoHaceSeg: Math.round((Date.now() - arrancoEn) / 1000),
    // Sirve en la demo para explicar por que un item volvio de 'procesando' a
    // 'error' sin que nadie tocara nada.
    itemsColgadosBarridos,
  });
});

// ===========================================================================
//  RUTAS DE LA API. Todas cuelgan de /v1/ (la unica excepcion es /salud).
// ===========================================================================
app.use('/v1/auth', rutasDeAuth);
app.use('/v1/workspaces', rutasDeWorkspaces);

// ---------------------------------------------------------------------------
// 404 de ruta inexistente. Va DESPUES de todas las rutas y ANTES del manejador
// de errores. Sin esto, un error de tipeo en la URL devuelve el HTML de Express
// ("Cannot POST /v1/workspace") y el cliente, que espera JSON, revienta al
// parsearlo con una pantalla roja.
// ---------------------------------------------------------------------------
app.use((req, res) => {
  return res.status(CATALOGO_DE_ERRORES.RUTA_NO_ENCONTRADA.http).json(
    cuerpoDeError('RUTA_NO_ENCONTRADA')
  );
});

// ---------------------------------------------------------------------------
// EL MANEJADOR DE ERRORES FINAL. Los cuatro parametros (err, req, res, next)
// son obligatorios: Express distingue un manejador de errores de un middleware
// comun contando los argumentos. Si le sacas el 'next' que no se usa, deja de
// funcionar y no avisa.
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  // 1) Errores nuestros, ya clasificados con un codigo del catalogo.
  if (esErrorApi(err)) {
    // No los logueamos como error: un 403 o un 404 son parte del
    // funcionamiento normal y llenarian el log de ruido.
    return res.status(err.http).json(cuerpoDeError(err.codigo, err.detalle));
  }

  // 2) JSON roto. express.json() tira un SyntaxError con status 400. Es culpa
  //    del que mando el pedido, no nuestra, asi que no es un ERROR_INTERNO.
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json(cuerpoDeError('DATOS_INVALIDOS', 'El cuerpo del pedido no es JSON válido.'));
  }

  // 3) Cualquier otra cosa: un bug nuestro o un servicio de afuera que se cayo.
  //    El stack COMPLETO va al log de Render (que solo vemos nosotros) y al
  //    cliente le llega ERROR_INTERNO con detalle HARDCODEADO en null.
  //    Nunca err.message: un error de firebase-admin trae rutas del servidor,
  //    hostnames internos y a veces pedazos de la configuracion.
  console.error(`[ERROR_INTERNO] ${req.method} ${req.originalUrl}`);
  console.error(err);

  if (res.headersSent) {
    // Si ya empezamos a responder no podemos cambiar el status: lo unico
    // sensato es cortar la conexion para que el cliente se de cuenta.
    return req.socket.destroy();
  }

  return res.status(500).json(cuerpoDeError('ERROR_INTERNO', null));
});

// ===========================================================================
//  EL BARRIDO DE ITEMS COLGADOS EN 'procesando'
// ===========================================================================

/**
 * Busca items que quedaron en 'procesando' hace mas de MINUTOS_ITEM_COLGADO y
 * los pasa a 'error' con un mensaje legible.
 *
 * Usa collectionGroup('items') porque los items viven adentro de cada
 * workspace y no queremos recorrer los workspaces uno por uno. Necesita el
 * indice de COLLECTION_GROUP (estado, actualizadoEn) que ya esta en
 * firestore.indexes.json. Como corre con Admin SDK, no le abre nada al
 * cliente: las consultas de grupo desde el celular siguen denegadas.
 *
 * Va de a 400 documentos porque un batch de Firestore admite hasta 500
 * operaciones.
 *
 * @returns {Promise<number>} cuantos items destrabo.
 */
export async function barrerItemsColgados() {
  const limite = Timestamp.fromMillis(Date.now() - MINUTOS_ITEM_COLGADO * 60 * 1000);
  let destrabados = 0;

  // Como maximo 10 vueltas (4000 items). El tope existe para que un bug no
  // deje al proceso barriendo para siempre y sin atender pedidos.
  for (let vuelta = 0; vuelta < 10; vuelta++) {
    const snap = await db
      .collectionGroup('items')
      .where('estado', '==', 'procesando')
      .where('actualizadoEn', '<', limite)
      .limit(400)
      .get();

    if (snap.empty) break;

    const lote = db.batch();
    for (const doc of snap.docs) {
      lote.update(doc.ref, {
        estado: 'error',
        // El MISMO texto que le mostrariamos por HTTP, escrito por nosotros.
        // Nunca un err.message: el cliente muestra este campo tal cual.
        errorMsg: 'Se cortó el procesamiento. Tocá Reintentar.',
        // Invariante 6: un item en 'error' tiene cantChunks == 0.
        cantChunks: 0,
        actualizadoEn: FieldValue.serverTimestamp(),
      });
    }
    await lote.commit();

    destrabados += snap.size;
    if (snap.size < 400) break;
  }

  if (destrabados > 0) {
    console.log(`[barrido] ${destrabados} item(s) colgados en 'procesando' pasaron a 'error'.`);
  }
  return destrabados;
}

/** Corre el barrido sin dejar que un error tumbe el proceso. */
async function barrerSinRomper(motivo) {
  try {
    itemsColgadosBarridos += await barrerItemsColgados();
  } catch (err) {
    // El caso tipico: falta el indice de collection group. Firestore devuelve
    // el error con el link para crearlo, y ese link aparece en el log.
    console.error(`[barrido] Fallo el barrido (${motivo}):`, err.message);
  }
}

// ===========================================================================
//  AYUDANTE
// ===========================================================================

/**
 * Le pone un tiempo maximo a una promesa que no lo trae.
 * firebase-admin reintenta solo durante bastante tiempo cuando la red esta
 * mal, y /salud tiene que contestar rapido o UptimeRobot lo da por caido.
 */
function conTiempoLimite(promesa, ms) {
  return Promise.race([
    promesa,
    new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('timeout')), ms)),
  ]);
}

// ===========================================================================
//  ARRANQUE
// ===========================================================================

// Escuchar PRIMERO y barrer despues, no al reves: Render le da un rato al
// servicio para que abra el puerto y, si el barrido tardara (o fallara por
// falta de indice), el deploy se marcaria como fallido sin que el servidor
// tenga nada malo.
const servidor = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[server] neurodesk-api v${VERSION} escuchando en 0.0.0.0:${PORT}`);
  console.log(`[server] Proyecto de Firebase: ${proyectoId}`);
  console.log(`[server] Origenes permitidos para CORS: ${ORIGENES_PERMITIDOS.join(', ')}`);

  await barrerSinRomper('arranque');

  // Y despues, cada 10 minutos mientras el proceso siga vivo.
  // .unref() para que este temporizador no sea un motivo para que Node se
  // quede prendido: si el servidor se cierra, el proceso tiene que poder salir.
  const reloj = setInterval(() => barrerSinRomper('periodico'), CADA_CUANTO_BARRE_MS);
  reloj.unref();
});

// ---------------------------------------------------------------------------
// Apagado ordenado. Render manda SIGTERM antes de reiniciar el servicio; sin
// esto, los pedidos que estaban en curso se cortan a la mitad y algun item
// queda en 'procesando' (que despues destraba el barrido, pero mejor evitarlo).
// ---------------------------------------------------------------------------
for (const senial of ['SIGTERM', 'SIGINT']) {
  process.on(senial, () => {
    console.log(`[server] Recibi ${senial}: cierro el servidor.`);
    servidor.close(() => process.exit(0));
    // Si en 10 segundos no cerro (una conexion que no termina nunca), salimos
    // igual: si no, Render lo mata a la fuerza y queda peor.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}

// Ultima red de contencion. Un rechazo de promesa sin catch, en Node moderno,
// TERMINA el proceso. Preferimos loguearlo y seguir vivos: en la demo, un
// servidor que se cae es mucho peor que un pedido que falla.
process.on('unhandledRejection', (motivo) => {
  console.error('[server] Promesa rechazada sin catch:', motivo);
});
process.on('uncaughtException', (err) => {
  console.error('[server] Excepcion no atrapada:', err);
});

export { app };
