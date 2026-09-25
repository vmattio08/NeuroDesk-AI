// ============================================================
//  Chequeo de liveness de los modelos de NVIDIA.
//  Correr TODOS LOS LUNES antes de empezar a laburar.
//
//  Truco: se llama SIN la API key a proposito.
//    401 = el modelo existe y esta vivo (nos rechazo por falta de auth)
//    410 = el modelo fue dado de baja  -> hay que cambiarlo en el .env
//
//  Uso:  node scripts/chequear-modelos.js
// ============================================================
const BASE = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";

const MODELOS = [
  { uso: "chat", id: process.env.NVIDIA_MODELO_CHAT || "nvidia/nemotron-3.5-lightning-30b-a3b", ruta: "/chat/completions" },
  { uso: "embeddings", id: process.env.NVIDIA_MODELO_EMBED || "nvidia/nemotron-3-embed-1b", ruta: "/embeddings" },
];

const LEYENDA = {
  401: ["VIVO", "el modelo existe (nos rechazo por falta de key, que es lo esperado)"],
  410: ["MUERTO", "dado de baja -> cambiar el ID en el .env AHORA"],
  404: ["NO EXISTE", "el ID esta mal escrito"],
};

console.log(`\nChequeando modelos contra ${BASE}\n`);
let hayProblema = false;

for (const m of MODELOS) {
  let estado, detalle;
  try {
    const res = await fetch(BASE + m.ruta, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: m.id, messages: [{ role: "user", content: "ping" }], input: "ping" }),
    });
    [estado, detalle] = LEYENDA[res.status] || [`HTTP ${res.status}`, "revisar a mano"];
  } catch (err) {
    estado = "SIN RED";
    detalle = err.message;
  }
  if (estado !== "VIVO") hayProblema = true;
  console.log(`  [${estado.padEnd(9)}] ${m.uso.padEnd(11)} ${m.id}`);
  console.log(`              ${detalle}\n`);
}

console.log(hayProblema ? "Revisar lo de arriba antes de seguir.\n" : "Todo en orden, a laburar.\n");
process.exit(hayProblema ? 1 : 0);
