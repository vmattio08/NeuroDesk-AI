// ============================================================
//  servicios/ia.js
//  El unico archivo que le habla a la IA: Google Gemini (Google AI Studio).
//
//  Dos funciones y nada mas:
//    - pedirEmbeddings(textos, 'passage'|'query', {titulos, hasta}) -> array de vectores
//    - chatear(mensajes, {temperatura, maxTokens, topP, hasta, msPorModelo}) -> string con la respuesta
//
//  POR QUE GOOGLE (cambio del 22/10/2026): el free tier de la API de Gemini
//  alcanza para el proyecto, no pide tarjeta y esta disponible en Argentina.
//  Antes usabamos NVIDIA NIM; lo dejamos para tener UNA sola clave que
//  administrar. OJO para la defensa: en el free tier Google puede usar lo que
//  le mandamos para mejorar sus productos. Por eso la app solo tiene datos de
//  prueba, nunca datos reales de un equipo.
//
//  POR QUE fetch crudo y no el SDK de Google: son dos POST con JSON. Con fetch
//  vemos exactamente que sale y que vuelve, que es lo que hay que poder
//  explicar, y no sumamos una dependencia.
//
//  DOS ENDPOINTS DISTINTOS, A PROPOSITO:
//    - Chat: el endpoint "compatible con OpenAI" de Gemini
//      (.../v1beta/openai/chat/completions). Mismo formato de mensajes que
//      ya usaba el backend: system / user / assistant.
//    - Embeddings: la API nativa (batchEmbedContents), porque es la unica que
//      deja pedir el taskType (documento vs pregunta) y el largo del vector.
//
//  LOS MODELOS: vienen con un valor por defecto aca abajo y se pueden pisar
//  desde el .env sin tocar el codigo (GEMINI_MODELO_CHAT, etc.). Asi para
//  arrancar alcanza con pegar GEMINI_API_KEY, y si Google da de baja un
//  modelo se cambia una linea del .env. `npm run modelos:vivos` avisa.
// ============================================================

// --- Valores por defecto (con el POR QUE de cada uno) ----------------------

const BASE_POR_DEFECTO = 'https://generativelanguage.googleapis.com/v1beta';

// ELEGIDOS MIDIENDO (29/10/2026, con nuestras claves del free tier, misma
// pregunta, dos intentos cada uno):
//   gemini-3.6-flash      2,5 s / 3,4 s   -> principal: el mas rapido y cita bien
//   gemini-3.1-flash-lite 3,0 s / 8,0 s   -> primer respaldo
//   gemini-3.5-flash-lite 6,2 s / 8,4 s   -> segundo respaldo
//   gemini-3.8-flash      no contesto en 60 s ("high demand", 503): afuera.
//     Es el "mas inteligente" segun Google, pero en el free tier vive
//     saturado, y un modelo que no contesta no sirve para la demo.
// Los limites del free tier son POR MODELO: si el principal se queda sin cupo
// (429) o esta saturado (503), el de respaldo todavia tiene el suyo.
const MODELO_CHAT_POR_DEFECTO = 'gemini-3.6-flash';
const RESPALDOS_CHAT_POR_DEFECTO = 'gemini-3.1-flash-lite,gemini-3.5-flash-lite';

// El de embeddings NO tiene respaldo: los vectores de dos modelos distintos no
// se pueden comparar. Cambiarlo obliga a reindexar todo y recalibrar.
const MODELO_EMBED_POR_DEFECTO = 'gemini-embedding-001';

// Los modelos Gemini 3 no dejan apagar el razonamiento del todo: solo bajarlo.
// 'low' es el mas bajo que la doc garantiza para toda la familia 3.x.
const RAZONAMIENTO_POR_DEFECTO = 'low';

// --- Constantes del servicio ------------------------------------------------

// batchEmbedContents acepta hasta 100 textos por pedido. Mandamos 50 y
// esperamos 1 s entre lotes para no comernos el limite por minuto del free tier.
const TAMANO_LOTE = 50;
const PAUSA_ENTRE_LOTES_MS = 1000;

// Cuantas veces reintentamos cuando la culpa NO es nuestra (429 o 5xx).
const MAX_INTENTOS = 3;

