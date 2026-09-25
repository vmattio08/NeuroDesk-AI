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
// ============================================================

import dns from 'node:dns/promises';

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
//  TRAER EL TEXTO
// ============================================================

/**
 * Descarga una pagina publica y devuelve su texto plano.
 *
 * @param {string} textoUrl
 * @returns {Promise<{texto:string, titulo:string|null, origen:'link', urlFinal:string, caracteres:number}>}
 *
 * LIMITACION CONOCIDA (hay que saber decirla): validamos el DNS y despues
 * fetch vuelve a resolver el nombre por su cuenta. Entre una cosa y la otra,
 * un atacante con su propio servidor DNS podria devolver una IP publica en la
 * primera consulta y una privada en la segunda ("DNS rebinding"). Taparlo del
 * todo obliga a hacer la conexion a mano con sockets y a mandar el Host a
 * mano, que es mucho para el alcance del TP. Con el timeout corto, el tope de
 * bytes y el filtro de Content-Type, la ventana que queda es muy chica.
 */
export async function traerTextoDeUrl(textoUrl) {
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
          Accept: 'text/html,text/plain;q=0.9',
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

  // --- Content-Type: solo texto --------------------------------------------
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  const tipo = contentType.split(';')[0].trim();
  if (!TIPOS_ACEPTADOS.includes(tipo)) {
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
  let html;
  try {
    html = new TextDecoder(charset, { fatal: false }).decode(crudo);
  } catch {
    html = new TextDecoder('utf-8', { fatal: false }).decode(crudo);
  }

  const titulo = tipo === 'text/html' ? sacarTitulo(html) : null;
  const texto = tipo === 'text/html' ? htmlATexto(html) : html;

  if (texto.replace(/\s+/g, '').length < 20) {
    // La pagina cargo pero no tiene texto: casi siempre es una app hecha toda
    // en JavaScript, que sin navegador no renderiza nada.
    throw fallo(
      'NO_SE_PUDO_EXTRAER_TEXTO',
      'No pudimos leer el texto de esa página. Probá copiando el contenido en una nota.',
      422,
      'La página no tiene texto plano (probablemente se arma con JavaScript).',
    );
  }

  return {
    texto,
    titulo,
    origen: 'link',
    urlFinal: url.toString(),
    caracteres: texto.length,
  };
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
  };

  return String(texto ?? '')
    .replace(/&[a-zA-Z]+;|&#\d+;|&#x[0-9a-fA-F]+;/g, (entidad) => {
      const conocida = tabla[entidad] ?? tabla[entidad.toLowerCase()];
      if (conocida !== undefined) return conocida;
      // Entidades numericas: &#241; o &#xF1;
      const decimal = /^&#(\d+);$/.exec(entidad);
      if (decimal) return String.fromCodePoint(Number.parseInt(decimal[1], 10));
      const hexa = /^&#x([0-9a-fA-F]+);$/.exec(entidad);
      if (hexa) return String.fromCodePoint(Number.parseInt(hexa[1], 16));
      return entidad;
    });
}
