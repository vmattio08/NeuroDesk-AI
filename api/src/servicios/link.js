// ============================================================
//  servicios/link.js
//  Traer el texto de una pagina web. CON VALIDACION ANTI-SSRF.
//
//  QUE ES SSRF Y POR QUE ESTE ARCHIVO ES 90% VALIDACION Y 10% fetch:
//  SSRF = Server Side Request Forgery. Nuestro backend acepta una URL que
//  escribe un usuario y la va a buscar EL SERVIDOR. Si no validamos nada,
//  cualquier miembro puede cargar un item tipo 'link' con
//  http://169.254.169.254/latest/meta-data/ (la direccion magica donde las
//  nubes guardan las credenciales de la maquina) o con http://localhost:3000/
//  y nuestro propio servidor le va a traer eso, se lo va a indexar como si
//  fuera conocimiento del equipo, y despues se lo va a leer tranquilo en la
//  app. El atacante no necesita entrar a la red interna: usa nuestro servidor,
//  que YA esta adentro, como si fuera un navegador propio.
//
//  Por eso: esquemas permitidos, resolucion de DNS a mano, lista negra de
//  rangos privados, redirects contados Y REVALIDADOS, timeout, tope de bytes
//  y tipo de contenido. Si algo no cierra: URL_NO_PERMITIDA.
//
//  Y UNA VEZ QUE LA PAGINA LLEGO, QUE TEXTO NOS QUEDAMOS (cambio del 29/10):
//  muchas paginas se arman con JavaScript, y sin navegador el cuerpo llega
//  vacio o con el pie de pagina nada mas. Caso REAL: un link a un video de
//  YouTube se indexo como "Acerca de Prensa Derechos de autor ... © 2026
//  Google LLC", y la IA no tenia forma de saber de que era el video. Por eso:
//    - de CUALQUIER pagina leemos tambien el <title>, la description y los de
//      Open Graph (og:title, og:description, og:site_name), y van ADELANTE;
//    - si el cuerpo es ruido y hay metadatos, nos quedamos con los metadatos;
//    - de un video de YouTube pedimos ademas el titulo y el canal al oEmbed
//      publico de YouTube, que pasa por la MISMA aduana que todo lo demas.
// ============================================================

import dns from 'node:dns/promises';

import { caracteresUtiles } from './texto.js';

// --- Numeros con su por que ----------------------------------------------

// 10 segundos para TODO el pedido, redirects incluidos. Si una pagina tarda
// mas, no vale la pena: el usuario esta esperando con el spinner en la mano.
const TIMEOUT_MS = 10_000;

// Como mucho 2 saltos. Los acortadores de links usan 1 o 2; mas que eso suele
// ser una cadena armada para esconder el destino final.
const MAX_REDIRECTS = 2;

// 2 MB de HTML es muchisimo (una nota de diario son ~100 KB). Cortamos ahi
// para que nadie nos tire un archivo de 5 GB y nos vuele la memoria de Render.
const TOPE_BYTES = 2 * 1024 * 1024;

// Solo texto. Nada de PDFs, imagenes, zips ni application/octet-stream.
const TIPOS_ACEPTADOS = ['text/html', 'text/plain'];

// Solo los puertos de la web. Un link a http://10.0.0.5:6379 (Redis) ya lo
// corta la lista negra de IPs, pero limitar los puertos es otra cerradura gratis.
const PUERTOS_PERMITIDOS = new Set(['', '80', '443']);

// --- Cuando el cuerpo de la pagina es ruido (ver esRuido) -----------------

// Menos de 50 caracteres utiles (sin contar espacios) no es contenido: es un
// "Cargando...", un menu o un boton suelto. Es el MISMO numero con el que
// extraer.js decide que una hoja de PDF esta vacia.
const MINIMO_UTILES_CUERPO = 50;

// Un cuerpo corto que trae el ©, "copyright" o "derechos de autor" es el pie
// de pagina y nada mas. El de YouTube mide 182 caracteres utiles. El tope
// queda en 300 y no mas alto para no tirar una nota corta DE VERDAD que tenga
// su "© Diario Tal" al final.
const TOPE_UTILES_PIE = 300;
const PISTAS_DE_PIE = /©|copyright|derechos de autor|derechos reservados|all rights reserved/i;

// Topes para lo que sale del <head>: un titulo de mas de 300 caracteres ya es
// raro, y hay sitios que meten media nota adentro de la description.
const TOPE_TITULO_META = 300;
const TOPE_DESCRIPCION_META = 1000;

const MSG_URL =
  'Esa dirección no se puede leer. Probá con un enlace público que empiece con https://';