// TIEMPOS. Todos estan atados al timeout de 90 s que tiene la app para
// /preguntar y /procesar.
//  - Embeddings al INDEXAR ('passage'): hasta 50 trozos de ~1500 caracteres
//    por pedido. 60 s es holgado a proposito.
//  - Embedding de una PREGUNTA ('query'): un texto corto, que Google contesta
//    en menos de 1 s. 15 s ya es "no anda": conviene cortar y reintentar en
//    vez de quemar 60 s de los 90 que tiene la app.
//  - Chat: un modelo sano contesta en 2 a 8 s, asi que 25 s ya es "no anda".
//
// OJO, CUENTA CORREGIDA (29/10/2026). Aca decia "3 x 25 s = 75 s", pero el
// ULTIMO modelo de la cadena tiene 2 intentos con ~1 s de espera en el medio:
// el peor caso real del chat solo era 25 + 25 + (25 + 1,4 + 25) = 101,4 s, y
// el del embedding de la pregunta 60 + 1,4 + 60 + 3,4 + 60 = 184,8 s. Ninguno
// de los dos entraba en los 90 s. Por eso ahora /preguntar le pasa a cada
// llamado una FECHA LIMITE (la opcion 'hasta'): cada intento dura como mucho
// lo que queda de la vuelta, y si no queda ni MINIMO_POR_INTENTO_MS ya no se
// manda ni se espera para reintentar (ver pedirAGoogle).
const TIMEOUT_EMBEDDINGS_MS = 60_000;
const TIMEOUT_EMBED_PREGUNTA_MS = 15_000;
const TIMEOUT_CHAT_MS = 25_000;

// Con menos que esto por delante no vale la pena mandar un pedido: el modelo
// de chat mas rapido tarda 2,5 s en contestar, asi que un intento de 1 s solo
// gasta cupo y termina en timeout seguro.
const MINIMO_POR_INTENTO_MS = 3_000;

// --- Estado del modulo -----------------------------------------------------

// Empezamos con la clave principal. Si Google nos dice que la clave no sirve o
// que se acabo la cuota del dia, pasamos a GEMINI_API_KEY_RESPALDO (una clave
// de OTRO proyecto de Google Cloud: los limites son por proyecto) y nos
// quedamos ahi hasta que se reinicie el servidor.
let usandoRespaldo = false;

// ============================================================
//  Helpers chiquitos
// ============================================================

/**
 * Arma el error con la forma UNICA del contrato. Todos los servicios tiran
 * errores asi y el middleware final del server solo los tiene que envolver.
 * OJO con "detalle": va SOLO texto escrito por nosotros a mano. Nunca un
 * err.message crudo ni el body de Google, porque ahi pueden viajar pedazos de
 * configuracion o (peor) la clave.
 */
function fallo(codigo, mensaje, http, detalle = null) {
  const err = new Error(`${codigo}: ${mensaje}`);
  err.codigo = codigo;
  err.mensaje = mensaje;
  err.http = http;
  err.detalle = detalle;
  return err;
}

/** Marca un error como "fallo este modelo, otro puede andar". */
function culpaDelModelo(err) {
  err.culpaDelModelo = true;
  return err;
}

const MSG_IA_CAIDA = 'El servicio de IA no está respondiendo. Probá de nuevo en un minuto.';
const MSG_INTERNO = 'Algo salió mal de nuestro lado. Ya lo estamos viendo, probá de nuevo.';

const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

// Backoff: 1s, 3s, 7s, con un ruidito al azar ("jitter") para que dos pedidos
// que se comieron el mismo 429 no reintenten en el mismo milisegundo.
function esperaDelIntento(intento) {
  const base = [1000, 3000, 7000][Math.min(intento - 1, 2)];
  return base + Math.floor(Math.random() * 400);
}

// --- La fecha limite ('hasta') ----------------------------------------------
// 'hasta' es una marca de Date.now() en ms. null = sin fecha limite, que es
// como funciona todo lo que no la pasa (indexar, los scripts): igual que antes.

/**
 * Cuanto puede durar el proximo intento: el timeout de siempre o lo que queda
 * hasta la fecha limite, lo que sea MENOR. 0 = no queda ni el minimo.
 */
