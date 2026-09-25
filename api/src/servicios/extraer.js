// ============================================================
//  servicios/extraer.js
//  Sacarle el texto a un PDF o a una foto. LA CASCADA DE 3 NIVELES.
//
//    NIVEL 1 - pdf-parse (local, gratis, instantaneo)
//              Sirve para el 90% de los PDFs: los que se hicieron desde una
//              computadora (Word -> PDF, una factura, un manual). El texto ya
//              esta adentro del archivo, solo hay que leerlo.
//
//    NIVEL 2 - OCR.space (nube, 25.000 pedidos gratis por mes, 1 MB por archivo)
//              Para lo que el nivel 1 no pudo: PDFs que son fotos de hojas
//              escaneadas, y todas las fotos sacadas con el celular.
//              OCREngine=2 porque el 1 se come los acentos del castellano.
//
//    NIVEL 3 - tesseract.js (local, gratis, LENTO y COME RAM)
//              Ultimo recurso: si nos quedamos sin cuota de OCR.space, si la
//              imagen pesa mas de 1 MB y no la podemos achicar, o si OCR.space
//              esta caido. Anda offline, que es lo que salva la demo si el
//              wifi de la escuela nos deja a pie.
//
//  POR QUE una cascada y no ir siempre al OCR: el nivel 1 es gratis, tarda
//  milisegundos y no manda el archivo a ningun lado. El nivel 2 gasta cuota y
//  manda el contenido a un servidor de terceros. Solo pagamos ese costo por
//  las paginas que de verdad lo necesitan.
//
//  ESTO HAY QUE DECIRLO EN LA DEFENSA Y ESTA EN EL README: el texto de los
//  PDFs escaneados y de las fotos se procesa en OCR.space, que es un servicio
//  EXTERNO, incluso cuando el item esta marcado como 'privado'.
//
//  Devuelve siempre: { texto, paginas, origen }
// ============================================================

import { limpiarTexto, caracteresUtiles, unirPaginas, marcaDePagina } from './texto.js';

// --- Numeros con su por que -----------------------------------------------

// Una pagina con menos de 50 caracteres utiles (sin contar espacios) esta
// vacia en los hechos: es el numero de pagina y un encabezado. Ese es el sintoma
// tipico de una hoja escaneada, y es la que mandamos al OCR.
const MINIMO_CARACTERES_UTILES_POR_PAGINA = 50;

// Si TODO el documento junta menos que esto, no sirve para nada: no lo
// indexamos y devolvemos NO_SE_PUDO_EXTRAER_TEXTO.
const MINIMO_CARACTERES_UTILES_TOTAL = 20;

// El plan free de OCR.space rechaza cualquier archivo de mas de 1 MB (1024 KB).
// Apuntamos a 900 KB para tener aire: el multipart le agrega unos bytes.
const TOPE_OCR_BYTES = 900 * 1024;

// OCR.space puede tardar bastante con un PDF de varias hojas.
const TIMEOUT_OCR_MS = 45_000;

const URL_OCR = 'https://api.ocr.space/parse/image';

// ============================================================
//  Helper de errores (misma forma que en todos los servicios)
// ============================================================

function fallo(codigo, mensaje, http, detalle = null) {
  const err = new Error(`${codigo}: ${mensaje}`);
  err.codigo = codigo;
  err.mensaje = mensaje;
  err.http = http;
  err.detalle = detalle;
  return err;
}

const MSG_SIN_TEXTO =
  'No pudimos leer el texto de ese archivo. Probá con una foto más nítida o un PDF con texto.';

// ============================================================
//  NIVEL 1 - pdf-parse
// ============================================================

/**
 * Lee el texto de un PDF, PAGINA POR PAGINA.
 *
 * Necesitamos las paginas separadas (y no un solo string) por dos motivos:
 *   1. para poder citar "pág. 3" en la respuesta, que es la gracia del producto;
 *   2. para saber CUALES paginas quedaron vacias y mandar SOLO esas al OCR.
 *
 * El import es dinamico y con dos caminos porque pdf-parse cambio de API entre
 * la v1 (una funcion por defecto) y la v2 (la clase PDFParse). Soportar las dos
 * son 10 lineas y nos evita que una actualizacion de npm rompa el backend el
 * dia de la entrega.
 */
