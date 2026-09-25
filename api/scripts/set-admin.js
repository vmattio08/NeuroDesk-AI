// ============================================================================
//  scripts/set-admin.js  —  sube a alguien a ADMIN de un workspace, por email
//
//  Uso:   node --env-file=.env scripts/set-admin.js <email> [wsId]
//         npm run set-admin -- valentino.demo@neurodesk.test
//
//  Si no se pasa el wsId, usa el del seed (ws_seed_6to1ra).
//
//  PARA QUE SIRVE
//  Es el "huevo o la gallina" del panel: para invitar gente hay que ser admin,
//  pero al primer admin no lo puede invitar nadie. Este script lo resuelve por
//  afuera, con el Admin SDK, que se saltea las reglas de Firestore.
//  Tambien sirve si en la demo se bajo por error al unico admin y quedo el
//  workspace sin nadie que pueda entrar al panel.
//
//  HACE EXACTAMENTE LO MISMO QUE EL ENDPOINT PATCH /v1/workspaces/:wsId/
//  miembros/:uid, y a proposito: los TRES lugares donde vive el rol tienen que
//  decir siempre lo mismo (invariante 12).
//    1. workspaces/{wsId}/members/{uid}.rol   <- manda para el BACKEND
//    2. usuarios/{uid}.workspaces[wsId].rol   <- la fuente de verdad del claim
//    3. el custom claim ws[wsId] del token    <- manda para las REGLAS
//  Si tocaramos solo uno, el backend y las reglas dirian cosas distintas y
//  ese bug es carisimo de encontrar.
// ============================================================================

import { conectar, WS_ID } from "./_comun.js";

const email = (process.argv[2] || "").trim().toLowerCase();
const wsId = (process.argv[3] || WS_ID).trim();

if (!email) {
  console.error("\nFalta el email.\n");
  console.error("  Uso:  node --env-file=.env scripts/set-admin.js <email> [wsId]");
  console.error(`  Ej.:  node --env-file=.env scripts/set-admin.js valentino.demo@neurodesk.test\n`);
  console.error(`  Si no pones wsId, usa el del seed: ${WS_ID}\n`);
  process.exit(1);
}

