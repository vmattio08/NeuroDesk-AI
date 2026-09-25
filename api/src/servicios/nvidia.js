// ============================================================
//  servicios/nvidia.js
//  El unico archivo que le habla a NVIDIA NIM.
//
//  Dos funciones y nada mas:
//    - pedirEmbeddings(textos, inputType) -> array de vectores
//    - chatear(mensajes, opciones)        -> string con la respuesta
//
//  POR QUE fetch crudo y no el SDK de OpenAI: la API de NVIDIA es
//  compatible con la de OpenAI, asi que el SDK andaria; pero son 3 MB de
//  dependencia para hacer un POST con JSON. Con fetch vemos exactamente
//  que sale y que vuelve, que es lo que tenemos que poder explicar.
//
//  POR QUE los IDs de modelo salen de process.env y NUNCA hardcodeados:
//  NVIDIA da de baja modelos sin avisar (responden HTTP 410). Cuando pasa,
//  se cambia UNA linea del .env y se reinicia; no se toca el codigo.
//  El script scripts/chequear-modelos.js avisa los lunes si murio alguno.
// ============================================================

// --- Constantes del servicio (con el POR QUE de cada numero) ---------------

// El plan gratis de NVIDIA tope en ~40 requests por minuto. Mandando lotes de
// 32 textos y esperando 1600 ms entre lote y lote quedamos en ~37 req/min:
// abajo del techo, con un poquito de aire para los reintentos.
const TAMANO_LOTE = 32;
const PAUSA_ENTRE_LOTES_MS = 1600;

// Cuantas veces reintentamos cuando la culpa NO es nuestra (429 o 5xx).
const MAX_INTENTOS = 3;

// Cuanto esperamos a que conteste antes de cortar. Los embeddings de un lote
// de 32 tardan bastante mas que un chat corto, por eso son dos numeros.
const TIMEOUT_EMBEDDINGS_MS = 60_000;
const TIMEOUT_CHAT_MS = 45_000;

// --- Estado del modulo -----------------------------------------------------

// Empezamos con la clave principal. Si NVIDIA nos dice que se acabaron los
// creditos (402) o que la clave no sirve (401), pasamos a la de respaldo y
// NOS QUEDAMOS ahi hasta que se reinicie el servidor: no tiene sentido volver
// a golpear una clave que ya sabemos que esta quemada en cada pedido.
let usandoRespaldo = false;

// ============================================================
//  Helpers chiquitos
// ============================================================

/**
 * Arma el error con la forma UNICA del contrato. Todos los servicios tiran
 * errores asi y el middleware final del server solo los tiene que envolver.
 * OJO con "detalle": va SOLO texto escrito por nosotros a mano. Nunca un
 * err.message crudo ni el body de NVIDIA, porque ahi pueden viajar pedazos
 * de configuracion, hostnames internos o (peor) la clave.
 */
function fallo(codigo, mensaje, http, detalle = null) {
  const err = new Error(`${codigo}: ${mensaje}`);
  err.codigo = codigo;
  err.mensaje = mensaje;
  err.http = http;
  err.detalle = detalle;
  return err;
}

const esperar = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

// Backoff: 1s, 3s, 7s. Le sumamos un ruidito al azar ("jitter") para que si
// dos pedidos se comen el mismo 429 no reintenten los dos en el mismo
// milisegundo y se vuelvan a chocar.
function esperaDelIntento(intento) {
  const base = [1000, 3000, 7000][Math.min(intento - 1, 2)];
  return base + Math.floor(Math.random() * 400);
}

// --- Lectura del entorno ---------------------------------------------------
// Se lee ADENTRO de las funciones y no arriba de todo a proposito: asi el
// modulo se puede importar en un test sin tener el .env cargado todavia.

function baseUrl() {
  const url = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';
  return url.replace(/\/+$/, ''); // sin barra final, la agregamos nosotros
}

function claveEnUso() {
  const principal = (process.env.NVIDIA_API_KEY || '').trim();
  const respaldo = (process.env.NVIDIA_API_KEY_BACKUP || '').trim();
  return usandoRespaldo ? respaldo : principal;
}

