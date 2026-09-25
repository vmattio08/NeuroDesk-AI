// ============================================================================
//  scripts/_comun.js
//
//  Lo UNICO que comparten los tres scripts: como conectarse a Firebase y
//  cuales son los datos de prueba (el wsId y los tres usuarios).
//
//  POR QUE existe este archivo y no esta todo copiado en cada script:
//  si seed.js y borrar-seed.js no usaran EXACTAMENTE el mismo wsId y los
//  mismos emails, el borrado limpiaria otra cosa (o nada) y nadie se
//  enteraria hasta el dia de la entrega. Un solo lugar, una sola verdad.
//  No es una "capa de abstraccion": son cinco constantes y una funcion.
//
//  OJO CON LOS ACENTOS: los mensajes que se imprimen en la consola van SIN
//  acentos a proposito, porque la consola de Windows (codepage 850) los
//  muestra rotos y las capturas de pantalla quedan feas. Los datos que se
//  guardan en Firestore SI llevan acentos: eso se ve bien en la consola web.
// ============================================================================

import admin from "firebase-admin";

// ---------------------------------------------------------------------------
// DATOS DE PRUEBA (los mismos para seed.js y para borrar-seed.js)
// ---------------------------------------------------------------------------

// El id del workspace es FIJO, no autogenerado. Es lo que hace que correr el
// seed dos veces pise los mismos documentos en vez de crear un workspace nuevo.
export const WS_ID = "ws_seed_6to1ra";
export const WS_NOMBRE = "6to 1ra - Programación II"; // 25 caracteres (el limite es 40)

// Los uid tambien son fijos: se los pasamos a mano a admin.auth().createUser().
// Firebase deja elegir el uid, y eso es lo que vuelve idempotente el alta.
export const USUARIOS_SEED = [
  {
    clave: "valentino",
    uid: "uid_seed_valentino",
    email: "valentino.demo@neurodesk.test",
    nombre: "Valentino Mattio",
    rol: "admin", // es el owner del workspace
  },
  {
    clave: "martin",
    uid: "uid_seed_martin",
    email: "martin.demo@neurodesk.test",
    nombre: "Martín Sosa",
    rol: "miembro",
  },
  {
    clave: "camila",
    uid: "uid_seed_camila",
    email: "camila.demo@neurodesk.test",
    nombre: "Camila Duarte",
    rol: "miembro",
  },
];

// Contrasena de las CUENTAS DE DEMO. Sirve para poder entrar desde la app y
// desde el panel durante la defensa. Son cuentas descartables de un proyecto
// escolar: si alguna vez esto se usa de verdad, se borran con borrar-seed.js
// --tambien-auth. Se puede cambiar con la variable de entorno SEED_PASSWORD.
export const PASSWORD_DEMO = process.env.SEED_PASSWORD || "NeuroDesk2026!";

// Largo del vector de embeddings. Tiene que ser el MISMO numero que EMBED_DIMS
// del .env: si el seed escribe 768 y el backend pide 1024, la similitud coseno
// explota con "arrays de distinto largo".
export const EMBED_DIMS = Number(process.env.EMBED_DIMS || 1024);

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
    admin.initializeApp({ projectId });
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

    admin.initializeApp({ credential: admin.credential.cert(credencial), projectId });
    console.log(`  Conectado al proyecto REAL de Firebase: ${projectId}`);
  }

  cache = { admin, db: admin.firestore(), auth: admin.auth() };
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
  return admin.firestore.Timestamp.fromDate(d);
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
