// ============================================================
//  Prueba de punta a punta de las APIs externas: Google Gemini y OCR.space.
//
//  Usa EL MISMO codigo que el backend (servicios/ia.js y
//  servicios/extraer.js), no un curl aparte: si esto anda, anda la busqueda
//  y la respuesta con IA del servidor. Si falla, falla por lo mismo que
//  fallaria en la demo, y lo vemos antes.
//
//  Uso:  npm run probar:ia                 -> solo Google Gemini
//        npm run probar:ia -- foto.png     -> Gemini + OCR de esa imagen
//
//  NUNCA imprime las claves: solo dice si estan o no.
//  Gasta unos 4 pedidos del free tier de Gemini y, si le pasas una imagen,
//  1 de OCR.space (de 25.000 por mes).
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { pedirEmbeddings, chatear, dimensiones, estadoDeLaClave, cadenaDeModelosChat, modelosEnUso } from "../src/servicios/ia.js";
import { extraerDeImagen } from "../src/servicios/extraer.js";

// Que hacer segun lo que conteste Google.
const PISTAS = {
  ERROR_INTERNO:
    "Google rechazo la clave: revisa que GEMINI_API_KEY este bien copiada (sin espacios ni comillas).\n" +
    "  Si arriba dice 'API has not been used' o 'PERMISSION_DENIED', la clave es de un proyecto sin la API habilitada:\n" +
    "  crea la clave desde aistudio.google.com -> Get API key.",
  SIN_CREDITOS_IA: "Se termino la cuota GRATIS del dia de ese modelo (se renueva a la medianoche del Pacifico).\n" +
    "  Para tener mas: GEMINI_API_KEY_RESPALDO con una clave de OTRO proyecto de Google.",
  DEMASIADOS_PEDIDOS: "Nos pasamos del limite por minuto del free tier. Espera un minuto y volve a correrlo.",
  IA_NO_RESPONDE: "Google no contesto a tiempo, esta sobrecargado o el modelo no existe (ver HTTP arriba). Proba de nuevo en un rato\n" +
    "  y corre `npm run modelos:vivos` para ver si los modelos siguen disponibles.",
};

const ms = (desde) => `${Math.round(performance.now() - desde)} ms`;
const si = (b) => (b ? "si" : "NO");

// Los vectores ya vienen normalizados (largo 1), asi que el coseno es el
// producto punto. No importamos buscar.js porque arrastra la conexion a Firestore.
const coseno = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

function contarError(paso, err) {
  console.log(`  FALLO en ${paso}: ${err?.codigo || err?.name || "error"}`);
  console.log(`  detalle: ${err?.detalle || err?.message}`);
  // Sin clave el codigo tambien es ERROR_INTERNO, pero la solucion es otra:
  // por eso se mira el detalle antes que la tabla de pistas.
  const pista = /No hay GEMINI_API_KEY/.test(err?.detalle || "")
    ? "Falta pegar la clave en api/.env, en una linea asi: GEMINI_API_KEY=... (se saca en aistudio.google.com -> Get API key)"
    : PISTAS[err?.codigo];
  if (pista) console.log(`  que hacer: ${pista}`);
  console.log("");
  process.exit(1);
}

// ---- 0. Configuracion ------------------------------------------------------
const clave = estadoDeLaClave();
console.log("\n== Configuracion (sin mostrar claves) ==");
const modelos = modelosEnUso();
console.log(`  GEMINI_API_KEY ............ ${si(clave.hayPrincipal)}`);
console.log(`  GEMINI_API_KEY_RESPALDO ... ${si(clave.hayRespaldo)}`);
console.log(`  chat (en orden) ........... ${modelos.chat.join(" -> ")}`);
console.log(`  razonamiento .............. ${modelos.razonamiento}`);
console.log(`  embeddings ................ ${modelos.embeddings}`);
console.log(`  EMBED_DIMS ................ ${dimensiones()}`);
console.log(`  OCR_SPACE_API_KEY ......... ${si((process.env.OCR_SPACE_API_KEY || "").trim())}`);

// ---- 1. Embeddings de documentos ('passage') -------------------------------
// Tres "items" de mentira de un colegio: la busqueda tiene que saber cual es cual.
const DOCUMENTOS = [
  "Presupuesto de agosto: compra de 12 notebooks para el laboratorio por $ 4.800.000.",
  "Cronograma de mesas de examen de diciembre: Matematica el lunes 9, Fisica el martes 10.",
  "Consignas del TP integrador de Programacion II: app Flutter, panel web y Firestore.",
];
console.log("\n== 1. Embeddings de documentos (input_type = passage) ==");
let vecDocs;
try {
  const t = performance.now();
  vecDocs = await pedirEmbeddings(DOCUMENTOS, "passage");
  const largo = Math.sqrt(vecDocs[0].reduce((s, x) => s + x * x, 0));
  console.log(`  OK en ${ms(t)}: ${vecDocs.length} vectores de ${vecDocs[0].length} dimensiones (largo ${largo.toFixed(3)}, tiene que dar 1.000)`);
} catch (err) {
  contarError("embeddings de documentos", err);
}