function fallo(codigo, mensaje, http, detalle = null) {
  const err = new Error(`${codigo}: ${mensaje}`);
  err.codigo = codigo;
  err.mensaje = mensaje;
  err.http = http;
  err.detalle = detalle;
  return err;
}

const errorDeUrl = (detalle) => fallo('URL_NO_PERMITIDA', MSG_URL, 400, detalle);

// ============================================================
//  LA LISTA NEGRA DE DIRECCIONES
// ============================================================

/**
 * ¿Esta IP apunta a algo que NO es internet publica?
 * Devuelve el motivo (string) si hay que rechazarla, o null si esta bien.
 *
 * Se valida la IP RESUELTA y no el hostname, porque un dominio publico como
 * "midominio.com" puede tener un registro A que apunte a 127.0.0.1. El texto
 * del hostname no dice nada; la direccion, si.
 */
export function motivoParaRechazarIp(ip) {
  const texto = String(ip ?? '').trim();

  // IPv6 con IPv4 adentro (::ffff:127.0.0.1). Le sacamos la cascara y
  // validamos la IPv4 de adentro, si no se cuela por la ventana.
  const conIpv4Adentro = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(texto);
  if (conIpv4Adentro) return motivoParaRechazarIp(conIpv4Adentro[1]);

  if (texto.includes(':')) return motivoIpv6(texto);
  return motivoIpv4(texto);
}

function motivoIpv4(ip) {
  const partes = ip.split('.');
  if (partes.length !== 4) return 'no parece una dirección IPv4 válida';

  const n = partes.map((p) => Number.parseInt(p, 10));
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) {
    return 'no parece una dirección IPv4 válida';
  }
  const [a, b] = n;

  if (a === 0) return 'la dirección 0.0.0.0/8 no es una dirección de internet';
  if (a === 127) return 'apunta al propio servidor (127.0.0.0/8)';
  if (a === 10) return 'apunta a una red privada (10.0.0.0/8)';
  if (a === 172 && b >= 16 && b <= 31) return 'apunta a una red privada (172.16.0.0/12)';
  if (a === 192 && b === 168) return 'apunta a una red privada (192.168.0.0/16)';
  // 169.254.169.254 es LA direccion de metadatos de AWS/GCP/Azure: la que
  // devuelve credenciales de la maquina. Es el objetivo clasico de un SSRF.
  if (a === 169 && b === 254) return 'apunta a la red de metadatos del proveedor (169.254.0.0/16)';
  if (a === 100 && b >= 64 && b <= 127) return 'apunta a una red del operador (100.64.0.0/10)';
  if (a === 192 && b === 0) return 'apunta a un rango reservado (192.0.0.0/16)';
  if (a === 198 && (b === 18 || b === 19)) return 'apunta a un rango reservado (198.18.0.0/15)';
  if (a >= 224) return 'apunta a multicast o a un rango reservado (224.0.0.0/4 y 240.0.0.0/4)';

  return null; // IP publica de verdad
}

function motivoIpv6(ip) {
  const grupos = expandirIpv6(ip);
  if (!grupos) return 'no parece una dirección IPv6 válida';

  const todosCero = grupos.every((g) => g === 0);
  if (todosCero) return 'la dirección :: no es una dirección de internet';
  if (grupos.slice(0, 7).every((g) => g === 0) && grupos[7] === 1) {
    return 'apunta al propio servidor (::1)';
  }

  const primerByte = grupos[0] >> 8;
  // fc00::/7 = "unique local", el equivalente IPv6 de 10.x / 192.168.x
  if (primerByte === 0xfc || primerByte === 0xfd) return 'apunta a una red privada (fc00::/7)';
  // fe80::/10 = link-local
  if (grupos[0] >= 0xfe80 && grupos[0] <= 0xfebf) return 'apunta a una dirección link-local (fe80::/10)';

  return null;
}

/**
 * Convierte una IPv6 en sus 8 grupos numericos, expandiendo el "::".
 * Devuelve null si no se puede parsear (y ahi rechazamos, fail-closed).
 */
