// ============================================================================
//  scripts/cambiar-clave-demo.js  —  CAMBIA LA CONTRASENA de las 4 cuentas demo
//
//  Uso:   node --env-file=.env scripts/cambiar-clave-demo.js
//         npm run demo:clave        (hace exactamente lo mismo)
//
//  PARA QUE ESTA: la contrasena que tenian las cuentas demo quedo escrita en
//  el repo, que es PUBLICO. Con ella cualquiera podia entrar como Valentino
//  (el admin), Martin, Camila o Lucas: leer todo lo del equipo, ver los emails
//  de los miembros y gastar el cupo gratis de Gemini antes de la defensa.
//  Sacarla de los archivos no alcanza, porque sigue en el historial de git:
//  hay que CAMBIARLA en Firebase Auth, y eso es lo que hace este script.
//
//  QUE HACE:
//    1. Lee la clave nueva de SEED_PASSWORD (api/.env). Si falta, si es muy
//       corta o si es la vieja, corta ANTES de conectarse a Firebase.
//    2. Busca cada cuenta demo (valentino, martin, camila y lucas
//       .demo@neurodesk.test) por su uid fijo y, si no esta, por el email.
//       Solo toca cuentas cuyo email es EXACTAMENTE el de la demo: ninguna
//       otra cuenta del proyecto se mira ni se cambia.
//    3. A cada una le pone la clave nueva (auth.updateUser) y le cierra las
//       sesiones abiertas (auth.revokeRefreshTokens). El servidor rechaza al
//       instante los tokens viejos (verifica con checkRevoked) y la lectura
//       directa de Firestore se corta cuando vence el token, 1 hora como mucho.
//    4. Imprime que cuentas cambio. La clave NO se imprime nunca.
//  No toca Firestore: ni items, ni miembros, ni roles, ni la contrasena de
//  ninguna cuenta que no sea de la demo.
//
//  DESPUES DE CORRERLO: en los celulares y en el panel hay que cerrar sesion
//  y volver a entrar con la clave nueva. El paso a paso esta en api/SEED.md.
//
//  ES IDEMPOTENTE: correrlo dos veces deja la misma clave (y vuelve a cerrar
//  las sesiones, asi que conviene correrlo ANTES de entrar, no durante la demo).
//
//  Los mensajes de consola van sin acentos (ver la nota de _comun.js).
// ============================================================================

import path from "node:path";
import { fileURLToPath } from "node:url";

import { conectar, passwordDemo, USUARIOS_SEED } from "./_comun.js";