async function leerPdfPorPaginas(buffer) {
  let mod;
  try {
    mod = await import('pdf-parse');
  } catch {
    throw fallo(
      'ERROR_INTERNO',
      'Algo salió mal de nuestro lado. Ya lo estamos viendo, probá de nuevo.',
      500,
      'Falta la dependencia pdf-parse. Correr npm install en api/.',
    );
  }

  try {
    // --- Camino v2: clase PDFParse ---
    if (typeof mod.PDFParse === 'function') {
      const lector = new mod.PDFParse({ data: new Uint8Array(buffer) });
      try {
        const r = await lector.getText();
        const paginas = Array.isArray(r?.pages) && r.pages.length > 0
          ? r.pages.map((p) => String(p?.text ?? ''))
          : String(r?.text ?? '').split('\f');
        return { paginas, total: Number(r?.total) || paginas.length };
      } finally {
        // Sin esto quedan workers de pdfjs vivos y en Render free (512 MB de
        // RAM) despues de 20 PDFs el proceso se muere por falta de memoria.
        if (typeof lector.destroy === 'function') await lector.destroy();
      }
    }

    // --- Camino v1: funcion por defecto con la opcion pagerender ---
    const pdf = mod.default ?? mod.pdf;
    const paginas = [];
    const r = await pdf(buffer, {
      // pdf-parse llama a esto una vez por pagina, en orden y esperando cada
      // una. Aprovechamos para guardarnos el texto de cada hoja por separado.
      pagerender: async (datosDePagina) => {
        const contenido = await datosDePagina.getTextContent();
        const txt = contenido.items.map((i) => i.str).join(' ');
        paginas.push(txt);
        return txt;
      },
    });
    const finales = paginas.length > 0 ? paginas : String(r?.text ?? '').split('\f');
    return { paginas: finales, total: Number(r?.numpages) || finales.length };
  } catch (err) {
    const msg = String(err?.message ?? '');
    // El caso mas comun de PDF que no se puede abrir: tiene clave.
    if (/password|encrypt/i.test(msg)) {
      throw fallo(
        'NO_SE_PUDO_EXTRAER_TEXTO',
        'Ese PDF está protegido con contraseña, así que no lo podemos leer.',
        422,
        'El PDF viene encriptado.',
      );
    }
    console.error('[extraer] pdf-parse fallo:', msg);
    throw fallo(
      'NO_SE_PUDO_EXTRAER_TEXTO',
      'Ese archivo PDF está dañado o no lo pudimos abrir. Probá subirlo de nuevo.',
      422,
      'pdf-parse no pudo abrir el archivo.',
    );
  }
}

// ============================================================
//  NIVEL 2 - OCR.space
// ============================================================

function claveOcr() {
  return (process.env.OCR_SPACE_API_KEY || '').trim();
}

/**
 * Manda UN archivo a OCR.space y devuelve el texto de cada pagina.
 *
 * UN ARCHIVO POR PEDIDO, SIEMPRE. El plan free no acepta pedidos con varios
 * archivos adjuntos: si mandas dos, te rechaza los dos. Ademas asi, si una
 * pagina falla, no se cae el resto del documento.
 *
 * @returns {Promise<string[]>} el texto de cada pagina (para una foto, 1 sola)
 */
