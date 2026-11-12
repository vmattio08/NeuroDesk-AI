// ============================================================================
//  armar-sitio.mjs  —  arma sitio/, la carpeta que publica Firebase Hosting.
//  NeuroDesk AI, fase 2.
//
//  Uso, desde fase2/:     node scripts/armar-sitio.mjs
//  Ademas lo corre SOLO `firebase deploy --only hosting` antes de subir nada
//  (es el "predeploy" de firebase.json): nunca se publica un sitio viejo.
//
//  QUE ARMA, y nada mas:
//      landing/                      ->  sitio/                       la pagina publica
//      panel/   (sin el README.md)   ->  sitio/panel/                 el panel del admin
//      app/build/web/  (si existe)   ->  sitio/app/                   la app en la web
//  y al final muestra cada archivo con su tamaño y el total.
//
//  LA APP EN LA WEB: es la MISMA app Flutter, compilada para el navegador con
//      cd app && flutter build web --base-href /app/
//  ("Probala gratis" de la landing lleva ahi). Si app/build/web no existe, el
//  sitio se arma igual sin ella y el resumen lo dice: la landing y el panel no
//  tienen por que esperar a la app. Si existe pero esta compilada para otra
//  ruta (base href distinto de /app/), se CORTA: publicarla asi deja una
//  pagina en blanco, y es mejor no publicar nada que publicar algo roto.
//
//  EL APK NO VA ACA: Hosting en el plan gratis (Spark) rechaza los archivos
//  ejecutables ("Executable files are forbidden on the Spark billing plan") y
//  el deploy entero falla. Se publica como release de GitHub
//  (gh release create ... neurodesk.apk) y la landing apunta ahi (descarga.js).
//
//  POR QUE SE ARMA Y NO SE PUBLICA landing/ DIRECTO: Hosting publica UNA sola
//  carpeta, y lo nuestro vive en tres lugares (la landing y el panel en el
//  repo, la app web en la salida de Flutter, que ni siquiera va a git). sitio/ es
//  un resultado, como app/build/: esta en el .gitignore y se puede borrar
//  cuando quieras, porque este script lo vuelve a armar igual.
//
//  LA REGLA QUE NO SE NEGOCIA: lo que sube a Hosting lo puede bajar cualquiera.
//    1. Solo se lee de landing/, de panel/, de app/build/web/ y de la ruta
//       exacta del APK.
//    2. Solo pasan las extensiones de una pagina web (EXTENSIONES_WEB). La
//       app web tiene su PROPIA lista (EXTENSIONES_APP), un poco mas ancha,
//       porque Flutter trae archivos que una pagina hecha a mano no (.wasm,
//       .json, fuentes .otf/.ttf...). El resto queda afuera y el resumen lo
//       muestra. Un ejecutable no pasa nunca (Hosting gratis lo rechaza).
//    3. Si aparece algo con cara de secreto (.env, la service account, una
//       clave de firma, un .json de la app con una clave privada adentro), se
//       CORTA con error: sitio/ no se toca y el deploy no sale.
//  Por eso primero se decide TODO y recien despues se borra y se copia.
//
//  Sin dependencias: solo modulos que trae Node (22 o mas nuevo).
// ============================================================================

