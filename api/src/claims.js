// ============================================================================
//  NeuroDesk AI — api/src/claims.js
//  LA RUTINA UNICA DE SINCRONIZACION DE CUSTOM CLAIMS.
//
//  QUE ES UN CUSTOM CLAIM: un pedacito de JSON que Firebase firma y mete
//  ADENTRO del ID token. Nosotros guardamos { ws: { "<wsId>": "admin"|"miembro" } }.
//  Las reglas de firestore.rules leen ese claim (request.auth.token.ws) y por eso
//  no necesitan hacer get() de ningun documento: cada get() en una regla es una
//  lectura facturada y hay un tope de 10 por request.
//
//  LOS TRES PROBLEMAS QUE RESUELVE ESTE ARCHIVO (van en la defensa oral):
//
//  1) setCustomUserClaims() PISA TODO. No mergea: lo que le mandas reemplaza el
//     claim entero. Entonces "leer el claim viejo, agregarle una clave y volver
//     a escribirlo" es una carrera: si dos admins invitan a la misma persona en
//     el mismo minuto, el segundo escribe lo que leyo ANTES de que el primero
//     guardara, y esa persona pierde el acceso a un workspace EN SILENCIO
//     (nadie ve un error; simplemente un dia no puede entrar).
//     Solucion: el claim NUNCA se lee. Se RECONSTRUYE ENTERO desde
//     usuarios/{uid}.workspaces, que es la unica fuente de verdad, y el alta o
//     la baja sobre ese mapa se aplica adentro de una runTransaction() (que SI
//     reintenta sola si alguien escribio en el medio).
//
//  2) EL TOKEN DURA 1 HORA. Cambiarle el claim a alguien no le cambia el token
//     que ya tiene en la mano. Por eso, en la MISMA transaccion, escribimos
//     'claimsActualizadoEn'. El cliente escucha su propio doc usuarios/{uid}
//     con onSnapshot y, cuando ese campo cambia, llama a getIdToken(true) y
//     saca un token nuevo con el claim nuevo. Sin ese campo, el rol nuevo
//     tardaria hasta 60 minutos en verse (invariante 14 del modelo).
//
//  3) EL DOC DEL USUARIO PUEDE NO EXISTIR. Cuando un admin invita por email a
//     alguien que se registro en Auth pero cuyo POST /v1/auth/registro fallo
//     (Render dormido, la app se cerro), usuarios/{uid} no esta. Como las
//     reglas tienen `allow create: if false`, ese doc solo lo puede crear el
//     backend. Aca se crea de forma idempotente adentro de la transaccion.
// ============================================================================

import { db, auth, FieldValue } from './firebase.js';
import { fallar } from './errores.js';

// Tope duro de Firebase: el claim entero no puede pasar los 1000 bytes.
// Dejamos margen porque el token lleva mas cosas nuestras a futuro.
const TOPE_BYTES_DEL_CLAIM = 900;

// El nombre tiene que medir de 2 a 60 caracteres. EXACTAMENTE ese rango en el
// modelo, en el contrato y en firestore.rules (invariante 22). Si lo cambiamos
// aca hay que cambiarlo en los tres lados.
const NOMBRE_MIN = 2;
const NOMBRE_MAX = 60;

/**
 * Arma un nombre presentable a partir de lo que haya en Firebase Auth.
 * Se usa SOLO cuando hay que crear usuarios/{uid} de apuro (caso 3 de arriba):
 * el nombre "de verdad" lo manda la persona en POST /v1/auth/registro.
 */
export function nombrePresentable(usuarioAuth) {
  const candidato =
    (usuarioAuth.displayName || '').trim() ||
    (usuarioAuth.email || '').split('@')[0] ||
    'Sin nombre';
  // Recortamos al maximo y, si quedo demasiado corto (un mail tipo "a@x.com"),
  // lo completamos: un nombre de 1 caracter no pasaria la regla de Firestore y
  // despues el cliente no podria editarlo nunca.
  const recortado = candidato.slice(0, NOMBRE_MAX);
  return recortado.length >= NOMBRE_MIN ? recortado : `Usuario ${recortado}`.slice(0, NOMBRE_MAX);
}

