// ============================================================================
//  scripts/seed.js  —  CREA Y LLENA la base de NeuroDesk AI
//
//  Uso:   node --env-file=.env scripts/seed.js
//         npm run seed        (hace exactamente lo mismo)
//
//  QUE HACE
//  Deja armada, de una sola corrida, una base realista de un colegio:
//  1 workspace, 4 usuarios (1 admin + 3 miembros, uno de ellos Lucas, el que
//  se saca en la demo) creados de verdad en Firebase Auth, sus documentos en
//  usuarios/ y en members/, 17 items de los cuatro tipos y en los cuatro
//  estados, 45 chunks con embeddings del largo correcto, 3 respuestas con sus
//  fuentes citadas, 23 eventos y el documento de suscripcion. Es lo que se ve
//  en las capturas de la consola de Firebase.
//  Lo de Lucas (su cuenta, sus 3 items y sus eventos) vive en _comun.js,
//  porque tambien lo usa scripts/sumar-lucas.js, que se lo agrega a un
//  espacio que ya existe SIN borrar nada.
//
//  ES IDEMPOTENTE: correrlo dos, tres o diez veces deja EXACTAMENTE la misma
//  base. Tres decisiones lo consiguen:
//    (a) TODOS los ids son fijos y deterministicos (wsId, uid, itemId,
//        chunkId = itemId_idx, respId, eventoId). No hay ni un add() ni un
//        doc() sin id: si los hubiera, cada corrida agregaria duplicados.
//    (b) TODAS las fechas son fijas (no serverTimestamp()), asi el documento
//        que queda es identico byte por byte. En la app de verdad las fechas
//        las pone el servidor: las reglas lo exigen comparando con request.time.
//    (c) Antes de escribir los chunks se borran TODOS los del workspace. Es la
//        misma regla que el invariante 5 le exige a la funcion indexar() del
//        backend: si una corrida vieja dejo 9 chunks y esta escribe 7, los dos
//        sobrantes no pueden sobrevivir con texto viejo.
//
//  ESTE SCRIPT USA EL ADMIN SDK, ASI QUE SE SALTEA LAS REGLAS DE FIRESTORE.
//  Por eso puede escribir campos que el cliente tiene prohibidos (texto,
//  cantChunks, chunks, eventos). Igual respeta a mano la tabla de "quien
//  escribe que": un item en 'pendiente' queda con EXACTAMENTE los campos que
//  escribiria Flutter, ni uno mas. Si no, las capturas mostrarian una base que
//  la app no puede producir, y eso en la defensa se nota.
// ============================================================================

import {
  conectar,
  fecha,
  escribirEnLotes,
  borrarPorQuery,
  armarItemDelSeed,
  WS_ID,
  WS_NOMBRE,
  USUARIOS_SEED,
  passwordDemo,
  EMBED_DIMS,
  PLAN_DEL_ESPACIO_DE_DEMO,
  ID_REGLAMENTO,
  ITEMS_DE_LUCAS,
  EVENTOS_DE_LUCAS,
  EVENTO_DEL_REGLAMENTO,
} from "./_comun.js";

// ============================================================================
//  PARTE 1 — EMBEDDINGS FALSOS PERO DEL LARGO CORRECTO
// ============================================================================
//  El seed sin clave NO llama a la IA (ver PASO 5). Genera
//  vectores de 1024 numeros con un generador pseudo-azaroso SEMBRADO CON EL
//  ID DEL CHUNK. Eso significa que el chunk "itm_seed_01_3" saca siempre el
//  mismo vector, en esta maquina y en la de Martin: sin eso el seed no seria
//  idempotente (cada corrida cambiaria los 45 vectores).
//
//  Los vectores se normalizan a norma 1 (L2) porque el backend compara por
//  similitud coseno: con vectores normalizados, el coseno es simplemente el
//  producto punto, que es lo que hace el codigo de /preguntar.
//
//  IMPORTANTE: estos vectores NO significan nada. Sirven para que la coleccion
//  exista, se vea en la consola y las queries funcionen. Una pregunta real
//  contra estos datos va a citar cualquier cosa, y esta bien que asi sea.
// ============================================================================