function msParaUnIntento(msTimeout, hasta) {
  if (hasta == null) return msTimeout;
  const quedan = hasta - Date.now();
  return quedan >= MINIMO_POR_INTENTO_MS ? Math.min(msTimeout, quedan) : 0;
}

/** Si despues de esperar `ms` todavia entra un intento minimo antes de la fecha limite. */
function hayTiempoPara(ms, hasta) {
  return hasta == null || Date.now() + ms + MINIMO_POR_INTENTO_MS <= hasta;
}

/**
 * Se termino el tiempo de la vuelta. Para la persona es lo mismo que un
 * Google que no contesta (IA_NO_RESPONDE), pero lleva la marca sinTiempo para
 * que chatear() no pruebe el modelo siguiente: tampoco tendria tiempo.
 */
function sinTiempo() {
  const err = culpaDelModelo(fallo('IA_NO_RESPONDE', MSG_IA_CAIDA, 503, 'Se terminó el tiempo de la vuelta antes de que contestara Google.'));
  err.sinTiempo = true;
  return err;
}

// --- Lectura del entorno ---------------------------------------------------
// Se lee ADENTRO de las funciones y no arriba de todo a proposito: asi el
// modulo se puede importar en un test sin tener el .env cargado todavia.

function baseUrl() {
  const url = process.env.GEMINI_BASE_URL || BASE_POR_DEFECTO;
  return url.replace(/\/+$/, ''); // sin barra final, la agregamos nosotros
}

function claveEnUso() {
  const principal = (process.env.GEMINI_API_KEY || '').trim();
  const respaldo = (process.env.GEMINI_API_KEY_RESPALDO || '').trim();
  return usandoRespaldo ? respaldo : principal;
}

/** Pasa a la clave de respaldo. true si efectivamente cambio algo. */
function pasarAlRespaldo() {
  const respaldo = (process.env.GEMINI_API_KEY_RESPALDO || '').trim();
  if (usandoRespaldo || !respaldo) return false;
  usandoRespaldo = true;
  console.warn('[ia] La clave principal fallo. Pasando a GEMINI_API_KEY_RESPALDO.');
  return true;
}

function modeloEmbed() {
  return (process.env.GEMINI_MODELO_EMBED || '').trim() || MODELO_EMBED_POR_DEFECTO;
}

/** El principal primero y despues los de respaldo, sin repetidos. */
export function cadenaDeModelosChat() {
  const principal = (process.env.GEMINI_MODELO_CHAT || '').trim() || MODELO_CHAT_POR_DEFECTO;
  // Vacia o ausente = el respaldo por defecto. Una variable que quedo vacia en
  // el panel de Render no tiene que dejar al backend sin respaldo sin que nadie
  // se entere. Para apagar el respaldo A PROPOSITO se escribe "ninguno".
  const pedido = (process.env.GEMINI_MODELOS_CHAT_RESPALDO || '').trim();
  const respaldos = pedido.toLowerCase() === 'ninguno'
    ? []
    : (pedido || RESPALDOS_CHAT_POR_DEFECTO).split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([principal, ...respaldos])];
}

/** Cuantas dimensiones guardamos de cada vector. El modelo de datos dice 1024. */
export function dimensiones() {
  const n = Number.parseInt(process.env.EMBED_DIMS || '1024', 10);
  return Number.isFinite(n) && n > 0 ? n : 1024;
}

// ============================================================
//  El pedido HTTP, con todo el manejo de errores en UN solo lugar
// ============================================================

/** Lee el cuerpo de un error SOLO para decidir y para el log del servidor. */
async function leerErrorParaElLog(res) {
  try {
    return (await res.text()).slice(0, 600);
  } catch {
    return '(sin cuerpo)';
  }
}

/**
 * Cuanto pide Google que esperemos antes de reintentar un 429. Viene adentro
 * del error, en details[].retryDelay ("12s"). Si no viene, null.
 */
function esperaPedidaPorGoogle(cuerpoError) {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(cuerpoError);
  return m ? Math.ceil(Number(m[1]) * 1000) : null;
}

