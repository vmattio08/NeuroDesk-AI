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
//      app-release.apk, SI existe    ->  sitio/descargas/neurodesk.apk
//  y al final muestra cada archivo con su tamaño y el total.
//
//  POR QUE SE ARMA Y NO SE PUBLICA landing/ DIRECTO: Hosting publica UNA sola
//  carpeta, y lo nuestro vive en tres lugares (la landing y el panel en el
//  repo, el APK en la salida de Flutter, que ni siquiera va a git). sitio/ es
//  un resultado, como app/build/: esta en el .gitignore y se puede borrar
//  cuando quieras, porque este script lo vuelve a armar igual.
//
//  LA REGLA QUE NO SE NEGOCIA: lo que sube a Hosting lo puede bajar cualquiera.
//    1. Solo se lee de landing/, de panel/ y de la ruta exacta del APK.
//    2. Solo pasan las extensiones de una pagina web (EXTENSIONES_WEB). El
//       resto queda afuera y el resumen lo muestra.
//    3. Si aparece algo con cara de secreto (.env, la service account, una
//       clave de firma), se CORTA con error: sitio/ no se toca y el deploy no
//       sale.
//  Por eso primero se decide TODO y recien despues se borra y se copia.
//
//  Sin dependencias: solo modulos que trae Node (22 o mas nuevo).
// ============================================================================

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// La raiz (fase2/) sale de donde esta ESTE archivo y no de la carpeta desde la
// que se lo llama: da lo mismo correrlo desde fase2/, desde scripts/ o que lo
// corra firebase deploy.
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LANDING = path.join(RAIZ, 'landing');
const PANEL = path.join(RAIZ, 'panel');
const APK = path.join(RAIZ, 'app', 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk');
const SITIO = path.join(RAIZ, 'sitio');

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

// Nombres con cara de secreto: los mismos que ignora el .gitignore, mas las
// claves con las que se firma el APK. Si aparece uno, no se publica NADA.
const CARA_DE_SECRETO = [
  /^\.env/i,                        // .env, .env.local, .env.example
  /\.env$/i,                        // produccion.env
  /firebase-adminsdk/i,             // el nombre que le pone Firebase a la service account
  /service-?account/i,              // serviceAccountKey.json, mi-service-account.json
  /\.(pem|key|p12|jks|keystore)$/i  // claves privadas y keystores de Android
];

// Las carpetas que ocupan el panel y el APK adentro de sitio/. Si landing/
// trajera una con el mismo nombre, se pisarian sin que nadie se entere.
const RESERVADAS = { panel: 'del panel', descargas: 'del APK' };


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
// recorrer()  —  mira una carpeta entera y decide archivo por archivo, SIN
// copiar nada todavia. Lo que se publica va a `plan`; lo que queda afuera, a
// `omitidos` con el motivo, para que el resumen no esconda nada.
// ----------------------------------------------------------------------------
async function recorrer(origen, destino, plan, omitidos) {
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
      await recorrer(desde, hacia, plan, omitidos);
      continue;
    }
    if (!entrada.isFile()) continue;

    const extension = path.extname(entrada.name).toLowerCase();
    if (extension === '.md') {
      omitidos.push([ruta, 'documentación interna']);
      continue;
    }
    if (!EXTENSIONES_WEB.has(extension)) {
      omitidos.push([ruta, `${extension || 'sin extensión'}: no está en la lista de archivos web`]);
      continue;
    }
    plan.push({ desde, hacia });
  }
}


async function armar() {
  console.log('Armando sitio/ (landing/ + panel/ + APK si existe)...');

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
  await recorrer(LANDING, SITIO, plan, omitidos);
  await recorrer(PANEL, path.join(SITIO, 'panel'), plan, omitidos);

  const apk = (await existe(APK)) ? await stat(APK) : null;
  if (apk) {
    plan.push({ desde: APK, hacia: path.join(SITIO, 'descargas', 'neurodesk.apk') });
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

  if (apk) {
    const mb = apk.size / 1024 / 1024;
    const cuando = apk.mtime.toLocaleString('es-AR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    });
    // El cupo gratis de Hosting (sin plan Blaze) es de 10 GB de transferencia
    // por mes, y cada descarga del APK lo gasta entero. Pasado el cupo,
    // Firebase deshabilita el sitio hasta el mes siguiente: mejor saberlo.
    console.log(`\nAPK: app-release.apk del ${cuando} -> /descargas/neurodesk.apk`);
    console.log(`  Cada descarga gasta ${numero.format(mb)} MB de los 10 GB por mes que Hosting da gratis`
      + ` (entran unas ${Math.floor((10 * 1024) / mb)} descargas por mes).`);
  } else {
    console.log('\nAPK: no hay app/build/app/outputs/flutter-apk/app-release.apk, así que no se publica.');
    console.log('  La landing lo detecta y muestra "Pedí acceso a la beta".'
      + ' Para sumarlo: flutter build apk --release (en app/) y volver a armar.');
  }
}


armar().catch((error) => {
  console.error(`\nNo se armó el sitio: ${error.message}`);
  // exitCode y no process.exit(): deja terminar de escribir la consola. Con
  // un codigo distinto de 0, firebase deploy corta y no publica nada.
  process.exitCode = 1;
});
