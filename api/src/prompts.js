// ============================================================================
//  prompts.js — TODO lo que le decimos al modelo de NVIDIA vive ACA.
//
//  ¿Por qué un archivo aparte y no el prompt suelto adentro de preguntar.js?
//  Porque el prompt es la parte del producto que MÁS se toca: se prueba una
//  pregunta, la respuesta sale mal, se cambia una línea del prompt y se vuelve
//  a probar. Si estuviera mezclado con la lógica del endpoint, cada retoque
//  sería un riesgo de romper el RAG. Acá es texto y nada más.
//
//  IDEA CENTRAL DEL RAG (esto hay que saber decirlo en la defensa):
//  el modelo NO sabe nada del equipo. Nosotros le pasamos, en el mismo mensaje,
//  los fragmentos que encontramos en la base y le pedimos que responda USANDO
//  SOLO ESO. Si le sacáramos los fragmentos, el modelo inventaría. Por eso el
//  prompt es tan mandón: cada regla de acá tapa una forma distinta de inventar.
// ============================================================================

// ----------------------------------------------------------------------------
//  Texto exacto que se guarda cuando la búsqueda no encontró NADA parecido.
//  Está acá y no escrito a mano en preguntar.js para que sea siempre el mismo
//  string (el panel lo puede comparar si algún día quiere dibujarlo distinto).
//  Ojo: cuando pasa esto NI SIQUIERA se llama al modelo. Ahorra créditos y,
//  sobre todo, garantiza que no pueda alucinar: no hay respuesta que inventar
//  si nunca le preguntamos.
// ----------------------------------------------------------------------------
export const RESPUESTA_SIN_RESULTADOS =
  'No encontré esto en la base del equipo. Probá con otras palabras, o cargá un ' +
  'item con esa información y volvé a preguntar.';

// ----------------------------------------------------------------------------
//  Aviso que se le pega adelante a la respuesta cuando el modelo contestó pero
//  NO citó ningún fragmento válido. No lo borramos ni lo escondemos: el producto
//  se llama "respuesta con fuente", así que una respuesta sin fuente tiene que
//  verse rara a propósito.
// ----------------------------------------------------------------------------
export const AVISO_SIN_CITAS =
  '(Ojo: la IA no citó ninguna fuente, así que esto puede no estar en los ' +
  'documentos del equipo. Verificalo antes de usarlo.)\n\n';

// ----------------------------------------------------------------------------
//  PROMPT DE SISTEMA.
//  Va en el mensaje role:'system'. Es la "personalidad" y, sobre todo, el
//  reglamento. Cada regla numerada existe por un problema concreto que vimos
//  probando; el comentario de al lado explica cuál.
// ----------------------------------------------------------------------------
export const PROMPT_SISTEMA_RAG = `Sos el asistente de NeuroDesk, el segundo cerebro de un equipo de trabajo.
Respondés preguntas del equipo usando ÚNICAMENTE los fragmentos de documentos que te paso en cada mensaje.

REGLAS QUE NO SE NEGOCIAN:

1. Respondé SOLO con lo que dicen los fragmentos. No uses nada de lo que sepas por tu cuenta, aunque estés seguro. Si el equipo escribió que el service sale $12.000, sale $12.000, aunque a vos te parezca poco.

2. Después de CADA dato que saques de un fragmento, poné su número entre corchetes: [1], [2], [3]. Si un dato sale de dos fragmentos, poné los dos: [1][3]. Una respuesta sin ningún número entre corchetes está mal hecha.

3. Usá SOLO los números que te pasé. Si te llegaron 4 fragmentos, los únicos números válidos son [1], [2], [3] y [4]. Nunca inventes un [7].

4. Si los fragmentos NO alcanzan para responder, decilo derecho: "No encontré esto en la base del equipo." No inventes, no completes con lo que suena razonable, no supongas.

5. Si los fragmentos se contradicen entre sí, mostrá las dos versiones con sus citas en vez de elegir una. Ejemplo: "Una nota dice $12.000 [1] y otra $15.000 [3]."

6. No cites títulos, nombres de archivo, páginas ni fechas por tu cuenta: eso lo arma el sistema con los datos reales. Vos poné el número y nada más.

7. Contestá en castellano rioplatense, natural y corto: 2 a 5 oraciones. Nada de "según el contexto proporcionado" ni de repetir la pregunta. Andá al grano, como si le contestaras a un compañero.

8. Si la pregunta pide una lista (precios, fechas, pasos), usá viñetas con guion, y citá en cada viñeta.

9. Nunca hables de "fragmentos", "contexto", "documentos que me pasaste" ni de cómo funcionás. El que pregunta ve una respuesta y sus fuentes, no la maquinaria.`;

// ----------------------------------------------------------------------------
//  armarMensajeDeUsuario()
//
//  Arma el mensaje role:'user' con los fragmentos NUMERADOS y la pregunta.
//
//  Detalles que parecen tontos y no lo son:
//  - Los fragmentos van ANTES de la pregunta. Los modelos le prestan más
//    atención al final del mensaje, así que la pregunta queda última.
//  - La numeración es 1, 2, 3... (no 0), porque es lo que la persona ve en
//    la respuesta: "[1]" tiene que ser el primer fragmento, no el segundo.
//  - NO le mandamos el título ni la página adentro del fragmento. Si se los
//    mandáramos, el modelo los copiaría en el texto y podría equivocarse o
//    inventarlos. El título y la página los pone el backend después, sacados
//    del chunk REAL. El modelo solo maneja números.
//
//  @param {string} pregunta      la pregunta tal cual la escribió la persona
//  @param {Array}  candidatos    [{ texto }] ya ordenados de mejor a peor
//  @returns {string}             el mensaje listo para role:'user'
// ----------------------------------------------------------------------------
export function armarMensajeDeUsuario(pregunta, candidatos) {
  const bloques = candidatos.map((c, i) => `[${i + 1}]\n${c.texto}`).join('\n\n---\n\n');

  return `FRAGMENTOS DE LA BASE DEL EQUIPO:

${bloques}

---

PREGUNTA DEL EQUIPO: ${pregunta}

Respondé usando solo los fragmentos de arriba y citá con [número] después de cada dato.`;
}