/**
 * POST a Google con reintentos, backoff y caida a la clave de respaldo.
 *
 * La tabla de decisiones (esto es lo que hay que saber explicar):
 *   400 "API key not valid", 401, 403 -> la clave no sirve (Google contesta
 *              400 y no 401 cuando la clave esta mal escrita). Probamos la de
 *              respaldo UNA vez; si tampoco, es configuracion nuestra.
 *   400 otro -> pedimos algo que ESE modelo no acepta: otro modelo puede andar.
 *   404     -> el modelo no existe (lo dieron de baja o esta mal escrito).
 *   429     -> nos pasamos del cupo del free tier. Reintento respetando el
 *              retryDelay que manda Google. Si es la cuota DEL DIA, no tiene
 *              sentido esperar: clave de respaldo o SIN_CREDITOS_IA.
 *   5xx     -> Google sobrecargado o caido. Reintento con backoff.
 *   timeout -> igual que 5xx.
 *
 * Los errores que son culpa DEL MODELO salen con err.culpaDelModelo = true y
 * chatear() pasa al modelo de respaldo. El 429 tambien cuenta como culpa del
 * modelo porque en el free tier el cupo es POR MODELO.
 *
 * CON FECHA LIMITE ('hasta'): cada intento dura como mucho lo que queda, y no
 * se espera para reintentar si despues de la espera ya no entra un intento
 * minimo. En ese caso sale el MISMO error que cuando se acaban los intentos.
 *
 * @param {string} url   URL completa
 * @param {object} cuerpo
 * @param {number} msTimeout
 * @param {{maxIntentos?:number, autenticacion:'bearer'|'cabecera', hasta?:number|null}} opciones
 *   'bearer' para el endpoint compatible con OpenAI, 'cabecera' (x-goog-api-key)
 *   para la API nativa: cada uno espera la clave en un lugar distinto.
 */
async function pedirAGoogle(url, cuerpo, msTimeout, { maxIntentos = MAX_INTENTOS, autenticacion, hasta = null }) {
  let intento = 0;
  let cambiosDeClave = 0;

  // while(true) y no un for, porque cambiar de clave NO gasta un intento:
  // es el mismo pedido con otra credencial.
  while (true) {
    const clave = claveEnUso();
    if (!clave) {
      throw fallo('ERROR_INTERNO', MSG_INTERNO, 500, 'No hay GEMINI_API_KEY configurada en el servidor.');
    }

    // Sin fecha limite es el timeout de siempre. Con fecha limite, lo que
    // quede de la vuelta; y si no queda ni el minimo, ni lo mandamos.
    const msDeEsteIntento = msParaUnIntento(msTimeout, hasta);
    if (msDeEsteIntento === 0) throw sinTiempo();

    intento += 1;
    const cabeceras = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (autenticacion === 'bearer') cabeceras.Authorization = `Bearer ${clave}`;
    else cabeceras['x-goog-api-key'] = clave;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: cabeceras,
        body: JSON.stringify(cuerpo),
        // AbortSignal.timeout corta la conexion sola. Sin esto, un pedido
        // colgado se queda tomando memoria hasta que Render reinicie.
        signal: AbortSignal.timeout(msDeEsteIntento),
      });
    } catch (err) {
      // Aca caen: timeout, DNS caido, conexion cortada a la mitad.
      console.error('[ia] fetch fallo:', err?.name, err?.message);
      const espera = esperaDelIntento(intento);
      if (intento < maxIntentos && hayTiempoPara(espera, hasta)) {
        await esperar(espera);
        continue;
      }
      throw culpaDelModelo(fallo('IA_NO_RESPONDE', MSG_IA_CAIDA, 503, 'Google no contestó dentro del tiempo de espera.'));
    }

    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw culpaDelModelo(fallo('IA_NO_RESPONDE', MSG_IA_CAIDA, 503, 'Google contestó algo que no era JSON.'));
      }
    }

    const cuerpoError = await leerErrorParaElLog(res);
    // La URL va sin la clave: la clave viaja en una cabecera, nunca en la URL.
    console.error(`[ia] HTTP ${res.status} en ${url.replace(baseUrl(), '')} -> ${cuerpoError}`);

    const claveInvalida =
      res.status === 401 ||
      res.status === 403 ||
      (res.status === 400 && /API key not valid|API_KEY_INVALID/i.test(cuerpoError));

    if (claveInvalida) {
      if (cambiosDeClave === 0 && pasarAlRespaldo()) {
        cambiosDeClave += 1;
        intento -= 1; // cambiar de clave no gasta intento
        continue;
      }
      throw fallo('ERROR_INTERNO', MSG_INTERNO, 500, 'Google rechazó la clave de la API. Hay que revisar GEMINI_API_KEY en el .env.');
    }

    if (res.status === 429) {
      // La cuota DEL DIA no se arregla esperando unos segundos.
      const cuotaDelDia = /per ?day|PerDay|daily/i.test(cuerpoError);
      if (cuotaDelDia) {
        if (cambiosDeClave === 0 && pasarAlRespaldo()) {
          cambiosDeClave += 1;
          intento -= 1;
          continue;
        }
        throw culpaDelModelo(fallo(
          'SIN_CREDITOS_IA',
          'Se terminó el cupo gratis de la IA. Avisale al administrador.',
          402,
          `Se terminó la cuota diaria gratuita de ${cuerpo.model ?? 'Google'} (se renueva a la medianoche del Pacífico).`,
        ));
      }
      if (intento < maxIntentos) {
        const pedida = esperaPedidaPorGoogle(cuerpoError);
        const espera = Math.min(pedida ?? esperaDelIntento(intento), 15_000); // nunca mas de 15 s
        if (hayTiempoPara(espera, hasta)) {
          await esperar(espera);
          continue;
        }
      }
      throw culpaDelModelo(fallo(
        'DEMASIADOS_PEDIDOS',
        'Estás yendo muy rápido. Esperá unos segundos y probá de nuevo.',
        429,
        'Google nos limitó por cantidad de pedidos (429).',
      ));
    }

    if (res.status >= 500 && intento < maxIntentos) {
      const espera = esperaDelIntento(intento);
      if (hayTiempoPara(espera, hasta)) {
        await esperar(espera);
        continue;
      }
    }

    // Lo que queda: 400 (algo que este modelo no acepta), 404 (el modelo no
    // existe), 5xx despues de los reintentos. En todos, otro modelo puede andar.
    throw culpaDelModelo(fallo('IA_NO_RESPONDE', MSG_IA_CAIDA, 503, `Google respondió HTTP ${res.status}.`));
  }
}