// ---- 2. Embedding de la pregunta ('query') + busqueda ----------------------
// Si la busqueda semantica anda, la pregunta tiene que quedar mas cerca del
// presupuesto aunque no repita sus palabras exactas ("plata", "computadoras").
const PREGUNTA = "¿Cuánta plata se gastó en computadoras?";
console.log("\n== 2. Embedding de la pregunta (input_type = query) y busqueda ==");
try {
  const t = performance.now();
  const [vecPregunta] = await pedirEmbeddings([PREGUNTA], "query");
  const puntajes = vecDocs.map((v, i) => ({ i, sim: coseno(vecPregunta, v) })).sort((a, b) => b.sim - a.sim);
  console.log(`  OK en ${ms(t)}. Pregunta: "${PREGUNTA}"`);
  for (const p of puntajes) console.log(`    ${p.sim.toFixed(3)}  ${DOCUMENTOS[p.i].slice(0, 60)}...`);
  console.log(puntajes[0].i === 0
    ? "  La busqueda encontro el documento correcto (el presupuesto)."
    : "  OJO: el mas parecido NO es el presupuesto. La busqueda anda, pero hay que revisar el modelo de embeddings.");
} catch (err) {
  contarError("embedding de la pregunta", err);
}

// ---- 3. Chat ----------------------------------------------------------------
console.log("\n== 3. Chat (redactar la respuesta) ==");
try {
  const t = performance.now();
  const respuesta = await chatear([
    { role: "system", content: "Respondé en castellano, en una sola oración, usando solo el fragmento que te dan." },
    { role: "user", content: `Fragmento: ${DOCUMENTOS[0]}\n\nPregunta: ${PREGUNTA}` },
  ], { maxTokens: 1024 });
  console.log(`  OK en ${ms(t)}. Respuesta: ${respuesta.slice(0, 300)}`);
} catch (err) {
  contarError("chat", err);
}

// ---- 3b. Cada modelo de la cadena, por separado -----------------------------
// chatear() usa el primero que conteste; aca probamos cada uno solo, para
// saber si los de respaldo andan ANTES de necesitarlos.
const cadena = cadenaDeModelosChat();
if (cadena.length > 1) {
  console.log("\n== 3b. Cada modelo de la cadena de chat, por separado ==");
  const principal = process.env.GEMINI_MODELO_CHAT;
  const respaldos = process.env.GEMINI_MODELOS_CHAT_RESPALDO;
  for (const modelo of cadena) {
    process.env.GEMINI_MODELO_CHAT = modelo;
    process.env.GEMINI_MODELOS_CHAT_RESPALDO = "ninguno"; // sin respaldo: probamos ESTE solo
    const t = performance.now();
    try {
      const r = await chatear([
        { role: "system", content: "Respondé en castellano, en una sola oración, usando solo el fragmento." },
        { role: "user", content: `Fragmento [1]: ${DOCUMENTOS[0]}\n\nPregunta: ${PREGUNTA}` },
      ], { maxTokens: 1024 });
      console.log(`  OK    ${modelo} en ${ms(t)}: ${r.replace(/\s+/g, " ").slice(0, 120)}`);
    } catch (err) {
      console.log(`  FALLA ${modelo} en ${ms(t)}: ${err?.codigo} ${err?.detalle ?? ""}`);
    }
  }
  // Ojo: asignar undefined a process.env guarda el TEXTO "undefined". Si no
  // estaban definidas, se borran para volver a los valores por defecto.
  if (principal === undefined) delete process.env.GEMINI_MODELO_CHAT; else process.env.GEMINI_MODELO_CHAT = principal;
  if (respaldos === undefined) delete process.env.GEMINI_MODELOS_CHAT_RESPALDO; else process.env.GEMINI_MODELOS_CHAT_RESPALDO = respaldos;
}

// ---- 4. OCR (opcional: solo si se pasa una imagen) --------------------------
const imagen = process.argv[2];
if (imagen) {
  console.log("\n== 4. OCR de la imagen ==");
  try {
    const ext = path.extname(imagen).toLowerCase();
    const tipo = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    const t = performance.now();
    const r = await extraerDeImagen(fs.readFileSync(imagen), tipo, { nombreArchivo: path.basename(imagen) });
    const texto = r.texto.replace(/\s+/g, " ").trim();
    console.log(`  OK en ${ms(t)} con ${r.origen === "ocr-space" ? "OCR.space" : "tesseract.js (OCR.space NO anduvo)"}.`);
    console.log(`  Texto: ${texto.slice(0, 200)}`);
  } catch (err) {
    contarError("OCR", err);
  }
} else {
  console.log("\n(OCR no probado: pasale una imagen con texto -> npm run probar:ia -- foto.png)");
}

console.log("\nTodo en orden: la IA responde con nuestro propio codigo.\n");
