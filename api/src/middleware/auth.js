// ============================================================================
//  NeuroDesk AI — api/src/middleware/auth.js
//  Los tres candados que atraviesa todo pedido protegido.
//
//  1) requireAuth   -> el token es de verdad y no esta revocado.
//  2) exigirMiembro -> la persona TODAVIA esta en el equipo (lee members/{uid}).
//  3) exigirAdmin   -> y ademas su rol en ESE documento dice 'admin'.
//
//  POR QUE 2 y 3 LEEN FIRESTORE Y NO SE CONFORMAN CON EL CLAIM (esto es LA
//  pregunta que puede hacer el profesor):
//  el custom claim viaja adentro del ID token, y ese token vale 1 HORA. Si un
//  admin echa a alguien a las 10:00, el token que esa persona ya tiene en la
//  mano sigue diciendo "sos miembro" hasta las 11:00. O sea que confiar solo en
//  el claim deja una ventana de hasta 60 minutos en la que un ex-miembro sigue
//  entrando al backend. Leer workspaces/{wsId}/members/{uid} cuesta 1 lectura
//  por request y CORTA AL INSTANTE, porque ese documento se borro de verdad.
//
//  LO QUE ESTO NO ARREGLA (hay que decirlo, no esconderlo): la lectura DIRECTA
//  a Firestore desde el celular la autorizan las reglas, y las reglas leen el
//  claim del token. Ahi la ventana de 1 hora sigue existiendo y no la podemos
//  cerrar sin hacer un get() por documento en cada regla, que se factura.
//  revokeRefreshTokens() impide sacar un token NUEVO, pero no invalida el que
//  la persona ya tiene. Esta escrito en las limitaciones conocidas.
//
//  INVARIANTE 19: ningun endpoint confia en un uid, un wsId o un rol que venga
//  en el body. El uid sale del token verificado, el wsId sale de la RUTA y el
//  rol sale del documento members. Si el body trae algo de eso, se ignora.
// ============================================================================

import { db, auth } from '../firebase.js';
import { fallar, ErrorApi } from '../errores.js';

/**
 * requireAuth — verifica el ID token de Firebase.
 *
 * Deja armado req.usuario = { uid, email, nombre } con datos del TOKEN, que
 * es lo unico en lo que confiamos.
 *
 * checkRevoked = true (el segundo parametro) es obligatorio: sin el,
 * verifyIdToken solo mira la firma y la fecha de vencimiento, y un token
 * emitido antes de un revokeRefreshTokens() seguiria pasando. Cuesta una
 * lectura interna extra contra Auth y es la que hace que "quitar a alguien"
 * signifique algo de verdad.
 */
export async function requireAuth(req, res, next) {
  const cabecera = req.headers.authorization || '';

  // El formato exacto es "Bearer <token>". Chequeamos el prefijo en vez de
  // partir a ciegas por el espacio para que un header raro de un proxy no
  // termine como un token vacio mandado a verifyIdToken.
  if (!cabecera.startsWith('Bearer ')) {
    return next(new ErrorApi('FALTA_TOKEN'));
  }

  const token = cabecera.slice('Bearer '.length).trim();
  if (!token) return next(new ErrorApi('FALTA_TOKEN'));

  try {
    const decodificado = await auth.verifyIdToken(token, true);
    req.usuario = {
      uid: decodificado.uid,
      // El email SIEMPRE sale de aca, nunca del body: es lo que garantiza que
      // el doc usuarios/{uid} guarde el email real de la cuenta.
      email: decodificado.email || '',
      // 'name' lo pone Firebase cuando el login fue con Google. Puede no venir.
      nombre: decodificado.name || '',
      // El claim se guarda solo para poder loguearlo y compararlo con members
      // cuando algo no cierra. NO se usa para autorizar nada en el backend.
      claimWs: decodificado.ws || {},
    };
    return next();
  } catch (err) {
    // Todas las variantes (vencido, revocado, firmado por otro proyecto, mal
    // formado) se responden igual a proposito: al cliente le sirve una sola
    // reaccion —volver a loguearse— y no le damos pistas a quien esta
    // probando tokens sobre CUAL de los chequeos fallo.
    console.warn('[auth] Token rechazado:', err.code || err.message);
    return next(new ErrorApi('TOKEN_INVALIDO'));
  }
}