import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// La raiz (fase2/) sale de donde esta ESTE archivo y no de la carpeta desde la
// que se lo llama: da lo mismo correrlo desde fase2/, desde scripts/ o que lo
// corra firebase deploy.
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LANDING = path.join(RAIZ, 'landing');
const PANEL = path.join(RAIZ, 'panel');
const APK = path.join(RAIZ, 'app', 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk');
const APP_WEB = path.join(RAIZ, 'app', 'build', 'web');
const SITIO = path.join(RAIZ, 'sitio');

// La ruta donde vive la app en el sitio. Tiene que coincidir con el
// --base-href con el que se compilo (ver revisarAppWeb) y con los links de la
// landing ("Probala gratis" -> /app/).
const RUTA_APP = '/app/';

// Lo unico que puede tener una pagina web. Afuera, a proposito:
//   .json -> la service account de Firebase es un .json;
//   .md   -> son documentos internos (README, notas);
//   .txt  -> el lugar clasico donde alguien pega una clave "un ratito".
// Si algun dia la landing necesita otro tipo de archivo, se agrega aca a
// conciencia, no "por las dudas".
const EXTENSIONES_WEB = new Set([
  '.html', '.css', '.js', '.mjs',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif', '.ico',
  '.woff', '.woff2', '.webmanifest'
]);

// La lista de la APP WEB (solo para app/build/web): lo de arriba, mas lo que
// trae `flutter build web` y una pagina hecha a mano no. Cada uno, por que:
//   .json     version.json, manifest.json, assets/AssetManifest.json y
//             FontManifest.json: sin ellos la app no sabe que assets tiene.
//             Es la extension de la service account: por eso cada .json de la
//             app se abre y se revisa que no traiga una clave (tieneClave).
//   .wasm     canvaskit/skwasm: el motor que dibuja la app en el navegador.
//   .symbols  los nombres del motor, para que un error se pueda leer.
//   .otf .ttf las fuentes y los iconos (MaterialIcons, CupertinoIcons).
//   .frag     los shaders de los efectos (el "ripple" al tocar un boton).
//   .bin      assets/AssetManifest.bin: la lista de assets, en binario.
// Y un solo archivo sin extension: assets/NOTICES, las licencias de los
// paquetes que usa la app (Flutter lo genera y la app lo muestra).
const EXTENSIONES_APP = new Set([
  ...EXTENSIONES_WEB,
  '.json', '.wasm', '.symbols', '.otf', '.ttf', '.frag', '.bin'
]);
const SIN_EXTENSION_APP = new Set(['NOTICES']);

// Las reglas de cada carpeta, para recorrer().
const REGLAS_WEB = { extensiones: EXTENSIONES_WEB, sinExtension: new Set(), revisarJson: false };
const REGLAS_APP = { extensiones: EXTENSIONES_APP, sinExtension: SIN_EXTENSION_APP, revisarJson: true };

// Ejecutables: NUNCA pasan, en ninguna carpeta. Hosting en el plan gratis
// rechaza el deploy ENTERO si encuentra uno (ya paso con el .apk). Ninguno
// esta en las listas de arriba, asi que igual quedarian afuera: esta lista es
// para que el resumen diga el motivo real y nadie lo "arregle" agregando la
// extension a una lista.
const EXTENSIONES_EJECUTABLES = new Set([
  '.apk', '.aab', '.ipa', '.exe', '.dll', '.msi', '.bat', '.cmd', '.com',
  '.sh', '.ps1', '.jar', '.so', '.dylib', '.deb', '.dmg'
]);

// Nombres con cara de secreto: los mismos que ignora el .gitignore, mas las
// claves con las que se firma el APK. Si aparece uno, no se publica NADA.
const CARA_DE_SECRETO = [
  /^\.env/i,                        // .env, .env.local, .env.example
  /\.env$/i,                        // produccion.env
  /firebase-adminsdk/i,             // el nombre que le pone Firebase a la service account
  /service-?account/i,              // serviceAccountKey.json, mi-service-account.json
  /client_secret/i,                 // client_secret_xxx.json: el secreto de un cliente OAuth de Google
  /\.(pem|key|p12|jks|keystore)$/i  // claves privadas y keystores de Android
];

// Las carpetas que ocupan el panel, la app y el APK adentro de sitio/. Si
// landing/ trajera una con el mismo nombre, se pisarian sin que nadie se entere.
const RESERVADAS = { panel: 'del panel', app: 'de la app web', descargas: 'del APK' };


async function existe(ruta) {
  try {
    await stat(ruta);
    return true;
  } catch {
    return false;
  }
}

// Ruta para mostrar: relativa a fase2/ (o a sitio/) y con "/", tambien en Windows.
function mostrar(ruta, base = RAIZ) {
  return path.relative(base, ruta).split(path.sep).join('/');
}

const numero = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });

// Desde 1000 KB ya se muestra en MB, para que la columna quede alineada.
function tamano(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1000 * 1024) return `${numero.format(bytes / 1024)} KB`;
  return `${numero.format(bytes / 1024 / 1024)} MB`;
}


// ----------------------------------------------------------------------------
// tieneClave()  —  ¿este .json trae una clave privada adentro?
//
// En la landing y el panel los .json no pasan, y listo. En la app web SI
// tienen que pasar (ver EXTENSIONES_APP), y el nombre no alcanza: una service
// account renombrada "config.json" pasaria el filtro de CARA_DE_SECRETO. Por
// eso se mira lo de adentro: toda service account de Google trae
// "private_key", y toda clave en texto, el "-----BEGIN ... PRIVATE KEY".
// Los .json de un build de Flutter pesan unos KB: leerlos no cuesta nada.
// ----------------------------------------------------------------------------
async function tieneClave(archivo) {
  const texto = await readFile(archivo, 'utf8');
  return /"private_key"\s*:/.test(texto) || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(texto);
}