function expandirIpv6(ip) {
  const limpia = ip.replace(/^\[|\]$/g, '').split('%')[0]; // saca corchetes y zona (%eth0)
  if (limpia.split('::').length > 2) return null; // "::" solo puede aparecer una vez

  const [izq, der] = limpia.includes('::') ? limpia.split('::') : [limpia, null];
  const gruposIzq = izq ? izq.split(':') : [];
  const gruposDer = der ? der.split(':') : [];

  if (der === null && gruposIzq.length !== 8) return null;

  const faltan = 8 - (gruposIzq.length + gruposDer.length);
  if (faltan < 0) return null;

  const todos = [...gruposIzq, ...Array(faltan).fill('0'), ...gruposDer];
  const numeros = todos.map((g) => Number.parseInt(g || '0', 16));
  if (numeros.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return null;

  return numeros;
}

// ============================================================
//  VALIDACION DE UNA URL (esquema + puerto + DNS)
// ============================================================

/**
 * Valida una URL de punta a punta. Si algo no cierra, TIRA URL_NO_PERMITIDA.
 * Se llama para la URL original Y para cada destino de redirect: un redirect
 * que no se revalida es la puerta de atras mas comun de este ataque (la
 * primera URL es publica y limpia, y te manda a 169.254.169.254).
 *
 * @returns {Promise<URL>}
 */
export async function validarUrl(textoUrl) {
  let url;
  try {
    url = new URL(String(textoUrl ?? '').trim());
  } catch {
    throw errorDeUrl('La dirección está mal escrita.');
  }

  // Solo http y https. Sin esto entran file:///etc/passwd, ftp://, gopher://
  // y hasta data: con contenido inventado por el que carga el item.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw errorDeUrl(`El esquema "${url.protocol.replace(':', '')}" no está permitido.`);
  }

  if (!PUERTOS_PERMITIDOS.has(url.port)) {
    throw errorDeUrl(`El puerto ${url.port} no está permitido.`);
  }

  // Usuario y clave en la URL (http://usuario:clave@host) son la forma clasica
  // de disfrazar el host real para que la persona no se de cuenta.
  if (url.username || url.password) {
    throw errorDeUrl('La dirección no puede llevar usuario y contraseña adentro.');
  }

  let direcciones;
  try {
    // all: true porque un dominio puede tener VARIAS IPs (una publica y una
    // privada). Alcanza con que UNA sea privada para rechazar todo: no
    // podemos elegir cual va a usar fetch.
    direcciones = await dns.lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw errorDeUrl('No pudimos resolver ese dominio.');
  }

  if (!direcciones || direcciones.length === 0) {
    throw errorDeUrl('El dominio no resolvió a ninguna dirección.');
  }

  for (const d of direcciones) {
    const motivo = motivoParaRechazarIp(d.address);
    if (motivo) throw errorDeUrl(`La dirección ${motivo}.`);
  }

  return url;
}

// ============================================================
//  EL FETCH SEGURO (el UNICO fetch de este archivo)
// ============================================================

/**
 * Trae UNA direccion pasando por toda la aduana: valida la URL, sigue los
 * redirects a mano REVALIDANDO cada salto, y corta a los 10 s, a los 2 MB o
 * si el tipo de contenido no esta en la lista.
 *
 * TODO lo que este archivo le pide a internet sale por aca: la pagina que
 * cargo la persona Y el oEmbed de YouTube. Aunque el oEmbed apunte siempre a
 * youtube.com, no le hacemos un fetch "suelto": un segundo camino para salir
 * a internet es un segundo lugar donde alguien se puede olvidar de validar.
 *
 * @param {string} textoUrl
 * @param {{tiposAceptados?: string[], accept?: string}} [opciones]
 *   tiposAceptados: los Content-Type que se dejan pasar. Por defecto, solo
 *   paginas de texto; el oEmbed pide 'application/json'.
 * @returns {Promise<{cuerpo:string, tipo:string, urlFinal:string}>}
 *
 * LIMITACION CONOCIDA (hay que saber decirla): validamos el DNS y despues
 * fetch vuelve a resolver el nombre por su cuenta. Entre una cosa y la otra,
 * un atacante con su propio servidor DNS podria devolver una IP publica en la
 * primera consulta y una privada en la segunda ("DNS rebinding"). Taparlo del
 * todo obliga a hacer la conexion a mano con sockets y a mandar el Host a
 * mano, que es mucho para el alcance del TP. Con el timeout corto, el tope de
 * bytes y el filtro de Content-Type, la ventana que queda es muy chica.
 */
