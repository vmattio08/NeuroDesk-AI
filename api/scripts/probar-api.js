// ============================================================
//  Prueba de punta a punta del backend contra el Firebase REAL.
//
//  Levanta el servidor en un puerto aparte, entra con las 3 cuentas del seed
//  (Valentino = admin, Martin y Camila = miembros) y recorre los endpoints del
//  contrato: auth, items (procesar, reprocesar, borrar, limpieza masiva),
//  preguntar (con el test OBLIGATORIO de privacidad) y cambio de rol.
//
//  Uso:  npm run probar:api
//  Requisitos: el seed cargado (npm run seed) y NVIDIA_API_KEY en el .env.
//
//  Todo lo que crea lleva el prefijo itm_test_ / resp_test_ y se borra al
//  final, junto con los eventos que generaron las pruebas, para no ensuciar
//  el feed de auditoria que se muestra en la demo.
//
//  COMO ENTRA SIN CONTRASENA: con el Admin SDK firmamos un "custom token"
//  para el uid de prueba y lo cambiamos por un ID token real en la API de
//  Firebase Auth. Es el mismo token que tendria la app despues del login.
// ============================================================
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, auth, FieldValue, Timestamp } from "../src/firebase.js";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ_API = path.resolve(AQUI, "..");
const PUERTO = 8099;
const BASE = `http://localhost:${PUERTO}`;
const WS = "ws_seed_6to1ra";
const U = { valentino: "uid_seed_valentino", martin: "uid_seed_martin", camila: "uid_seed_camila" };

// La apiKey web es PUBLICA por diseno (viaja en el panel). La leemos del
// panel para no tener el mismo dato copiado en dos lugares.
function apiKeyWeb() {
  if (process.env.FIREBASE_WEB_API_KEY) return process.env.FIREBASE_WEB_API_KEY;
  const panel = fs.readFileSync(path.resolve(RAIZ_API, "../panel/js/firebase.js"), "utf8");
  const m = panel.match(/apiKey:\s*'([^']+)'/);
  if (!m || m[1].startsWith("PEGAR_")) throw new Error("No encontre la apiKey web en panel/js/firebase.js");
  return m[1];
}

async function idTokenDe(uid) {
  const custom = await auth.createCustomToken(uid);
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKeyWeb()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: custom, returnSecureToken: true }),
  });
  const j = await res.json();
  if (!j.idToken) throw new Error(`No pude conseguir el token de ${uid}: ${j.error?.message}`);
  return j.idToken;
}

// ---- mini framework de pruebas ---------------------------------------------
const resultados = [];
async function prueba(nombre, fn) {
  const t = performance.now();
  try {
    const nota = await fn();
    resultados.push({ ok: true, nombre });
    console.log(`  OK    ${nombre} (${Math.round(performance.now() - t)} ms)${nota ? " — " + nota : ""}`);
  } catch (err) {
    resultados.push({ ok: false, nombre, error: err.message });
    console.log(`  FALLA ${nombre}\n        ${err.message}`);
  }
}
function esperar(cond, msg) { if (!cond) throw new Error(msg); }

async function pedir(metodo, ruta, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + ruta, { method: metodo, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* sin cuerpo */ }
  return { status: res.status, json };
}
function esperarError(r, status, codigo) {
  esperar(r.status === status && r.json?.codigo === codigo,
    `esperaba ${status} ${codigo} y vino ${r.status} ${r.json?.codigo ?? ""} ${r.json?.detalle ?? ""}`);
}

// ---- datos de prueba (los crea "el cliente", como haria la app) ------------
const ITEM_EQUIPO = "itm_test_reunion";
const ITEM_PRIVADO = "itm_test_wifi";
const RESP_PRUEBA = ["resp_test_1", "resp_test_2", "resp_test_3"];
const itemRef = (id) => db.collection("workspaces").doc(WS).collection("items").doc(id);
const respRef = (id) => db.collection("workspaces").doc(WS).collection("respuestas").doc(id);

