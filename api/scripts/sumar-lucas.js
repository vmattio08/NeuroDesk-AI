// ============================================================================
//  scripts/sumar-lucas.js  —  SUMA A LUCAS al espacio de demo que YA EXISTE
//
//  Uso:   node --env-file=.env scripts/sumar-lucas.js
//         npm run seed:lucas        (hace exactamente lo mismo)
//
//  PARA QUE ESTA: la demo de "la memoria que no se va". Valentino saca a Lucas
//  del equipo desde el panel, y la IA le sigue citando a Martin el Reglamento
//  "de Lucas (ya no esta en el equipo)". Lucas existe para poder sacarlo sin
//  cerrarle la sesion a nadie (sacar a alguien le revoca los tokens): nadie
//  entra con esta cuenta.
//
//  QUE HACE, con los datos de _comun.js (los MISMOS que usa seed.js):
//    1. La cuenta lucas.demo@neurodesk.test en Firebase Auth, con uid fijo y
//       la misma contrasena que las otras cuentas demo: SEED_PASSWORD del
//       .env, que no tiene valor por omision. Se pide SOLO si hay que crear
//       la cuenta: si Lucas ya existe, el script anda sin ella; si hay que
//       crearla y falta, corta antes de tocar nada (ver passwordDemo() en
//       _comun.js). La contrasena no se imprime nunca.
//    2. usuarios/{uid} y el custom claim, juntando los espacios que ya tenia
//       (igual que el PASO 3 de seed.js: pisar el mapa lo dejaria afuera de
//       otro espacio sin que nadie se entere).
//    3. members/{uid} en el espacio de demo. Si lo habian sacado, borra su
//       clave de exMiembros, igual que el POST de miembros del backend. Si el
//       plan del espacio no deja sumarlo, lo pasa al plan de demo.
//    4. Sus 3 items del equipo, ya procesados: el Reglamento pasa a ser suyo
//       (el item y la copia creadoPor de sus chunks) y las dos notas se crean
//       con vectores REALES de Gemini, igual que /procesar.
//    5. Los eventos del seed que cuentan su llegada y sus items.
//    6. Vuelve a leer todo de Firestore y verifica que quedo bien.
//
//  POR QUE UN SCRIPT APARTE Y NO seed.js: el seed BORRA todos los chunks del
//  espacio antes de escribir los suyos, y el espacio de demo ya tiene items
//  reales cargados desde la app: sus chunks se perderian y esos items
//  quedarian 'listo' pero mudos para la IA. Este script NO BORRA NADA: crea lo
//  que falta y corrige lo de Lucas. Si un item de Lucas quedo distinto de como
//  lo deja el seed (lo reprocesaron, quedo en error), no lo toca y avisa: se
//  borra desde el panel y se vuelve a correr el script, que lo crea de cero.
//
//  ES IDEMPOTENTE: ids fijos, fechas fijas y los mismos datos. Correrlo dos
//  veces deja lo mismo. Sirve tambien entre ensayo y ensayo de la demo, para
//  volver a poner a Lucas en Miembros despues de sacarlo.
//
//  Los mensajes de consola van sin acentos (ver la nota de _comun.js).
// ============================================================================

import { FieldPath, FieldValue } from "firebase-admin/firestore";

import {
  conectar,
  fecha,
  armarItemDelSeed,
  usuarioSeed,
  WS_ID,
  WS_NOMBRE,
  passwordDemo,
  EMBED_DIMS,
  PLAN_DEL_ESPACIO_DE_DEMO,
  MAX_MIEMBROS_PLAN_FREE,
  ITEMS_DE_LUCAS,
  EVENTOS_DE_LUCAS,
  EVENTO_DEL_REGLAMENTO,
} from "./_comun.js";

const LUCAS = usuarioSeed("lucas");
const VALENTINO = usuarioSeed("valentino");

// Las dos fechas fijas que seed.js le pone a usuarios/{uid} (PASO 3). Son las
// mismas para que el doc de Lucas quede igual por los dos caminos.
const USUARIO_CREADO_EN = "2026-08-23T20:00:00-03:00";
const CLAIMS_ACTUALIZADOS_EN = "2026-08-24T09:04:00-03:00";

// Lo que se encontro mal y no se toco: se imprime al final y el script
// termina con codigo 1.
const problemas = [];

// ============================================================================
//  AYUDANTES
// ============================================================================