// ----------------------------------------------------------------------------
// recorrer()  —  mira una carpeta entera y decide archivo por archivo, SIN
// copiar nada todavia. Lo que se publica va a `plan`; lo que queda afuera, a
// `omitidos` con el motivo, para que el resumen no esconda nada. `reglas` dice
// que extensiones pasan en ESTA carpeta (REGLAS_WEB o REGLAS_APP).
// ----------------------------------------------------------------------------
async function recorrer(origen, destino, plan, omitidos, reglas = REGLAS_WEB) {
  const entradas = await readdir(origen, { withFileTypes: true });
  entradas.sort((a, b) => a.name.localeCompare(b.name));   // mismo orden en todas las PCs

  for (const entrada of entradas) {
    const desde = path.join(origen, entrada.name);
    const hacia = path.join(destino, entrada.name);
    const ruta = mostrar(desde);

    if (CARA_DE_SECRETO.some((patron) => patron.test(entrada.name))) {
      throw new Error(`${ruta} tiene cara de secreto. No se publica nada hasta sacarlo de ahí.`);
    }
    // Un acceso directo (symlink o junction de Windows) puede apuntar a
    // cualquier lado del disco, incluida la carpeta del backend: no se sigue.
    if (entrada.isSymbolicLink()) {
      omitidos.push([ruta, 'es un acceso directo']);
      continue;
    }
    if (entrada.name.startsWith('.')) {
      omitidos.push([ruta, 'archivo oculto']);
      continue;
    }
    if (entrada.isDirectory()) {
      if (entrada.name === 'node_modules') {
        omitidos.push([ruta + '/', 'dependencias']);
        continue;
      }
      await recorrer(desde, hacia, plan, omitidos, reglas);
      continue;
    }
    if (!entrada.isFile()) continue;

    const extension = path.extname(entrada.name).toLowerCase();
    if (extension === '.md') {
      omitidos.push([ruta, 'documentación interna']);
      continue;
    }
    if (EXTENSIONES_EJECUTABLES.has(extension)) {
      omitidos.push([ruta, `${extension}: es un ejecutable y Hosting gratis lo rechaza`]);
      continue;
    }
    // Sin extension pasa SOLO un nombre exacto de la lista (NOTICES en la
    // app). Comparar el nombre entero, y no "no tiene punto", es lo que deja
    // afuera un "id_rsa" o un "clave" sueltos.
    const pasa = extension
      ? reglas.extensiones.has(extension)
      : reglas.sinExtension.has(entrada.name);
    if (!pasa) {
      omitidos.push([ruta, `${extension || 'sin extensión'}: no está en la lista de archivos web`]);
      continue;
    }
    if (reglas.revisarJson && extension === '.json' && await tieneClave(desde)) {
      throw new Error(`${ruta} tiene una clave privada adentro. No se publica nada hasta sacarlo de ahí.`);
    }
    plan.push({ desde, hacia });
  }
}


// ----------------------------------------------------------------------------
// revisarAppWeb()  —  ¿hay una app web para publicar, y esta bien compilada?
//
//   - No hay app/build/web: no es un error. Se arma sin la app y se avisa
//     (devuelve false).
//   - Hay carpeta pero no index.html: un build a medias (se corto, o alguien
//     borro a mano). Se CORTA.
//   - El <base href> no es /app/: Flutter pide main.dart.js, los .wasm y los
//     assets relativos a ese base. Compilada con el "/" de siempre, en /app/
//     buscaria todo en la raiz del sitio y quedaria una pagina en blanco. Se
//     CORTA, con el comando para arreglarlo.
//   - Si el index.html no tiene <base> (alguien lo saco de app/web/), los
//     pedidos son relativos y en /app/ andan: pasa.
// ----------------------------------------------------------------------------
async function revisarAppWeb() {
  if (!(await existe(APP_WEB))) return false;

  const indice = path.join(APP_WEB, 'index.html');
  if (!(await existe(indice))) {
    throw new Error('app/build/web existe pero no tiene index.html: parece un build a medias. '
      + `Volvé a compilarla: cd app && flutter build web --base-href ${RUTA_APP}`);
  }

  // Sin los comentarios: el index.html de app/web/ explica el base href en un
  // comentario, y un ejemplo ahi adentro no es el base de verdad.
  const html = (await readFile(indice, 'utf8')).replace(/<!--[\s\S]*?-->/g, '');
  const base = /<base\s[^>]*href\s*=\s*["']([^"']*)["']/i.exec(html);
  if (base && base[1] !== RUTA_APP) {
    throw new Error(`app/build/web está compilada para «${base[1]}» y se publica en «${RUTA_APP}»: `
      + `quedaría en blanco. Volvé a compilarla: cd app && flutter build web --base-href ${RUTA_APP}`);
  }
  return true;
}