async function ocrSpace(buffer, { tipoMime, nombre, motor = 2 }) {
  const clave = claveOcr();
  if (!clave) {
    throw fallo(
      'ERROR_INTERNO',
      'Algo salió mal de nuestro lado. Ya lo estamos viendo, probá de nuevo.',
      500,
      'Falta OCR_SPACE_API_KEY en el entorno del servidor.',
    );
  }
  if (buffer.length > TOPE_OCR_BYTES) {
    // No lo mandamos: sabemos de antemano que lo va a rechazar y seria gastar
    // 3 segundos y un pedido de la cuota para nada.
    throw fallo(
      'NO_SE_PUDO_EXTRAER_TEXTO',
      MSG_SIN_TEXTO,
      422,
      `El archivo pesa ${(buffer.length / 1024).toFixed(0)} KB y el OCR gratuito acepta hasta 1 MB.`,
    );
  }

  const formulario = new FormData();
  // Blob y FormData son globales en Node 24: no hace falta ninguna libreria.
  formulario.append('file', new Blob([buffer], { type: tipoMime }), nombre);
  formulario.append('language', 'spa');
  formulario.append('isOverlayRequired', 'false');
  // Motor 2: reconoce mucho mejor los acentos y las eñes que el 1, y no le
  // molesta que la foto este un poco torcida. El 1 queda como plan B porque
  // el 2 no soporta todos los idiomas y a veces rebota por eso.
  formulario.append('OCREngine', String(motor));
  formulario.append('scale', 'true'); // agranda las imagenes de baja resolucion
  formulario.append('detectOrientation', 'true'); // fotos sacadas de costado
  if (tipoMime === 'application/pdf') formulario.append('filetype', 'PDF');

  let res;
  try {
    res = await fetch(URL_OCR, {
      method: 'POST',
      headers: { apikey: clave },
      body: formulario,
      signal: AbortSignal.timeout(TIMEOUT_OCR_MS),
    });
  } catch (err) {
    console.error('[extraer] OCR.space no respondio:', err?.name, err?.message);
    throw fallo(
      'IA_NO_RESPONDE',
      'El servicio de IA no está respondiendo. Probá de nuevo en un minuto.',
      503,
      'El servicio de OCR no contestó a tiempo.',
    );
  }

  if (res.status === 402 || res.status === 403) {
    throw fallo(
      'SIN_CREDITOS_IA',
      'Se acabaron los créditos de la IA por este mes. Avisale al administrador.',
      402,
      'OCR.space agotó el cupo mensual gratuito.',
    );
  }
  if (res.status === 429) {
    throw fallo(
      'DEMASIADOS_PEDIDOS',
      'Estás yendo muy rápido. Esperá unos segundos y probá de nuevo.',
      429,
      'OCR.space nos limitó por cantidad de pedidos.',
    );
  }
  if (!res.ok) {
    console.error('[extraer] OCR.space HTTP', res.status);
    throw fallo(
      'IA_NO_RESPONDE',
      'El servicio de IA no está respondiendo. Probá de nuevo en un minuto.',
      503,
      `El servicio de OCR respondió HTTP ${res.status}.`,
    );
  }

  let json;
  try {
    json = await res.json();
  } catch {
    throw fallo(
      'IA_NO_RESPONDE',
      'El servicio de IA no está respondiendo. Probá de nuevo en un minuto.',
      503,
      'El servicio de OCR devolvió algo que no era JSON.',
    );
  }

  if (json?.IsErroredOnProcessing) {
    const detalleCrudo = [].concat(json?.ErrorMessage ?? []).join(' ');
    console.error('[extraer] OCR.space error:', detalleCrudo);
    // El motor 2 no soporta todos los idiomas. Si rebota por eso, reintentamos
    // UNA vez con el motor 1 antes de darnos por vencidos.
    if (motor === 2 && /language|engine/i.test(detalleCrudo)) {
      return ocrSpace(buffer, { tipoMime, nombre, motor: 1 });
    }
    throw fallo('NO_SE_PUDO_EXTRAER_TEXTO', MSG_SIN_TEXTO, 422, 'El servicio de OCR no pudo procesar el archivo.');
  }

  const resultados = Array.isArray(json?.ParsedResults) ? json.ParsedResults : [];
  return resultados.map((r) => String(r?.ParsedText ?? ''));
}

// ============================================================
//  NIVEL 3 - tesseract.js
// ============================================================

/**
 * OCR local, en castellano, sin salir del servidor.
 *
 * ADVERTENCIA HONESTA (esto va en la defensa): tesseract.js carga el modelo
 * del idioma en memoria y en Render free (512 MB y CPU compartida) puede tardar
 * 30 segundos largos y, con una foto grande, quedarse sin RAM y matar el
 * proceso. Por eso es el ULTIMO nivel y se puede apagar entero con la variable
 * TESSERACT_HABILITADO=0 si el dia de la demo vemos que el server se cae.
 */
function tesseractHabilitado() {
  return (process.env.TESSERACT_HABILITADO ?? '1') !== '0';
}

async function tesseractLocal(buffer) {
  const { createWorker } = await import('tesseract.js');
  // 'spa' = castellano. Con 'eng' (el default) confunde los acentos y escribe
  // "informacion" como "informaci6n".
  const trabajador = await createWorker('spa');
  try {
    const { data } = await trabajador.recognize(buffer);
    return String(data?.text ?? '');
  } finally {
    // SIEMPRE terminate, aunque haya explotado: cada worker es un proceso
    // aparte con el modelo cargado. Dos olvidados y no queda memoria.
    await trabajador.terminate();
  }
}

// ============================================================
//  Achicar la imagen antes de mandarla al OCR
// ============================================================