// ============================================================
//  Vectores: recorte + normalizacion L2
// ============================================================

/**
 * Deja el vector en exactamente EMBED_DIMS numeros y lo re-normaliza.
 *
 * Le pedimos a Google directamente 1024 dimensiones (outputDimensionality), asi
 * que normalmente no hay nada que recortar. Pero la doc de Google avisa que
 * los vectores de menos de 3072 dimensiones NO vienen normalizados: hay que
 * normalizarlos nosotros. Y si algun dia llega uno mas largo, el recorte lo
 * deja del tamaño del modelo de datos (un documento de Firestore no puede
 * pasar de 1 MiB).
 *
 * POR QUE NORMALIZAR: con vectores de largo 1, la similitud coseno es
 * simplemente el producto punto, y todos los puntajes viven en la misma escala
 * (la que usamos para el umbral y para 'alta/media/baja').
 */
export function recortarYNormalizar(vector, dims = dimensiones()) {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw fallo('IA_NO_RESPONDE', MSG_IA_CAIDA, 503, 'Google devolvió un embedding vacío.');
  }

  const corto = vector.slice(0, dims).map(Number);

  let sumaDeCuadrados = 0;
  for (const n of corto) {
    if (!Number.isFinite(n)) {
      throw fallo('IA_NO_RESPONDE', MSG_IA_CAIDA, 503, 'Google devolvió un embedding con valores que no son números.');
    }
    sumaDeCuadrados += n * n;
  }

  const largo = Math.sqrt(sumaDeCuadrados);
  // Un vector de ceros no se puede normalizar (dividir por 0 da NaN). Lo
  // devolvemos tal cual: nunca va a matchear con nada, que es lo correcto.
  if (largo === 0) return corto;

  return corto.map((n) => n / largo);
}

// ============================================================
//  EMBEDDINGS
// ============================================================

/**
 * El titulo listo para mandar: sin espacios de mas, o null si no hay.
 * Un titulo vacio NO se manda: "title: " a secas no le dice nada al modelo.
 */