/** Hash FNV-1a: convierte el id del chunk en un numero de 32 bits. */
function semillaDesde(texto) {
  let h = 2166136261;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Generador pseudo-azaroso (mulberry32): misma semilla, misma secuencia. */
function generadorPseudoAzar(semilla) {
  let s = semilla >>> 0;
  return function siguiente() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function embeddingFalso(chunkId) {
  const azar = generadorPseudoAzar(semillaDesde(chunkId));
  const v = new Array(EMBED_DIMS);
  let sumaCuadrados = 0;
  for (let i = 0; i < EMBED_DIMS; i++) {
    const x = azar() * 2 - 1; // numeros entre -1 y 1, como un embedding real
    v[i] = x;
    sumaCuadrados += x * x;
  }
  const norma = Math.sqrt(sumaCuadrados) || 1;
  // Redondeamos a 6 decimales: un float de 17 decimales no aporta nada y hace
  // el documento mas pesado (1024 numeros por chunk ya son ~9 KB).
  for (let i = 0; i < EMBED_DIMS; i++) v[i] = Number((v[i] / norma).toFixed(6));
  return v;
}

// ============================================================================
//  PARTE 2 — LOS DATOS DEL COLEGIO
// ============================================================================

const U = Object.fromEntries(USUARIOS_SEED.map((u) => [u.clave, u]));

// --- LOS 17 ITEMS (3 de ellos de Lucas: ver _comun.js) ----------------------
// Los que tienen 'trozos' son los que quedaron en estado 'listo': de esos
// trozos salen los chunks Y TAMBIEN el campo 'texto' del item (se arma
// pegandolos con saltos de linea). Lo hacemos asi a proposito: si el texto se
// escribiera aparte, tarde o temprano no coincidiria con sus chunks, y eso
// rompe el invariante 6 sin que se note.
const ITEMS = [
  // ---------------------------------------------------------------- LISTOS
  {
    id: "itm_seed_01",
    titulo: "Cronograma de mesas de examen — Diciembre 2026",
    tipo: "pdf",
    visibilidad: "equipo",
    autor: U.valentino,
    nombreArchivo: "mesas-diciembre-2026.pdf",
    estado: "listo",
    origen: "pdf-texto",
    paginas: 3,
    creadoEn: "2026-08-24T09:12:00-03:00",
    actualizadoEn: "2026-08-24T09:12:31-03:00",
    trozos: [
      { pagina: 1, texto: 'E.E.S.T. N.º 5 «Ing. Pedro Cerini» — Berazategui. Mesas de examen, turno diciembre 2026. Los alumnos tienen que presentarse 15 minutos antes con DNI y libreta.' },
      { pagina: 1, texto: "Matemática (6.º 1.ª): lunes 14/12, 8:00 hs, aula 12. Tribunal: Prof. Gómez, Prof. Ledesma, Prof. Arce." },
      { pagina: 2, texto: "Programación II (6.º 1.ª): miércoles 16/12, 10:00 hs, laboratorio 2. Tribunal: Prof. Bonelli, Prof. Ferreyra, Prof. Gómez." },
      { pagina: 2, texto: "Redes de Datos (6.º 1.ª): jueves 17/12, 8:00 hs, laboratorio 1. Tribunal: Prof. Arce, Prof. Bonelli, Prof. Sánchez." },
      { pagina: 3, texto: "Los alumnos que adeuden más de dos materias tienen que anotarse en preceptoría antes del viernes 4/12." },
      { pagina: 3, texto: "Las notas se publican en cartelera el lunes 21/12 a las 12:00 hs. Los recursos se presentan por escrito dentro de las 48 horas." },
    ],
  },
  {
    id: "itm_seed_02",
    titulo: "Consignas del TP integrador de Programación II",
    tipo: "nota",
    visibilidad: "equipo",
    autor: U.martin,
    estado: "listo",
    origen: "nota",
    paginas: null,
    creadoEn: "2026-08-24T18:40:00-03:00",
    actualizadoEn: "2026-08-24T18:40:09-03:00",
    trozos: [
      { pagina: null, texto: "El trabajo práctico integrador se entrega en tres fases. La fase 1 es el modelo de datos y las reglas de seguridad, y vence el 18/9." },
      { pagina: null, texto: "La fase 2 suma el backend con al menos cinco endpoints protegidos y la app móvil consumiéndolos. Vence el 16/10." },
      { pagina: null, texto: "La fase 3 es la defensa oral: cada integrante tiene que poder explicar cualquier parte del código, aunque lo haya escrito la IA." },
      { pagina: null, texto: "Se evalúa: modelo de datos coherente, control de acceso por rol, manejo de errores, y que la demo funcione en vivo sin pantallas rojas." },
    ],
  },
  {
    id: "itm_seed_03",
    titulo: "Reglas de seguridad de Firestore — documentación oficial",
    tipo: "link",
    visibilidad: "equipo",
    autor: U.valentino,
    url: "https://firebase.google.com/docs/firestore/security/get-started",
    estado: "listo",
    origen: "link",
    paginas: null,
    creadoEn: "2026-08-25T11:05:00-03:00",
    actualizadoEn: "2026-08-25T11:05:14-03:00",
    trozos: [
      { pagina: null, texto: "Las reglas de seguridad de Cloud Firestore controlan el acceso a los documentos desde los clientes web y móviles. El Admin SDK no pasa por las reglas." },
      { pagina: null, texto: "Por defecto todo está denegado. Cada allow abre un permiso puntual, y las reglas se combinan con OR: una regla nueva nunca cierra lo que otra abrió." },
      { pagina: null, texto: "Las reglas no filtran las consultas: si una query puede devolver un documento no permitido, falla la consulta entera con permission-denied." },
      { pagina: null, texto: "request.auth.token trae los custom claims firmados. Usarlos evita hacer get() de documentos adentro de las reglas, que se cobra como lectura." },
      { pagina: null, texto: "El método get() de un mapa, por ejemplo resource.data.get('campo', 'default'), no lee nada de la base y no se cobra. No confundirlo con get(/databases/...)." },
    ],
  },
  {
    id: "itm_seed_04",
    titulo: "Pizarrón: diagrama del modelo de datos",
    tipo: "foto",
    visibilidad: "equipo",
    autor: U.camila,
    nombreArchivo: "pizarron-modelo-datos.jpg",
    estado: "listo",
    origen: "ocr-space",
    paginas: null,
    creadoEn: "2026-08-26T08:55:00-03:00",
    actualizadoEn: "2026-08-26T08:55:22-03:00",
    trozos: [
      // El texto sale de una foto: queda con la suciedad tipica del OCR. Es a
      // proposito, para poder explicar en la defensa por que una respuesta
      // basada en fotos puede salir peor que una basada en un PDF con texto.
      { pagina: null, texto: "USUARIOS -> WORKSPACES -> MEMBERS / ITEMS / RESPUESTAS / EVENTOS. CHUNI(S va aparte, coleccion plana, id = itemId_idx" },
      { pagina: null, texto: "OJO!! el cliente crea el item en 'pendiente'. El backend NUNCA crea el item, solo lo actua1iza" },
    ],
  },
  {
    id: "itm_seed_05",
    titulo: "Mis dudas para la defensa oral",
    tipo: "nota",
    visibilidad: "privado", // <-- solo Martín y el admin lo ven
    autor: U.martin,
    estado: "listo",
    origen: "nota",
    paginas: null,
    creadoEn: "2026-08-27T21:30:00-03:00",
    actualizadoEn: "2026-08-27T21:30:06-03:00",
    trozos: [
      { pagina: null, texto: "Preguntar en clase: ¿para qué guarda el chunk una copia de la visibilidad, si igual se vuelve a chequear contra los items leídos en vivo?" },
      { pagina: null, texto: "Repasar la diferencia entre textoOriginal y texto. textoOriginal lo escribe la persona; texto lo extrae el backend y es lo único que se trocea." },
      { pagina: null, texto: "No me acuerdo de memoria los umbrales de confianza: 0.60 o más es alta, 0.45 o más es media, y abajo de eso es baja." },
    ],
  },
  // El Reglamento (itm_seed_06) es de LUCAS y vive en _comun.js, porque
  // sumar-lucas.js lo necesita igual. Va aca para que siga saliendo sexto.
  ITEMS_DE_LUCAS.find((it) => it.id === ID_REGLAMENTO),
  {
    id: "itm_seed_07",
    titulo: "Reparto de tareas del grupo",
    tipo: "nota",
    visibilidad: "equipo",
    autor: U.valentino,
    estado: "listo",
    origen: "nota",
    paginas: null,
    creadoEn: "2026-08-29T15:00:00-03:00",
    actualizadoEn: "2026-08-29T15:00:05-03:00",
    trozos: [
      { pagina: null, texto: "Valentino: backend en Node con Express, reglas de Firestore, integración con Google Gemini y el script del seed." },
      { pagina: null, texto: "Martín: la app en Flutter con StatefulWidget y StreamBuilder, el panel web en JavaScript vanilla, y las pruebas." },
      { pagina: null, texto: "Los dos: el modelo de datos, el contrato de endpoints y la defensa oral. Nadie entrega código que no pueda explicar." },
    ],
  },
  {
    id: "itm_seed_08",
    titulo: "Cómo usar StreamBuilder en Flutter",
    tipo: "link",
    visibilidad: "equipo",
    autor: U.martin,
    url: "https://api.flutter.dev/flutter/widgets/StreamBuilder-class.html",
    estado: "listo",
    origen: "link",
    paginas: null,
    creadoEn: "2026-08-30T19:45:00-03:00",
    actualizadoEn: "2026-08-30T19:45:11-03:00",
    trozos: [
      { pagina: null, texto: "StreamBuilder es un widget que se reconstruye solo cada vez que el stream que está escuchando emite un dato nuevo." },
      { pagina: null, texto: "Recibe el stream en la propiedad stream y una función builder, que recibe el contexto y el snapshot con el último valor emitido." },
      { pagina: null, texto: "El snapshot trae connectionState y hasData: conviene mostrar un indicador mientras está en waiting y un mensaje si hasError es verdadero." },
      { pagina: null, texto: "Con Firestore, snapshots() devuelve un stream: la pantalla se actualiza sola cuando cambia un documento, sin ningún gestor de estado." },
    ],
  },
  {
    id: "itm_seed_09",
    titulo: "Datos del entorno de prueba",
    tipo: "nota",
    visibilidad: "privado", // <-- solo Valentino (que ademas es el admin)
    autor: U.valentino,
    estado: "listo",
    origen: "nota",
    paginas: null,
    creadoEn: "2026-08-31T08:10:00-03:00",
    actualizadoEn: "2026-08-31T08:10:04-03:00",
    trozos: [
      { pagina: null, texto: "El backend de desarrollo escucha en el puerto 3000. Desde el emulador de Android se llega con 10.0.2.2, no con localhost." },
      { pagina: null, texto: "Las claves de Google Gemini y de OCR.space viven solamente en el archivo .env, que está en el .gitignore. Acá no se anota ninguna clave." },
    ],
  },
  {
    id: "itm_seed_10",
    titulo: "Rúbrica de evaluación del proyecto integrador",
    tipo: "pdf",
    visibilidad: "equipo",
    autor: U.valentino,
    nombreArchivo: "rubrica-integrador.pdf",
    estado: "listo",
    origen: "pdf-texto",
    paginas: 2,
    creadoEn: "2026-09-01T09:30:00-03:00",
    actualizadoEn: "2026-09-01T09:30:19-03:00",
    trozos: [
      { pagina: 1, texto: "Rúbrica del proyecto integrador. Cada criterio se puntúa de 1 a 10 y todos pesan lo mismo en la nota final." },
      { pagina: 1, texto: "Criterio 1 — Modelo de datos: las colecciones están justificadas y no hay datos duplicados sin un motivo escrito." },
      { pagina: 2, texto: "Criterio 3 — Control de acceso: se demuestra en vivo, con dos cuentas, que un rol ve menos información que el otro." },
      { pagina: 2, texto: "Criterio 5 — Defensa oral: el alumno explica cualquier fragmento del código, incluso el que generó con inteligencia artificial." },
    ],
  },

  // ---------------------------------------------------------------- ERRORES
  // Invariante 6: un item en 'error' tiene errorMsg NO vacio y cantChunks 0.
  // El errorMsg es EXACTAMENTE el mensaje_usuario del contrato: el mismo texto
  // que devolvio el HTTP, escrito a mano por nosotros. Nunca un err.message.
  {
    id: "itm_seed_11",
    titulo: "Apunte escaneado de Redes (fotocopia vieja)",
    tipo: "pdf",
    visibilidad: "equipo",
    autor: U.martin,
    nombreArchivo: "redes-fotocopia.pdf",
    estado: "error",
    creadoEn: "2026-09-01T14:02:00-03:00",
    actualizadoEn: "2026-09-01T14:02:38-03:00",
    errorMsg: "No pudimos leer el texto de ese archivo. Probá con una foto más nítida o un PDF con texto.",
  },
  {
    id: "itm_seed_12",
    titulo: "Planilla de notas del trimestre",
    tipo: "link",
    visibilidad: "equipo",
    autor: U.camila,
    // Apunta a una IP privada a proposito: es el caso que corta la validacion
    // anti-SSRF del backend antes de hacer el fetch (codigo URL_NO_PERMITIDA).
    url: "http://192.168.1.50/planilla-notas",
    estado: "error",
    creadoEn: "2026-09-02T10:15:00-03:00",
    actualizadoEn: "2026-09-02T10:15:03-03:00",
    errorMsg: "Esa dirección no se puede leer. Probá con un enlace público que empiece con https://",
  },

  // ------------------------------------------------------------- PROCESANDO
  // Asi queda el item apenas la transaccion lo pasa de 'pendiente' a
  // 'procesando': solo se le agregaron estado, actualizadoEn y errorMsg null.
  // Todavia no tiene texto, ni cantChunks, ni origen: eso se escribe recien
  // cuando termina de indexar.
  {
    id: "itm_seed_13",
    titulo: "Foto del pizarrón de la clase del 3/9",
    tipo: "foto",
    visibilidad: "equipo",
    autor: U.camila,
    nombreArchivo: "pizarron-03-09.jpg",
    estado: "procesando",
    creadoEn: "2026-09-03T11:40:00-03:00",
    actualizadoEn: "2026-09-03T11:40:02-03:00",
  },

  // -------------------------------------------------------------- PENDIENTES
  // ESTOS DOS SON LOS MAS IMPORTANTES PARA LA DEFENSA: tienen EXACTAMENTE los
  // campos que escribe Flutter y ni uno mas. Sin texto, sin cantChunks, sin
  // actualizadoEn. Si el seed les agregara un campo de mas, estaria mostrando
  // una base que la app real no puede producir (las reglas usan hasOnly()).
  {
    id: "itm_seed_14",
    titulo: "Ideas sueltas para la presentación",
    tipo: "nota",
    visibilidad: "privado",
    autor: U.camila,
    estado: "pendiente",
    creadoEn: "2026-09-03T20:05:00-03:00",
    textoOriginalSuelto:
      "Arrancar mostrando el problema: nadie encuentra el PDF que mandaron por el grupo hace dos meses. Después la demo en vivo con dos celulares, uno de admin y otro de miembro.",
  },
  {
    id: "itm_seed_15",
    titulo: "Manual del sensor DHT22",
    tipo: "pdf",
    visibilidad: "equipo",
    autor: U.martin,
    nombreArchivo: "dht22-datasheet.pdf",
    estado: "pendiente",
    creadoEn: "2026-09-04T07:50:00-03:00",
  },

  // ------------------------------------------------------- LOS DE LUCAS
  // Las otras dos notas de Lucas (itm_seed_16 y 17), listas y del equipo.
  // Estan en _comun.js junto con el Reglamento: ver ITEMS_DE_LUCAS.
  ...ITEMS_DE_LUCAS.filter((it) => it.id !== ID_REGLAMENTO),
];

// --- LAS 3 RESPUESTAS ------------------------------------------------------
// Las fuentes NO se escriben a mano: se apunta a { itemId, idxChunk } y el
// script saca de ahi el titulo, la pagina y el fragmento. Asi una cita nunca
// puede quedar apuntando a un chunk que no existe (invariante 11).
//
// chunksVisibles es el filtro de privacidad hecho numero, y es LO QUE HAY QUE
// MOSTRAR EN LA DEMO. Con estos datos:
//   total de chunks del workspace .......... 45
//   privados de Martín (item 05) ............ 3
//   privados de Valentino (item 09) ......... 2
//   del equipo .............................. 40  (con los 5 de las notas de Lucas)
// Entonces: Camila ve 40, Martín ve 43 (40 + sus 3) y Valentino, que es
// admin, ve los 45. Misma base, tres numeros distintos.
// chunksMirados (el TOTAL del espacio) va SOLO en la respuesta del admin: a un
// miembro el backend le escribe null (endpoint 11 del contrato), porque el
// total le contaria cuanto contenido privado ajeno existe. Si el seed se lo
// cargara a Martin o a Camila, la app les diria "Como sos admin..." al abrir
// esa pregunta vieja.
const RESPUESTAS = [
  {
    id: "resp_seed_01",
    autor: U.martin,
    pregunta: "¿Cuándo es la mesa de Programación II y en qué aula?",
    estado: "listo",
    creadoEn: "2026-09-02T17:22:00-03:00",
    actualizadoEn: "2026-09-02T17:22:06-03:00",
    respuesta:
      "La mesa de Programación II de 6.º 1.ª es el miércoles 16/12 a las 10:00 hs en el laboratorio 2, con el tribunal de los profesores Bonelli, Ferreyra y Gómez [1]. Acordate de presentarte 15 minutos antes con el DNI y la libreta [2].",
    confianza: "alta",
    chunksMirados: null, // es miembro: lo que escribe el backend (ver arriba)
    chunksVisibles: 43,
    fuentes: [
      { itemId: "itm_seed_01", idxChunk: 2, similitud: 0.87 },
      { itemId: "itm_seed_01", idxChunk: 0, similitud: 0.64 },
    ],
  },
  {
    id: "resp_seed_02",
    autor: U.camila,
    pregunta: "¿Qué le toca hacer a cada uno en el trabajo práctico?",
    estado: "listo",
    creadoEn: "2026-09-03T09:05:00-03:00",
    actualizadoEn: "2026-09-03T09:05:08-03:00",
    respuesta:
      "Valentino se ocupa del backend en Node con Express, las reglas de Firestore y la integración con la IA [1]. Martín hace la app en Flutter y el panel web [1]. El modelo de datos, el contrato y la defensa oral los preparan los dos [1], y la entrega se divide en tres fases [2].",
    confianza: "media",
    chunksMirados: null, // es miembro: lo que escribe el backend (ver arriba)
    chunksVisibles: 40, // Camila NO ve ningun item privado ajeno
    fuentes: [
      { itemId: "itm_seed_07", idxChunk: 0, similitud: 0.58 },
      { itemId: "itm_seed_02", idxChunk: 0, similitud: 0.47 },
    ],
  },
  {
    id: "resp_seed_03",
    autor: U.valentino, // es el ADMIN: ve los 45 chunks, incluso los privados
    pregunta: "¿Qué tengo pendiente del entorno y qué pide la rúbrica?",
    estado: "listo",
    creadoEn: "2026-09-03T22:40:00-03:00",
    actualizadoEn: "2026-09-03T22:40:07-03:00",
    respuesta:
      "Del entorno: el backend de desarrollo escucha en el puerto 3000 y desde el emulador de Android se llega con 10.0.2.2 [1]. De la rúbrica, el criterio 3 pide demostrar en vivo, con dos cuentas, que un rol ve menos información que el otro [2], y el criterio 5 pide poder explicar cualquier fragmento del código [3].",
    confianza: "alta",
    chunksMirados: 45,
    chunksVisibles: 45,
    fuentes: [
      // La fuente [1] sale de un item PRIVADO: se puede citar porque el que
      // pregunto es su autor (y ademas es admin). Si preguntara Camila lo
      // mismo, este chunk no entraria ni al ranking.
      { itemId: "itm_seed_09", idxChunk: 0, similitud: 0.81 },
      { itemId: "itm_seed_10", idxChunk: 2, similitud: 0.72 },
      { itemId: "itm_seed_10", idxChunk: 3, similitud: 0.66 },
    ],
  },
];

// --- LOS 23 EVENTOS --------------------------------------------------------
// Feed de auditoria, append-only y SOLO para el admin. Los ids van numerados
// para que el orden por creadoEn coincida con el orden alfabetico: asi la
// consola de Firebase (que ordena por id) los muestra en el mismo orden que
// el panel (que ordena por creadoEn desc, o sea al reves).
// Los 3 de Lucas van al final con su PROPIO id (evt_seed_lucas_N, ver
// _comun.js): se sumaron despues, y numerarlos en el medio correria los
// numeros de todos los que ya existen en la base.
const EVENTOS = [
  { tipo: "workspace.creado",  actor: U.valentino, itemId: null,          resumen: "Valentino creó el espacio «6to 1ra - Programación II»",        creadoEn: "2026-08-24T09:00:00-03:00" },
  { tipo: "miembro.agregado",  actor: U.valentino, itemId: null,          resumen: "Valentino agregó a Martín Sosa como miembro",                  creadoEn: "2026-08-24T09:03:00-03:00" },
  { tipo: "miembro.agregado",  actor: U.valentino, itemId: null,          resumen: "Valentino agregó a Camila Duarte como miembro",                creadoEn: "2026-08-24T09:04:00-03:00" },
  { tipo: "item.listo",        actor: U.valentino, itemId: "itm_seed_01", resumen: "Valentino subió «Cronograma de mesas de examen — Diciembre 2026»", creadoEn: "2026-08-24T09:12:31-03:00" },
  { tipo: "item.listo",        actor: U.martin,    itemId: "itm_seed_02", resumen: "Martín cargó la nota «Consignas del TP integrador de Programación II»", creadoEn: "2026-08-24T18:40:09-03:00" },
  { tipo: "item.listo",        actor: U.valentino, itemId: "itm_seed_03", resumen: "Valentino guardó el enlace «Reglas de seguridad de Firestore — documentación oficial»", creadoEn: "2026-08-25T11:05:14-03:00" },
  { tipo: "item.listo",        actor: U.camila,    itemId: "itm_seed_04", resumen: "Camila subió la foto «Pizarrón: diagrama del modelo de datos»", creadoEn: "2026-08-26T08:55:22-03:00" },
  { tipo: "item.listo",        actor: U.martin,    itemId: "itm_seed_05", resumen: "Martín cargó una nota privada",                                 creadoEn: "2026-08-27T21:30:06-03:00" },
  EVENTO_DEL_REGLAMENTO, // evt_seed_09: "Lucas subió «Reglamento de convivencia 2026»" (ver _comun.js)
  { tipo: "item.listo",        actor: U.valentino, itemId: "itm_seed_07", resumen: "Valentino cargó la nota «Reparto de tareas del grupo»",         creadoEn: "2026-08-29T15:00:05-03:00" },
  { tipo: "item.listo",        actor: U.martin,    itemId: "itm_seed_08", resumen: "Martín guardó el enlace «Cómo usar StreamBuilder en Flutter»",  creadoEn: "2026-08-30T19:45:11-03:00" },
  { tipo: "item.listo",        actor: U.valentino, itemId: "itm_seed_09", resumen: "Valentino cargó una nota privada",                              creadoEn: "2026-08-31T08:10:04-03:00" },
  { tipo: "rol.cambiado",      actor: U.valentino, itemId: null,          resumen: "Valentino le dio permisos de administrador a Camila y se los quitó enseguida (prueba)", creadoEn: "2026-08-31T16:00:00-03:00" },
  { tipo: "item.listo",        actor: U.valentino, itemId: "itm_seed_10", resumen: "Valentino subió «Rúbrica de evaluación del proyecto integrador»", creadoEn: "2026-09-01T09:30:19-03:00" },
  { tipo: "item.error",        actor: U.martin,    itemId: "itm_seed_11", resumen: "Falló «Apunte escaneado de Redes (fotocopia vieja)»: no se pudo leer el texto", creadoEn: "2026-09-01T14:02:38-03:00" },
  { tipo: "item.eliminado",    actor: U.valentino, itemId: null,          resumen: "Valentino eliminó «Prueba de carga (borrar)» y sus 2 fragmentos", creadoEn: "2026-09-01T18:20:00-03:00" },
  { tipo: "item.error",        actor: U.camila,    itemId: "itm_seed_12", resumen: "Falló «Planilla de notas del trimestre»: la dirección no se puede leer", creadoEn: "2026-09-02T10:15:03-03:00" },
  { tipo: "pregunta.hecha",    actor: U.martin,    itemId: null,          resumen: "Martín preguntó: «¿Cuándo es la mesa de Programación II y en qué aula?»", creadoEn: "2026-09-02T17:22:06-03:00" },
  { tipo: "pregunta.hecha",    actor: U.camila,    itemId: null,          resumen: "Camila preguntó: «¿Qué le toca hacer a cada uno en el trabajo práctico?»", creadoEn: "2026-09-03T09:05:08-03:00" },
  { tipo: "pregunta.hecha",    actor: U.valentino, itemId: null,          resumen: "Valentino preguntó: «¿Qué tengo pendiente del entorno y qué pide la rúbrica?»", creadoEn: "2026-09-03T22:40:07-03:00" },
  ...EVENTOS_DE_LUCAS,
];

// ============================================================================
//  PARTE 3 — EL SCRIPT
// ============================================================================

const resumen = {
  usuarios: 0,
  workspaces: 0,
  members: 0,
  items: 0,
  chunks: 0,
  respuestas: 0,
  eventos: 0,
  suscripcion: 0,
};
const cuentasCreadas = [];
const cuentasReusadas = [];

async function main() {
  console.log("\n============================================================");
  console.log("  SEED de NeuroDesk AI");
  console.log("============================================================\n");

  const { admin, db, auth } = conectar();

  // --------------------------------------------------------------------
  // PASO 1 — Las cuentas en Firebase Auth
  // --------------------------------------------------------------------
  // Idempotencia: primero buscamos por uid fijo, despues por email, y recien
  // si no existe ninguna de las dos creamos. Buscar TAMBIEN por email importa
  // porque si alguien ya se registro desde la app con ese mail, Firebase le
  // dio otro uid y crear de nuevo tiraria auth/email-already-exists.
  console.log("PASO 1/7  Cuentas en Firebase Auth");
  const usuarios = [];
  for (const u of USUARIOS_SEED) {
    let cuenta = null;
    try {
      cuenta = await auth.getUser(u.uid);
    } catch {
      try {
        cuenta = await auth.getUserByEmail(u.email);
      } catch {
        cuenta = null;
      }
    }

    if (cuenta) {
      cuentasReusadas.push(u.email);
      console.log(`  ya existia   ${u.email.padEnd(32)} uid ${cuenta.uid}`);
    } else {
      cuenta = await auth.createUser({
        uid: u.uid, // uid FIJO: es lo que hace idempotente el alta
        email: u.email,
        emailVerified: true,
        // La clave sale de SEED_PASSWORD del .env y se pide RECIEN aca, cuando
        // de verdad hay que crear una cuenta: si falta, passwordDemo() corta
        // antes de este createUser y antes de escribir nada en Firestore (este
        // es el primer paso). Con las cuentas ya creadas, el seed anda sin ella.
        password: passwordDemo(),
        displayName: u.nombre,
      });
      cuentasCreadas.push(u.email);
      console.log(`  CREADA       ${u.email.padEnd(32)} uid ${cuenta.uid}`);
    }
    usuarios.push({ ...u, uidReal: cuenta.uid });
  }

  // Mapa clave -> uid real, por si alguna cuenta ya existia con otro uid.
  const uidDe = Object.fromEntries(usuarios.map((u) => [u.clave, u.uidReal]));

  // --------------------------------------------------------------------
  // PASO 2 — El workspace y los members
  // --------------------------------------------------------------------
  console.log("\nPASO 2/7  Workspace y miembros");
  const refWs = db.collection("workspaces").doc(WS_ID);
  const escrituras = [];

  escrituras.push({
    ref: refWs,
    datos: {
      nombre: WS_NOMBRE,
      ownerUid: uidDe.valentino, // el owner es admin siempre (invariante 15)
      // El espacio de demo va en el plan 'pro', activo y sin cargo: tiene mas
      // personas de las 5 que deja el plan free (ver PLAN_DEL_ESPACIO_DE_DEMO
      // en _comun.js).
      plan: PLAN_DEL_ESPACIO_DE_DEMO.plan,
      // planStatus usa el MISMO enum que suscripcion/actual.estado
      // ('sin_plan' | 'pendiente' | 'activa' | 'pausada' | 'cancelada')
      // y los dos valores tienen que coincidir siempre (invariante 21).
      planStatus: PLAN_DEL_ESPACIO_DE_DEMO.estado,
      creadoEn: fecha("2026-08-24T09:00:00-03:00"),
      actualizadoEn: fecha("2026-08-24T09:05:00-03:00"),
      // Sin exMiembros a proposito: este set() pisa el documento entero, asi
      // que un seed nuevo vuelve a poner a todos en members y no queda nadie
      // "que se fue". exMiembros lo escribe el backend al sacar a alguien.
    },
  });
  resumen.workspaces = 1;

  for (const u of usuarios) {
    escrituras.push({
      ref: refWs.collection("members").doc(u.uidReal),
      datos: {
        uid: u.uidReal, // repetido como campo aunque este en el path
        email: u.email,
        nombre: u.nombre,
        rol: u.rol,
        // Al owner lo "agrego" el mismo al crear el workspace.
        agregadoPor: uidDe.valentino,
        agregadoEn: fecha(u.agregadoEn),
      },
    });
    resumen.members++;
  }

  // --------------------------------------------------------------------
  // PASO 3 — usuarios/{uid} + custom claims
  // --------------------------------------------------------------------
  // El claim se RECONSTRUYE ENTERO desde usuarios/{uid}.workspaces, nunca se
  // mergea a ciegas contra el claim viejo (invariante 13). Aca leemos primero
  // el doc que ya exista, por si estas cuentas pertenecen a otro workspace:
  // pisar el mapa dejaria a la persona afuera de ese otro workspace en
  // silencio, que es justo el bug que el invariante quiere evitar.
  console.log("\nPASO 3/7  Documentos de usuario y custom claims");
  for (const u of usuarios) {
    const refUsuario = db.collection("usuarios").doc(u.uidReal);
    const snap = await refUsuario.get();
    const workspacesPrevios = (snap.exists && snap.get("workspaces")) || {};
    // Si el doc ya existia, le respetamos la fecha de alta original; si no
    // (o si estaba roto y no la tenia), ponemos la fecha fija del seed.
    const creadoEn = (snap.exists && snap.get("creadoEn")) || fecha("2026-08-23T20:00:00-03:00");

    const mapaWorkspaces = { ...workspacesPrevios, [WS_ID]: { rol: u.rol, nombre: WS_NOMBRE } };

    await refUsuario.set({
      email: u.email,
      nombre: u.nombre,
      workspaces: mapaWorkspaces,
      workspaceActual: WS_ID,
      claimsActualizadoEn: fecha("2026-08-24T09:04:00-03:00"),
      creadoEn,
    });
    resumen.usuarios++;

    // El claim es el reflejo exacto del mapa del documento: rol por workspace.
    const claimWs = {};
    for (const [wsId, datos] of Object.entries(mapaWorkspaces)) claimWs[wsId] = datos.rol;
    await auth.setCustomUserClaims(u.uidReal, { ws: claimWs });

    console.log(`  ${u.nombre.padEnd(18)} rol ${u.rol.padEnd(8)} claim ws = ${JSON.stringify(claimWs)}`);
  }

  // --------------------------------------------------------------------
  // PASO 4 — Los items
  // --------------------------------------------------------------------
  console.log("\nPASO 4/7  Items");
  const chunksAEscribir = [];
  const itemsPorId = {}; // para armar las citas de las respuestas

  for (const it of ITEMS) {
    // El documento del item y sus chunks los arma armarItemDelSeed (en
    // _comun.js): (a) los campos del CLIENTE, iguales a los que escribe
    // Flutter, y un item 'pendiente' se queda EXACTAMENTE con esos; (b) los
    // del BACKEND segun el estado; (c) los chunks de los 'listo', con id
    // itemId_idx y la copia de visibilidad y autor. Es la misma funcion que
    // usa sumar-lucas.js, asi los items de Lucas quedan iguales por los dos
    // caminos.
    const { ref, datos, chunks } = armarItemDelSeed(db, it, uidDe[it.autor.clave]);
    // Sin clave de Gemini quedan estos vectores falsos (ver PARTE 1); con
    // clave, el PASO 5 los reemplaza por los de verdad.
    for (const c of chunks) c.datos.embedding = embeddingFalso(c.ref.id);
    chunksAEscribir.push(...chunks);

    escrituras.push({ ref, datos });
    itemsPorId[it.id] = it;
    resumen.items++;
    console.log(
      `  ${it.id}  ${it.tipo.padEnd(5)} ${it.estado.padEnd(10)} ${it.visibilidad.padEnd(8)}` +
        `${String(it.trozos ? it.trozos.length : 0).padStart(2)} chunks  ${it.titulo}`
    );
  }

  // --------------------------------------------------------------------
  // PASO 5 — Los chunks
  // --------------------------------------------------------------------
  // Antes de escribir, BORRAMOS todos los chunks del workspace. Es lo mismo
  // que hace indexar() en el backend y lo que exige el invariante 5: si una
  // corrida anterior dejo mas chunks de los que escribe esta, los sobrantes
  // quedarian vivos con texto viejo y la IA los podria seguir citando.
  // EMBEDDINGS REALES SI HAY CLAVE. Con GEMINI_API_KEY en el .env, los 45
  // trozos se mandan a Google (como documento, igual que /procesar) y
  // las preguntas de la demo encuentran lo que tienen que encontrar. Sin clave
  // quedan los falsos de la PARTE 1: la base existe y se ve, pero una pregunta
  // cita cualquier cosa. Se hace ACA y no reprocesando cada item por la API
  // porque asi cada trozo sigue siendo su propio chunk con su pagina: el
  // reproceso juntaria cada PDF corto en un solo chunk sin numero de pagina.
  // Es 1 pedido a Google (lotes de 50), unos segundos.
  const conClave = Boolean((process.env.GEMINI_API_KEY || "").trim());
  if (conClave) {
    const { pedirEmbeddings } = await import("../src/servicios/ia.js");
    // Cada trozo va con el TITULO de su item, exactamente como lo hace
    // indexar() en el backend. Si el seed embebiera distinto que /procesar,
    // la calibracion del umbral mediria vectores que la app no produce.
    const vectores = await pedirEmbeddings(
      chunksAEscribir.map((c) => c.datos.texto),
      "passage",
      { titulos: chunksAEscribir.map((c) => c.datos.titulo) },
    );
    // Mismo redondeo a 6 decimales que los falsos: no cambia la busqueda y el
    // documento pesa la mitad.
    chunksAEscribir.forEach((c, i) => { c.datos.embedding = vectores[i].map((x) => Number(x.toFixed(6))); });
  }
  console.log(`\nPASO 5/7  Chunks (embeddings ${conClave ? "REALES de Google Gemini" : "falsos"} de ${EMBED_DIMS} dimensiones)`);
  const chunksViejos = await borrarPorQuery(
    db,
    db.collection("chunks").where("workspaceId", "==", WS_ID)
  );
  if (chunksViejos > 0) console.log(`  se borraron ${chunksViejos} chunks de una corrida anterior`);

  // Chequeo barato pero que salva la demo: si el vector no tiene el largo del
  // .env o no esta normalizado, la similitud coseno del backend da cualquier
  // cosa. Mejor que reviente aca que en la defensa.
  for (const c of chunksAEscribir) {
    const v = c.datos.embedding;
    if (v.length !== EMBED_DIMS) throw new Error(`El embedding de ${c.ref.id} tiene ${v.length} dims y deberia tener ${EMBED_DIMS}`);
    const norma = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
    if (Math.abs(norma - 1) > 0.001) throw new Error(`El embedding de ${c.ref.id} no esta normalizado (norma ${norma})`);
  }
  escrituras.push(...chunksAEscribir);
  resumen.chunks = chunksAEscribir.length;
  console.log(`  ${chunksAEscribir.length} chunks listos, todos con norma 1 y id itemId_idx`);

  // --------------------------------------------------------------------
  // PASO 6 — Respuestas y eventos
  // --------------------------------------------------------------------
  console.log("\nPASO 6/7  Respuestas y eventos");
  for (const r of RESPUESTAS) {
    // Las fuentes se arman leyendo el chunk de verdad: el titulo, la pagina y
    // el fragmento salen del dato, no de una copia escrita a mano.
    const fuentes = r.fuentes.map((f, i) => {
      const item = itemsPorId[f.itemId];
      const trozo = item.trozos[f.idxChunk];
      if (!trozo) throw new Error(`La respuesta ${r.id} cita ${f.itemId}_${f.idxChunk}, que no existe`);
      return {
        n: i + 1, // los [1] [2] del texto apuntan aca
        itemId: f.itemId,
        titulo: item.titulo,
        pagina: trozo.pagina,
        fragmento: trozo.texto.slice(0, 160),
        similitud: f.similitud,
      };
    });

    escrituras.push({
      ref: refWs.collection("respuestas").doc(r.id),
      datos: {
        // OJO: esta coleccion NO lleva campo workspaceId. El wsId va SOLO en
        // el path (decision D1 del contrato / invariante 4). Agregarselo seria
        // un dato mas que se puede desincronizar sin que nadie se entere.
        pregunta: r.pregunta,
        autorUid: uidDe[r.autor.clave],
        estado: r.estado,
        creadoEn: fecha(r.creadoEn),
        respuesta: r.respuesta,
        fuentes,
        confianza: r.confianza, // STRING: 'alta' | 'media' | 'baja'
        chunksMirados: r.chunksMirados,
        chunksVisibles: r.chunksVisibles,
        errorMsg: null,
        actualizadoEn: fecha(r.actualizadoEn),
      },
    });
    resumen.respuestas++;
    // El total va solo si lo hay (solo la del admin): si no, diria "43/null".
    const deCuantos = r.chunksMirados == null ? "" : `/${r.chunksMirados}`;
    console.log(`  ${r.id}  ${r.confianza.padEnd(5)} ${fuentes.length} fuentes  ve ${r.chunksVisibles}${deCuantos} chunks  (${r.autor.nombre})`);
  }

  EVENTOS.forEach((e, i) => {
    // Los que traen id propio (los de Lucas y el del Reglamento, que estan en
    // _comun.js) lo conservan; el resto se numera por su lugar en la lista.
    const eventoId = e.id ?? `evt_seed_${String(i + 1).padStart(2, "0")}`;
    if (e === EVENTO_DEL_REGLAMENTO && eventoId !== `evt_seed_${String(i + 1).padStart(2, "0")}`) {
      // Si alguien mueve el evento del Reglamento de lugar en la lista, su id
      // fijo ya no coincide con el numero y quedarian dos eventos con el
      // mismo id (uno pisaria al otro). Mejor que reviente aca.
      throw new Error(`El evento del Reglamento tiene que ser el numero ${eventoId.slice(-2)} de la lista`);
    }
    escrituras.push({
      ref: refWs.collection("eventos").doc(eventoId),
      datos: {
        tipo: e.tipo,
        actorUid: uidDe[e.actor.clave],
        resumen: e.resumen,
        itemId: e.itemId,
        creadoEn: fecha(e.creadoEn),
      },
    });
    resumen.eventos++;
  });
  console.log(`  ${resumen.eventos} eventos de auditoria (solo los ve el admin)`);

  // --------------------------------------------------------------------
  // PASO 7 — La suscripcion
  // --------------------------------------------------------------------
  // Documento UNICO, con id fijo 'actual'. Mercado Pago es un stretch goal:
  // el doc existe igual. El espacio de demo va en 'pro', activo y SIN CARGO
  // (montoMensual 0 y sin preapprovalId: no hay ningun cobro de Mercado Pago
  // detras), porque tiene mas personas de las que deja el plan free. Los
  // nombres son 'vence' (no venceEn) y 'preapprovalId' (no mpPreapprovalId).
  console.log("\nPASO 7/7  Suscripcion");
  escrituras.push({
    ref: refWs.collection("suscripcion").doc("actual"),
    datos: {
      plan: PLAN_DEL_ESPACIO_DE_DEMO.plan, // tiene que coincidir con workspaces/{wsId}.plan
      estado: PLAN_DEL_ESPACIO_DE_DEMO.estado, // mismo enum que workspaces/{wsId}.planStatus
      preapprovalId: null,
      montoMensual: PLAN_DEL_ESPACIO_DE_DEMO.montoMensual,
      vence: null,
      eventosProcesados: [], // ids de notificacion de MP ya aplicados
      actualizadoEn: fecha("2026-08-24T09:00:00-03:00"),
    },
  });
  resumen.suscripcion = 1;
  console.log(`  suscripcion/actual  plan ${PLAN_DEL_ESPACIO_DE_DEMO.plan}, estado ${PLAN_DEL_ESPACIO_DE_DEMO.estado}, sin cargo`);

  // --------------------------------------------------------------------
  // ESCRIBIR TODO
  // --------------------------------------------------------------------
  // Los 3 docs de usuarios/ ya se escribieron uno por uno en el paso 3 (habia
  // que LEER cada uno antes para no pisarle el mapa de workspaces), asi que no
  // estan en esta lista. Por eso este numero da 3 menos que el TOTAL de abajo.
  console.log(`\nEscribiendo ${escrituras.length} documentos en lotes (+ los ${resumen.usuarios} de usuarios/ que ya fueron)...`);
  await escribirEnLotes(db, escrituras);

  imprimirResumen();
  await admin.app().delete(); // cierra la conexion asi el proceso termina solo
}

function imprimirResumen() {
  const total = Object.values(resumen).reduce((a, b) => a + b, 0);
  const linea = (nombre, n) => `  ${nombre.padEnd(22, ".")} ${String(n).padStart(3)} ${n === 1 ? "doc" : "docs"}`;

  console.log("\n============================================================");
  console.log("  RESUMEN — documentos escritos en Firestore");
  console.log("============================================================");
  console.log(linea("usuarios", resumen.usuarios));
  console.log(linea("workspaces", resumen.workspaces));
  console.log(linea("  members", resumen.members));
  console.log(linea("  items", resumen.items));
  console.log(linea("  respuestas", resumen.respuestas));
  console.log(linea("  eventos", resumen.eventos));
  console.log(linea("  suscripcion", resumen.suscripcion));
  console.log(linea("chunks", resumen.chunks));
  console.log("  " + "-".repeat(32));
  console.log(linea("TOTAL", total));

  console.log("\n  Cuentas de Firebase Auth:");
  console.log(`    creadas ahora ... ${cuentasCreadas.length ? cuentasCreadas.join(", ") : "(ninguna)"}`);
  console.log(`    ya existian ..... ${cuentasReusadas.length ? cuentasReusadas.join(", ") : "(ninguna)"}`);
  // La contrasena NO se imprime nunca: la terminal termina en capturas y en
  // el log, y el repo es publico. A las cuentas que ya existian el seed no
  // les toca la clave (para cambiarla esta npm run demo:clave).
  const textoClave = cuentasCreadas.length === 0
    ? "no se toco (las cuentas ya existian)"
    : cuentasReusadas.length === 0
      ? "la de SEED_PASSWORD del .env (no se imprime)"
      : "las creadas ahora, la de SEED_PASSWORD del .env (no se imprime); a las que ya existian no se les toco";
  console.log(`    contrasena ...... ${textoClave}`);

  console.log(`\n  Workspace: ${WS_ID}  (${WS_NOMBRE})`);
  console.log("  Podes correrlo de nuevo cuantas veces quieras: no duplica nada.");
  console.log("  Ahora abri la consola de Firebase y saca las capturas (ver api/SEED.md).\n");
}

main().catch((err) => {
  console.error("\n!! EL SEED NO TERMINO. Que paso:\n");
  console.error("   " + err.message + "\n");
  console.error("   Arregla eso y correlo de nuevo: el seed es idempotente,");
  console.error("   asi que volver a correrlo no duplica lo que ya habia escrito.\n");
  process.exit(1);
});