async function main() {
  console.log("\n============================================================");
  console.log("  SET-ADMIN");
  console.log("============================================================\n");

  const { admin, db, auth } = conectar();

  // ------------------------------------------------------------------
  // 1) Buscar la persona en Firebase Auth
  // ------------------------------------------------------------------
  let cuenta;
  try {
    cuenta = await auth.getUserByEmail(email);
  } catch {
    throw new Error(
      `No existe ninguna cuenta con el email "${email}".\n` +
        "   En NeuroDesk no hay invitaciones pendientes: primero la persona se\n" +
        "   registra desde la app o el panel, y recien despues se la asciende."
    );
  }
  const uid = cuenta.uid;
  const nombre = cuenta.displayName || email.split("@")[0];
  console.log(`  Persona:   ${nombre}  <${email}>`);
  console.log(`  uid:       ${uid}`);

  // ------------------------------------------------------------------
  // 2) Chequear que el workspace exista
  // ------------------------------------------------------------------
  const refWs = db.collection("workspaces").doc(wsId);
  const snapWs = await refWs.get();
  if (!snapWs.exists) {
    throw new Error(
      `El workspace "${wsId}" no existe en Firestore.\n` +
        "   Corre primero el seed (npm run seed) o pasale el wsId correcto."
    );
  }
  const nombreWs = snapWs.get("nombre");
  console.log(`  Workspace: ${wsId}  (${nombreWs})\n`);

  const refMiembro = refWs.collection("members").doc(uid);
  const snapMiembro = await refMiembro.get();
  const rolAnterior = snapMiembro.exists ? snapMiembro.get("rol") : "(no era miembro)";

  // ------------------------------------------------------------------
  // 3) members/{uid} — el documento que el backend lee en CADA request
  // ------------------------------------------------------------------
  // Si la persona ya estaba, solo le cambiamos el rol (merge). Si no estaba,
  // la damos de alta como admin. Aca usamos serverTimestamp() y no una fecha
  // fija: esto no es el seed, es una operacion real que pasa ahora.
  const ahora = admin.firestore.FieldValue.serverTimestamp();
  if (snapMiembro.exists) {
    await refMiembro.update({ rol: "admin" });
  } else {
    await refMiembro.set({
      uid,
      email,
      nombre,
      rol: "admin",
      agregadoPor: uid, // se dio de alta a si mismo desde un script, no lo invito nadie
      agregadoEn: ahora,
    });
  }
  console.log(`  [1/3] members/${uid}.rol   ${rolAnterior} -> admin`);

  // ------------------------------------------------------------------
  // 4) usuarios/{uid}.workspaces — adentro de una transaccion
  // ------------------------------------------------------------------
  // La transaccion no es decoracion: si dos admins tocan a la misma persona
  // al mismo tiempo, sin transaccion el segundo pisa el mapa que leyo antes
  // del primero y esa persona pierde el acceso a un workspace EN SILENCIO.
  // Por eso se lee y se escribe el mapa en un solo paso atomico.
  const refUsuario = db.collection("usuarios").doc(uid);
  const mapaFinal = await db.runTransaction(async (tx) => {
    const snap = await tx.get(refUsuario);
    const mapa = { ...((snap.exists && snap.get("workspaces")) || {}) };
    mapa[wsId] = { rol: "admin", nombre: nombreWs };

    if (snap.exists) {
      tx.update(refUsuario, { workspaces: mapa, claimsActualizadoEn: ahora });
    } else {
      // Raro pero posible: la cuenta existe en Auth y nunca paso por
      // /v1/auth/registro. Dejamos el doc completo para que no quede a medias.
      tx.set(refUsuario, {
        email,
        nombre,
        workspaces: mapa,
        workspaceActual: wsId,
        claimsActualizadoEn: ahora,
        creadoEn: ahora,
      });
    }
    return mapa;
  });
  console.log(`  [2/3] usuarios/${uid}.workspaces actualizado`);

  // ------------------------------------------------------------------
  // 5) El custom claim, RECONSTRUIDO ENTERO desde el mapa del documento
  // ------------------------------------------------------------------
  // Nunca se mergea a ciegas contra el claim viejo (invariante 13): el claim
  // es siempre el reflejo exacto de usuarios/{uid}.workspaces.
  const claimWs = {};
  for (const [id, datos] of Object.entries(mapaFinal)) claimWs[id] = datos.rol;
  await auth.setCustomUserClaims(uid, { ws: claimWs });
  console.log(`  [3/3] custom claim ws = ${JSON.stringify(claimWs)}`);

  // ------------------------------------------------------------------
  // 6) El evento de auditoria (append-only, solo lo lee el admin)
  // ------------------------------------------------------------------
  await refWs.collection("eventos").add({
    tipo: "rol.cambiado",
    actorUid: uid,
    resumen: `${nombre} pasó a administrador (desde el script set-admin)`,
    itemId: null,
    creadoEn: ahora,
  });

  console.log("\n  Listo.");
  console.log("\n  IMPORTANTE — el token de esa persona todavia dice el rol VIEJO.");
  console.log("  El custom claim viaja adentro del ID token y el token dura 1 hora.");
  console.log("  Para que el cambio se note ya mismo, la persona tiene que:");
  console.log("    - cerrar sesion y volver a entrar, o");
  console.log("    - que el cliente haga  await user.getIdToken(true)");
  console.log("  (La app lo hace sola: escucha su doc usuarios/{uid} y, cuando ve");
  console.log("   cambiar claimsActualizadoEn, refresca el token.)\n");

  await admin.app().delete();
}

main().catch((err) => {
  console.error("\n!! No se pudo cambiar el rol:\n");
  console.error("   " + err.message + "\n");
  process.exit(1);
});