async function pedirSeguro(textoUrl, { tiposAceptados = TIPOS_ACEPTADOS, accept = 'text/html,text/plain;q=0.9' } = {}) {
  // Un solo reloj para TODO el viaje, redirects incluidos: si no, tres saltos
  // de 9 segundos cada uno son 27 segundos con el usuario esperando.
  const reloj = AbortSignal.timeout(TIMEOUT_MS);

  let url = await validarUrl(textoUrl);
  let res;
  let saltos = 0;

  while (true) {
    try {
      res = await fetch(url, {
        method: 'GET',
        // manual = fetch NO sigue los redirects solo. Los seguimos nosotros
        // para poder REVALIDAR cada destino. Si dejaramos que los siga solo,
        // toda la validacion de arriba no serviria para nada.
        redirect: 'manual',
        headers: {
          'User-Agent': 'NeuroDeskBot/2.0 (+https://neurodesk-api.onrender.com)',
          Accept: accept,
          'Accept-Language': 'es-AR,es;q=0.9',
        },
        signal: reloj,
      });
    } catch (err) {
      console.error('[link] fetch falló:', err?.name, err?.message);
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw errorDeUrl('La página tardó más de 10 segundos en contestar.');
      }
      throw errorDeUrl('No pudimos conectarnos a esa dirección.');
    }

    const esRedirect = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!esRedirect) break;

    if (saltos >= MAX_REDIRECTS) {
      throw errorDeUrl(`La dirección tiene más de ${MAX_REDIRECTS} redirecciones.`);
    }
    saltos += 1;

    // El Location puede ser relativo ("/otra-pagina"): se resuelve contra la
    // URL actual, y despues se REVALIDA de cero como si fuera la primera.
    const destino = new URL(res.headers.get('location'), url).toString();
    url = await validarUrl(destino);
  }

  if (!res.ok) {
    throw errorDeUrl(`La página respondió con el código ${res.status}.`);
  }

  // --- Content-Type: solo lo que este pedido espera ------------------------
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const tipo = contentType.split(';')[0].trim();
  if (!tiposAceptados.includes(tipo)) {
    throw errorDeUrl(`Ese enlace devuelve "${tipo || 'contenido desconocido'}" y solo leemos páginas de texto.`);
  }

  // --- Descarga con tope de bytes -------------------------------------------
  // Si el servidor ya nos avisa que pesa mas de 2 MB, cortamos sin descargar.
  const largoDeclarado = Number.parseInt(res.headers.get('content-length') || '', 10);
  if (Number.isFinite(largoDeclarado) && largoDeclarado > TOPE_BYTES) {
    throw errorDeUrl(`La página pesa ${(largoDeclarado / 1024 / 1024).toFixed(1)} MB y el máximo son 2 MB.`);
  }

  const crudo = await leerConTope(res, TOPE_BYTES);

  // El charset viene declarado en el header. Si no viene, utf-8 (y fatal:false
  // para que un byte roto no tire abajo toda la extraccion).
  const charset = /charset=([\w-]+)/i.exec(contentType)?.[1] || 'utf-8';
  let cuerpo;
  try {
    cuerpo = new TextDecoder(charset, { fatal: false }).decode(crudo);
  } catch {
    cuerpo = new TextDecoder('utf-8', { fatal: false }).decode(crudo);
  }

  return { cuerpo, tipo, urlFinal: url.toString() };
}

// ============================================================
//  TRAER EL TEXTO
// ============================================================

/**
 * Descarga una pagina publica y devuelve su texto plano, con lo que la pagina
 * dice de si misma (titulo, descripcion) ADELANTE de todo.
 *
 * @param {string} textoUrl
 * @returns {Promise<{texto:string, titulo:string|null, origen:'link', urlFinal:string, caracteres:number}>}
 */
export async function traerTextoDeUrl(textoUrl) {
  const idVideo = idDeVideoDeYoutube(textoUrl);
  let pagina = null;
  let video = null;

  if (!idVideo) {
    pagina = await pedirSeguro(textoUrl);
  } else {
    // La direccion que cargo la persona pasa la aduana ANTES que nada, como
    // cualquier otra: si no es publica, no hay oEmbed que la salve.
    await validarUrl(textoUrl);

    // La pagina y el oEmbed salen JUNTOS: el usuario espera lo que tarde el
    // mas lento (10 s como mucho) y no la suma de los dos. allSettled y no
    // all: que falle uno no tiene que tirar abajo al otro.
    const [dePagina, deVideo] = await Promise.allSettled([
      pedirSeguro(textoUrl),
      datosDelVideo(idVideo),
    ]);

    if (deVideo.status === 'fulfilled') {
      video = deVideo.value;
    } else {
      // Video privado, borrado, o YouTube que no contesta: seguimos como con
      // cualquier otra pagina (titulo y descripcion de los metadatos).
      console.warn('[link] El oEmbed de YouTube falló, sigo con la página:', deVideo.reason?.detalle ?? deVideo.reason?.message);
    }

    if (dePagina.status === 'fulfilled') {
      pagina = dePagina.value;
    } else if (video) {
      // El titulo y el canal ya los tenemos: con eso alcanza para indexar.
      console.warn('[link] La página del video falló, me quedo con el oEmbed:', dePagina.reason?.detalle ?? dePagina.reason?.message);
    } else {
      throw dePagina.reason; // sin pagina y sin oEmbed no hay nada que leer
    }

    // Sin oEmbed, la pagina tiene que ser la de UN video. Si es la generica de
    // YouTube (titulo "- YouTube" y "Disfruta los videos y la musica..."), el
    // video no existe, es privado o lo borraron: indexar eso es guardar
    // basura con cara de item 'listo'. Lo probamos con un id inventado.
    if (!video && !esPaginaDeUnVideo(pagina)) {
      throw fallo(
        'NO_SE_PUDO_EXTRAER_TEXTO',
        'No pudimos leer ese video de YouTube. Fijate que sea público.',
        422,
        'El video no existe, es privado o lo borraron.',
      );
    }
  }

  const texto = armarTexto(pagina, video);

  if (texto.replace(/\s+/g, '').length < 20) {
    // La pagina cargo pero no tiene texto, y ni siquiera metadatos: casi
    // siempre es una app hecha toda en JavaScript, que sin navegador no
    // renderiza nada.
    throw fallo(
      'NO_SE_PUDO_EXTRAER_TEXTO',
      'No pudimos leer el texto de esa página. Probá copiando el contenido en una nota.',
      422,
      'La página no tiene texto plano (probablemente se arma con JavaScript).',
    );
  }

  let titulo = null;
  if (video) titulo = video.titulo.slice(0, 120);
  else if (pagina.tipo === 'text/html') titulo = sacarTitulo(pagina.cuerpo);

  return {
    texto,
    titulo,
    origen: 'link',
    urlFinal: pagina ? pagina.urlFinal : video.url,
    caracteres: texto.length,
  };
}

