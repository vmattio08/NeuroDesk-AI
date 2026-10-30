// ============================================================
//  servicios/buscar.js
//  El corazon del RAG y, sobre todo, EL FILTRO DE PRIVACIDAD.
//
//  Este archivo es el que hay que saber defender de memoria: es el
//  requisito 2 de la materia ("cada rol ve solo lo suyo") hecho codigo.
//
//  LA REGLA MADRE: FAIL-CLOSED. Si no podemos PROBAR que el que pregunta
//  puede ver un chunk, el chunk se descarta. Nunca al reves. "No encontre el
//  item, lo dejo pasar" es exactamente el bug que filtra una nota privada.
//
//  LAS DOS CERRADURAS (van con AND, nunca con OR):
//    (a) EN VIVO: el itemId del chunk tiene que estar en el conjunto de items
//        que ese uid puede ver AHORA, leido de Firestore en esta misma
//        pregunta. Es la que manda.
//    (b) EN EL DATO: ademas, la copia de visibilidad/creadoPor que cada chunk
//        guarda tiene que dar permiso. Es defensa en profundidad. El autor
//        no se cambia desde ningun lado de la app, y la visibilidad la
//        reescribe en TODOS los chunks el candado en vivo (PATCH
//        .../visibilidad, rutas/items-extra.js), sin reprocesar: las reglas
//        no dejan cambiarla de otra forma desde la app. Igual PUEDE QUEDAR
//        VIEJA: un instante en el medio de ese pedido ("primero cerrar,
//        ultimo abrir"), si el pedido se corta a la mitad (hasta que se
//        reintente) o si alguien toca el item desde la consola o con el
//        Admin SDK (hasta el proximo reproceso o el proximo candado). Como
//        se aplica con AND y la que manda es (a), una copia vieja solo puede
//        ESCONDER DE MAS, nunca mostrar de mas.
//
//  SIN CACHE. Nada de guardarse "los items visibles de este uid" por 60
//  segundos: en esos 60 segundos alguien puede pasar una nota de 'equipo' a
//  'privado', o lo pueden echar del workspace, y la respuesta saldria con
//  datos que ya no le corresponden. Preferimos pagar las lecturas de Firestore
//  antes que tener una ventana de un minuto donde el filtro miente.
// ============================================================

// OJO CON ESTE IMPORT: espera que exista src/firebase.js exportando `db`
// (la instancia de Firestore del Admin SDK ya inicializada).
import { db } from '../firebase.js';
import { pedirEmbeddings } from './ia.js';

// --- Numeros -------------------------------------------------------------

// Cuantos fragmentos le pasamos al modelo como contexto. 6 x ~1600 caracteres
// son unos 10.000 caracteres: entra comodo en el prompt y alcanza para
// responder. Con mas, el modelo se pierde y la respuesta empeora.
export const MAX_FUENTES = 6;

// Por debajo de esto consideramos que el chunk NO habla de la pregunta.
// Con vectores normalizados el coseno va de -1 a 1.
//
// RECALIBRADO EL 29/10/2026, despues de sumar el TITULO del item a cada
// embedding (npm run calibrar, gemini-embedding-001 a 1024 dimensiones, contra
// los 48 chunks del workspace: los 40 del seed y 8 de items cargados desde la
// app). Las 11 preguntas con respuesta en el seed dieron entre 0.649 y 0.804
// (mediana 0.726), y las 11 encontraron su item en el PRIMER puesto. Las 5 que
// no tienen nada que ver (el dolar, el mundial, empanadas...) dieron entre
// 0.453 y 0.595. Los dos grupos NO se pisan, y 0.62 queda justo en el medio.
// (La medicion anterior, sin titulos, habia dado 0.67-0.84 contra 0.51-0.61,
// con el umbral en 0.64: con los titulos, ese 0.64 dejaba a la peor respuesta
// correcta pasando por 0.009.)
//
// OJO: el numero depende del MODELO, no es universal. Con el modelo anterior
// (nemotron de NVIDIA) las correctas daban 0.26 a 0.69 y el ruido 0.08 a 0.14:
// el umbral era 0.20. Gemini "aprieta" todo hacia arriba, ruido incluido. Si se
// cambia el modelo de embeddings (o lo que se le manda), HAY QUE VOLVER A
// CALIBRAR.
//
// Lo que se cuele por arriba lo frena la segunda barrera: el prompt le exige
// al modelo decir "No encontre" si los fragmentos no contestan, y sin citas
// validas la respuesta sale con aviso.
const UMBRAL_POR_DEFECTO = 0.62;