// Dos emails son el mismo sin importar mayusculas (Firebase los guarda en
// minuscula, pero el dato del seed lo escribio una persona).
function mismoEmail(a, b) {
  return typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Busca la cuenta como el PASO 1 de seed.js: primero por el uid fijo y
// despues por el email (si alguien se registro desde la app con ese mail,
// Firebase le dio otro uid). A diferencia del seed, un error que NO es "no
// existe" (sin red, sin permiso) no se toma como "no existe": sube.
async function buscarCuenta(auth, u) {
  try {
    const porUid = await auth.getUser(u.uid);
    // El uid fijo con OTRO email no es la cuenta demo: se sigue por el email.
    if (mismoEmail(porUid.email, u.email)) return porUid;
  } catch (err) {
    if (err?.code !== "auth/user-not-found") throw err;
  }
  try {
    return await auth.getUserByEmail(u.email);
  } catch (err) {
    if (err?.code === "auth/user-not-found") return null;
    throw err;
  }
}

// Para el log: el codigo de Firebase si lo hay. El mensaje completo no, por
// las dudas: ningun error tiene que poder arrastrar la clave a la pantalla.
function motivo(err) {
  return err?.code || "error sin codigo";
}

/**
 * Le pone 'clave' a las cuentas demo y les cierra las sesiones.
 *
 * Recibe el Auth de afuera (no llama a conectar()) a proposito: asi se puede
 * probar con un Auth falso en memoria, sin tocar Firebase. Sigue con las
 * otras cuentas aunque una falle, y devuelve { cambiadas, problemas } para
 * que quien llama decida el codigo de salida.
 */
export async function cambiarClavesDemo({ auth, clave, usuarios = USUARIOS_SEED, log = console.log }) {
  const cambiadas = [];
  const problemas = [];

  for (const u of usuarios) {
    let cuenta;
    try {
      cuenta = await buscarCuenta(auth, u);
    } catch (err) {
      // Sin red o sin permiso: esta cuenta no se toca y se sigue con las
      // otras. Al final se dice cuales cambiaron y cuales no.
      problemas.push(`${u.email}: no se pudo buscar la cuenta (${motivo(err)})`);
      log(`  FALLO        ${u.email.padEnd(32)} no se pudo buscar (${motivo(err)})`);
      continue;
    }
    if (!cuenta) {
      problemas.push(`${u.email} no existe (este script no crea cuentas: para eso estan el seed y sumar-lucas.js)`);
      log(`  NO EXISTE    ${u.email}`);
      continue;
    }

    try {
      await auth.updateUser(cuenta.uid, { password: clave });
    } catch (err) {
      problemas.push(`${u.email}: no se pudo cambiar la clave (${motivo(err)})`);
      log(`  FALLO        ${u.email.padEnd(32)} uid ${cuenta.uid}  la clave NO cambio (${motivo(err)})`);
      continue;
    }

    try {
      await auth.revokeRefreshTokens(cuenta.uid);
    } catch (err) {
      // La clave ya cambio: la cuenta cuenta como cambiada, pero se avisa,
      // porque alguien que ya habia entrado podria seguir adentro un rato.
      cambiadas.push(u.email);
      problemas.push(`${u.email}: la clave cambio pero no se pudieron cerrar sus sesiones (${motivo(err)}); volve a correr el script`);
      log(`  A MEDIAS     ${u.email.padEnd(32)} uid ${cuenta.uid}  clave cambiada, sesiones SIN cerrar (${motivo(err)})`);
      continue;
    }

    cambiadas.push(u.email);
    log(`  CAMBIADA     ${u.email.padEnd(32)} uid ${cuenta.uid}  (sesiones cerradas)`);
  }

  return { cambiadas, problemas };
}

async function main() {
  console.log("\n============================================================");
  console.log("  CAMBIAR LA CONTRASENA de las cuentas demo");
  console.log("============================================================\n");

  // 1. La clave, ANTES de conectarse: si falta (o es la vieja), no se toca nada.
  const clave = passwordDemo();

  const { admin, auth } = conectar();

  console.log(`Cuentas demo (${USUARIOS_SEED.length}):`);
  const { cambiadas, problemas } = await cambiarClavesDemo({ auth, clave });

  // La clave NO se imprime: la terminal termina en capturas y en el log.
  console.log(`\n  ${cambiadas.length} de ${USUARIOS_SEED.length} cuentas con la clave de SEED_PASSWORD del .env (no se imprime).`);
  if (problemas.length > 0) {
    console.log("\n  OJO, quedo algo sin hacer:");
    for (const p of problemas) console.log(`   - ${p}`);
  }
  if (cambiadas.length > 0) {
    console.log("\n  AHORA: en los celulares y en el panel, cerrar sesion y volver a entrar");
    console.log("  con la clave nueva. Pasensela por un canal privado, nunca por el repo.\n");
  }

  await admin.app().delete(); // cierra la conexion asi el proceso termina solo
  if (problemas.length > 0) process.exitCode = 1;
}

// Corre SOLO si este archivo es el que se llamo con node (npm run demo:clave).
// Si otro archivo lo importa (por ejemplo, para probar cambiarClavesDemo() con
// un Auth de mentira; hoy no hay ninguno en el repo), solo presta esa funcion
// y no se conecta a nada. En Windows la letra del disco
// puede venir en mayuscula o en minuscula, por eso se compara sin mayusculas.
function esElScriptQueSeCorrio() {
  if (!process.argv[1]) return false;
  const llamado = path.resolve(process.argv[1]);
  const este = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? llamado.toLowerCase() === este.toLowerCase() : llamado === este;
}

if (esElScriptQueSeCorrio()) {
  main().catch((err) => {
    console.error("\n!! NO SE CAMBIO LA CONTRASENA. Que paso:\n");
    console.error("   " + err.message + "\n");
    process.exit(1);
  });
}