/**
 * Arma el texto final con lo que haya:
 *   1. ADELANTE, lo que la pagina dice de si misma: titulos, descripcion y
 *      sitio, sin repetir. Si es un video de YouTube y el oEmbed contesto:
 *      "Video de YouTube: <titulo>. Canal: <autor>." y la descripcion.
 *   2. DESPUES, el cuerpo... salvo que sea ruido y haya metadatos: ahi nos
 *      quedamos SOLO con los metadatos.
 *
 * POR QUE ADELANTE: el texto se trocea de a 1500 caracteres, y lo que va al
 * principio cae en el primer chunk. Asi ese chunk dice DE QUE habla la pagina,
 * que es justo lo que suele buscar una pregunta.
 */
function armarTexto(pagina, video) {
  // Texto plano: no hay <head> ni etiquetas. Va tal cual.
  if (pagina && pagina.tipo !== 'text/html') return pagina.cuerpo;

  const meta = pagina ? sacarMetadatos(pagina.cuerpo) : { titulos: [], descripciones: [], sitio: null };
  let cuerpo = pagina ? htmlATexto(pagina.cuerpo) : '';
  let { titulos, descripciones, sitio } = meta;

  if (video) {
    const lineaDelVideo = `Video de YouTube: ${conPunto(video.titulo)}` +
      (video.autor ? ` Canal: ${conPunto(video.autor)}` : '');
    // ¿La pagina que bajamos es la DEL VIDEO? En Europa, por ejemplo, YouTube
    // contesta con un cartel de cookies. Si su titulo no es el del video, de
    // esa pagina no usamos nada: ni la descripcion ni el cuerpo.
    const esLaDelVideo = yaDicho(video.titulo, titulos);
    titulos = [lineaDelVideo];
    descripciones = esLaDelVideo ? descripciones.filter((d) => !yaDicho(d, titulos)) : [];
    sitio = null; // "YouTube" ya esta dicho en la linea del video
    if (!esLaDelVideo) cuerpo = '';
  }

  // Cuerpo ruidoso y metadatos para reemplazarlo: afuera el cuerpo. Sin
  // metadatos no se toca: un cuerpo flojo es mejor que nada.
  if (titulos.length + descripciones.length > 0 && esRuido(cuerpo)) cuerpo = '';

  // Muchos diarios usan la bajada de la nota como description: si el cuerpo
  // ya la dice, no la repetimos arriba. El titulo va siempre: es corto y es
  // lo que le da contexto al primer chunk.
  if (cuerpo) {
    const enElCuerpo = normalizar(cuerpo);
    descripciones = descripciones.filter((d) => !enElCuerpo.includes(normalizar(d)));
  }

  const encabezado = [...titulos, ...descripciones];
  if (sitio) encabezado.push(`Sitio: ${sitio}`);

  return [encabezado.join('\n'), cuerpo].filter(Boolean).join('\n\n');
}

/**
 * Lee el body de a pedacitos y CORTA apenas se pasa del tope.
 *
 * POR QUE NO res.text() Y LISTO: porque res.text() se traga el archivo entero
 * antes de devolverte nada. Un servidor malicioso que manda 5 GB (o un stream
 * infinito) nos vuela los 512 MB de RAM de Render antes de que podamos mirar
 * el tamaño. Leyendo de a chunks cortamos al llegar a los 2 MB.
 */