/**
 * Convierte el mapa rico que vive en el documento
 *     { wsId: { rol: 'admin', nombre: 'Kiosco Central' } }
 * en el mapa flaco que va adentro del token
 *     { wsId: 'admin' }
 * En el token va SOLO el rol: el nombre del workspace ocuparia lugar del
 * presupuesto de 1000 bytes y no sirve para autorizar nada.
 */
function mapaParaElClaim(workspaces) {
  const flaco = {};
  for (const [wsId, entrada] of Object.entries(workspaces)) {
    // Un documento roto (una entrada sin rol) NO se vuelve admin por omision:
    // se la saltea. Fail-closed tambien aca.
    const rol = entrada && typeof entrada === 'object' ? entrada.rol : entrada;
    if (rol === 'admin' || rol === 'miembro') flaco[wsId] = rol;
  }
  return flaco;
}

/** Compara dos mapas flacos. Sirve para la vuelta de control del final. */
function mismoMapa(a, b) {
  const clavesA = Object.keys(a).sort();
  const clavesB = Object.keys(b).sort();
  if (clavesA.length !== clavesB.length) return false;
  return clavesA.every((k, i) => k === clavesB[i] && a[k] === b[k]);
}

/** Escribe el claim ENTERO. Nunca mergea contra el claim viejo (problema 1). */
async function escribirClaim(uid, workspaces) {
  const ws = mapaParaElClaim(workspaces);
  const bytes = Buffer.byteLength(JSON.stringify({ ws }), 'utf8');
  if (bytes > TOPE_BYTES_DEL_CLAIM) {
    // Si esto salta, la persona esta en demasiados workspaces. Es un limite de
    // Firebase, no nuestro, y no se puede "arreglar" con codigo: hay que salir
    // de algun workspace. Lo devolvemos como LIMITE_PLAN porque es el codigo
    // que el cliente ya sabe mostrar.
    fallar('LIMITE_PLAN', `El listado de espacios no entra en el token (${bytes} de ${TOPE_BYTES_DEL_CLAIM} bytes).`);
  }
  await auth.setCustomUserClaims(uid, { ws });
  return ws;
}

/**
 * sincronizarClaims(uid, cambio)
 *
 * Es la UNICA funcion que toca los claims en todo el backend. La llaman los
 * cuatro endpoints que cambian membresias: crear workspace, invitar, quitar y
 * cambiar rol.
 *
 * @param {string} uid  el usuario cuyos claims hay que dejar al dia.
 * @param {object|null} cambio  que hacerle al mapa ANTES de reconstruir:
 *        null                                        -> solo resincronizar
 *        { tipo:'alta',  wsId, rol, nombre }         -> entra a un workspace
 *        { tipo:'rol',   wsId, rol }                 -> le cambian el rol
 *        { tipo:'baja',  wsId }                      -> lo sacan del workspace
 * @returns {Promise<object>} el mapa flaco que quedo en el token: { wsId: rol }
 *
 * OJO CON EL ORDEN: primero la transaccion sobre el DOCUMENTO, despues el
 * claim. Si se cortara la luz en el medio, el documento (que es la fuente de
 * verdad) queda bien y el claim queda viejo; volver a llamar a esta funcion lo
 * arregla. Al reves seria irreparable: el claim diria una cosa y el documento
 * otra, y nadie sabria cual esta bien.
 */