function tituloParaEmbeber(titulo) {
  if (typeof titulo !== 'string') return null;
  const limpio = titulo.replace(/\s+/g, ' ').trim();
  return limpio || null;
}

/**
 * Convierte textos en vectores.
 *
 * @param {string[]} textos    Los trozos a vectorizar, en orden.
 * @param {'passage'|'query'} inputType
 * @param {{titulos?: (string|null)[], hasta?: number|null}} [opciones]
 *   titulos: el titulo del documento de cada trozo, en un array PARALELO a
 *   textos (titulos[i] es el de textos[i]). Opcional, y SOLO con 'passage'.
 *   hasta: fecha limite (Date.now() en ms). La pasa /preguntar para que el
 *   embedding de la pregunta no se coma el tiempo de la vuelta. Sin ella,
 *   todo igual que siempre.
 * @returns {Promise<number[][]>} Un vector por texto, EN EL MISMO ORDEN.
 *
 * LA DIFERENCIA DOCUMENTO / PREGUNTA ES OBLIGATORIA. Estos modelos se entrenan
 * con dos "modos": lo que se guarda va como documento y lo que se busca va
 * como pregunta. Si mandas los dos igual, el buscador SIGUE ANDANDO pero
 * contesta peor: es un bug silencioso carisimo de encontrar. Por eso el
 * parametro es obligatorio y validado: preferimos reventar antes que adivinar.
 *   - gemini-embedding-001 lo recibe como taskType (RETRIEVAL_DOCUMENT/QUERY).
 *   - gemini-embedding-2 NO acepta taskType: la doc pide marcarlo con un
 *     prefijo en el texto. Soportamos los dos por si hay que cambiar de modelo.
 *
 * EL TITULO (desde el 29/10/2026): el titulo que le puso la persona al item
 * ("Tienda online") casi nunca esta escrito adentro del texto, y sin el, una
 * pregunta por "la tienda online" no encontraba el link. Google deja mandar
 * el titulo del documento junto con cada trozo, y lo usa para armar el vector:
 *   - gemini-embedding-001: campo `title` del pedido. La referencia de la API
 *     dice que solo vale con taskType RETRIEVAL_DOCUMENT, o sea con 'passage'.
 *   - gemini-embedding-2: va en el prefijo, "title: <titulo> | text: ...". Sin
 *     titulo, la doc pide escribir "title: none".
 * Una PREGUNTA no tiene titulo: mandar titulos con 'query' es un error de
 * quien llama, y como con inputType, preferimos reventar antes que adivinar.
 *
 * OJO para la defensa: la referencia de la API marca como "deprecated" a
 * taskType, title y outputDimensionality sueltos (los quiere adentro de
 * embedContentConfig). Hoy andan, y lo medimos: el mismo texto con titulo da
 * otro vector. Los dejamos sueltos los tres juntos, como estaban; si Google
 * algun dia los apaga, se mudan los tres al mismo objeto.
 */