// Busca la cuenta como el PASO 1 de seed.js: primero por el uid fijo y
// despues por el email. Lo segundo importa porque si alguien ya se registro
// desde la app con ese mail, Firebase le dio otro uid, y crear de nuevo
// tiraria auth/email-already-exists.
// Solo "no existe" (auth/user-not-found) quiere decir que no esta. Cualquier
// otro error (sin red, sin permiso) sube y lo muestra main(): antes se tomaba
// como "no existe" y terminaba en un "No existe la cuenta de valentino..." o
// en un "Falta SEED_PASSWORD" que no tenian nada que ver (igual que en
// cambiar-clave-demo.js).
async function buscarCuenta(auth, u) {
  try {
    return await auth.getUser(u.uid);
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

// ¿El item esta EXACTAMENTE como lo deja el seed? Mismo titulo, 'listo', y un
// chunk por trozo con el mismo texto y un vector del largo correcto. Solo en
// ese caso el script le corrige el autor y la visibilidad sin rehacer nada:
// los vectores dependen del texto y del titulo, no de quien lo subio.
function estaComoLoDejaElSeed(item, chunksDelWs, it) {
  if (item.estado !== "listo" || item.workspaceId !== WS_ID || item.titulo !== it.titulo) return false;
  if (item.cantChunks !== it.trozos.length || chunksDelWs.length !== it.trozos.length) return false;
  return chunksDelWs.every((doc) => {
    const c = doc.data();
    const trozo = it.trozos[c.idx];
    return (
      doc.id === `${it.id}_${c.idx}` &&
      trozo !== undefined &&
      c.texto === trozo.texto &&
      Array.isArray(c.embedding) &&
      c.embedding.length === EMBED_DIMS
    );
  });
}

// Vectores REALES para los chunks nuevos: el mismo pedido que hace seed.js
// con clave (y indexar() en el backend): cada trozo como 'passage', con el
// titulo de su item al lado, redondeado a 6 decimales y con norma 1.
async function ponerVectoresReales(chunks) {
  const { pedirEmbeddings } = await import("../src/servicios/ia.js");
  const vectores = await pedirEmbeddings(
    chunks.map((c) => c.datos.texto),
    "passage",
    { titulos: chunks.map((c) => c.datos.titulo) },
  );
  chunks.forEach((c, i) => {
    const v = vectores[i].map((x) => Number(x.toFixed(6)));
    const norma = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
    if (v.length !== EMBED_DIMS) throw new Error(`El vector de ${c.ref.id} tiene ${v.length} dims y deberia tener ${EMBED_DIMS}`);
    if (Math.abs(norma - 1) > 0.001) throw new Error(`El vector de ${c.ref.id} no esta normalizado (norma ${norma})`);
    c.datos.embedding = v;
  });
}

// ============================================================================
//  EL SCRIPT
// ============================================================================

async function main() {
  console.log("\n============================================================");
  console.log("  SUMAR A LUCAS al espacio de demo (sin borrar nada)");
  console.log("============================================================\n");

  const { admin, db, auth } = conectar();
  const refWs = db.collection("workspaces").doc(WS_ID);

  const snapWs = await refWs.get();
  if (!snapWs.exists) {
    throw new Error(`No existe workspaces/${WS_ID}. Este script SUMA a Lucas a un espacio que ya existe: primero hay que correr el seed.`);
  }

  // --------------------------------------------------------------------
  // PASO 1 — La cuenta en Firebase Auth
  // --------------------------------------------------------------------
  console.log("PASO 1/6  La cuenta de Lucas en Firebase Auth");
  const cuentaValentino = await buscarCuenta(auth, VALENTINO);
  if (!cuentaValentino) throw new Error(`No existe la cuenta de ${VALENTINO.email}: primero hay que correr el seed.`);

  let cuentaLucas = await buscarCuenta(auth, LUCAS);
  if (cuentaLucas) {
    console.log(`  ya existia   ${LUCAS.email}  uid ${cuentaLucas.uid}`);
    console.log("  contrasena: no se toco (para cambiarla esta npm run demo:clave)");
  } else {
    cuentaLucas = await auth.createUser({
      uid: LUCAS.uid, // uid FIJO: es lo que hace idempotente el alta
      email: LUCAS.email,
      emailVerified: true,
      // Recien aca se pide la clave: si falta SEED_PASSWORD, passwordDemo()
      // corta antes de crear la cuenta y antes de escribir nada en Firestore.
      password: passwordDemo(),
      displayName: LUCAS.nombre,
    });
    console.log(`  CREADA       ${LUCAS.email}  uid ${cuentaLucas.uid}`);
    // La contrasena NO se imprime: la terminal termina en capturas y en el log.
    console.log("  contrasena: la de SEED_PASSWORD del .env, la misma de las otras cuentas demo (no se imprime)");
  }

  const uidLucas = cuentaLucas.uid;
  const uidValentino = cuentaValentino.uid;
  const uidDe = { lucas: uidLucas, valentino: uidValentino };

  // --------------------------------------------------------------------
  // PASO 2 — usuarios/{uid}
  // --------------------------------------------------------------------
  // El mapa se arma sumando el espacio de demo a los que ya tenia. De este
  // mapa sale el claim ENTERO (invariante 13), que se escribe al final del
  // paso 3, cuando ya estan todos los documentos.
  console.log("\nPASO 2/6  Documento de usuario");
  const refUsuario = db.collection("usuarios").doc(uidLucas);
  const snapUsuario = await refUsuario.get();
  const workspacesPrevios = (snapUsuario.exists && snapUsuario.get("workspaces")) || {};
  const mapaWorkspaces = { ...workspacesPrevios, [WS_ID]: { rol: LUCAS.rol, nombre: WS_NOMBRE } };

  await refUsuario.set({
    email: LUCAS.email,
    nombre: LUCAS.nombre,
    workspaces: mapaWorkspaces,
    workspaceActual: WS_ID,
    claimsActualizadoEn: fecha(CLAIMS_ACTUALIZADOS_EN),
    // Si el doc ya existia, se respeta su fecha de alta, como en seed.js.
    creadoEn: (snapUsuario.exists && snapUsuario.get("creadoEn")) || fecha(USUARIO_CREADO_EN),
  });

  // --------------------------------------------------------------------
  // PASO 3 — members/{uid}, exMiembros y el plan
  // --------------------------------------------------------------------
  console.log("\nPASO 3/6  Lucas en members (y el plan del espacio)");
  const ws = snapWs.data();
  const refMiembro = refWs.collection("members").doc(uidLucas);
  const yaEraMiembro = (await refMiembro.get()).exists;
  const miembrosAhora = (await refWs.collection("members").count().get()).data().count;
  const miembrosConLucas = yaEraMiembro ? miembrosAhora : miembrosAhora + 1;

  // EL PLAN. El free deja 5 personas por espacio (el mismo numero que
  // workspaces.js) y el de demo ya tiene a las 3 cuentas del seed y a las
  // cuentas reales del equipo. Si Lucas no entra, el espacio pasa al plan de
  // demo: 'pro', activo y SIN CARGO (ver PLAN_DEL_ESPACIO_DE_DEMO en
  // _comun.js). Sin esto, el backend contestaria LIMITE_PLAN la proxima vez
  // que el admin quiera invitar a alguien (o volver a sumar a Lucas).
  const necesitaOtroPlan = (ws.plan || "free") === "free" && miembrosConLucas > MAX_MIEMBROS_PLAN_FREE;

  // Si lo habian sacado en un ensayo, su nombre quedo en exMiembros. Ahora
  // vuelve a tener ficha, asi que esa clave sobra: lo mismo que hace el POST
  // de miembros. FieldPath y no 'exMiembros.' + uid, por si el uid trajera un
  // punto (armaria un mapa adentro de otro).
  const volvio = Boolean(ws.exMiembros && typeof ws.exMiembros === "object" && Object.hasOwn(ws.exMiembros, uidLucas));

  // members, exMiembros y el plan van en UN lote: o queda todo o nada.
  const lote = db.batch();
  lote.set(refMiembro, {
    uid: uidLucas,
    email: LUCAS.email,
    nombre: LUCAS.nombre,
    rol: LUCAS.rol,
    agregadoPor: uidValentino, // lo "agrego" el admin, como en el seed
    agregadoEn: fecha(LUCAS.agregadoEn),
  });

  const cambiosDelWs = [];
  if (volvio) cambiosDelWs.push(new FieldPath("exMiembros", uidLucas), FieldValue.delete());
  if (necesitaOtroPlan) cambiosDelWs.push("plan", PLAN_DEL_ESPACIO_DE_DEMO.plan, "planStatus", PLAN_DEL_ESPACIO_DE_DEMO.estado);
  if (cambiosDelWs.length > 0) {
    lote.update(refWs, ...cambiosDelWs, "actualizadoEn", FieldValue.serverTimestamp());
  }

  if (necesitaOtroPlan) {
    // workspaces.plan/planStatus y suscripcion/actual dicen SIEMPRE lo mismo
    // (invariante 21). Sin preapprovalId: no hay ningun cobro detras.
    const refSuscripcion = refWs.collection("suscripcion").doc("actual");
    const plan = {
      plan: PLAN_DEL_ESPACIO_DE_DEMO.plan,
      estado: PLAN_DEL_ESPACIO_DE_DEMO.estado,
      montoMensual: PLAN_DEL_ESPACIO_DE_DEMO.montoMensual,
      actualizadoEn: FieldValue.serverTimestamp(),
    };
    if ((await refSuscripcion.get()).exists) {
      lote.update(refSuscripcion, plan);
    } else {
      lote.set(refSuscripcion, { ...plan, preapprovalId: null, vence: null, eventosProcesados: [] });
    }
  }
  await lote.commit();

  console.log(`  members/${uidLucas}  ${yaEraMiembro ? "ya estaba (queda con los datos del seed)" : "AGREGADO"}  rol ${LUCAS.rol}`);
  if (volvio) console.log("  estaba en exMiembros (lo habian sacado): se borro esa clave");
  console.log(
    necesitaOtroPlan
      ? `  el plan free deja ${MAX_MIEMBROS_PLAN_FREE} personas y con Lucas son ${miembrosConLucas}: el espacio paso al plan ${PLAN_DEL_ESPACIO_DE_DEMO.plan}, ${PLAN_DEL_ESPACIO_DE_DEMO.estado}, sin cargo`
      : `  plan ${ws.plan || "free"} (${miembrosConLucas} personas con Lucas): no hace falta cambiarlo`
  );

  // El claim va DESPUES de los documentos, como en el backend: si se corta en
  // el medio, el claim queda viejo y volver a correr el script lo arregla.
  const claimWs = {};
  for (const [wsId, datos] of Object.entries(mapaWorkspaces)) claimWs[wsId] = datos.rol;
  await auth.setCustomUserClaims(uidLucas, { ws: claimWs });
  console.log(`  claim ws = ${JSON.stringify(claimWs)}`);

  // --------------------------------------------------------------------
  // PASO 4 — Sus 3 items
  // --------------------------------------------------------------------
  console.log("\nPASO 4/6  Los items de Lucas");
  const aCrear = [];
  for (const it of ITEMS_DE_LUCAS) {
    // El documento y los chunks como los deja el seed (misma funcion).
    const armado = armarItemDelSeed(db, it, uidLucas);
    const snapItem = await armado.ref.get();

    // Los chunks se buscan por itemId y se quedan SOLO los de este espacio:
    // la coleccion es plana y otro espacio puede tener un item con el mismo
    // id. Los ajenos no se miran ni se tocan.
    const snapChunks = await db.collection("chunks").where("itemId", "==", it.id).get();
    const chunksDelWs = snapChunks.docs.filter((d) => d.get("workspaceId") === WS_ID);

    if (!snapItem.exists) {
      // Los ids de los chunks son itemId_idx. Si alguno ya existe en OTRO
      // espacio, escribirlo pisaria un dato ajeno: no se crea y se avisa.
      // Los de ESTE espacio solo pueden ser restos de una corrida que se
      // corto antes de crear el item (mismos ids y mismos datos): se pisan.
      const idsDelSeed = new Set(armado.chunks.map((c) => c.ref.id));
      const ajenos = snapChunks.size - chunksDelWs.length;
      const sobrantes = chunksDelWs.filter((d) => !idsDelSeed.has(d.id)).length;
      if (ajenos > 0 || sobrantes > 0) {
        problemas.push(
          `${it.id} («${it.titulo}») no existe, pero hay chunks con ese itemId ` +
            `(${ajenos} de otro espacio, ${sobrantes} de este que no son del seed). No se creo nada para no pisarlos.`
        );
        console.log(`  ${it.id}  NO SE CREO (ver el aviso del final)`);
        continue;
      }
      aCrear.push(armado);
      continue;
    }

    if (!estaComoLoDejaElSeed(snapItem.data(), chunksDelWs, it)) {
      const item = snapItem.data();
      problemas.push(
        `${it.id} («${it.titulo}») no esta como lo deja el seed (estado ${item.estado}, ` +
          `${chunksDelWs.length} chunks y el seed tiene ${it.trozos.length}). No se toco: ` +
          "borralo desde el panel y volve a correr este script, que lo crea de cero."
      );
      console.log(`  ${it.id}  NO SE TOCO (ver el aviso del final)`);
      continue;
    }

    // Esta bien armado: solo se corrigen el autor y la visibilidad, en el item
    // y en la copia que guarda cada chunk (la segunda cerradura de buscar.js).
    const deseado = { creadoPor: uidLucas, visibilidad: it.visibilidad };
    const cambiar = (datos) => Object.fromEntries(Object.entries(deseado).filter(([k, v]) => datos[k] !== v));
    const delItem = cambiar(snapItem.data());
    const deLosChunks = chunksDelWs
      .map((d) => ({ ref: d.ref, campos: cambiar(d.data()) }))
      .filter((c) => Object.keys(c.campos).length > 0);

    // "Primero cerrar, ultimo abrir", como el candado en vivo: si la
    // visibilidad pasa a 'equipo', primero los chunks y despues el item; si
    // no, al reves. Si se corta en el medio, la IA esconde de mas, nunca
    // muestra de mas.
    const abre = delItem.visibilidad === "equipo";
    const escribirChunks = async () => {
      for (let i = 0; i < deLosChunks.length; i += 400) {
        const loteChunks = db.batch();
        for (const c of deLosChunks.slice(i, i + 400)) loteChunks.update(c.ref, c.campos);
        await loteChunks.commit();
      }
    };
    const escribirItem = async () => {
      if (Object.keys(delItem).length > 0) await armado.ref.update(delItem);
    };
    if (abre) {
      await escribirChunks();
      await escribirItem();
    } else {
      await escribirItem();
      await escribirChunks();
    }

    const cambios = Object.keys(delItem).length + deLosChunks.length;
    console.log(
      cambios === 0
        ? `  ${it.id}  ya estaba bien (de Lucas, ${it.visibilidad}, ${chunksDelWs.length} chunks)`
        : `  ${it.id}  CORREGIDO: ${Object.keys(delItem).join(" y ") || "solo los chunks"} en el item y en ${deLosChunks.length} de sus ${chunksDelWs.length} chunks  «${it.titulo}»`
    );
  }

  if (aCrear.length > 0) {
    // Sin clave de Gemini no se crea nada: con vectores falsos el item
    // existiria pero la IA no lo encontraria nunca, y en la demo no se nota
    // hasta que falla.
    if (!(process.env.GEMINI_API_KEY || "").trim()) {
      throw new Error("Falta GEMINI_API_KEY en el .env: los items nuevos de Lucas necesitan vectores reales.");
    }
    const chunks = aCrear.flatMap((a) => a.chunks);
    await ponerVectoresReales(chunks);
    // Primero los chunks y despues el item, como /procesar: el item recien
    // aparece 'listo' cuando sus chunks ya estan. Y mientras no exista el
    // item, la cerradura en vivo de buscar.js no deja pasar esos chunks.
    // set() y no create(): arriba ya se comprobo que esos ids no son de otro
    // espacio, y asi un resto de una corrida cortada no hace fallar esta.
    // De a 80, como indexar(): cada chunk lleva 1024 numeros.
    for (let i = 0; i < chunks.length; i += 80) {
      const loteChunks = db.batch();
      for (const c of chunks.slice(i, i + 80)) loteChunks.set(c.ref, c.datos);
      await loteChunks.commit();
    }
    for (const a of aCrear) {
      await a.ref.create(a.datos);
      console.log(`  ${a.ref.id}  CREADO con ${a.chunks.length} chunks (vectores reales de Gemini)  «${a.datos.titulo}»`);
    }
  }

  // --------------------------------------------------------------------
  // PASO 5 — Los eventos del seed que lo nombran
  // --------------------------------------------------------------------
  // Mismos ids y fechas que en seed.js. evt_seed_09 ya existia con Camila
  // como autora del Reglamento: se reescribe para que el feed diga lo mismo
  // que el item.
  console.log("\nPASO 5/6  Eventos");
  const loteEventos = db.batch();
  for (const e of [EVENTO_DEL_REGLAMENTO, ...EVENTOS_DE_LUCAS]) {
    loteEventos.set(refWs.collection("eventos").doc(e.id), {
      tipo: e.tipo,
      actorUid: uidDe[e.actor.clave],
      resumen: e.resumen,
      itemId: e.itemId,
      creadoEn: fecha(e.creadoEn),
    });
  }
  await loteEventos.commit();
  console.log(`  ${EVENTOS_DE_LUCAS.length + 1} eventos (${[EVENTO_DEL_REGLAMENTO, ...EVENTOS_DE_LUCAS].map((e) => e.id).join(", ")})`);

  // --------------------------------------------------------------------
  // PASO 6 — Verificar, leyendo de nuevo
  // --------------------------------------------------------------------
  console.log("\nPASO 6/6  Verificacion (vuelvo a leer todo)");
  const chequeos = [];
  const chequear = (ok, texto) => {
    chequeos.push(ok);
    console.log(`  ${ok ? "ok   " : "MAL  "} ${texto}`);
  };

  const usuarioAuth = await auth.getUser(uidLucas);
  chequear(usuarioAuth.email === LUCAS.email, `cuenta de Auth ${usuarioAuth.email} (uid ${uidLucas})`);
  chequear(usuarioAuth.customClaims?.ws?.[WS_ID] === LUCAS.rol, `claim ws.${WS_ID} = ${usuarioAuth.customClaims?.ws?.[WS_ID]}`);

  const miembro = (await refMiembro.get()).data();
  chequear(miembro?.nombre === LUCAS.nombre && miembro?.rol === LUCAS.rol, `members/${uidLucas}: nombre ${miembro?.nombre}, rol ${miembro?.rol}`);

  const wsDespues = (await refWs.get()).data();
  chequear(!Object.hasOwn(wsDespues.exMiembros ?? {}, uidLucas), "no figura en exMiembros");
  const totalMiembros = (await refWs.collection("members").count().get()).data().count;
  chequear(
    (wsDespues.plan || "free") !== "free" || totalMiembros <= MAX_MIEMBROS_PLAN_FREE,
    `plan ${wsDespues.plan} / ${wsDespues.planStatus} con ${totalMiembros} personas`
  );

  for (const it of ITEMS_DE_LUCAS) {
    const item = (await refWs.collection("items").doc(it.id).get()).data();
    const chunks = (await db.collection("chunks").where("itemId", "==", it.id).get()).docs.filter((d) => d.get("workspaceId") === WS_ID);
    const chunksBien = chunks.every((d) => {
      const c = d.data();
      return c.creadoPor === uidLucas && c.visibilidad === it.visibilidad && c.embedding?.length === EMBED_DIMS;
    });
    chequear(
      item?.estado === "listo" && item?.creadoPor === uidLucas && item?.visibilidad === it.visibilidad &&
        item?.cantChunks === chunks.length && chunks.length > 0 && chunksBien,
      `${it.id} ${item?.estado} ${item?.visibilidad} de ${item?.creadoPor === uidLucas ? "Lucas" : item?.creadoPor}, ` +
        `${chunks.length} chunks (cantChunks ${item?.cantChunks}) con su copia de autor y visibilidad  «${it.titulo}»`
    );
  }

  for (const e of [EVENTO_DEL_REGLAMENTO, ...EVENTOS_DE_LUCAS]) {
    const ev = (await refWs.collection("eventos").doc(e.id).get()).data();
    chequear(ev?.actorUid === uidDe[e.actor.clave] && ev?.resumen === e.resumen, `${e.id}: ${ev?.resumen}`);
  }

  if (problemas.length > 0) {
    console.log("\n  OJO, quedo algo sin hacer:");
    for (const p of problemas) console.log(`   - ${p}`);
  }
  const todoBien = chequeos.every(Boolean) && problemas.length === 0;
  console.log(`\n  ${todoBien ? "LISTO: Lucas esta en el equipo con sus 3 items." : "NO QUEDO TODO BIEN: mira los MAL y los avisos de arriba."}`);
  console.log("  Se puede correr de nuevo cuantas veces haga falta: no duplica ni borra nada.\n");

  await admin.app().delete(); // cierra la conexion asi el proceso termina solo
  if (!todoBien) process.exitCode = 1;
}

main().catch((err) => {
  console.error("\n!! SUMAR A LUCAS NO TERMINO. Que paso:\n");
  console.error("   " + err.message + "\n");
  console.error("   Arregla eso y correlo de nuevo: es idempotente, volver a");
  console.error("   correrlo no duplica nada de lo que ya habia escrito.\n");
  process.exit(1);
});