async function leerConTope(res, tope) {
  if (!res.body) return new Uint8Array(0);

  const lector = res.body.getReader();
  const pedazos = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await lector.read();
      if (done) break;
      total += value.length;
      if (total > tope) {
        await lector.cancel(); // le avisamos al servidor que corte de mandar
        throw errorDeUrl('La página pesa más de 2 MB.');
      }
      pedazos.push(value);
    }
  } finally {
    lector.releaseLock?.();
  }

  const salida = new Uint8Array(total);
  let posicion = 0;
  for (const p of pedazos) {
    salida.set(p, posicion);
    posicion += p.length;
  }
  return salida;
}

// ============================================================
//  HTML -> texto
// ============================================================

/** Saca el <title> para usarlo si el usuario no le puso titulo al item. */
function sacarTitulo(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const t = decodificarEntidades(m[1].replace(/\s+/g, ' ')).trim();
  return t ? t.slice(0, 120) : null;
}

// ============================================================
//  METADATOS: lo que la pagina dice de si misma en el <head>
// ============================================================

// Las <meta> que nos sirven. Da igual si vienen con name= o con property=:
// la norma de Open Graph dice property, pero muchos sitios escriben name.
const METAS_QUE_SIRVEN = new Set(['description', 'og:title', 'og:description', 'og:site_name']);

/**
 * Lee el <title>, la description y los de Open Graph.
 *
 * POR QUE HACE FALTA: htmlATexto() tira el <head> entero (ahi viven scripts
 * y estilos), y con el se iban estos datos, que son justo los que una pagina
 * hecha con JavaScript SI trae escritos: los necesita para que WhatsApp o
 * Twitter muestren la vista previa del link sin ejecutar nada.
 *
 * @returns {{titulos:string[], descripciones:string[], sitio:string|null}}
 *   Ya sin repetidos: og:title casi siempre es el <title> sin el " - Sitio".
 */
export function sacarMetadatos(html) {
  const texto = String(html ?? '');
  const metas = {};
  for (const [etiqueta] of texto.matchAll(/<meta\b[^>]*>/gi)) {
    const atributos = leerAtributos(etiqueta);
    const clave = String(atributos.property || atributos.name || '').toLowerCase();
    // Gana la primera: si una pagina repite og:title, la segunda suele ser
    // de algo embebido y no de la pagina.
    if (!METAS_QUE_SIRVEN.has(clave) || metas[clave]) continue;
    const tope = clave === 'og:title' || clave === 'og:site_name' ? TOPE_TITULO_META : TOPE_DESCRIPCION_META;
    metas[clave] = textoPlano(decodificarEntidades(atributos.content), tope);
  }
  const tituloHtml = textoPlano(decodificarEntidades(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(texto)?.[1]), TOPE_TITULO_META);

  const titulos = sinRepetidos([tituloHtml, metas['og:title']]);
  const descripciones = sinRepetidos([metas.description, metas['og:description']])
    .filter((d) => !yaDicho(d, titulos));
  // El nombre del sitio solo si suma: en "Bobina de Tesla - Wikipedia" ya esta.
  const sitio = metas['og:site_name'] && !yaDicho(metas['og:site_name'], [...titulos, ...descripciones])
    ? metas['og:site_name']
    : null;

  return { titulos, descripciones, sitio };
}

/**
 * Los atributos de UNA etiqueta: <meta property="og:title" content="X"> ->
 * { property: 'og:title', content: 'X' }. Acepta comillas dobles, simples o
 * ninguna, y cualquier orden: hay sitios que ponen content antes que name.
 */
function leerAtributos(etiqueta) {
  const atributos = {};
  const patron = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const m of etiqueta.matchAll(patron)) {
    const nombre = m[1].toLowerCase();
    if (!(nombre in atributos)) atributos[nombre] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return atributos;
}

/** Un string de una sola linea, sin espacios de mas y con tope. '' si no es texto. */
function textoPlano(valor, tope) {
  if (typeof valor !== 'string') return '';
  return valor.replace(/\s+/g, ' ').trim().slice(0, tope);
}

