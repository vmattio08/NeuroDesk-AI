// ============================================================
//  Calibracion del umbral de similitud (y de los cortes de confianza).
//
//  POR QUE HACE FALTA: el umbral (UMBRAL_SIMILITUD) decide si un fragmento
//  "tiene que ver" con la pregunta. Si queda alto, la IA contesta "No encontre
//  esto" aunque el dato este; si queda bajo, cita cualquier cosa. El numero
//  depende del MODELO de embeddings: con nemotron-3-embed-1b recortado a 1024
//  dimensiones, la respuesta correcta dio 0.21 en la primera prueba real, muy
//  lejos del 0.35 que habiamos puesto a ojo.
//
//  QUE HACE: compara preguntas CON respuesta en el seed contra preguntas que
//  no tienen nada que ver, y propone un umbral que separe los dos grupos.
//  Mira todos los chunks del workspace (como el admin): es una medicion, no
//  una prueba de permisos.
//
//  Uso: npm run calibrar   (necesita el seed con embeddings reales y la clave)
// ============================================================
import { db } from "../src/firebase.js";
import { pedirEmbeddings } from "../src/servicios/ia.js";

const WS = "ws_seed_6to1ra";

// [pregunta, itemId que la contesta]. Varias estan dichas con OTRAS palabras
// que el texto ("faltas" vs "inasistencias"): eso es justo lo que tiene que
// resolver una busqueda por significado y no por palabra exacta.
const CON_RESPUESTA = [
  ["¿Cuándo es la mesa de Programación II y en qué aula?", "itm_seed_01"],
  ["¿Cuándo se publican las notas de las mesas?", "itm_seed_01"],
  ["¿Hasta qué hora se puede entrar al colegio?", "itm_seed_06"],
  ["¿Cuántas faltas puedo tener antes de quedar libre?", "itm_seed_06"],
  ["¿Se puede usar el celular en clase?", "itm_seed_06"],
  ["¿Qué le toca hacer a Martín en el trabajo?", "itm_seed_07"],
  ["¿Cuándo vence la fase 2 del TP?", "itm_seed_02"],
  ["¿Las reglas de Firestore filtran las consultas?", "itm_seed_03"],
  ["¿Cómo se actualiza sola la pantalla con Firestore en Flutter?", "itm_seed_08"],
  ["¿Cómo se evalúa el control de acceso en el proyecto?", "itm_seed_10"],
  ["¿Quién crea el item, el cliente o el backend?", "itm_seed_04"],
];
const SIN_RESPUESTA = [
  "¿Cuál es el precio del dólar hoy?",
  "¿Quién ganó el último mundial de fútbol?",
  "¿Cuál es la receta de las empanadas tucumanas?",
  "¿Cuánto cuesta la cuota del colegio?",
  "¿Qué tiempo va a hacer mañana en Berazategui?",
];

const coseno = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0); // ya normalizados

const snap = await db.collection("chunks").where("workspaceId", "==", WS).get();
const chunks = snap.docs.map((d) => d.data()).filter((c) => Array.isArray(c.embedding));
console.log(`\n${chunks.length} chunks del workspace ${WS}.`);

const preguntas = [...CON_RESPUESTA.map(([p]) => p), ...SIN_RESPUESTA];
const vectores = await pedirEmbeddings(preguntas, "query");

const ranking = (v) => chunks.map((c) => ({ c, sim: coseno(v, c.embedding) })).sort((a, b) => b.sim - a.sim);

console.log("\n== Preguntas CON respuesta en el seed ==");
const simsCorrectas = [];
let aciertos = 0;
CON_RESPUESTA.forEach(([p, esperado], i) => {
  const r = ranking(vectores[i]);
  const posicion = r.findIndex((x) => x.c.itemId === esperado);
  const simCorrecta = r[posicion]?.sim ?? 0;
  if (posicion === 0) aciertos++;
  simsCorrectas.push(simCorrecta);
  const marca = posicion === 0 ? "OK " : posicion < 6 ? `#${posicion + 1} ` : "MAL";
  console.log(`  ${marca} ${simCorrecta.toFixed(3)}  ${p}`);
  if (posicion !== 0) console.log(`         el primero fue ${r[0].c.itemId} (${r[0].sim.toFixed(3)}): ${r[0].c.texto.slice(0, 70)}...`);
});

console.log("\n== Preguntas SIN respuesta (el mejor fragmento es ruido) ==");
const simsRuido = SIN_RESPUESTA.map((p, j) => {
  const r = ranking(vectores[CON_RESPUESTA.length + j]);
  console.log(`  ${r[0].sim.toFixed(3)}  ${p}   (mas parecido: ${r[0].c.itemId})`);
  return r[0].sim;
});

const minCorrecta = Math.min(...simsCorrectas);
const maxRuido = Math.max(...simsRuido);
const ordenadas = [...simsCorrectas].sort((a, b) => a - b);
const mediana = ordenadas[Math.floor(ordenadas.length / 2)];
console.log(`\nAcerto el item en el primer puesto: ${aciertos}/${CON_RESPUESTA.length}`);
console.log(`Similitud de la respuesta correcta: min ${minCorrecta.toFixed(3)}, mediana ${mediana.toFixed(3)}, max ${Math.max(...simsCorrectas).toFixed(3)}`);
console.log(`Similitud del ruido (sin respuesta): max ${maxRuido.toFixed(3)}`);
if (minCorrecta > maxRuido) {
  const umbral = (minCorrecta + maxRuido) / 2;
  console.log(`\nLos grupos se separan. Umbral sugerido: UMBRAL_SIMILITUD=${umbral.toFixed(2)} (mitad entre ${maxRuido.toFixed(3)} y ${minCorrecta.toFixed(3)})`);
} else {
  console.log(`\nOJO: los grupos se SUPERPONEN (hay ruido por encima de alguna respuesta correcta). Hay que elegir: umbral bajo (contesta mas, a veces cita de mas) o alto (mas "No encontre").`);
}
process.exit(0);
