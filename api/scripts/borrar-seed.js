// ============================================================================
//  scripts/borrar-seed.js  —  limpia TODOS los datos de prueba
//
//  Uso:   node --env-file=.env scripts/borrar-seed.js            (simulacro)
//         node --env-file=.env scripts/borrar-seed.js --si       (borra)
//         node --env-file=.env scripts/borrar-seed.js --si --tambien-auth
//         npm run seed:borrar -- --si
//
//  POR QUE PIDE --si
//  Sin esa bandera NO BORRA NADA: cuenta lo que hay y lo muestra. Un script
//  que borra apenas se lo ejecuta es una bomba esperando un Enter de mas en la
//  terminal equivocada, y el dia de la entrega no hay backup que valga.
//
//  QUE BORRA
//    - todos los chunks con workspaceId == WS_ID (coleccion plana, top-level)
//    - el workspace entero con sus subcolecciones:
//      members, items, respuestas, eventos y suscripcion
//    - los documentos usuarios/{uid} de las tres cuentas del seed
//    - la entrada de ese workspace en el custom claim de cada una
//
//  QUE **NO** BORRA (salvo que se pase --tambien-auth)
//    - las cuentas de Firebase Auth. Se dejan a proposito: normalmente uno
//      quiere limpiar los datos y volver a correr el seed sin tener que
//      re-crear usuarios ni cambiar la contrasena de la demo.
//
//  EL ORDEN IMPORTA: primero los chunks, despues los items. Es la misma regla
//  del endpoint DELETE de items. Si el proceso se corta en el medio, pueden
//  quedar chunks de un item que todavia existe (inofensivo, se limpia
//  reintentando) pero NUNCA chunks huerfanos de un item que ya no esta, que es
//  el caso peligroso: texto de una nota privada vivo en la base, sin ningun
//  item al que preguntarle los permisos.
// ============================================================================

import { conectar, borrarPorQuery, WS_ID, WS_NOMBRE, USUARIOS_SEED } from "./_comun.js";

const banderas = process.argv.slice(2);
const enSerio = banderas.includes("--si");
const tambienAuth = banderas.includes("--tambien-auth");

const SUBCOLECCIONES = ["members", "items", "respuestas", "eventos", "suscripcion"];

