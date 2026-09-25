// ============================================================
//  servicios/texto.js
//  Limpieza y troceado. No habla con nadie: entra texto, sale texto.
//  Por eso es el archivo mas facil de testear de todo el backend.
//
//  Exporta:
//    limpiarTexto(texto)              -> texto normalizado
//    trocear(texto, {tamano, solape}) -> [{ idx, texto, pagina }]
//    marcaDePagina(n) / unirPaginas() -> como viaja el numero de pagina
//    quitarMarcasDePagina(texto)      -> el texto "lindo" que se guarda en el item
//    recortarTexto(texto, tope)       -> {texto, recortado} para el limite de Firestore
// ============================================================

// Un documento de Firestore no puede pasar de 1 MiB. El campo `texto` del item
// se recorta a 300.000 caracteres y se marca `recortado: true` para que el
// panel pueda avisar "documento muy largo, se indexó la primera parte".
export const TOPE_TEXTO_ITEM = 300_000;

// ============================================================
//  MARCAS DE PAGINA
//
//  PROBLEMA: el troceado tiene que saber de que pagina salio cada chunk para
//  poder citar "pág. 3", pero trocear() recibe UN solo string.
//  SOLUCION: extraer.js pega las paginas separadas por una marca visible y
//  rarisima, y trocear() la usa como cartel de "de acá en adelante, pág. N"
//  y despues la borra del texto del chunk.
//
//  POR QUE no un array de paginas como parametro: porque el texto ya extraido
//  se guarda en el item (campo `texto`) y /reprocesar lo vuelve a trocear
//  desde ahi. Con la marca adentro del string, el numero de pagina sobrevive
//  la ida y vuelta a Firestore sin necesitar otro campo.
// ============================================================

const MARCA = /<<<PAGINA:(\d+)>>>/g;

/** El cartel que separa una pagina de la siguiente. n arranca en 1. */
export function marcaDePagina(n) {
  return `\n<<<PAGINA:${n}>>>\n`;
}

/**
 * Pega un array de paginas en un solo string con las marcas puestas.
 * @param {string[]} paginas texto de cada pagina, en orden (indice 0 = pág. 1)
 */
export function unirPaginas(paginas) {
  return paginas.map((txt, i) => marcaDePagina(i + 1) + (txt ?? '')).join('\n');
}

/**
 * Saca las marcas. Es lo que se guarda en item.texto: la persona que abre el
 * item no tiene por que ver nuestros carteles internos.
 */
