// ============================================================================
//  NeuroDesk AI — api/src/firebase.js
//  Arranque de firebase-admin. Es el UNICO archivo del backend que toca las
//  credenciales: todos los demas importan { db, auth } de aca.
//
//  POR QUE LA SERVICE ACCOUNT VIENE EN BASE64 (FIREBASE_SERVICE_ACCOUNT_B64):
//  el JSON de la service account tiene un campo "private_key" que adentro trae
//  saltos de linea de verdad. Cuando eso se pega en el panel de variables de
//  entorno de Render, los \n se convierten en la cadena literal "\\n" y
//  firebase-admin explota con "Failed to parse private key". La vuelta que
//  todos terminan haciendo es .replace(/\\n/g, '\n'), que funciona a veces y
//  se rompe en cuanto la clave tiene una barra invertida de verdad.
//  Codificando el JSON ENTERO en base64 el problema no existe: base64 no tiene
//  saltos de linea, ni comillas, ni barras. Se genera una vez con:
//    [Convert]::ToBase64String([IO.File]::ReadAllBytes("serviceAccountKey.json"))
//
//  EL ADMIN SDK IGNORA LAS REGLAS DE FIRESTORE. Todo lo que se escribe desde
//  aca pasa por arriba de firestore.rules. Por eso cada endpoint tiene que
//  verificar el token Y leer members/{uid} a mano: las reglas no nos cubren.
// ============================================================================

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// ----------------------------------------------------------------------------
// Leer y validar la credencial. Si algo falta preferimos MORIR EN EL ARRANQUE
// con un mensaje claro, y no levantar un servidor que responde 500 en cada
// pedido: un backend que arranca "a medias" es la peor forma de fallar, porque
// UptimeRobot lo ve verde y nosotros no nos enteramos hasta la demo.
// ----------------------------------------------------------------------------
function leerServiceAccount() {
  const b64 = (process.env.FIREBASE_SERVICE_ACCOUNT_B64 || '').trim();
  if (!b64) return null;

  let json;
  try {
    json = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_B64 no es base64 valido. Volvé a generarla con [Convert]::ToBase64String(...).'
    );
  }

  let cuenta;
  try {
    cuenta = JSON.parse(json);
  } catch {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_B64 decodifica pero no es un JSON valido. ' +
      'Lo mas comun: se copio la variable cortada (el panel de Render recorta si hay espacios o saltos).'
    );
  }

  for (const campo of ['project_id', 'client_email', 'private_key']) {
    if (!cuenta[campo]) {
      throw new Error(`A la service account le falta el campo "${campo}". Bajá el JSON de nuevo desde la consola de Firebase.`);
    }
  }
  return cuenta;
}

// ----------------------------------------------------------------------------
// Inicializacion. getApps().length evita el error "The default Firebase app
// already exists": con `node --watch` el modulo se puede recargar y sin este
// chequeo el segundo arranque se cae.
// ----------------------------------------------------------------------------
function inicializar() {
  if (getApps().length > 0) return getApps()[0];

  const cuenta = leerServiceAccount();

  if (cuenta) {
    return initializeApp({
      credential: cert(cuenta),
      // El projectId explicito es a proposito: si algun dia la variable de
      // entorno apunta a otro proyecto que el JSON, queremos enterarnos
      // comparando estas dos lineas y no debuggeando por que "no aparecen los
      // datos" (estarian en el otro proyecto).
      projectId: process.env.FIREBASE_PROJECT_ID || cuenta.project_id,
    });
  }

  // Sin service account SOLO se puede arrancar contra el emulador, que no pide
  // credenciales. Es el modo que usan los tests de reglas (npm run test:rules).
  const conEmulador =
    process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST;

  if (conEmulador) {
    const projectId = process.env.FIREBASE_PROJECT_ID || 'demo-neurodesk';
    console.warn(
      `[firebase] Sin FIREBASE_SERVICE_ACCOUNT_B64: arranco contra el EMULADOR (proyecto ${projectId}). ` +
      'Esto NUNCA tiene que pasar en produccion.'
    );
    return initializeApp({ projectId });
  }

  throw new Error(
    'Falta FIREBASE_SERVICE_ACCOUNT_B64. Sin eso el backend no puede hablar con Firestore. ' +
    'En local: copiá .env.example a .env y completala. En Render: Settings > Environment.'
  );
}

const app = inicializar();

// ----------------------------------------------------------------------------
// Los dos objetos que usa todo el resto del backend.
//
// NO ponemos db.settings({ ignoreUndefinedProperties: true }) a proposito: con
// esa opcion, si escribimos { paginas: undefined } por un bug, el campo
// desaparece en silencio y el panel muestra un guion sin que nadie se entere.
// Preferimos que Firestore tire el error y que el bug salte en desarrollo.
// Cuando un campo tiene que ir vacio, se escribe null EXPLICITO (asi lo pide
// el modelo de datos: paginas, errorMsg y workspaceActual son `X | null`).
// ----------------------------------------------------------------------------
export const db = getFirestore(app);
export const auth = getAuth(app);

// Se reexportan para que ningun otro archivo tenga que importar de
// 'firebase-admin/firestore' por su cuenta. FieldValue.serverTimestamp() es
// obligatorio en TODOS los timestamps (invariante 17 del modelo): la hora la
// pone el servidor, nunca Date.now() ni el reloj del celular.
export { FieldValue, Timestamp };

// Datos utiles para el log de arranque y para /salud.
export const proyectoId = app.options.projectId || 'desconocido';