async function main() {
  console.log("\n============================================================");
  console.log("  BORRAR-SEED" + (enSerio ? "" : "   (SIMULACRO: no borra nada)"));
  console.log("============================================================\n");

  const { admin, db, auth } = conectar();
  const refWs = db.collection("workspaces").doc(WS_ID);

  // ------------------------------------------------------------------
  // 1) Contar primero, para saber que se va a perder
  // ------------------------------------------------------------------
  console.log(`  Workspace objetivo: ${WS_ID}  (${WS_NOMBRE})\n`);

  const existeWs = (await refWs.get()).exists;
  const conteo = {};
  for (const sub of SUBCOLECCIONES) {
    conteo[sub] = (await refWs.collection(sub).count().get()).data().count;
  }
  conteo.chunks = (
    await db.collection("chunks").where("workspaceId", "==", WS_ID).count().get()
  ).data().count;

  console.log("  Lo que hay ahora:");
  console.log(`    workspaces/${WS_ID} ......... ${existeWs ? "existe" : "NO existe"}`);
  for (const sub of SUBCOLECCIONES) {
    console.log(`    ${sub.padEnd(24, ".")} ${String(conteo[sub]).padStart(4)} docs`);
  }
  console.log(`    ${"chunks".padEnd(24, ".")} ${String(conteo.chunks).padStart(4)} docs`);

  // Cuales de las cuentas del seed existen de verdad.
  const cuentas = [];
  for (const u of USUARIOS_SEED) {
    try {
      cuentas.push(await auth.getUserByEmail(u.email));
    } catch {
      /* no existe, no pasa nada */
    }
  }
  console.log(`\n  Cuentas del seed encontradas: ${cuentas.length ? cuentas.map((c) => c.email).join(", ") : "(ninguna)"}`);
  console.log(`  Las cuentas de Firebase Auth ${tambienAuth ? "SE VAN A BORRAR (--tambien-auth)" : "se conservan (pasa --tambien-auth para borrarlas)"}`);

  if (!enSerio) {
    console.log("\n  ------------------------------------------------------------");
    console.log("  SIMULACRO. No se toco nada.");
    console.log("  Si de verdad queres borrar todo esto, volve a correrlo asi:");
    console.log("     node --env-file=.env scripts/borrar-seed.js --si");
    console.log("  ------------------------------------------------------------\n");
    await admin.app().delete();
    return;
  }

  // ------------------------------------------------------------------
  // 2) PRIMERO los chunks (coleccion plana: se buscan por workspaceId)
  // ------------------------------------------------------------------
  console.log("\n  [1/4] Borrando chunks...");
  const chunksBorrados = await borrarPorQuery(
    db,
    db.collection("chunks").where("workspaceId", "==", WS_ID)
  );
  console.log(`        ${chunksBorrados} chunks borrados`);

  // ------------------------------------------------------------------
  // 3) DESPUES el workspace y todo lo que cuelga de el
  // ------------------------------------------------------------------
  // recursiveDelete() del Admin SDK baja el documento con TODAS sus
  // subcolecciones. Ojo: borrar un documento desde la consola de Firebase NO
  // borra sus subcolecciones (quedan "huerfanas" y siguen ocupando lugar);
  // este metodo si.
  console.log("  [2/4] Borrando el workspace y sus subcolecciones...");
  if (typeof db.recursiveDelete === "function") {
    await db.recursiveDelete(refWs);
  } else {
    // Plan B por si la version de firebase-admin no lo tiene: a mano.
    for (const sub of SUBCOLECCIONES) {
      await borrarPorQuery(db, refWs.collection(sub));
    }
    await refWs.delete();
  }
  console.log("        workspace borrado");

  // ------------------------------------------------------------------
  // 4) Los documentos usuarios/{uid} y los custom claims
  // ------------------------------------------------------------------
  console.log("  [3/4] Limpiando usuarios y custom claims...");
  let usuariosBorrados = 0;
  for (const cuenta of cuentas) {
    // El claim se reconstruye entero SIN este workspace, igual que en el
    // endpoint que saca a alguien del equipo. Si la persona pertenece a otro
    // workspace, ese acceso se lo respetamos.
    const refUsuario = db.collection("usuarios").doc(cuenta.uid);
    const snap = await refUsuario.get();
    const mapa = { ...((snap.exists && snap.get("workspaces")) || {}) };
    delete mapa[WS_ID];

    const claimWs = {};
    for (const [id, datos] of Object.entries(mapa)) claimWs[id] = datos.rol;
    await auth.setCustomUserClaims(cuenta.uid, Object.keys(claimWs).length ? { ws: claimWs } : null);

    if (snap.exists) {
      await refUsuario.delete();
      usuariosBorrados++;
    }
    console.log(`        ${cuenta.email.padEnd(32)} claim -> ${JSON.stringify(claimWs)}`);
  }
  console.log(`        ${usuariosBorrados} documentos usuarios/{uid} borrados`);

  // ------------------------------------------------------------------
  // 5) Las cuentas de Auth, solo si lo pidieron
  // ------------------------------------------------------------------
  console.log("  [4/4] Cuentas de Firebase Auth...");
  let authBorradas = 0;
  if (tambienAuth) {
    for (const cuenta of cuentas) {
      await auth.deleteUser(cuenta.uid);
      authBorradas++;
      console.log(`        borrada ${cuenta.email}`);
    }
  } else {
    console.log("        se conservan (no se paso --tambien-auth)");
  }

  console.log("\n============================================================");
  console.log("  RESUMEN — documentos borrados");
  console.log("============================================================");
  console.log(`  chunks .................. ${chunksBorrados}`);
  for (const sub of SUBCOLECCIONES) console.log(`  ${sub.padEnd(23, ".")} ${conteo[sub]}`);
  console.log(`  workspaces .............. ${existeWs ? 1 : 0}`);
  console.log(`  usuarios ................ ${usuariosBorrados}`);
  console.log(`  cuentas de Auth ......... ${authBorradas}`);
  console.log("\n  Para volver a llenar la base:  npm run seed\n");

  await admin.app().delete();
}

main().catch((err) => {
  console.error("\n!! El borrado no termino. Que paso:\n");
  console.error("   " + err.message + "\n");
  console.error("   Si ya habia empezado a borrar, correlo de nuevo sin miedo:");
  console.error("   borrar dos veces lo mismo no rompe nada.\n");
  process.exit(1);
});