export async function pedirEmbeddings(textos, inputType, opciones = {}) {
  if (!Array.isArray(textos)) {
    throw fallo('ERROR_INTERNO', MSG_INTERNO, 500, 'pedirEmbeddings() esperaba un array de textos.');
  }
  if (inputType !== 'passage' && inputType !== 'query') {
    throw fallo('ERROR_INTERNO', MSG_INTERNO, 500, "inputType tiene que ser 'passage' (al indexar) o 'query' (al preguntar).");
  }
  const titulos = opciones?.titulos ?? null;
  if (titulos !== null) {
    if (inputType !== 'passage') {
      throw fallo('ERROR_INTERNO', MSG_INTERNO, 500, "Los titulos solo van con 'passage': una pregunta no tiene titulo.");
    }
    // Paralelo quiere decir paralelo: si los largos no coinciden, el titulo
    // de un item terminaria pegado al texto de OTRO, y eso no avisa nada.
    if (!Array.isArray(titulos) || titulos.length !== textos.length) {
      throw fallo('ERROR_INTERNO', MSG_INTERNO, 500, 'opciones.titulos tiene que traer un titulo por texto (mismo largo que textos).');
    }
  }
  if (textos.length === 0) return [];
  for (const t of textos) {
    if (typeof t !== 'string' || t.trim() === '') {
      throw fallo('ERROR_INTERNO', MSG_INTERNO, 500, 'pedirEmbeddings() recibió un texto vacío. trocear() nunca debería devolver uno.');
    }
  }

  const modelo = modeloEmbed();
  const dims = dimensiones();
  const conPrefijo = /embedding-2/i.test(modelo);
  const vectores = [];
  const hasta = opciones?.hasta ?? null;
  // Las preguntas son textos cortos: no necesitan los 60 s de un lote de 50
  // trozos (ver TIMEOUT_EMBED_PREGUNTA_MS arriba de todo).
  const msTimeout = inputType === 'query' ? TIMEOUT_EMBED_PREGUNTA_MS : TIMEOUT_EMBEDDINGS_MS;

  for (let i = 0; i < textos.length; i += TAMANO_LOTE) {
    const lote = textos.slice(i, i + TAMANO_LOTE);
    // La pausa va ANTES del lote y solo a partir del segundo: el primero sale
    // al toque, asi una nota corta (un solo lote) no espera de mas.
    if (i > 0) await esperar(PAUSA_ENTRE_LOTES_MS);

    const pedidos = lote.map((texto, j) => {
      // i + j: la posicion del trozo en el array ENTERO, no en el lote.
      const titulo = titulos ? tituloParaEmbeber(titulos[i + j]) : null;
      const pedido = {
        model: `models/${modelo}`,
        content: {
          parts: [{
            text: conPrefijo
              ? (inputType === 'query' ? `task: search result | query: ${texto}` : `title: ${titulo ?? 'none'} | text: ${texto}`)
              : texto,
          }],
        },
        outputDimensionality: dims,
      };
      if (!conPrefijo) {
        pedido.taskType = inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
        if (titulo) pedido.title = titulo;
      }
      return pedido;
    });

    const json = await pedirAGoogle(
      `${baseUrl()}/models/${modelo}:batchEmbedContents`,
      { requests: pedidos },
      msTimeout,
      { autenticacion: 'cabecera', hasta },
    );

    // batchEmbedContents devuelve los vectores EN EL MISMO ORDEN que los
    // pedidos (no trae un "index" como la API de OpenAI).
    const datos = Array.isArray(json?.embeddings) ? json.embeddings : [];
    if (datos.length !== lote.length) {
      throw fallo('IA_NO_RESPONDE', MSG_IA_CAIDA, 503, `Pedimos ${lote.length} embeddings y Google devolvió ${datos.length}.`);
    }
    for (const d of datos) vectores.push(recortarYNormalizar(d?.values, dims));
  }

  return vectores;
}

// ============================================================
//  CHAT
// ============================================================

/**
 * Saca el razonamiento que se haya colado en la respuesta, por si algun
 * modelo lo devuelve adentro del texto:
 *   <think>borrador</think>respuesta -> se va el bloque entero
 *   borrador</think>respuesta        -> nos quedamos con lo de despues
 */