// Cuanto texto del chunk se guarda como cita visible en la respuesta.
const LARGO_FRAGMENTO = 240;

function umbral() {
  const n = Number.parseFloat(process.env.UMBRAL_SIMILITUD || '');
  return Number.isFinite(n) ? n : UMBRAL_POR_DEFECTO;
}

function fallo(codigo, mensaje, http, detalle = null) {
  const err = new Error(`${codigo}: ${mensaje}`);
  err.codigo = codigo;
  err.mensaje = mensaje;
  err.http = http;
  err.detalle = detalle;
  return err;
}

// ============================================================
//  SIMILITUD COSENO
// ============================================================

/**
 * Que tan parecidos son dos vectores. 1 = misma direccion (mismo tema),
 * 0 = no tienen nada que ver, -1 = opuestos.
 *
 * POR QUE COSENO Y NO DISTANCIA: el coseno mira el ANGULO entre los dos
 * vectores y no el largo. Un parrafo largo y uno corto sobre el mismo tema
 * apuntan para el mismo lado aunque tengan tamaños distintos; con distancia
 * comun, el largo del texto ensuciaria el resultado.
 *
 * Nuestros vectores ya salen normalizados (largo 1) de ia.js, asi que
 * dividir por los largos es casi al pedo... pero lo hacemos igual: es una
 * linea, cuesta nada, y si algun dia entra un vector sin normalizar la
 * funcion sigue dando el numero correcto en vez de devolver cualquier cosa.
 */
export function similitudCoseno(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0) return 0;
  // Largos distintos = alguien mezclo embeddings de dos modelos distintos.
  // Compararlos no significa nada, asi que devolvemos 0 (fail-closed tambien aca).
  if (a.length !== b.length) return 0;

  let producto = 0;
  let largoA = 0;
  let largoB = 0;

  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (typeof x !== 'number' || typeof y !== 'number') return 0;
    producto += x * y;
    largoA += x * x;
    largoB += y * y;
  }

  const divisor = Math.sqrt(largoA) * Math.sqrt(largoB);
  if (divisor === 0) return 0; // vector de ceros: nunca matchea con nada
  return producto / divisor;
}

/**
 * Traduce la similitud del MEJOR chunk al string que pide el contrato.
 * Es string y no numero a proposito: el numero crudo vive en fuentes[].similitud.
 */
export function nivelDeConfianza(mejorSimilitud) {
  // Cortes calibrados con la misma medicion que el umbral (ver arriba, Gemini
  // con titulos, 29/10/2026). 0.72 queda justo debajo de la mediana de las
  // respuestas correctas (0.726): un poco mas de la mitad de las buenas salen
  // 'alta' (7 de 11). 0.64 queda apenas debajo de la PEOR respuesta correcta
  // (0.649): todo lo que se parece a una respuesta real es al menos 'media'.
  // Entre el umbral (0.62) y 0.64 queda 'baja': paso el filtro, pero por poco.
  if (mejorSimilitud >= 0.72) return 'alta';
  if (mejorSimilitud >= 0.64) return 'media';
  return 'baja';
}

// ============================================================
//  PASO 1 - QUE ITEMS PUEDE VER ESTE UID (leido en vivo)
// ============================================================

/**
 * Devuelve un Set con los itemIds que ese uid tiene permitido ver AHORA.
 *
 * @param {string} wsId
 * @param {string} uid
 * @param {boolean} esAdmin  El rol sale de workspaces/{wsId}/members/{uid},
 *                           NUNCA del claim del token (que puede estar hasta
 *                           una hora desactualizado).
 *
 * POR QUE DOS QUERIES Y NO UN OR: Firestore no tiene un "where visibilidad ==
 * 'equipo' OR creadoPor == uid" que se pueda indexar barato. Se hacen las dos
 * consultas por separado y se juntan los ids en memoria. Es exactamente la
 * misma logica que las dos pestañas del muro de items en la app.
 *
 * POR QUE .select() SIN CAMPOS: asi Firestore devuelve SOLO los ids de los
 * documentos y no el contenido. Nos ahorra traer el campo `texto` de 200
 * items (megabytes) cuando lo unico que necesitamos son las claves.
 */