/**
 * Pasa a la clave de respaldo. Devuelve true si efectivamente cambio algo
 * (o sea: si habia respaldo configurado y todavia no lo estabamos usando).
 */
function pasarAlRespaldo() {
  const respaldo = (process.env.NVIDIA_API_KEY_BACKUP || '').trim();
  if (usandoRespaldo || !respaldo) return false;
  usandoRespaldo = true;
  console.warn('[nvidia] La clave principal fallo. Pasando a NVIDIA_API_KEY_BACKUP.');
  return true;
}

function modeloEmbed() {
  const id = (process.env.NVIDIA_MODELO_EMBED || '').trim();
  if (!id) {
    throw fallo(
      'ERROR_INTERNO',
      'Algo salió mal de nuestro lado. Ya lo estamos viendo, probá de nuevo.',
      500,
      'Falta NVIDIA_MODELO_EMBED en el entorno del servidor.',
    );
  }
  return id;
}

function modeloChat() {
  const id = (process.env.NVIDIA_MODELO_CHAT || '').trim();
  if (!id) {
    throw fallo(
      'ERROR_INTERNO',
      'Algo salió mal de nuestro lado. Ya lo estamos viendo, probá de nuevo.',
      500,
      'Falta NVIDIA_MODELO_CHAT en el entorno del servidor.',
    );
  }
  return id;
}

/** Cuantas dimensiones guardamos de cada vector. El modelo de datos dice 1024. */
export function dimensiones() {
  const n = Number.parseInt(process.env.EMBED_DIMS || '1024', 10);
  return Number.isFinite(n) && n > 0 ? n : 1024;
}

// ============================================================
//  El pedido HTTP, con todo el manejo de errores en UN solo lugar
// ============================================================

/**
 * Lee el cuerpo de una respuesta con error SOLO para decidir que hacer.
 * Lo que sale de aca va al console.error del servidor, NUNCA al cliente.
 */
async function leerErrorParaElLog(res) {
  try {
    const txt = await res.text();
    return txt.slice(0, 400);
  } catch {
    return '(sin cuerpo)';
  }
}

/**
 * POST a NVIDIA con reintentos, backoff y caida a la clave de respaldo.
 *
 * La tabla de decisiones (esto es lo que hay que saber explicar):
 *   401/403 -> la clave no sirve. Probamos la de respaldo UNA vez; si tampoco,
 *              es un problema NUESTRO de configuracion -> ERROR_INTERNO.
 *              No reintentamos: reintentar una clave invalida es al pedo.
 *   402     -> se acabaron los creditos. Probamos la de respaldo; si tampoco
 *              -> SIN_CREDITOS_IA (402), que el cliente muestra tal cual.
 *   410     -> NVIDIA dio de baja el modelo. NO se reintenta nunca: va a fallar
 *              siempre hasta que cambiemos el ID en el .env.
 *   429     -> nos pasamos de pedidos. Reintento con backoff (respetando
 *              Retry-After si viene) y recien despues DEMASIADOS_PEDIDOS.
 *   5xx     -> se cayo NVIDIA. Reintento con backoff, despues IA_NO_RESPONDE.
 *   timeout -> igual que 5xx.
 */