/** Para comparar textos sin que importen las mayusculas ni los espacios. */
function normalizar(texto) {
  return String(texto ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** ¿`texto` ya esta dicho (contenido entero) en alguno de `lista`? */
function yaDicho(texto, lista) {
  const buscado = normalizar(texto);
  return lista.some((l) => normalizar(l).includes(buscado));
}

/**
 * Saca los vacios y los repetidos. "Repetido" incluye estar CONTENIDO en
 * otro: og:title "Bobina de Tesla" sobra si el <title> ya dice "Bobina de
 * Tesla - Wikipedia". De dos parecidos, se queda el mas completo.
 */
function sinRepetidos(textos) {
  const quedan = [];
  for (const t of textos) {
    if (!normalizar(t) || yaDicho(t, quedan)) continue;
    // Si el nuevo CONTIENE a uno de antes, el de antes sobra.
    const nuevo = normalizar(t);
    for (let i = quedan.length - 1; i >= 0; i--) {
      if (nuevo.includes(normalizar(quedan[i]))) quedan.splice(i, 1);
    }
    quedan.push(t);
  }
  return quedan;
}

/** "Titulo" -> "Titulo."; "¿Que es?" queda igual (y no "¿Que es?."). */
function conPunto(texto) {
  return /[.!?…]$/.test(texto) ? texto : `${texto}.`;
}

/**
 * ¿El cuerpo es ruido y no contenido? Cualquiera de los dos sintomas alcanza:
 *   - casi no tiene texto (menos de MINIMO_UTILES_CUERPO caracteres utiles);
 *   - es corto y huele a pie de pagina (el ©, "copyright", "derechos de autor").
 * Solo se usa cuando HAY metadatos para reemplazarlo (ver armarTexto).
 */
function esRuido(texto) {
  const utiles = caracteresUtiles(texto);
  if (utiles < MINIMO_UTILES_CUERPO) return true;
  return utiles < TOPE_UTILES_PIE && PISTAS_DE_PIE.test(texto);
}

/**
 * Convierte HTML en texto plano a mano, con expresiones regulares.
 *
 * POR QUE A MANO Y NO CON UNA LIBRERIA (cheerio, jsdom): son 5 MB de
 * dependencia para hacer esto, y jsdom ademas EJECUTA el JavaScript de la
 * pagina, o sea que le estariamos dando a un tercero permiso para correr
 * codigo en nuestro servidor. Con regex es peor para el HTML raro, pero para
 * sacar texto de un articulo alcanza y sobra, y no ejecuta nada de nadie.
 */
export function htmlATexto(html) {
  let t = String(html ?? '');

  // Lo primero: sacar todo lo que NO es contenido leible. Si no, el texto
  // del item termina lleno de codigo JavaScript y reglas CSS.
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<(script|style|noscript|template|svg|canvas|iframe)[\s\S]*?<\/\1>/gi, ' ');
  t = t.replace(/<(head|nav|footer|aside)[\s\S]*?<\/\1>/gi, ' ');

  // Las etiquetas que separan bloques se vuelven saltos de linea, asi el
  // troceado despues puede cortar por parrafo en vez de cortar cualquier cosa.
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre)>/gi, '\n');
  t = t.replace(/<li[^>]*>/gi, '\n- ');

  // Y ahora si, afuera todas las etiquetas que queden.
  t = t.replace(/<[^>]+>/g, ' ');

  t = decodificarEntidades(t);

  t = t.replace(/\r\n?/g, '\n');
  t = t.replace(/[ \t]+/g, ' ');
  t = t
    .split('\n')
    .map((l) => l.trim())
    .join('\n');
  t = t.replace(/\n{3,}/g, '\n\n');

  return t.trim();
}

/** Las entidades HTML mas comunes. Con estas alcanza para el 99% del texto. */
function decodificarEntidades(texto) {
  const tabla = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&aacute;': 'á',
    '&eacute;': 'é',
    '&iacute;': 'í',
    '&oacute;': 'ó',
    '&uacute;': 'ú',
    '&ntilde;': 'ñ',
    '&Ntilde;': 'Ñ',
    '&uuml;': 'ü',
    '&iquest;': '¿',
    '&iexcl;': '¡',
    '&hellip;': '…',
    '&mdash;': '—',
    '&ndash;': '–',
    '&laquo;': '«',
    '&raquo;': '»',
    '&euro;': '€',
    // &copy; no estaba, y el pie de YouTube llegaba con "&copy; 2026 Google
    // LLC" escrito asi, literal. Y sin el © decodificado, esRuido() no lo ve.
    '&copy;': '©',
    '&reg;': '®',
    '&trade;': '™',
    '&deg;': '°',
    '&ordm;': 'º',
    '&ordf;': 'ª',
    '&middot;': '·',
  };

  return String(texto ?? '')
    .replace(/&[a-zA-Z]+;|&#\d+;|&#x[0-9a-fA-F]+;/g, (entidad) => {
      const conocida = tabla[entidad] ?? tabla[entidad.toLowerCase()];
      if (conocida !== undefined) return conocida;
      // Entidades numericas: &#241; o &#xF1;
      const decimal = /^&#(\d+);$/.exec(entidad);
      if (decimal) return caracterDe(Number.parseInt(decimal[1], 10));
      const hexa = /^&#x([0-9a-fA-F]+);$/.exec(entidad);
      if (hexa) return caracterDe(Number.parseInt(hexa[1], 16));
      return entidad;
    });
}