export async function itemsVisibles(wsId, uid, esAdmin) {
  const items = db.collection('workspaces').doc(wsId).collection('items');
  const visibles = new Set();

  if (esAdmin) {
    // El admin ve todo el workspace. Es LA diferencia de rol que se muestra
    // en la demo: la misma pregunta le devuelve mas fuentes.
    const todos = await items.select().get();
    for (const doc of todos.docs) visibles.add(doc.id);
    return visibles;
  }

  const [delEquipo, mios] = await Promise.all([
    items.where('visibilidad', '==', 'equipo').select().get(),
    items.where('creadoPor', '==', uid).select().get(),
  ]);

  for (const doc of delEquipo.docs) visibles.add(doc.id);
  for (const doc of mios.docs) visibles.add(doc.id); // el Set deduplica solo

  return visibles;
}

// ============================================================
//  PASO 2 - BUSCAR
// ============================================================

/**
 * Busca los fragmentos del workspace que mejor responden la pregunta,
 * mirando SOLO lo que ese uid puede ver.
 *
 * @param {string} wsId
 * @param {string} pregunta
 * @param {string} uid
 * @param {boolean} esAdmin
 * @param {{hasta?: number|null}} [opciones]
 *   hasta: fecha limite de la vuelta (Date.now() en ms) que pone /preguntar
 *   para entrar en los 90 s de la app. SOLO llega al embedding de la pregunta:
 *   el filtro de permisos no tiene apuro ni atajos, se hace entero siempre.
 * @returns {Promise<{
 *   fuentes: {n:number,chunkId:string,itemId:string,titulo:string,pagina:number|null,
 *             fragmento:string,texto:string,origen:string,similitud:number}[],
 *   chunksMirados:number, chunksVisibles:number,
 *   mejorSimilitud:number, confianza:'alta'|'media'|'baja', umbral:number
 * }>}
 *
 * Si no hay nada por encima del umbral devuelve fuentes: [] y confianza
 * 'baja'. ESO NO ES UN ERROR: el endpoint responde 200 con "No encontré esto
 * en la base del equipo". Preferimos mil veces decir "no sé" que inventar.
 */