async function pedirANvidia(ruta, cuerpo, msTimeout) {
  let intento = 0;
  let cambiosDeClave = 0;

  // while(true) y no un for, porque cambiar de clave NO gasta un intento:
  // es el mismo pedido con otra credencial.
  while (true) {
    const clave = claveEnUso();
    if (!clave) {
      throw fallo(
        'ERROR_INTERNO',
        'Algo salió mal de nuestro lado. Ya lo estamos viendo, probá de nuevo.',
        500,
        'No hay NVIDIA_API_KEY configurada en el servidor.',
      );
    }

    intento += 1;
    let res;
    try {
      res = await fetch(baseUrl() + ruta, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${clave}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(cuerpo),
        // AbortSignal.timeout corta la conexion sola. Sin esto, un pedido
        // colgado se queda tomando memoria hasta que Render reinicie.
        signal: AbortSignal.timeout(msTimeout),
      });
    } catch (err) {
      // Aca caen: timeout, DNS caido, conexion cortada a la mitad.
      console.error('[nvidia] fetch fallo:', err?.name, err?.message);
      if (intento < MAX_INTENTOS) {
        await esperar(esperaDelIntento(intento));
        continue;
      }
      throw fallo(
        'IA_NO_RESPONDE',
        'El servicio de IA no está respondiendo. Probá de nuevo en un minuto.',
        503,
        'NVIDIA no contestó dentro del tiempo de espera.',
      );
    }

    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw fallo(
          'IA_NO_RESPONDE',
          'El servicio de IA no está respondiendo. Probá de nuevo en un minuto.',
          503,
          'NVIDIA contestó algo que no era JSON.',
        );
      }
    }

    const cuerpoError = await leerErrorParaElLog(res);
    console.error(`[nvidia] HTTP ${res.status} en ${ruta} -> ${cuerpoError}`);

    // A veces el "se acabaron los creditos" no viene como 402 sino como 400 o
    // 403 con la palabra credit/quota en el texto. Lo detectamos a mano.
    const pareceFaltaDeCreditos =
      res.status === 402 || /credit|quota|insufficient|exceeded/i.test(cuerpoError);

    if (res.status === 401 || res.status === 403 || pareceFaltaDeCreditos) {
      if (cambiosDeClave === 0 && pasarAlRespaldo()) {
        cambiosDeClave += 1;
        intento -= 1; // cambiar de clave no gasta intento
        continue;
      }
      if (pareceFaltaDeCreditos) {
        throw fallo(
          'SIN_CREDITOS_IA',
          'Se acabaron los créditos de la IA por este mes. Avisale al administrador.',
          402,
          'NVIDIA rechazó el pedido por falta de créditos (y la clave de respaldo tampoco alcanzó).',
        );
      }
      throw fallo(
        'ERROR_INTERNO',
        'Algo salió mal de nuestro lado. Ya lo estamos viendo, probá de nuevo.',
        500,
        'NVIDIA rechazó la clave de la API (401/403). Hay que revisarla en el .env.',
      );
    }

    if (res.status === 410) {
      // Gone. El modelo fue dado de baja. Reintentar no sirve para nada.
      throw fallo(
        'ERROR_INTERNO',
        'Algo salió mal de nuestro lado. Ya lo estamos viendo, probá de nuevo.',
        500,
        `NVIDIA dio de baja el modelo "${cuerpo.model}". Hay que cambiar el ID en el .env.`,
      );
    }

    if (res.status === 429) {
      if (intento < MAX_INTENTOS) {
        // Si NVIDIA nos dice cuanto esperar, le hacemos caso; si no, backoff.
        const retryAfter = Number.parseInt(res.headers.get('retry-after') || '', 10);
        const ms = Number.isFinite(retryAfter) ? retryAfter * 1000 : esperaDelIntento(intento);
        await esperar(Math.min(ms, 15_000)); // nunca mas de 15 s, o el request muere de viejo
        continue;
      }
      throw fallo(
        'DEMASIADOS_PEDIDOS',
        'Estás yendo muy rápido. Esperá unos segundos y probá de nuevo.',
        429,
        'NVIDIA nos limitó por cantidad de pedidos (429) después de 3 intentos.',
      );
    }

    if (res.status >= 500 && intento < MAX_INTENTOS) {
      await esperar(esperaDelIntento(intento));
      continue;
    }

    throw fallo(
      'IA_NO_RESPONDE',
      'El servicio de IA no está respondiendo. Probá de nuevo en un minuto.',
      503,
      `NVIDIA respondió HTTP ${res.status}.`,
    );
  }
}

// ============================================================
//  Vectores: recorte + normalizacion L2
// ============================================================