export async function sincronizarClaims(uid, cambio = null) {
  // Leemos el usuario de Auth AFUERA de la transaccion a proposito: una
  // transaccion de Firestore se puede reintentar varias veces, y meter adentro
  // una llamada de red que no es Firestore la haria correr de nuevo en cada
  // reintento (mas lenta y, si tuviera efectos, repetidos).
  let usuarioAuth;
  try {
    usuarioAuth = await auth.getUser(uid);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      fallar('USUARIO_NO_REGISTRADO', 'No existe esa cuenta en Firebase Auth.');
    }
    throw err;
  }

  const refUsuario = db.collection('usuarios').doc(uid);

  // ---- PASO 1: la transaccion sobre usuarios/{uid} ----
  let workspaces = await db.runTransaction(async (tx) => {
    const snap = await tx.get(refUsuario);
    const datos = snap.exists ? snap.data() : null;

    // Copia del mapa actual. El `typeof === 'object'` es por si el documento
    // quedo roto (campo ausente o con otro tipo): arrancamos de {} y no
    // explotamos.
    const mapa =
      datos && datos.workspaces && typeof datos.workspaces === 'object'
        ? { ...datos.workspaces }
        : {};

    // ---- aplicar el cambio pedido ----
    if (cambio && cambio.tipo === 'alta') {
      mapa[cambio.wsId] = { rol: cambio.rol, nombre: cambio.nombre };
    } else if (cambio && cambio.tipo === 'rol') {
      if (!mapa[cambio.wsId]) fallar('MIEMBRO_NO_ENCONTRADO', 'Esa persona no figura en ese espacio.');
      mapa[cambio.wsId] = { ...mapa[cambio.wsId], rol: cambio.rol };
    } else if (cambio && cambio.tipo === 'baja') {
      delete mapa[cambio.wsId];
    }

    if (!snap.exists) {
      // Caso 3: el doc no existe (invitaron a alguien cuyo registro fallo).
      // Lo creamos completo e idempotente, con TODOS los campos que declara el
      // modelo, para que el cliente no se encuentre con un doc a medias.
      tx.set(refUsuario, {
        email: usuarioAuth.email || '',
        nombre: nombrePresentable(usuarioAuth),
        workspaces: mapa,
        workspaceActual: primerWorkspace(mapa),
        claimsActualizadoEn: FieldValue.serverTimestamp(),
        creadoEn: FieldValue.serverTimestamp(),
      });
      return mapa;
    }

    // El doc ya existe: tocamos SOLO lo que nos corresponde. 'nombre' y
    // 'workspaceActual' son del cliente y no los pisamos... salvo el caso de
    // abajo, que es una consecuencia inevitable de la baja.
    const parche = {
      workspaces: mapa,
      // Invariante 14: cada vez que se toca el claim se escribe esta marca.
      // Es lo que dispara el getIdToken(true) del cliente.
      claimsActualizadoEn: FieldValue.serverTimestamp(),
    };

    // Si lo sacaron del workspace que tenia abierto, ese wsId ya no le sirve:
    // si lo dejamos, la app arranca en un workspace donde ya no puede leer y
    // muestra un permission-denied en la primera pantalla. Lo movemos a otro
    // workspace suyo, o a null si no le queda ninguno (el modelo declara
    // workspaceActual como `string | null` justamente por esto).
    if (cambio && cambio.tipo === 'baja' && datos.workspaceActual === cambio.wsId) {
      parche.workspaceActual = primerWorkspace(mapa);
    }

    tx.update(refUsuario, parche);
    return mapa;
  });

  // ---- PASO 2: el claim, reconstruido entero ----
  await escribirClaim(uid, workspaces);

  // ---- PASO 3: la vuelta de control ----
  // Entre el commit de la transaccion y el setCustomUserClaims pasaron unos
  // milisegundos. Si en ese hueco OTRO endpoint cambio el mapa (dos admins
  // trabajando a la vez), el claim que acabamos de escribir ya quedo viejo.
  // Releemos y, si no coincide, escribimos una vez mas. UNA sola vez: si
  // volviera a cambiar, la proxima llamada lo arregla y no queremos un bucle
  // infinito en un endpoint HTTP.
  const snapControl = await refUsuario.get();
  const mapaAhora =
    snapControl.exists && snapControl.get('workspaces') ? snapControl.get('workspaces') : {};

  if (!mismoMapa(mapaParaElClaim(workspaces), mapaParaElClaim(mapaAhora))) {
    console.warn(`[claims] El mapa de ${uid} cambio mientras escribiamos el claim. Reescribo una vez.`);
    workspaces = mapaAhora;
    await escribirClaim(uid, workspaces);
  }

  return mapaParaElClaim(workspaces);
}

/**
 * Devuelve un wsId cualquiera del mapa, o null si esta vacio.
 * Se usa para reubicar 'workspaceActual' cuando sacan a alguien del workspace
 * que tenia abierto. No importa cual: el cliente le va a mostrar el selector.
 */
function primerWorkspace(mapa) {
  const claves = Object.keys(mapa);
  return claves.length > 0 ? claves[0] : null;
}