async function crearNota(id, autor, visibilidad, titulo, textoOriginal) {
  // Exactamente los campos que la regla deja escribir al cliente al crear.
  await itemRef(id).set({
    titulo, tipo: "nota", visibilidad, workspaceId: WS, creadoPor: autor,
    textoOriginal, estado: "pendiente", creadoEn: FieldValue.serverTimestamp(),
  });
}
async function crearPregunta(id, autor, pregunta) {
  await respRef(id).set({ pregunta, autorUid: autor, estado: "buscando", creadoEn: FieldValue.serverTimestamp() });
}
async function preguntar(token, respId, autor, pregunta) {
  await crearPregunta(respId, autor, pregunta);
  return pedir("POST", `/v1/workspaces/${WS}/preguntar`, { token, body: { respId, pregunta } });
}
const citaA = (r, itemId) => (r.json?.fuentes ?? []).some((f) => f.itemId === itemId);

// ---- limpieza ---------------------------------------------------------------
async function limpiar(desde) {
  for (const id of [ITEM_EQUIPO, ITEM_PRIVADO]) {
    const chunks = await db.collection("chunks").where("itemId", "==", id).get();
    const lote = db.batch();
    chunks.forEach((d) => lote.delete(d.ref));
    lote.delete(itemRef(id));
    await lote.commit();
  }
  // Los respId de prueba son fijos: se borran por id, sin query.
  const lote = db.batch();
  for (const id of RESP_PRUEBA) lote.delete(respRef(id));
  const eventos = await db.collection("workspaces").doc(WS).collection("eventos").where("creadoEn", ">=", desde).get();
  eventos.forEach((d) => lote.delete(d.ref));
  await lote.commit();
  return { respuestas: RESP_PRUEBA.length, eventos: eventos.size };
}