// String.fromCodePoint TIRA un RangeError con un numero mas alla de Unicode
// (&#99999999;). Una pagina con eso, a proposito o por error, nos hacia
// fallar la extraccion entera. Un numero invalido se vuelve '�' (el
// rombito con el signo de pregunta) y la pagina sigue leyendose.
function caracterDe(numero) {
  return Number.isInteger(numero) && numero >= 0 && numero <= 0x10ffff
    ? String.fromCodePoint(numero)
    : '�';
}

// ============================================================
//  YOUTUBE: el titulo y el canal por oEmbed
// ============================================================
//
//  oEmbed es un estandar abierto para pedirle a un sitio los datos de un
//  contenido que se quiere "embeber" en otra pagina: titulo, autor y
//  miniatura. YouTube lo publica SIN CLAVE y contesta un JSON de 1 KB. Es la
//  forma oficial de saber como se llama un video sin ejecutar el JavaScript
//  de la pagina, que es donde vive todo lo demas.

const URL_OEMBED_YOUTUBE = 'https://www.youtube.com/oembed';

// Un id de video de YouTube son SIEMPRE 11 caracteres de [A-Za-z0-9_-]. Con
// una regex cerrada, la URL que armamos para el oEmbed nunca lleva basura
// escrita por el usuario.
const FORMATO_ID_DE_VIDEO = /^[A-Za-z0-9_-]{11}$/;

/**
 * Si la URL es de un video de YouTube devuelve su id; si no, null.
 * Entiende youtube.com/watch?v=ID, youtu.be/ID y youtube.com/shorts/ID (y
 * tambien /live/ID y /embed/ID, que tienen la misma forma).
 *
 * Se compara el hostname EXACTO (o que termine en ".youtube.com"): con un
 * includes('youtube'), "youtube.com.sitio-trucho.net" pasaria por YouTube.
 */
export function idDeVideoDeYoutube(textoUrl) {
  let url;
  try {
    url = new URL(String(textoUrl ?? '').trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    id = url.pathname === '/watch'
      ? url.searchParams.get('v')
      : /^\/(?:shorts|live|embed)\/([^/]+)/.exec(url.pathname)?.[1];
  }
  return id && FORMATO_ID_DE_VIDEO.test(id) ? id : null;
}

/**
 * ¿La pagina que devolvio YouTube es la de un video de verdad? La de un video
 * se titula "<nombre del video> - YouTube"; la generica (video borrado o
 * privado) se titula "- YouTube" a secas. Si al sacarle el " - YouTube" no
 * queda nada, no hay video.
 */
function esPaginaDeUnVideo(pagina) {
  if (pagina.tipo !== 'text/html') return false;
  return sacarMetadatos(pagina.cuerpo).titulos
    .some((t) => t.replace(/\s*-\s*YouTube\s*$/i, '').trim() !== '');
}

/**
 * Le pide al oEmbed de YouTube el titulo y el canal del video. Sale por
 * pedirSeguro() como cualquier otro pedido: misma validacion anti-SSRF, mismo
 * reloj, mismo tope de bytes, y solo acepta un JSON.
 *
 * @returns {Promise<{titulo:string, autor:string|null, url:string}>}
 */
async function datosDelVideo(id) {
  // La URL del video la armamos NOSOTROS con el id ya validado: al oEmbed no
  // le pasamos lo que escribio la persona.
  const urlVideo = `https://www.youtube.com/watch?v=${id}`;
  const { cuerpo } = await pedirSeguro(
    `${URL_OEMBED_YOUTUBE}?url=${encodeURIComponent(urlVideo)}&format=json`,
    { tiposAceptados: ['application/json'], accept: 'application/json' },
  );

  let datos;
  try {
    datos = JSON.parse(cuerpo);
  } catch {
    throw errorDeUrl('El oEmbed de YouTube no devolvió un JSON válido.');
  }

  // El JSON ya viene en texto plano: aca NO se decodifican entidades HTML.
  const titulo = textoPlano(datos?.title, TOPE_TITULO_META);
  if (!titulo) throw errorDeUrl('El oEmbed de YouTube no trajo el título del video.');
  return { titulo, autor: textoPlano(datos?.author_name, TOPE_TITULO_META) || null, url: urlVideo };
}