export function sacarRazonamiento(texto) {
  let limpio = String(texto ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const cierre = limpio.toLowerCase().lastIndexOf('</think>');
  if (cierre !== -1) limpio = limpio.slice(cierre + '</think>'.length);
  return limpio.trim();
}

/**
 * Le manda la conversacion al modelo de chat y devuelve el texto pelado.
 *
 * @param {{role:'system'|'user'|'assistant', content:string}[]} mensajes
 * @param {{temperatura?:number, maxTokens?:number, topP?:number,
 *          hasta?:number|null, msPorModelo?:number}} opciones
 *   Las dos ultimas son opcionales; sin ellas chatear() hace lo de siempre.
 *   - hasta: fecha limite (Date.now() en ms) para TODA la cadena de modelos.
 *     Cada modelo tiene como mucho lo que queda, y si ya no queda, no se
 *     prueba el siguiente.
 *   - msPorModelo: timeout de cada modelo, en vez de los 25 s del chat.
 *   /preguntar las usa asi: la respuesta va con lo que queda de los 75 s de
 *   la vuelta; la reformulacion de un seguimiento, con un plazo corto propio
 *   y un timeout por modelo mas corto todavia, para que si el principal se
 *   cuelga el siguiente entre en el plazo.
 * @returns {Promise<string>}
 *
 * temperatura 0.2 y no 0.7: para un RAG queremos que copie lo que dicen los
 * fragmentos, no que invente lindo. Cuanto mas baja, menos se manda macanas.
 */
export async function chatear(mensajes, opciones = {}) {
  if (!Array.isArray(mensajes) || mensajes.length === 0) {
    throw fallo('ERROR_INTERNO', MSG_INTERNO, 500, 'chatear() esperaba un array de mensajes con al menos uno.');
  }

  // LA CADENA DE MODELOS: si el principal no existe, no contesta o se quedo
  // sin cupo, probamos el siguiente en vez de reintentar el mismo. Los errores
  // de la CLAVE cortan ahi nomas: con otro modelo de la misma clave pasaria
  // exactamente lo mismo.
  const modelos = cadenaDeModelosChat();
  const hasta = opciones.hasta ?? null;
  const msPorModelo = opciones.msPorModelo ?? TIMEOUT_CHAT_MS;
  const razonamiento = (process.env.GEMINI_RAZONAMIENTO || '').trim() || RAZONAMIENTO_POR_DEFECTO;
  let ultimoError = null;

  for (let i = 0; i < modelos.length; i++) {
    const modelo = modelos[i];
    const hayOtro = i < modelos.length - 1;
    try {
      const json = await pedirAGoogle(
        `${baseUrl()}/openai/chat/completions`,
        {
          model: modelo,
          messages: mensajes,
          temperature: opciones.temperatura ?? 0.2,
          top_p: opciones.topP ?? 0.9,
          // Holgado a proposito: en Gemini 3 el razonamiento (que no se puede
          // apagar) tambien gasta tokens, y con poco margen la respuesta se
          // corta a la mitad.
          max_tokens: opciones.maxTokens ?? 2048,
          reasoning_effort: razonamiento,
          stream: false, // sin streaming: la respuesta se guarda entera en Firestore
        },
        msPorModelo,
        // Con respaldo, un solo intento: probar otro modelo es mas rapido que
        // esperar al mismo. El ultimo de la cadena si se banca reintentos.
        { maxIntentos: hayOtro ? 1 : 2, autenticacion: 'bearer', hasta },
      );

      const salida = sacarRazonamiento(json?.choices?.[0]?.message?.content);
      if (!salida) {
        throw culpaDelModelo(fallo('IA_NO_RESPONDE', MSG_IA_CAIDA, 503, `Google devolvió una respuesta de chat vacía (${modelo}).`));
      }
      if (i > 0) console.warn(`[ia] Contestó el modelo de respaldo ${modelo}.`);
      return salida;
    } catch (err) {
      ultimoError = err;
      // Si se termino el tiempo de la vuelta, el modelo siguiente tampoco lo
      // tendria: cortamos aca en vez de "probarlo" sin tiempo.
      if (!err?.culpaDelModelo || !hayOtro || err.sinTiempo) throw err;
      console.warn(`[ia] El modelo ${modelo} falló (${err.detalle}). Pruebo con ${modelos[i + 1]}.`);
    }
  }
  throw ultimoError; // inalcanzable: el ultimo modelo siempre tira o devuelve
}

// ============================================================
//  Para los tests, los scripts y /salud
// ============================================================

/** Cuenta que clave estamos usando, SIN mostrar la clave (obvio). */
export function estadoDeLaClave() {
  return {
    usandoRespaldo,
    hayPrincipal: Boolean((process.env.GEMINI_API_KEY || '').trim()),
    hayRespaldo: Boolean((process.env.GEMINI_API_KEY_RESPALDO || '').trim()),
  };
}

/** Los modelos que se estan usando, para mostrarlos en los scripts. */
export function modelosEnUso() {
  return { chat: cadenaDeModelosChat(), embeddings: modeloEmbed(), razonamiento: (process.env.GEMINI_RAZONAMIENTO || '').trim() || RAZONAMIENTO_POR_DEFECTO };
}

/** Vuelve a la clave principal. Solo lo usan los tests. */
export function reiniciarClave() {
  usandoRespaldo = false;
}