export async function buscarChunks(wsId, pregunta, uid, esAdmin, opciones = {}) {
  const texto = String(pregunta ?? '').trim();
  if (texto.length < 3) {
    throw fallo(
      'DATOS_INVALIDOS',
      'Faltan datos o están mal cargados. Revisá el formulario.',
      400,
      'La pregunta tiene que tener al menos 3 caracteres.',
    );
  }

  // --- 1. El conjunto de items visibles, EN VIVO, ANTES de rankear nada -----
  // Va primero a proposito: si esto falla, no gastamos un solo credito de IA.
  const visibles = await itemsVisibles(wsId, uid, esAdmin);

  // --- 2. Todos los chunks del workspace ------------------------------------
  // El where('workspaceId','==',wsId) es lo que impide que un workspace vea el
  // conocimiento de otro, y es OBLIGATORIO aunque la coleccion sea plana.
  //
  // COSTO (medido, va en el informe): con 200 items indexados son ~2.800
  // lecturas por pregunta, o sea unas 17 preguntas por dia en el plan gratis
  // de Firestore. Es caro y lo sabemos: la alternativa seria una base
  // vectorial de verdad, que no entra en el alcance del TP. Preferimos que el
  // filtro sea siempre correcto antes que barato.
  const snap = await db.collection('chunks').where('workspaceId', '==', wsId).get();
  const chunksMirados = snap.size;

  // --- 3. EL FILTRO. Las dos cerraduras, con AND ----------------------------
  const permitidos = [];
  for (const doc of snap.docs) {
    const c = doc.data();

    // Cerradura (a): el item tiene que estar en el conjunto leido recien.
    // FAIL-CLOSED: si el item fue borrado, si cambio a 'privado' de otro, o si
    // simplemente no aparece, el chunk NO pasa. Nunca preguntamos "¿existirá?".
    if (!c?.itemId || !visibles.has(c.itemId)) continue;

    // Cerradura (b): la copia de permisos que vive en el propio chunk.
    const permitePorElDato = esAdmin || c.visibilidad === 'equipo' || c.creadoPor === uid;
    if (!permitePorElDato) continue;

    // Paranoia barata: el campo workspaceId tiene que coincidir con el path.
    // Si alguna vez no coincide, es un bug de seguridad (invariante 4 del modelo).
    if (c.workspaceId !== wsId) continue;

    if (!Array.isArray(c.embedding) || typeof c.texto !== 'string' || !c.texto.trim()) continue;

    permitidos.push({ id: doc.id, ...c });
  }
  const chunksVisibles = permitidos.length;

  // Si el workspace esta vacio o el usuario no puede ver nada, cortamos ACA.
  // Sin esto pagariamos un embedding de la pregunta para compararlo contra 0
  // chunks: gasto puro. Y ademas es el resultado correcto del test de
  // privacidad (A sube una nota privada, B pregunta, fuentes viene vacio).
  if (chunksVisibles === 0) {
    return {
      fuentes: [],
      chunksMirados,
      chunksVisibles: 0,
      mejorSimilitud: 0,
      confianza: 'baja',
      umbral: umbral(),
    };
  }

  // --- 4. Vectorizar la pregunta -------------------------------------------
  // input_type 'query' y NO 'passage'. Es asimetrico y obligatorio: al indexar
  // va 'passage', al preguntar va 'query'. Si se manda mal, el buscador sigue
  // andando pero responde peor, y es un bug silencioso carisimo de encontrar.
  const [vectorPregunta] = await pedirEmbeddings([texto], 'query', { hasta: opciones?.hasta ?? null });

  // --- 5. Rankear ----------------------------------------------------------
  const puntuados = permitidos.map((c) => ({
    chunk: c,
    similitud: similitudCoseno(vectorPregunta, c.embedding),
  }));

  puntuados.sort((a, b) => b.similitud - a.similitud);

  const piso = umbral();
  const mejores = puntuados.filter((p) => p.similitud >= piso).slice(0, MAX_FUENTES);
  const mejorSimilitud = puntuados.length > 0 ? puntuados[0].similitud : 0;

  const fuentes = mejores.map((p, i) => ({
    n: i + 1, // el numerito de la cita [1] [2] que se muestra en la respuesta
    chunkId: p.chunk.id,
    itemId: p.chunk.itemId,
    titulo: p.chunk.titulo ?? '',
    pagina: p.chunk.pagina ?? null,
    fragmento: recorteParaCitar(p.chunk.texto),
    texto: p.chunk.texto, // el trozo entero, para armar el prompt
    origen: p.chunk.origen ?? null,
    // Redondeamos a 2 decimales: es lo que se guarda en Firestore y lo que se
    // muestra. 0.8342719... no le dice nada a nadie.
    similitud: Math.round(p.similitud * 100) / 100,
  }));

  return {
    fuentes,
    chunksMirados,
    chunksVisibles,
    mejorSimilitud: Math.round(mejorSimilitud * 100) / 100,
    // La confianza sale del MEJOR chunk que efectivamente citamos. Si no
    // citamos ninguno, es 'baja' aunque el mejor rechazado estuviera cerca.
    confianza: fuentes.length > 0 ? nivelDeConfianza(mejorSimilitud) : 'baja',
    umbral: piso,
  };
}

/** Corta el fragmento para mostrarlo como cita, sin partir una palabra al medio. */
function recorteParaCitar(texto) {
  const t = String(texto ?? '').trim();
  if (t.length <= LARGO_FRAGMENTO) return t;
  const cortado = t.slice(0, LARGO_FRAGMENTO);
  const ultimoEspacio = cortado.lastIndexOf(' ');
  return (ultimoEspacio > 100 ? cortado.slice(0, ultimoEspacio) : cortado).trim() + '…';
}