// ---- servidor ---------------------------------------------------------------
function levantarServidor() {
  const hijo = spawn(process.execPath, ["--env-file=.env", "src/server.js"], {
    cwd: RAIZ_API, env: { ...process.env, PORT: String(PUERTO) }, stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  hijo.stdout.on("data", (b) => log.push(String(b)));
  hijo.stderr.on("data", (b) => log.push(String(b)));
  return { hijo, log };
}
async function esperarSalud(segundos = 25) {
  for (let i = 0; i < segundos * 2; i++) {
    try { const r = await fetch(BASE + "/salud"); if (r.ok) return true; } catch { /* todavia no */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ============================================================
const inicio = Timestamp.now();
const { hijo, log } = levantarServidor();
let codigoSalida = 1;
try {
  if (!(await esperarSalud())) throw new Error("El servidor no arranco:\n" + log.join("").slice(-3000));
  console.log(`\nServidor arriba en ${BASE}. Consiguiendo tokens de prueba...`);
  const T = { valentino: await idTokenDe(U.valentino), martin: await idTokenDe(U.martin), camila: await idTokenDe(U.camila) };

  console.log("\n== Infraestructura y autenticacion ==");
  await prueba("GET /salud y /v1/salud responden con Firestore ok", async () => {
    for (const ruta of ["/salud", "/v1/salud"]) {
      const r = await pedir("GET", ruta);
      esperar(r.status === 200 && r.json?.firestore === "ok", `${ruta} -> ${r.status} ${JSON.stringify(r.json)}`);
    }
  });
  await prueba("ruta inexistente -> 404 RUTA_NO_ENCONTRADA en JSON", async () => esperarError(await pedir("GET", "/v1/no-existe"), 404, "RUTA_NO_ENCONTRADA"));
  await prueba("sin token -> 401 FALTA_TOKEN", async () => esperarError(await pedir("POST", `/v1/workspaces/${WS}/preguntar`, { body: {} }), 401, "FALTA_TOKEN"));
  await prueba("token trucho -> 401 TOKEN_INVALIDO", async () => esperarError(await pedir("POST", `/v1/workspaces/${WS}/preguntar`, { token: "abc.def.ghi", body: {} }), 401, "TOKEN_INVALIDO"));
  await prueba("POST /v1/auth/registro es idempotente (Martin ya existe)", async () => {
    const r = await pedir("POST", "/v1/auth/registro", { token: T.martin, body: { nombre: "Martín Sosa" } });
    esperar(r.status === 200 && r.json?.ok, `${r.status} ${JSON.stringify(r.json)}`);
    return `creado=${r.json.creado}`;
  });

  console.log("\n== Items: procesar, autoria y limpieza masiva ==");
  await crearNota(ITEM_EQUIPO, U.martin, "equipo", "Reunión de padres de octubre",
    "La reunión de padres de sexto año es el jueves 17 de octubre a las 18 horas en el aula 4. Hay que llevar el boletín firmado y la autorización para el viaje de egresados.");
  await crearNota(ITEM_PRIVADO, U.camila, "privado", "Datos del laboratorio (privado)",
    "La contraseña del wifi del laboratorio de informática es tortuga42. No compartirla con los alumnos de primer año.");

  await prueba("Camila NO puede procesar el item de Martin -> 403 NO_SOS_EL_AUTOR", async () =>
    esperarError(await pedir("POST", `/v1/workspaces/${WS}/items/${ITEM_EQUIPO}/procesar`, { token: T.camila }), 403, "NO_SOS_EL_AUTOR"));
  await prueba("item inexistente -> 404 ITEM_NO_ENCONTRADO", async () =>
    esperarError(await pedir("POST", `/v1/workspaces/${WS}/items/itm_test_no_existe/procesar`, { token: T.martin }), 404, "ITEM_NO_ENCONTRADO"));
  await prueba("Martin procesa su nota -> listo, con chunks reales en Firestore", async () => {
    const r = await pedir("POST", `/v1/workspaces/${WS}/items/${ITEM_EQUIPO}/procesar`, { token: T.martin });
    esperar(r.status === 200 && r.json?.item?.estado === "listo", `${r.status} ${JSON.stringify(r.json)}`);
    const doc = (await itemRef(ITEM_EQUIPO).get()).data();
    esperar(doc.estado === "listo" && doc.cantChunks >= 1 && doc.texto, `doc: estado=${doc.estado} cantChunks=${doc.cantChunks}`);
    const chunks = await db.collection("chunks").where("itemId", "==", ITEM_EQUIPO).get();
    esperar(chunks.size === doc.cantChunks, `chunks en la base=${chunks.size}, cantChunks=${doc.cantChunks}`);
    const c = chunks.docs[0].data();
    esperar(c.workspaceId === WS && c.visibilidad === "equipo" && c.creadoPor === U.martin && c.embedding?.length === 1024,
      `chunk mal armado: ${JSON.stringify({ ws: c.workspaceId, vis: c.visibilidad, por: c.creadoPor, dims: c.embedding?.length })}`);
    return `${doc.cantChunks} chunk(s), origen=${doc.origen}, ${r.json.tardoMs} ms`;
  });
  await prueba("Camila procesa su nota PRIVADA", async () => {
    const r = await pedir("POST", `/v1/workspaces/${WS}/items/${ITEM_PRIVADO}/procesar`, { token: T.camila });
    esperar(r.status === 200 && r.json?.item?.estado === "listo", `${r.status} ${JSON.stringify(r.json)}`);
  });
  await prueba("reprocesar borra los chunks viejos (misma cantidad, no el doble)", async () => {
    const r = await pedir("POST", `/v1/workspaces/${WS}/items/${ITEM_EQUIPO}/reprocesar`, { token: T.martin, body: {} });
    esperar(r.status === 200 && r.json?.chunksBorrados >= 1, `${r.status} ${JSON.stringify(r.json)}`);
    const chunks = await db.collection("chunks").where("itemId", "==", ITEM_EQUIPO).get();
    esperar(chunks.size === r.json.item.cantChunks, `quedaron ${chunks.size} chunks y cantChunks=${r.json.item.cantChunks}`);
  });
  await prueba("limpieza masiva: un miembro -> 403 NO_ES_ADMIN", async () =>
    esperarError(await pedir("DELETE", `/v1/workspaces/${WS}/items?estado=pendiente&antesDe=2020-01-01T00:00:00.000Z`, { token: T.martin }), 403, "NO_ES_ADMIN"));
  await prueba("limpieza masiva con estado=listo -> 400 DATOS_INVALIDOS (nunca borra lo indexado)", async () =>
    esperarError(await pedir("DELETE", `/v1/workspaces/${WS}/items?estado=listo&antesDe=2020-01-01T00:00:00.000Z`, { token: T.valentino }), 400, "DATOS_INVALIDOS"));
  await prueba("limpieza masiva antes de 2020 -> 200 con 0 borrados (no toca el seed)", async () => {
    const r = await pedir("DELETE", `/v1/workspaces/${WS}/items?estado=pendiente&antesDe=2020-01-01T00:00:00.000Z`, { token: T.valentino });
    esperar(r.status === 200 && r.json?.itemsBorrados === 0, `${r.status} ${JSON.stringify(r.json)}`);
  });

  console.log("\n== Preguntar (RAG) y privacidad ==");
  await prueba("Martin pregunta y la respuesta cita su nota", async () => {
    const r = await preguntar(T.martin, "resp_test_1", U.martin, "¿Cuándo es la reunión de padres?");
    esperar(r.status === 200 && r.json?.estado === "listo", `${r.status} ${JSON.stringify(r.json)}`);
    esperar(citaA(r, ITEM_EQUIPO), `no cito la nota. respuesta="${r.json.respuesta}" fuentes=${JSON.stringify(r.json.fuentes)}`);
    esperar(!("chunksMirados" in r.json), "a un miembro NO le tiene que llegar chunksMirados");
    return `confianza=${r.json.confianza}, sim=${r.json.fuentes[0]?.similitud} — "${r.json.respuesta.slice(0, 120)}"`;
  });
  await prueba("PRIVACIDAD: Martin pregunta por la nota privada de Camila y NO se la cita", async () => {
    const r = await preguntar(T.martin, "resp_test_2", U.martin, "¿Cuál es la contraseña del wifi del laboratorio?");
    esperar(r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);
    esperar(!citaA(r, ITEM_PRIVADO), "SE FILTRO la nota privada de Camila");
    esperar(!/tortuga42/i.test(r.json.respuesta || ""), "la respuesta contiene la contraseña privada");
    return `fuentes=${r.json.fuentes.length}, "${(r.json.respuesta || "").slice(0, 100)}"`;
  });
  await prueba("el admin SI ve la nota privada y recibe chunksMirados", async () => {
    const r = await preguntar(T.valentino, "resp_test_3", U.valentino, "¿Cuál es la contraseña del wifi del laboratorio?");
    esperar(r.status === 200 && citaA(r, ITEM_PRIVADO), `${r.status} fuentes=${JSON.stringify(r.json?.fuentes)}`);
    esperar(typeof r.json.chunksMirados === "number", "al admin le tiene que llegar chunksMirados");
    return `chunksVisibles=${r.json.chunksVisibles}, chunksMirados=${r.json.chunksMirados}`;
  });
  await prueba("la consulta de otro -> 404 RESPUESTA_NO_ENCONTRADA", async () =>
    esperarError(await pedir("POST", `/v1/workspaces/${WS}/preguntar`, { token: T.camila, body: { respId: "resp_test_1", pregunta: "¿Cuándo es la reunión de padres?" } }), 404, "RESPUESTA_NO_ENCONTRADA"));

  console.log("\n== Roles ==");
  await prueba("un miembro no puede cambiar roles -> 403 NO_ES_ADMIN", async () =>
    esperarError(await pedir("PATCH", `/v1/workspaces/${WS}/miembros/${U.camila}`, { token: T.martin, body: { rol: "admin" } }), 403, "NO_ES_ADMIN"));
  await prueba("el admin asciende a Camila y el claim se actualiza", async () => {
    const r = await pedir("PATCH", `/v1/workspaces/${WS}/miembros/${U.camila}`, { token: T.valentino, body: { rol: "admin" } });
    esperar(r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);
    const claims = (await auth.getUser(U.camila)).customClaims;
    esperar(claims?.ws?.[WS] === "admin", `claim=${JSON.stringify(claims)}`);
  });
  await prueba("y la vuelve a miembro (members y claim coinciden)", async () => {
    const r = await pedir("PATCH", `/v1/workspaces/${WS}/miembros/${U.camila}`, { token: T.valentino, body: { rol: "miembro" } });
    esperar(r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);
    const rol = (await db.collection("workspaces").doc(WS).collection("members").doc(U.camila).get()).data()?.rol;
    const claims = (await auth.getUser(U.camila)).customClaims;
    esperar(rol === "miembro" && claims?.ws?.[WS] === "miembro", `members=${rol} claim=${JSON.stringify(claims)}`);
  });
  await prueba("el owner no se puede sacar el admin -> ACCION_NO_PERMITIDA", async () => {
    const r = await pedir("PATCH", `/v1/workspaces/${WS}/miembros/${U.valentino}`, { token: T.valentino, body: { rol: "miembro" } });
    esperar(r.json?.codigo === "ACCION_NO_PERMITIDA", `${r.status} ${JSON.stringify(r.json)}`);
  });

  console.log("\n== Borrar items ==");
  // La baja de rol revoco los tokens de Camila (a proposito): pedimos uno nuevo.
  T.camila = await idTokenDe(U.camila);
  await prueba("Camila NO puede borrar el item de Martin -> 403 NO_SOS_EL_AUTOR", async () =>
    esperarError(await pedir("DELETE", `/v1/workspaces/${WS}/items/${ITEM_EQUIPO}`, { token: T.camila }), 403, "NO_SOS_EL_AUTOR"));
  await prueba("Martin borra su item y se van tambien sus chunks", async () => {
    const r = await pedir("DELETE", `/v1/workspaces/${WS}/items/${ITEM_EQUIPO}`, { token: T.martin });
    esperar(r.status === 200 && r.json?.borrado?.chunksBorrados >= 1, `${r.status} ${JSON.stringify(r.json)}`);
    const quedan = await db.collection("chunks").where("itemId", "==", ITEM_EQUIPO).get();
    esperar(quedan.empty && !(await itemRef(ITEM_EQUIPO).get()).exists, `quedaron ${quedan.size} chunks o el item`);
  });
  await prueba("el admin borra la nota privada de Camila", async () => {
    const r = await pedir("DELETE", `/v1/workspaces/${WS}/items/${ITEM_PRIVADO}`, { token: T.valentino });
    esperar(r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);
  });

  const fallas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - fallas.length}/${resultados.length} pruebas OK.`);
  if (fallas.length) {
    console.log("\nUltimas lineas del servidor:\n" + log.join("").split("\n").slice(-40).join("\n"));
  }
  codigoSalida = fallas.length ? 1 : 0;
} catch (err) {
  console.log("\nLa prueba se corto: " + err.message);
} finally {
  try {
    const l = await limpiar(inicio);
    console.log(`Limpieza: datos de prueba borrados (${l.respuestas} respuestas, ${l.eventos} eventos).`);
  } catch (err) {
    console.log("OJO: la limpieza fallo: " + err.message);
  }
  hijo.kill();
  process.exit(codigoSalida);
}