export function quitarMarcasDePagina(texto) {
  return String(texto ?? '')
    .replace(MARCA, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ============================================================
//  LIMPIEZA
// ============================================================

/**
 * Deja el texto en condiciones de ser troceado y vectorizado.
 *
 * POR QUE limpiamos antes de vectorizar: la basura (saltos de linea de PDF,
 * espacios triples, guiones de corte de renglon) ocupa lugar adentro de los
 * 1600 caracteres del chunk y ADEMAS mueve el vector. Un chunk lleno de
 * espacios se parece menos a la pregunta que el mismo chunk limpio.
 * O sea: limpiar no es cosmetica, mejora la busqueda.
 */
export function limpiarTexto(texto) {
  let t = String(texto ?? '');

  // Unicode a forma unica: "á" se puede escribir de dos maneras distintas
  // (una sola letra, o "a" + tilde combinante). Si no normalizamos, dos textos
  // que se ven iguales son distintos para el modelo.
  t = t.normalize('NFC');

  // Saltos de linea de Windows y de Mac viejo -> \n a secas.
  t = t.replace(/\r\n?/g, '\n');

  // Guion blando (U+00AD): invisible, lo mete Word para cortar palabras.
  t = t.replace(/\u00AD/g, '');

  // Palabra cortada al final del renglon: "presu-\npuesto" -> "presupuesto".
  // Es MUY comun en PDFs de una columna y arruina la busqueda: "presu" no
  // matchea con nada.
  t = t.replace(/(\p{L})-\n(\p{L})/gu, '$1$2');

  // Espacios raros (no-break space, espacios finos de tipografia) -> espacio.
  t = t.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
  // Separadores de linea de Unicode: son saltos de linea de verdad, asi que
  // se convierten (borrarlos pegaria la ultima palabra con la primera de abajo).
  t = t.replace(/[\u2028\u2029]/g, '\n');
  // Invisibles de ancho cero y marcas de direccion: esos si se van directamente.
  t = t.replace(/[\u200B-\u200F\uFEFF]/g, '');

  // Caracteres de control (dejamos \n y \t). El \u0000 rompe Firestore.
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');

  t = t.replace(/\t/g, ' ');
  t = t.replace(/ {2,}/g, ' '); // espacios repetidos -> uno

  // Espacios al principio y al final de CADA renglon.
  t = t
    .split('\n')
    .map((linea) => linea.trim())
    .join('\n');

  // 3 o mas renglones en blanco -> uno solo (un parrafo vacio alcanza).
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/**
 * Recorta al tope de Firestore y avisa si tuvo que hacerlo.
 * @returns {{texto:string, recortado:boolean, caracteres:number}}
 *          `caracteres` es el largo REAL, ANTES de recortar: es lo que se
 *          guarda en el item para poder explicar "el PDF tenía 800.000".
 */
export function recortarTexto(texto, tope = TOPE_TEXTO_ITEM) {
  const t = String(texto ?? '');
  if (t.length <= tope) return { texto: t, recortado: false, caracteres: t.length };
  return { texto: t.slice(0, tope), recortado: true, caracteres: t.length };
}

// ============================================================
//  TROCEADO
// ============================================================

/**
 * Corta el texto en pedazos que se puedan vectorizar y citar.
 *
 * @param {string} texto  Texto ya limpio, con o sin marcas de pagina.
 * @param {{tamano?:number, solape?:number}} opciones
 * @returns {{idx:number, texto:string, pagina:number|null}[]}
 *
 * POR QUE 1600 CARACTERES: es el equilibrio. Muy chico (200) y el chunk queda
 * sin contexto: dice "$12.000" pero no de que. Muy grande (10.000) y el vector
 * se vuelve un promedio de diez temas distintos, asi que no se parece a
 * ninguna pregunta puntual. 1600 son mas o menos 3 parrafos: una idea completa.
 *
 * POR QUE 200 DE SOLAPE (que el final de un chunk se repita al principio del
 * siguiente): porque el corte cae en cualquier lado. Si "El service de
 * heladera se cobra" queda al final del chunk 3 y "$12.000" al principio del
 * chunk 4, sin solape NINGUNO de los dos responde la pregunta. Con solape, el
 * chunk 4 arranca con la frase entera. Se paga con ~12% de texto repetido.
 */
export function trocear(texto, opciones = {}) {
  const tamano = Math.max(200, Number(opciones.tamano) || 1600);
  // El solape nunca puede llegar a la mitad del chunk: si fuera >= tamano/2,
  // cada trozo avanzaria menos de lo que repite y el bucle no terminaria mas
  // (o generaria cientos de chunks casi iguales, que es peor: cuesta plata).
  const solape = Math.min(Math.max(0, Number(opciones.solape) ?? 200), Math.floor(tamano / 2) - 1);

  const trozos = [];
  for (const pag of separarEnPaginas(String(texto ?? ''))) {
    for (const pedazo of trocearUnaPagina(pag.texto, tamano, solape)) {
      trozos.push({ idx: trozos.length, texto: pedazo, pagina: pag.pagina });
    }
  }
  return trozos;
}

/**
 * Parte el string en {pagina, texto}. Si no hay marcas (nota, link, foto),
 * devuelve una sola entrada con pagina null, que es justo lo que dice el
 * modelo de datos: `pagina` es null en notas y links.
 */
function separarEnPaginas(texto) {
  MARCA.lastIndex = 0; // el flag /g guarda estado entre llamadas: hay que resetear
  if (!MARCA.test(texto)) return [{ pagina: null, texto }];

  const paginas = [];
  let ultimaPagina = null;
  let desde = 0;

  MARCA.lastIndex = 0;
  let m;
  while ((m = MARCA.exec(texto)) !== null) {
    const pedazo = texto.slice(desde, m.index);
    if (pedazo.trim()) paginas.push({ pagina: ultimaPagina, texto: pedazo });
    ultimaPagina = Number.parseInt(m[1], 10);
    desde = m.index + m[0].length;
  }
  const cola = texto.slice(desde);
  if (cola.trim()) paginas.push({ pagina: ultimaPagina, texto: cola });

  return paginas;
}

/** Corta UNA pagina (o el texto entero si no hay paginas) en pedazos. */
function trocearUnaPagina(texto, tamano, solape) {
  const limpio = texto.trim();
  if (!limpio) return [];
  if (limpio.length <= tamano) return [limpio];

  const trozos = [];
  let desde = 0;

  while (desde < limpio.length) {
    let hasta = Math.min(desde + tamano, limpio.length);

    // Si no es el ultimo pedazo, corremos el corte hacia atras para que caiga
    // en un borde natural (fin de parrafo, punto, espacio) y no en la mitad de
    // una palabra. Un chunk que arranca con "...esupuesto de agosto" confunde
    // al modelo y queda feo cuando se muestra como cita.
    if (hasta < limpio.length) hasta = buscarCorteLindo(limpio, desde, hasta, tamano);

    const trozo = limpio.slice(desde, hasta).trim();
    if (trozo) trozos.push(trozo);

    if (hasta >= limpio.length) break;

    const proximo = hasta - solape;
    // Red de seguridad contra el bucle infinito: si por lo que sea el proximo
    // arranque no avanza, arrancamos igual donde termino este pedazo.
    desde = proximo > desde ? proximo : hasta;
  }

  return trozos;
}

/**
 * Busca hacia atras, dentro de una ventana, el mejor lugar para cortar.
 * Orden de preferencia: fin de parrafo > fin de oracion > fin de renglon > espacio.
 * Si no encuentra nada (texto sin espacios, tipo un base64), corta a lo bruto.
 */
function buscarCorteLindo(texto, desde, hasta, tamano) {
  const ventana = Math.max(150, Math.floor(tamano * 0.25));
  // Nunca dejamos un chunk de menos de la mitad del tamano por buscar un corte lindo.
  const minimo = Math.max(desde + Math.floor(tamano / 2), hasta - ventana);
  if (minimo >= hasta) return hasta;

  const pedazo = texto.slice(minimo, hasta);

  const candidatos = [
    { pos: pedazo.lastIndexOf('\n\n'), largo: 2 },
    { pos: pedazo.lastIndexOf('. '), largo: 2 },
    { pos: pedazo.lastIndexOf('.\n'), largo: 2 },
    { pos: pedazo.lastIndexOf('? '), largo: 2 },
    { pos: pedazo.lastIndexOf('! '), largo: 2 },
    { pos: pedazo.lastIndexOf('\n'), largo: 1 },
    { pos: pedazo.lastIndexOf(' '), largo: 1 },
  ];

  for (const c of candidatos) {
    if (c.pos > 0) return minimo + c.pos + c.largo;
  }
  return hasta;
}

/**
 * Cuenta los caracteres que sirven de verdad (sin espacios ni saltos).
 * Lo usa extraer.js para decidir si una pagina de PDF esta vacia y hay que
 * mandarla al OCR: un PDF escaneado devuelve 300 caracteres que son todos
 * espacios y saltos de linea, y `texto.length` te miente.
 */
export function caracteresUtiles(texto) {
  return String(texto ?? '').replace(/\s+/g, '').length;
}
