// ============================================================================
//  scripts/_comun.js
//
//  Lo UNICO que comparten los scripts: como conectarse a Firebase y cuales
//  son los datos de prueba (el wsId, los cuatro usuarios y lo que es de Lucas).
//
//  POR QUE existe este archivo y no esta todo copiado en cada script:
//  si seed.js y borrar-seed.js no usaran EXACTAMENTE el mismo wsId y los
//  mismos emails, el borrado limpiaria otra cosa (o nada) y nadie se
//  enteraria hasta el dia de la entrega. Un solo lugar, una sola verdad.
//  Lo mismo con Lucas: seed.js y sumar-lucas.js escriben sus documentos con
//  los MISMOS datos y la MISMA funcion (armarItemDelSeed), asi un espacio
//  armado de cero y uno al que se le sumo Lucas despues quedan iguales.
//
//  OJO CON LOS ACENTOS: los mensajes que se imprimen en la consola van SIN
//  acentos a proposito, porque la consola de Windows (codepage 850) los
//  muestra rotos y las capturas de pantalla quedan feas. Los datos que se
//  guardan en Firestore SI llevan acentos: eso se ve bien en la consola web.
// ============================================================================

// firebase-admin v14 usa la API MODULAR: cada servicio se importa de su propio
// subpaquete. La forma vieja (import admin from "firebase-admin" y despues
// admin.credential.cert(), admin.firestore(), admin.auth()) ya no existe.
import { createHash } from "node:crypto";