/**
 * Si la foto se pasa de 900 KB, intenta bajarle la calidad con sharp.
 *
 * sharp es una dependencia OPCIONAL a proposito: pesa ~30 MB y tiene binarios
 * nativos que a veces no compilan en Render. Por eso el import es dinamico y
 * dentro de un try: si no esta instalado, no se rompe nada, simplemente
 * devolvemos null y el que llama se va derecho al nivel 3 (tesseract), que no
 * tiene limite de tamaño.
 *
 * Igual el cliente ya achica la foto en el celular antes de subirla (esta en
 * el contrato). Esto es la red de contencion por si alguien sube desde el panel.
 */
async function achicarParaOcr(buffer, tipoMime) {
  if (buffer.length <= TOPE_OCR_BYTES) return buffer;

  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.warn('[extraer] La imagen se pasa de 900 KB y sharp no está instalado.');
    return null;
  }

  try {
    // Vamos bajando calidad hasta entrar. Empezamos en 75 porque para leer
    // texto no hace falta calidad de foto: alcanza con que se distingan las letras.
    for (const calidad of [75, 60, 45, 30]) {
      const achicada = await sharp(buffer)
        .rotate() // respeta la orientacion EXIF: si no, el texto queda de costado
        .resize({ width: 2200, withoutEnlargement: true })
        .jpeg({ quality: calidad })
        .toBuffer();
      if (achicada.length <= TOPE_OCR_BYTES) {
        console.log(
          `[extraer] Foto achicada de ${(buffer.length / 1024).toFixed(0)} KB a ` +
            `${(achicada.length / 1024).toFixed(0)} KB (calidad ${calidad}).`,
        );
        return achicada;
      }
    }
    return null;
  } catch (err) {
    console.error('[extraer] sharp no pudo achicar la imagen:', err?.message);
    return null;
  }
}

// ============================================================
//  LA CASCADA PARA PDFs
// ============================================================

/**
 * @param {Buffer} buffer
 * @param {{nombreArchivo?:string}} opciones
 * @returns {Promise<{texto:string, paginas:number, origen:string, paginasOcr:number[]}>}
 *
 * `texto` viene con las marcas <<<PAGINA:n>>> puestas, que es lo que trocear()
 * necesita para poder citar "pág. 3". El que llama guarda en el item el texto
 * SIN marcas (quitarMarcasDePagina) y trocea el que las tiene.
 */
export async function extraerDePdf(buffer, opciones = {}) {
  const nombre = opciones.nombreArchivo || 'documento.pdf';

  // ---- NIVEL 1 ----
  const { paginas: crudas, total } = await leerPdfPorPaginas(buffer);
  const paginas = crudas.map(limpiarTexto);

  // Que hojas quedaron practicamente vacias: esas son las escaneadas.
  const flojas = [];
  paginas.forEach((txt, i) => {
    if (caracteresUtiles(txt) < MINIMO_CARACTERES_UTILES_POR_PAGINA) flojas.push(i);
  });

  let origen = 'pdf-texto';
  const paginasOcr = [];

  // ---- NIVEL 2, SOLO para las hojas flojas ----
  if (flojas.length > 0 && claveOcr()) {
    console.log(`[extraer] ${flojas.length} de ${paginas.length} páginas sin texto digital -> OCR.`);
    try {
      // NOTA HONESTA: mandamos el PDF entero en UN pedido y no cada hoja por
      // separado porque para recortar una sola pagina y convertirla en imagen
      // haria falta un renderizador nativo (canvas), que no se puede instalar
      // en Render free. OCR.space devuelve un ParsedResult POR PAGINA, asi que
      // igual usamos el resultado SOLO en las hojas que estaban flojas: las
      // que ya tenian texto digital quedan como estaban, porque el texto
      // original siempre es mas prolijo que el del OCR.
      const textosOcr = await ocrSpace(buffer, { tipoMime: 'application/pdf', nombre });

      for (const i of flojas) {
        const delOcr = limpiarTexto(textosOcr[i] ?? '');
        if (caracteresUtiles(delOcr) > caracteresUtiles(paginas[i])) {
          paginas[i] = delOcr;
          paginasOcr.push(i + 1);
        }
      }
      if (paginasOcr.length > 0) origen = 'ocr-space';
    } catch (err) {
      // Que falle el OCR NO es motivo para tirar todo: puede ser que las otras
      // 5 hojas del PDF si tengan texto y alcancen para responder. Solo
      // fallamos abajo, si al final no juntamos nada util.
      console.error('[extraer] El OCR del PDF falló, seguimos con lo que haya:', err?.codigo || err?.message);
    }
  }

  const texto = unirPaginas(paginas);
  if (caracteresUtiles(texto) < MINIMO_CARACTERES_UTILES_TOTAL) {
    throw fallo(
      'NO_SE_PUDO_EXTRAER_TEXTO',
      MSG_SIN_TEXTO,
      422,
      'El PDF no tiene texto digital y el OCR tampoco pudo leer nada.',
    );
  }

  return { texto, paginas: total || paginas.length, origen, paginasOcr };
}