/**
 * Deja el vector en exactamente EMBED_DIMS numeros y lo re-normaliza.
 *
 * POR QUE SE RECORTA: algunos modelos de NVIDIA devuelven 2048 o 4096 dims.
 * Nuestro modelo de datos dice 1024 y un documento de Firestore no puede
 * pasar de 1 MiB; guardar 4096 floats por chunk nos come la cuota al pedo.
 * Estos modelos estan entrenados con "Matryoshka", o sea que las primeras
 * dimensiones ya concentran casi toda la informacion: cortar por la mitad
 * casi no baja la calidad de la busqueda.
 *
 * POR QUE SE RE-NORMALIZA DESPUES DE CORTAR: el vector venia con largo 1.
 * Si le sacas la mitad de las componentes, el largo YA NO es 1. Como la
 * similitud coseno divide por los largos, con vectores de largo distinto los
 * numeros dejan de ser comparables entre si. Renormalizando, coseno vuelve a
 * ser simplemente el producto punto y todos los puntajes viven en la misma
 * escala (que es la que usamos para el umbral y para 'alta/media/baja').
 */
export function recortarYNormalizar(vector, dims = dimensiones()) {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw fallo(
      'IA_NO_RESPONDE',
      'El servicio de IA no está respondiendo. Probá de nuevo en un minuto.',
      503,
      'NVIDIA devolvió un embedding vacío.',
    );
  }

  const corto = vector.slice(0, dims).map(Number);

  let sumaDeCuadrados = 0;
  for (const n of corto) {
    if (!Number.isFinite(n)) {
      throw fallo(
        'IA_NO_RESPONDE',
        'El servicio de IA no está respondiendo. Probá de nuevo en un minuto.',
        503,
        'NVIDIA devolvió un embedding con valores que no son números.',
      );
    }
    sumaDeCuadrados += n * n;
  }

  const largo = Math.sqrt(sumaDeCuadrados);
  // Si el largo es 0 no se puede dividir: devolvemos el vector tal cual para
  // no generar NaN. Un vector de ceros nunca va a matchear con nada, que es
  // exactamente lo que queremos que pase.
  if (largo === 0) return corto;

  return corto.map((n) => n / largo);
}

// ============================================================
//  EMBEDDINGS
// ============================================================

/**
 * Convierte textos en vectores.
 *
 * @param {string[]} textos    Los trozos a vectorizar, en orden.
 * @param {'passage'|'query'} inputType
 * @returns {Promise<number[][]>} Un vector por texto, EN EL MISMO ORDEN.
 *
 * EL input_type ES ASIMETRICO Y OBLIGATORIO. Este tipo de modelo se entrena
 * con dos "modos": los documentos que se guardan van como 'passage' y la
 * pregunta que se busca va como 'query'. Si mandas los dos con el mismo valor
 * el buscador SIGUE ANDANDO pero contesta peor, y es un bug silencioso
 * carisimo de encontrar (no hay error, solo respuestas mediocres). Por eso el
 * parametro es obligatorio y validado: preferimos reventar antes que adivinar.
 */