import { initializeApp, cert, deleteApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

// La app de Firebase de los scripts (se crea una sola vez en conectar()).
let app = null;

// Objeto "admin" con la misma forma que usan seed.js, borrar-seed.js y
// set-admin.js (admin.app().delete() y admin.firestore.FieldValue), asi esos
// tres scripts no tuvieron que cambiar con la migracion.
const admin = {
  app: () => ({ delete: () => (app ? deleteApp(app) : Promise.resolve()) }),
  firestore: { FieldValue, Timestamp },
};

// ---------------------------------------------------------------------------
// DATOS DE PRUEBA (los mismos para seed.js y para borrar-seed.js)
// ---------------------------------------------------------------------------

// El id del workspace es FIJO, no autogenerado. Es lo que hace que correr el
// seed dos veces pise los mismos documentos en vez de crear un workspace nuevo.
export const WS_ID = "ws_seed_6to1ra";
export const WS_NOMBRE = "6to 1ra - Programación II"; // 25 caracteres (el limite es 40)

// Los uid tambien son fijos: se los pasamos a mano a admin.auth().createUser().
// Firebase deja elegir el uid, y eso es lo que vuelve idempotente el alta.
// 'agregadoEn' es la fecha fija con la que entra cada uno a members/.
export const USUARIOS_SEED = [
  {
    clave: "valentino",
    uid: "uid_seed_valentino",
    email: "valentino.demo@neurodesk.test",
    nombre: "Valentino Mattio",
    rol: "admin", // es el owner del workspace
    agregadoEn: "2026-08-24T09:00:00-03:00", // se "agrego" solo al crear el espacio
  },
  {
    clave: "martin",
    uid: "uid_seed_martin",
    email: "martin.demo@neurodesk.test",
    nombre: "Martín Sosa",
    rol: "miembro",
    agregadoEn: "2026-08-24T09:03:00-03:00",
  },
  {
    clave: "camila",
    uid: "uid_seed_camila",
    email: "camila.demo@neurodesk.test",
    nombre: "Camila Duarte",
    rol: "miembro",
    agregadoEn: "2026-08-24T09:04:00-03:00",
  },
  // LUCAS, la cuarta cuenta (funcion "la memoria que no se va"). Existe para
  // SACARLO del equipo en la demo sin cerrarle la sesion a nadie: sacar a
  // alguien le revoca los tokens, y Valentino, Martin y Camila estan abiertos
  // en los celulares y en el panel. Nadie tiene que entrar con esta cuenta.
  // Se suma a un espacio que ya existe con scripts/sumar-lucas.js.
  {
    clave: "lucas",
    uid: "uid_seed_lucas",
    email: "lucas.demo@neurodesk.test",
    nombre: "Lucas",
    rol: "miembro",
    agregadoEn: "2026-08-24T09:05:00-03:00",
  },
];

/** Un usuario del seed por su clave ('valentino', 'lucas', ...). */
export function usuarioSeed(clave) {
  const u = USUARIOS_SEED.find((x) => x.clave === clave);
  if (!u) throw new Error(`No hay ningun usuario del seed con clave "${clave}"`);
  return u;
}

// ---------------------------------------------------------------------------
// EL PLAN DEL ESPACIO DE DEMO
// ---------------------------------------------------------------------------
// El plan free permite 5 personas por espacio, y el de la demo tiene mas: las
// 4 cuentas del seed, las cuentas reales del equipo con las que se prueba la
// app en el celular, y la cuenta temporal que suma y saca probar-api.js. Con
// el plan free, sumar a Lucas (o a cualquiera) daria LIMITE_PLAN. Por eso el
// espacio de demo va en el plan 'pro', ACTIVO y SIN CARGO (montoMensual 0, sin
// preapprovalId): no es un cobro falso, es una cortesia para la prueba. Los
// valores son del enum unico del modelo, y workspaces.plan/planStatus y
// suscripcion/actual.plan/estado dicen lo mismo (invariante 21).
// Lo escriben seed.js (siempre) y sumar-lucas.js (solo si el espacio sigue en
// free y Lucas no entra).
export const PLAN_DEL_ESPACIO_DE_DEMO = { plan: "pro", estado: "activa", montoMensual: 0 };

// Lo que el plan free deja tener por espacio (el mismo numero que
// MAX_MIEMBROS_PLAN_FREE de src/rutas/workspaces.js).
export const MAX_MIEMBROS_PLAN_FREE = 5;

// ---------------------------------------------------------------------------
// LA CONTRASENA DE LAS CUENTAS DE DEMO
// ---------------------------------------------------------------------------
// Sale SOLO de SEED_PASSWORD del .env y NO tiene valor por omision, a
// proposito: el repo es PUBLICO y una clave escrita aca la podria usar
// cualquiera para entrar como Valentino (el admin), Martin, Camila o Lucas.
// Para ponerla o cambiarla en las cuentas que ya existen esta
// npm run demo:clave (ver SEED.md).
//
// Es una FUNCION y no una constante para que la clave se pida recien cuando
// hace falta: importar este archivo no la pide. probar-api.js, borrar-seed.js
// y sumar-lucas.js con Lucas ya creado andan sin ella. La piden, en el momento
// de usarla, los scripts que CREAN una cuenta (seed.js, sumar-lucas.js) o le
// CAMBIAN la contrasena (cambiar-clave-demo.js). Si falta, cortan ANTES de
// tocar nada.
//
// La clave nunca se imprime ni se escribe en ningun archivo del repo: vive
// solo en api/.env (que esta en .gitignore).
const LARGO_MINIMO_CLAVE = 10;

// Huella (sha256) de una clave VIEJA que ya no se tiene que usar. Sirve para
// que nadie la vuelva a poner en SEED_PASSWORD por costumbre.
const HUELLA_CLAVE_VIEJA = "99ff0f2b576badd2f9c313824d00b648da5dbac4f4110d77619b885107ffc5f0";

export function passwordDemo() {
  const clave = process.env.SEED_PASSWORD ?? "";
  if (!clave.trim()) {
    throw new Error(
      "Falta SEED_PASSWORD en el .env. Es la contrasena de las cuentas demo y ya no tiene\n" +
        "   valor por omision (la de antes quedo publicada en el repo). Elegi una clave nueva,\n" +
        "   ponela en api/.env como SEED_PASSWORD=<la clave> y volve a correr el script.\n" +
        "   No la escribas en ningun archivo del repo. El paso a paso esta en api/SEED.md."
    );
  }
  if (clave.length < LARGO_MINIMO_CLAVE) {
    throw new Error(`SEED_PASSWORD es muy corta: tiene que tener ${LARGO_MINIMO_CLAVE} caracteres o mas.`);
  }
  if (createHash("sha256").update(clave).digest("hex") === HUELLA_CLAVE_VIEJA) {
    throw new Error("SEED_PASSWORD es la contrasena VIEJA, la que quedo publicada en el repo. Elegi otra.");
  }
  return clave;
}

// Largo del vector de embeddings. Tiene que ser el MISMO numero que EMBED_DIMS
// del .env: si el seed escribe 768 y el backend pide 1024, la similitud coseno
// explota con "arrays de distinto largo".
export const EMBED_DIMS = Number(process.env.EMBED_DIMS || 1024);

// ---------------------------------------------------------------------------
// LO QUE ES DE LUCAS: tres items del equipo, ya procesados
// ---------------------------------------------------------------------------
// Cuando Valentino lo saca en la demo, el panel avisa "le quedan 3 items
// cargados" y la IA los sigue citando con su nombre: "Lucas se fue; lo que
// sabia, no".
//  - El Reglamento (itm_seed_06) antes era de Camila. Es de Lucas porque es la
//    cita de la demo: "¿Qué dice el reglamento sobre los laboratorios?" ->
//    pag. 2, articulo 7.
//  - Los otros dos son nuevos y de temas que no se cruzan con ninguna pregunta
//    ensayada (la de la demo ni las de probar-api.js): la biblioteca y el
//    certificado de alumno regular. Si hablaran de laboratorios o de mesas de
//    examen, le podrian ganar al Reglamento o al Cronograma en la demo.
// Mismo formato que los ITEMS de seed.js: cada 'trozo' es un chunk, y el texto
// del item se arma pegandolos (ver armarItemDelSeed).
export const ID_REGLAMENTO = "itm_seed_06";

export const ITEMS_DE_LUCAS = [
  {
    id: ID_REGLAMENTO,
    titulo: "Reglamento de convivencia 2026",
    tipo: "pdf",
    visibilidad: "equipo",
    autor: usuarioSeed("lucas"),
    nombreArchivo: "reglamento-convivencia-2026.pdf",
    estado: "listo",
    origen: "pdf-texto",
    paginas: 5,
    creadoEn: "2026-08-28T10:20:00-03:00",
    actualizadoEn: "2026-08-28T10:20:47-03:00",
    trozos: [
      { pagina: 1, texto: "Reglamento de convivencia — ciclo lectivo 2026. Aprobado por el consejo institucional el 3 de marzo de 2026." },
      { pagina: 1, texto: "Artículo 1: el ingreso al establecimiento es hasta las 7:45 hs. Después de ese horario se registra tardanza." },
      { pagina: 2, texto: "Artículo 4: el uso del celular en el aula queda a criterio del docente y solo con fines pedagógicos." },
      { pagina: 2, texto: "Artículo 7: los laboratorios de informática se usan con autorización del profesor a cargo. No se puede instalar software sin permiso." },
      { pagina: 3, texto: "Artículo 9: las inasistencias se computan por jornada completa. Con 15 inasistencias el alumno queda en condición de reincorporación." },
      { pagina: 4, texto: "Artículo 12: los actos escolares son de asistencia obligatoria y se computan como jornada de clase." },
      { pagina: 5, texto: "Artículo 18: cualquier daño al equipamiento del taller se comunica a la familia y se labra un acta." },
    ],
  },
  {
    id: "itm_seed_16",
    titulo: "Biblioteca: horarios y préstamo de libros",
    tipo: "nota",
    visibilidad: "equipo",
    autor: usuarioSeed("lucas"),
    estado: "listo",
    origen: "nota",
    paginas: null,
    creadoEn: "2026-09-02T12:30:00-03:00",
    actualizadoEn: "2026-09-02T12:30:06-03:00",
    trozos: [
      { pagina: null, texto: "La biblioteca abre de lunes a viernes de 8:00 a 17:00 hs. Los sábados y los feriados está cerrada." },
      { pagina: null, texto: "Los libros se prestan por siete días con el carnet de estudiante. La renovación se pide en el mostrador y se puede hacer una sola vez por libro." },
      { pagina: null, texto: "Quien devuelve un libro dañado o fuera de término no puede retirar otro hasta hablar con la bibliotecaria." },
    ],
  },
  {
    id: "itm_seed_17",
    titulo: "Cómo pedir el certificado de alumno regular",
    tipo: "nota",
    visibilidad: "equipo",
    autor: usuarioSeed("lucas"),
    estado: "listo",
    origen: "nota",
    paginas: null,
    creadoEn: "2026-09-03T08:15:00-03:00",
    actualizadoEn: "2026-09-03T08:15:05-03:00",
    trozos: [
      { pagina: null, texto: "El certificado de alumno regular se pide en secretaría, de lunes a viernes de 8:00 a 12:00 hs, con el DNI del alumno." },
      { pagina: null, texto: "Se entrega a las 48 horas hábiles. Si es para ANSES o para una beca hay que avisarlo al pedirlo, porque lleva otro formulario y la firma de la directora." },
    ],
  },
];

// Los eventos del seed que cuentan la llegada de Lucas y sus dos notas.
// Llevan id PROPIO (evt_seed_lucas_N) y no un numero de la lista de seed.js:
// si se intercalaran por fecha, se correrian todos los numeros de los eventos
// que ya existen y sumar-lucas.js tendria que reescribirlos.
export const EVENTOS_DE_LUCAS = [
  { id: "evt_seed_lucas_1", tipo: "miembro.agregado", actor: usuarioSeed("valentino"), itemId: null,          resumen: "Valentino agregó a Lucas como miembro",                               creadoEn: "2026-08-24T09:05:00-03:00" },
  { id: "evt_seed_lucas_2", tipo: "item.listo",       actor: usuarioSeed("lucas"),     itemId: "itm_seed_16", resumen: "Lucas cargó la nota «Biblioteca: horarios y préstamo de libros»",     creadoEn: "2026-09-02T12:30:06-03:00" },
  { id: "evt_seed_lucas_3", tipo: "item.listo",       actor: usuarioSeed("lucas"),     itemId: "itm_seed_17", resumen: "Lucas cargó la nota «Cómo pedir el certificado de alumno regular»", creadoEn: "2026-09-03T08:15:05-03:00" },
];

// El evento del seed que cuenta la subida del Reglamento. Antes decia Camila;
// ahora el autor es Lucas, y el feed tiene que decir lo mismo que el item.
// Conserva su id de siempre (es el noveno de la lista de seed.js).
export const EVENTO_DEL_REGLAMENTO = {
  id: "evt_seed_09",
  tipo: "item.listo",
  actor: usuarioSeed("lucas"),
  itemId: ID_REGLAMENTO,
  resumen: "Lucas subió «Reglamento de convivencia 2026»",
  creadoEn: "2026-08-28T10:20:47-03:00",
};

// ---------------------------------------------------------------------------
// CONEXION A FIREBASE
// ---------------------------------------------------------------------------

let cache = null;

/**
 * Levanta firebase-admin una sola vez y devuelve { admin, db, auth }.
 *
 * La service account viaja en UNA variable de entorno codificada en base64
 * (FIREBASE_SERVICE_ACCOUNT_B64). Va en base64 para esquivar el infierno de
 * los \n del campo private_key cuando se pega un JSON adentro de un .env.
 *
 * Si estan levantados los emuladores (FIRESTORE_EMULATOR_HOST), no hace falta
 * ninguna credencial: alcanza con el projectId.
 */
export function conectar() {
  if (cache) return cache;

  const usandoEmulador = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  const projectId = process.env.FIREBASE_PROJECT_ID;

  if (!projectId) {
    throw new Error(
      "Falta FIREBASE_PROJECT_ID en el .env.\n" +
        "  Acordate de correr los scripts con:  node --env-file=.env scripts/<script>.js"
    );
  }

  if (usandoEmulador) {
    // Contra el emulador no se usa credencial real a proposito: si por error
    // quedara una service account de produccion, el emulador la ignora igual,
    // pero asi queda escrito que este camino NO toca la base de verdad.
    app = initializeApp({ projectId });
    console.log(`  Conectado al EMULADOR (${process.env.FIRESTORE_EMULATOR_HOST}), proyecto ${projectId}`);
  } else {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    if (!b64) {
      throw new Error(
        "Falta FIREBASE_SERVICE_ACCOUNT_B64 en el .env.\n" +
          "  Se genera asi en PowerShell, parado en la carpeta del json:\n" +
          '  [Convert]::ToBase64String([IO.File]::ReadAllBytes("serviceAccountKey.json")) | Set-Clipboard'
      );
    }

    let credencial;
    try {
      credencial = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    } catch {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_B64 no es un JSON valido en base64.\n" +
          "  Lo mas comun: se copio con saltos de linea o quedaron comillas de mas.\n" +
          "  Tiene que ser UNA sola linea larga, sin comillas."
      );
    }

    if (credencial.project_id !== projectId) {
      throw new Error(
        `La service account es del proyecto "${credencial.project_id}" pero ` +
          `FIREBASE_PROJECT_ID dice "${projectId}". Son dos proyectos distintos: ` +
          "corregi el .env antes de escribir nada."
      );
    }

    app = initializeApp({ credential: cert(credencial), projectId });
    console.log(`  Conectado al proyecto REAL de Firebase: ${projectId}`);
  }

  cache = { admin, db: getFirestore(app), auth: getAuth(app) };
  return cache;
}

