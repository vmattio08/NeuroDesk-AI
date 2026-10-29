// ============================================================
//  Chequeo de que los modelos de Google Gemini que usamos sigan existiendo.
//  Correr TODOS LOS LUNES antes de empezar a laburar.
//
//  Le pide a Google la lista de modelos disponibles PARA NUESTRA CLAVE y
//  verifica que esten los del chat (principal + respaldos) y el de embeddings.
//  Si Google da de baja uno, se cambia el ID en el .env (GEMINI_MODELO_CHAT,
//  GEMINI_MODELOS_CHAT_RESPALDO o GEMINI_MODELO_EMBED) y listo.
//
//  Uso:  npm run modelos:vivos
// ============================================================
import { modelosEnUso } from "../src/servicios/ia.js";

const BASE = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
const CLAVE = (process.env.GEMINI_API_KEY || "").trim();

if (!CLAVE) {
  console.log("\nFalta GEMINI_API_KEY en api/.env (se saca en aistudio.google.com -> Get API key).\n");
  process.exit(1);
}

const { chat, embeddings } = modelosEnUso();
const BUSCADOS = [
  ...chat.map((id, i) => ({ uso: i === 0 ? "chat" : "chat-resp", id })),
  { uso: "embeddings", id: embeddings },
];

console.log(`\nChequeando modelos contra ${BASE}\n`);

// La lista viene paginada: la recorremos entera. La clave va en una cabecera,
// nunca en la URL (las URLs quedan en logs).
const disponibles = new Map();
let pagina = "";
try {
  do {
    const res = await fetch(`${BASE}/models?pageSize=1000${pagina ? `&pageToken=${pagina}` : ""}`, {
      headers: { "x-goog-api-key": CLAVE },
    });
    if (!res.ok) {
      console.log(`  Google respondio HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      console.log(res.status === 400 || res.status === 403 ? "  -> Revisar que GEMINI_API_KEY este bien copiada.\n" : "");
      process.exit(1);
    }
    const json = await res.json();
    for (const m of json.models ?? []) disponibles.set(m.name.replace(/^models\//, ""), m);
    pagina = json.nextPageToken ?? "";
  } while (pagina);
} catch (err) {
  console.log(`  [SIN RED] ${err.message}\n`);
  process.exit(1);
}

let hayProblema = false;
for (const b of BUSCADOS) {
  const m = disponibles.get(b.id);
  if (!m) hayProblema = true;
  const estado = m ? "VIVO" : "NO ESTA";
  const detalle = m ? (m.displayName ?? "") : "Google no lo ofrece para esta clave -> cambiar el ID en el .env";
  console.log(`  [${estado.padEnd(7)}] ${b.uso.padEnd(11)} ${b.id}`);
  console.log(`              ${detalle}\n`);
}

console.log(hayProblema ? "Revisar lo de arriba antes de seguir.\n" : "Todo en orden, a laburar.\n");
// exitCode y no process.exit(): en Windows, cortar el proceso con conexiones
// de fetch todavia abiertas tira un "Assertion failed" de libuv que asusta.
process.exitCode = hayProblema ? 1 : 0;