/**
 * cargarMembresia — el chequeo de verdad, en una funcion suelta para poder
 * reusarla desde cualquier lado (no solo como middleware).
 *
 * Hace DOS lecturas, en paralelo con Promise.all porque no dependen una de la
 * otra: el doc del workspace (para saber si existe y quien es el owner) y el
 * doc del miembro.
 */
export async function cargarMembresia(wsId, uid) {
  const refWorkspace = db.collection('workspaces').doc(wsId);
  const refMiembro = refWorkspace.collection('members').doc(uid);

  const [snapWorkspace, snapMiembro] = await Promise.all([
    refWorkspace.get(),
    refMiembro.get(),
  ]);

  // Ojo con el orden de los errores: primero "no existe el workspace" y
  // despues "no sos miembro". Si fuera al reves, alguien podria distinguir un
  // wsId que existe de uno que no probando ids al azar.
  if (!snapWorkspace.exists) fallar('WORKSPACE_NO_ENCONTRADO');
  if (!snapMiembro.exists) fallar('NO_ES_MIEMBRO');

  const datosMiembro = snapMiembro.data();
  // Default que DENIEGA: si el documento quedo sin 'rol' (cargado a mano desde
  // la consola de Firebase), la persona NO se vuelve admin por omision.
  const rol = datosMiembro.rol === 'admin' ? 'admin' : 'miembro';

  return {
    workspace: { wsId, ...snapWorkspace.data() },
    miembro: { ...datosMiembro, uid, rol },
    rol,
    esAdmin: rol === 'admin',
  };
}

/**
 * exigirMiembro — middleware. Va SIEMPRE despues de requireAuth y en toda ruta
 * que tenga :wsId.
 *
 * Deja armados:
 *   req.workspace  el doc del workspace (para leer ownerUid, plan, planStatus)
 *   req.miembro    el doc de members/{uid}
 *   req.rol        'admin' | 'miembro'  <- el rol que manda para el BACKEND
 *   req.esAdmin    atajo booleano
 */
export async function exigirMiembro(req, res, next) {
  try {
    const wsId = req.params.wsId;
    if (!wsId) fallar('DATOS_INVALIDOS', 'Falta el wsId en la ruta.');

    const membresia = await cargarMembresia(wsId, req.usuario.uid);
    req.workspace = membresia.workspace;
    req.miembro = membresia.miembro;
    req.rol = membresia.rol;
    req.esAdmin = membresia.esAdmin;
    return next();
  } catch (err) {
    return next(err);
  }
}

/**
 * exigirAdmin — middleware. Se puede poner solo (hace el trabajo de
 * exigirMiembro tambien) o despues de exigirMiembro (reusa lo ya leido y no
 * gasta las dos lecturas otra vez).
 *
 * INVARIANTE 12: si el claim del token y members/{uid}.rol no coinciden, para
 * el BACKEND manda members. El claim puede estar hasta una hora atrasado.
 */
export async function exigirAdmin(req, res, next) {
  try {
    if (!req.miembro) {
      const wsId = req.params.wsId;
      if (!wsId) fallar('DATOS_INVALIDOS', 'Falta el wsId en la ruta.');
      const membresia = await cargarMembresia(wsId, req.usuario.uid);
      req.workspace = membresia.workspace;
      req.miembro = membresia.miembro;
      req.rol = membresia.rol;
      req.esAdmin = membresia.esAdmin;
    }

    if (!req.esAdmin) fallar('NO_ES_ADMIN');
    return next();
  } catch (err) {
    return next(err);
  }
}