// ---------------------------------------------------------------------------
// AYUDANTES CHIQUITOS
// ---------------------------------------------------------------------------

/**
 * Convierte un texto ISO ("2026-09-01T09:15:00-03:00") en un Timestamp de
 * Firestore. Usamos fechas FIJAS en el seed (no serverTimestamp()) para que
 * correrlo dos veces deje exactamente los mismos documentos.
 * En la app de verdad las fechas SIEMPRE las pone FieldValue.serverTimestamp():
 * las reglas lo exigen comparando contra request.time.
 */
export function fecha(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha invalida en el seed: ${iso}`);
  return Timestamp.fromDate(d);
}

/**
 * Escribe una lista de { ref, datos } en lotes.
 * Firestore acepta como maximo 500 operaciones por batch; usamos 400 para
 * dejar aire. Devuelve cuantos documentos escribio.
 */
export async function escribirEnLotes(db, escrituras, tamanoLote = 400) {
  for (let i = 0; i < escrituras.length; i += tamanoLote) {
    const lote = db.batch();
    for (const { ref, datos } of escrituras.slice(i, i + tamanoLote)) {
      // set() SIN merge: pisa el documento entero. Es lo que queremos, porque
      // si una corrida vieja dejo un campo de mas, tiene que desaparecer.
      lote.set(ref, datos);
    }
    await lote.commit();
  }
  return escrituras.length;
}

/**
 * Arma el documento de un item del seed y los de sus chunks, segun su estado,
 * tal cual quedarian si los hubieran escrito la app (los campos del cliente) y
 * el backend (los del procesamiento). La usan seed.js y sumar-lucas.js: si
 * cada uno armara el item a su manera, el Reglamento rehecho por un script no
 * seria igual al del seed, y eso en las capturas se nota.
 *
 * Devuelve { ref, datos, chunks: [{ ref, datos }] }. El 'embedding' de cada
 * chunk queda en null: lo pone quien llama (el seed, falso o de Gemini;
 * sumar-lucas.js, siempre de Gemini).
 */
export function armarItemDelSeed(db, it, uidAutor) {
  // (a) LOS CAMPOS DEL CLIENTE. Son los mismos, y en el mismo orden, que
  //     escribe Flutter. Un item en 'pendiente' se queda EXACTAMENTE aca.
  const datos = {
    titulo: it.titulo,
    tipo: it.tipo,
    visibilidad: it.visibilidad,
    workspaceId: WS_ID, // tiene que coincidir con el wsId del path
    creadoPor: uidAutor,
    creadoEn: fecha(it.creadoEn),
    estado: it.estado,
  };
  if (it.url) datos.url = it.url;
  if (it.nombreArchivo) datos.nombreArchivo = it.nombreArchivo;

  // El texto de una nota lo escribe la PERSONA. Para las notas ya procesadas
  // sale de pegar sus trozos; para la nota pendiente, del campo
  // textoOriginalSuelto (todavia no la vio el backend).
  if (it.tipo === "nota") {
    datos.textoOriginal = it.trozos ? it.trozos.map((t) => t.texto).join("\n") : it.textoOriginalSuelto;
  }

  // (b) LOS CAMPOS DEL BACKEND, segun el estado. Una diferencia a sabiendas
  //     con el backend: en un PDF, items.js guarda item.texto CON las marcas
  //     <<<PAGINA:n>>> entre pagina y pagina, y aca el texto se arma pegando
  //     los trozos, SIN marcas (cada chunk igual lleva su 'pagina'). Por eso
  //     "Lo que leyo NeuroDesk" muestra los PDF del seed (el Reglamento) en
  //     una sola tarjeta y no en una por pagina. OJO: por lo mismo, si se
  //     REPROCESA un PDF del seed, /reprocesar trocea ese texto sin marcas y
  //     sus chunks pierden el numero de pagina (la cita "pág. 2").
  if (it.estado === "procesando") {
    // Lo unico que escribe la transaccion pendiente -> procesando.
    datos.actualizadoEn = fecha(it.actualizadoEn);
    datos.errorMsg = null;
  }

  if (it.estado === "error") {
    datos.texto = "";
    datos.cantChunks = 0; // invariante 6
    datos.paginas = null;
    datos.origen = null; // no se llego a extraer nada
    datos.caracteres = 0;
    datos.recortado = false;
    datos.errorMsg = it.errorMsg;
    datos.actualizadoEn = fecha(it.actualizadoEn);
  }

  const chunks = [];
  if (it.estado === "listo") {
    // 'texto' se arma pegando los trozos: asi el texto del item y sus chunks
    // no pueden desincronizarse nunca.
    const texto = it.trozos.map((t) => t.texto).join("\n");
    datos.texto = texto;
    datos.cantChunks = it.trozos.length; // invariante 6
    datos.paginas = it.paginas;
    datos.origen = it.origen;
    datos.caracteres = texto.length; // el largo REAL, calculado, no inventado
    datos.recortado = false; // ninguno pasa los 300.000 caracteres
    datos.errorMsg = null;
    datos.actualizadoEn = fecha(it.actualizadoEn);

    // (c) LOS CHUNKS de este item. Id deterministico itemId_idx, idx desde 0 y
    //     sin huecos (invariante 5).
    it.trozos.forEach((trozo, idx) => {
      const chunkId = `${it.id}_${idx}`;
      chunks.push({
        ref: db.collection("chunks").doc(chunkId),
        datos: {
          workspaceId: WS_ID, // filtro obligatorio de TODA busqueda
          itemId: it.id,
          titulo: it.titulo, // desnormalizado, para citar sin leer el item
          idx,
          pagina: trozo.pagina,
          origen: it.origen,
          texto: trozo.texto,
          embedding: null, // lo pone quien llama
          // COPIA de la visibilidad y del autor del item: es la SEGUNDA
          // cerradura del filtro de privacidad, nunca la que manda. Despues
          // la mantiene al dia el candado en vivo (PATCH .../visibilidad);
          // solo queda vieja si alguien toca el item desde la consola, y
          // como se aplica con AND, una copia vieja solo puede esconder de
          // mas.
          visibilidad: it.visibilidad,
          creadoPor: uidAutor,
          creadoEn: fecha(it.actualizadoEn),
        },
      });
    });
  }

  return { ref: db.collection("workspaces").doc(WS_ID).collection("items").doc(it.id), datos, chunks };
}

/**
 * Borra todos los documentos que devuelve una query, de a lotes.
 * Se usa para los chunks (que viven en una coleccion plana y se buscan por
 * workspaceId, asi que no alcanza con recursiveDelete de un documento).
 */
export async function borrarPorQuery(db, query, tamanoLote = 400) {
  let borrados = 0;
  while (true) {
    const snap = await query.limit(tamanoLote).get();
    if (snap.empty) return borrados;
    const lote = db.batch();
    snap.docs.forEach((d) => lote.delete(d.ref));
    await lote.commit();
    borrados += snap.size;
    if (snap.size < tamanoLote) return borrados;
  }
}