export async function pedirEmbeddings(textos, inputType) {
  if (!Array.isArray(textos)) {
    throw fallo(
      'ERROR_INTERNO',
      'Algo salió mal de nuestro lado. Ya lo estamos viendo, probá de nuevo.',
      500,
      'pedirEmbeddings() esperaba un array de textos.',
    );
  }
  if (inputType !== 'passage' && inputType !== 'query') {
    throw fallo(
      'ERROR_INTERNO',
      'Algo salió mal de nuestro lado. Ya lo estamos viendo, probá de nuevo.',
      500,
      "input_type tiene que ser 'passage' (al indexar) o 'query' (al preguntar).",
    );
  }
  if (textos.length === 0) return [];

  for (const t of textos) {
    if (typeof t !== 'string' || t.trim() === '') {
      throw fallo(
        'ERROR_INTERNO',
        'Algo salió mal de nuestro lado. Ya lo estamos viendo, probá de nuevo.',
        500,
        'pedirEmbeddings() recibió un texto vacío. trocear() nunca debería devolver uno.',
      );
    }
  }

  const modelo = modeloEmbed();
  const dims = dimensiones();
  const vectores = [];

  for (let i = 0; i < textos.length; i += TAMANO_LOTE) {
    const lote = textos.slice(i, i + TAMANO_LOTE);

    // La pausa va ANTES del lote y solo a partir del segundo: el primero sale
    // al toque, asi una nota corta (un solo lote) no espera 1,6 s al pedo.
    if (i > 0) await esperar(PAUSA_ENTRE_LOTES_MS);

    const json = await pedirANvidia(
      '/embeddings',
      {
        model: modelo,
        input: lote,
        input_type: inputType,
        encoding_format: 'float',
        // Si un trozo se pasa de la ventana del modelo, que lo corte NVIDIA
        // en vez de devolvernos un 400 y romper todo el indexado.
        truncate: 'END',
      },
      TIMEOUT_EMBEDDINGS_MS,
    );

    const datos = Array.isArray(json?.data) ? [...json.data] : [];
    if (datos.length !== lote.length) {
      throw fallo(
        'IA_NO_RESPONDE',
        'El servicio de IA no está respondiendo. Probá de nuevo en un minuto.',
        503,
        `Pedimos ${lote.length} embeddings y NVIDIA devolvió ${datos.length}.`,
      );
    }

    // La API NO garantiza el orden: cada resultado trae su "index". Si no
    // ordenamos, el chunk 3 se puede quedar con el vector del chunk 7 y las
    // citas salen cruzadas. Ordenamos siempre, aunque casi siempre ya venga bien.
    datos.sort((a, b) => (a?.index ?? 0) - (b?.index ?? 0));

    for (const d of datos) {
      vectores.push(recortarYNormalizar(d?.embedding, dims));
    }
  }

  return vectores;
}

// ============================================================
//  CHAT
// ============================================================

/**
 * Le manda la conversacion al modelo de chat y devuelve el texto pelado.
 *
 * @param {{role:'system'|'user'|'assistant', content:string}[]} mensajes
 * @param {{temperatura?:number, maxTokens?:number}} opciones
 * @returns {Promise<string>}
 *
 * temperatura 0.2 y no 0.7: para un RAG queremos que copie lo que dicen los
 * fragmentos, no que invente lindo. Cuanto mas baja, menos se manda macanas.
 */
export async function chatear(mensajes, opciones = {}) {
  if (!Array.isArray(mensajes) || mensajes.length === 0) {
    throw fallo(
      'ERROR_INTERNO',
      'Algo salió mal de nuestro lado. Ya lo estamos viendo, probá de nuevo.',
      500,
      'chatear() esperaba un array de mensajes con al menos uno.',
    );
  }

  const json = await pedirANvidia(
    '/chat/completions',
    {
      model: modeloChat(),
      messages: mensajes,
      temperature: opciones.temperatura ?? 0.2,
      top_p: opciones.topP ?? 0.9,
      max_tokens: opciones.maxTokens ?? 700,
      stream: false, // sin streaming: la respuesta se guarda entera en Firestore
    },
    TIMEOUT_CHAT_MS,
  );

  const salida = json?.choices?.[0]?.message?.content;
  if (typeof salida !== 'string' || salida.trim() === '') {
    throw fallo(
      'IA_NO_RESPONDE',
      'El servicio de IA no está respondiendo. Probá de nuevo en un minuto.',
      503,
      'NVIDIA devolvió una respuesta de chat vacía.',
    );
  }

  // Los modelos "de razonamiento" (nemotron entre ellos) a veces meten su
  // borrador adentro de <think>...</think>. Eso es basura para el usuario:
  // lo sacamos antes de guardarlo en Firestore.
  return salida.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// ============================================================
//  Para los tests y para /salud
// ============================================================

/** Cuenta que clave estamos usando, SIN mostrar la clave (obvio). */
export function estadoDeLaClave() {
  return {
    usandoRespaldo,
    hayPrincipal: Boolean((process.env.NVIDIA_API_KEY || '').trim()),
    hayRespaldo: Boolean((process.env.NVIDIA_API_KEY_BACKUP || '').trim()),
  };
}

/** Vuelve a la clave principal. Solo lo usan los tests. */
export function reiniciarClave() {
  usandoRespaldo = false;
}