async function armar() {
  console.log('Armando sitio/ (landing/ + panel/ + la app web si está)...');

  // -- 1. Lo minimo para que tenga sentido publicar ------------------------
  // Lo de firebase.json es para no borrar nunca una carpeta "sitio" que no sea
  // la nuestra (por ejemplo, si alguien copia este script a otro proyecto).
  if (!(await existe(path.join(RAIZ, 'firebase.json')))) {
    throw new Error(`${RAIZ} no tiene firebase.json: no parece la carpeta fase2/.`);
  }
  if (!(await existe(path.join(LANDING, 'index.html')))) {
    throw new Error('falta landing/index.html (sin landing no hay página principal).');
  }
  if (!(await existe(path.join(PANEL, 'index.html')))) {
    throw new Error('falta panel/index.html.');
  }
  for (const [carpeta, duenio] of Object.entries(RESERVADAS)) {
    if (await existe(path.join(LANDING, carpeta))) {
      throw new Error(`landing/${carpeta} pisaría sitio/${carpeta}/, que es ${duenio}. Cambiale el nombre.`);
    }
  }

  // -- 2. Decidir TODO antes de tocar sitio/ -------------------------------
  const plan = [];
  const omitidos = [];
  await recorrer(LANDING, SITIO, plan, omitidos, REGLAS_WEB);
  await recorrer(PANEL, path.join(SITIO, 'panel'), plan, omitidos, REGLAS_WEB);

  // La app va ULTIMA y con su propia lista. Si algo de adentro tiene cara de
  // secreto, recorrer() corta aca, todavia antes de borrar sitio/.
  const hayAppWeb = await revisarAppWeb();
  const desdeApp = plan.length;
  if (hayAppWeb) {
    await recorrer(APP_WEB, path.join(SITIO, 'app'), plan, omitidos, REGLAS_APP);
  }

  // -- 3. Recien ahora: borrar y copiar ------------------------------------
  // maxRetries: en Windows, si el emulador justo tiene un archivo abierto, el
  // borrado falla una vez con EBUSY y al reintentar anda.
  await rm(SITIO, { recursive: true, force: true, maxRetries: 3 });
  let total = 0;
  try {
    for (const archivo of plan) {
      await mkdir(path.dirname(archivo.hacia), { recursive: true });
      await copyFile(archivo.desde, archivo.hacia);
      archivo.bytes = (await stat(archivo.hacia)).size;
      total += archivo.bytes;
    }
  } catch (error) {
    // Un sitio a medio copiar no se deja: el emulador lo serviria igual.
    await rm(SITIO, { recursive: true, force: true, maxRetries: 3 });
    throw new Error(`falló la copia (${error.message}); se borró sitio/ para no dejarlo a medio armar.`);
  }

  // -- 4. Resumen ----------------------------------------------------------
  console.log(`\nListo: ${SITIO}\n`);
  for (const archivo of plan) {
    console.log(`  ${tamano(archivo.bytes).padStart(9)}  ${mostrar(archivo.hacia, SITIO)}`);
  }
  console.log(`  ${tamano(total).padStart(9)}  en total, ${plan.length} archivos`);

  if (omitidos.length > 0) {
    console.log('\nQuedan afuera (no se publican):');
    for (const [ruta, motivo] of omitidos) console.log(`  ${ruta}  (${motivo})`);
  }

  // La app web, aparte: es lo que mas cambia de un deploy a otro y lo que
  // primero hay que mirar si "Probala gratis" no abre.
  if (hayAppWeb) {
    const archivosApp = plan.slice(desdeApp);
    const bytesApp = archivosApp.reduce((suma, archivo) => suma + archivo.bytes, 0);
    console.log(`\nApp web: ${archivosApp.length} archivos (${tamano(bytesApp)}) en sitio${RUTA_APP}.`);
  } else {
    console.log('\nApp web: NO se publica, porque no está app/build/web.'
      + ` La landing manda a ${RUTA_APP} («Probala gratis») y sin la app ese link da 404.`
      + ` Para sumarla: cd app && flutter build web --base-href ${RUTA_APP}  y volvé a armar.`);
  }

  if (await existe(APK)) {
    console.log('\nAPK: no se copia a sitio/ (Hosting gratis no acepta ejecutables).'
      + ' Si es nuevo, subilo como release de GitHub: gh release upload <tag> neurodesk.apk --clobber');
  }
}


armar().catch((error) => {
  console.error(`\nNo se armó el sitio: ${error.message}`);
  // exitCode y no process.exit(): deja terminar de escribir la consola. Con
  // un codigo distinto de 0, firebase deploy corta y no publica nada.
  process.exitCode = 1;
});