// ============================================================
//  LA CASCADA PARA FOTOS
// ============================================================

/**
 * @param {Buffer} buffer
 * @param {string} tipoMime image/jpeg | image/png | image/webp
 * @returns {Promise<{texto:string, paginas:null, origen:string, paginasOcr:number[]}>}
 *
 * En una foto no hay nivel 1: no hay texto digital que leer, hay que
 * reconocerlo si o si. Asi que la cascada arranca en el 2.
 */
export async function extraerDeImagen(buffer, tipoMime, opciones = {}) {
  const nombre = opciones.nombreArchivo || 'foto.jpg';
  let texto = '';
  let origen = null;

  // ---- NIVEL 2 ----
  if (claveOcr()) {
    // Si se pasa de 900 KB probamos achicarla; si no se puede, devuelve null y
    // saltamos derecho al nivel 3, que no tiene limite de tamaño.
    const paraOcr = await achicarParaOcr(buffer, tipoMime);
    if (paraOcr) {
      try {
        // El mime puede haber cambiado a jpeg si sharp la reconvirtio.
        const mimeFinal = paraOcr === buffer ? tipoMime : 'image/jpeg';
        const paginasOcr = await ocrSpace(paraOcr, { tipoMime: mimeFinal, nombre });
        texto = limpiarTexto(paginasOcr.join('\n'));
        if (caracteresUtiles(texto) >= MINIMO_CARACTERES_UTILES_TOTAL) origen = 'ocr-space';
      } catch (err) {
        // Si es falta de creditos vale la pena decirlo tal cual, pero primero
        // probamos el nivel 3: si tesseract la saca, el usuario ni se entera.
        console.error('[extraer] OCR.space falló con la foto:', err?.codigo || err?.message);
      }
    }
  }

  // ---- NIVEL 3 ----
  if (!origen && tesseractHabilitado()) {
    console.log('[extraer] Cayendo a tesseract.js (OCR local, esto tarda).');
    try {
      const local = limpiarTexto(await tesseractLocal(buffer));
      if (caracteresUtiles(local) >= MINIMO_CARACTERES_UTILES_TOTAL) {
        texto = local;
        origen = 'ocr-tesseract';
      }
    } catch (err) {
      console.error('[extraer] tesseract.js falló:', err?.message);
    }
  }

  if (!origen) {
    throw fallo(
      'NO_SE_PUDO_EXTRAER_TEXTO',
      MSG_SIN_TEXTO,
      422,
      'Ninguno de los lectores de texto encontró letras en esa imagen.',
    );
  }

  // Una foto es "una pagina": le ponemos la marca para que trocear() no la
  // trate distinto que a un PDF, pero `paginas` va null como dice el modelo.
  return { texto: marcaDePagina(1) + texto, paginas: null, origen, paginasOcr: origen === 'ocr-space' ? [1] : [] };
}

// ============================================================
//  Puerta de entrada unica
// ============================================================

/**
 * Elige la cascada segun el mimetype. Es lo que llama /procesar.
 * @returns {Promise<{texto:string, paginas:number|null, origen:string, paginasOcr:number[]}>}
 */
export async function extraerDeArchivo({ buffer, tipoMime, nombreArchivo }) {
  if (!buffer || buffer.length === 0) {
    throw fallo('ARCHIVO_FALTANTE', 'No llegó el archivo. Elegilo de nuevo.', 400, null);
  }

  if (tipoMime === 'application/pdf') {
    return extraerDePdf(buffer, { nombreArchivo });
  }
  if (tipoMime === 'image/jpeg' || tipoMime === 'image/png' || tipoMime === 'image/webp') {
    return extraerDeImagen(buffer, tipoMime, { nombreArchivo });
  }

  throw fallo(
    'TIPO_NO_SOPORTADO',
    'Solo aceptamos PDF, JPG, PNG o WEBP.',
    415,
    `Llegó un archivo de tipo "${tipoMime}".`,
  );
}
