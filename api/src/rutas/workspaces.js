// ============================================================================
//  NeuroDesk AI — api/src/rutas/workspaces.js
//  Los tres endpoints que manejan el EQUIPO:
//
//    POST   /v1/workspaces                       crear el espacio de trabajo
//    POST   /v1/workspaces/:wsId/miembros        invitar por email
//    DELETE /v1/workspaces/:wsId/miembros/:uid   sacar a alguien
//
//  LOS TRES TOCAN CUATRO LUGARES DE UNA (por eso no los puede hacer el cliente
//  directo contra Firestore):
//    1. workspaces/{wsId}                  el doc del equipo
//    2. workspaces/{wsId}/members/{uid}    quien esta y con que rol
//    3. usuarios/{uid}.workspaces          el espejo del que se reconstruye el claim
//    4. el custom claim del token          lo que leen las reglas de Firestore
//  Si el cliente pudiera escribir (2), cualquiera se pondria rol 'admin' en su
//  propio documento. Por eso en las reglas members esta con
//  `allow create, update, delete: if false`.
//
//  EL ORDEN DE LAS ESCRITURAS ES A PROPOSITO: primero los documentos (que son
//  la fuente de verdad) y al final el claim (que es un reflejo). Si se corta en
//  el medio, el claim queda viejo y volver a llamar al endpoint lo arregla; al
//  reves seria irreparable.
// ============================================================================

import express from 'express';
import { randomBytes } from 'node:crypto';

import { db, auth, FieldValue } from '../firebase.js';
import { fallar } from '../errores.js';
import { requireAuth, exigirMiembro, exigirAdmin } from '../middleware/auth.js';
import { sincronizarClaims, nombrePresentable } from '../claims.js';

export const rutasDeWorkspaces = express.Router();

// ---------------------------------------------------------------------------
// LIMITES DEL PLAN FREE. Estan aca, con nombre, y no sueltos en un if perdido.
// El cliente tambien los valida para no dejar tocar un boton que va a fallar,
// pero el backend los vuelve a validar SIEMPRE: el cliente se puede saltear.
// ---------------------------------------------------------------------------
const MAX_WORKSPACES_POR_USUARIO = 3;
const MAX_MIEMBROS_PLAN_FREE = 5;

const NOMBRE_WS_MIN = 2;
const NOMBRE_WS_MAX = 40;

// ---------------------------------------------------------------------------
// COMO SE INVITA A ALGUIEN QUE TODAVIA NO TIENE CUENTA.
// Hay dos comportamientos posibles y el equipo eligio uno; la variable de
// entorno deja cambiarlo sin tocar codigo:
//
//   INVITAR_SOLO_REGISTRADOS = '1'  -> responde USUARIO_NO_REGISTRADO (404).
//                                      Es lo que dice el contrato v2: primero
//                                      se registra la persona, despues la
//                                      invitan. No hay invitaciones pendientes.
//
//   (cualquier otro valor, el que usamos) -> el backend CREA la cuenta en
//                                      Firebase Auth con una contrasena
//                                      temporal al azar y la devuelve UNA sola
//                                      vez en la respuesta, para que el admin
//                                      se la pase a la persona. No mandamos
//                                      mail porque no tenemos servicio de mail
//                                      (y Cloud Functions esta descartado
//                                      porque pide tarjeta).
//
// La contrasena temporal viaja SOLO en la respuesta del pedido que creo la
// cuenta, nunca se guarda en Firestore y nunca aparece en un log.
// ---------------------------------------------------------------------------
const SOLO_REGISTRADOS = process.env.INVITAR_SOLO_REGISTRADOS === '1';

// ===========================================================================
//  POST /v1/workspaces  — crear el espacio de trabajo
// ===========================================================================
rutasDeWorkspaces.post('/', requireAuth, async (req, res) => {
  const { uid, email } = req.usuario;

  const nombre = typeof req.body?.nombre === 'string' ? req.body.nombre.trim() : '';
  if (nombre.length < NOMBRE_WS_MIN || nombre.length > NOMBRE_WS_MAX) {
    fallar(
      'DATOS_INVALIDOS',
      `El nombre del espacio tiene que medir entre ${NOMBRE_WS_MIN} y ${NOMBRE_WS_MAX} caracteres.`
    );
  }

  // ---- 1. Limite del plan ----
  // Contamos del propio doc del usuario (1 lectura) y no con una query sobre
  // workspaces (que no tiene indice por ownerUid y ademas contaria mal: el
  // limite es "en cuantos workspaces esta", no "cuantos creo").
  const snapUsuario = await db.collection('usuarios').doc(uid).get();
  const cuantosTiene = snapUsuario.exists
    ? Object.keys(snapUsuario.get('workspaces') || {}).length
    : 0;

  if (cuantosTiene >= MAX_WORKSPACES_POR_USUARIO) {
    fallar('LIMITE_PLAN', `El plan gratuito permite ${MAX_WORKSPACES_POR_USUARIO} espacios por persona.`);
  }

  // El nombre de la persona sale de su doc; si todavia no lo tiene (registro a
  // medias), lo derivamos del email. Nunca del body: en members se muestra el
  // nombre real, no uno que se pueda inventar en cada pedido.
  const nombreDeLaPersona = snapUsuario.exists
    ? snapUsuario.get('nombre') || nombrePresentable({ email, displayName: '' })
    : nombrePresentable({ email, displayName: req.usuario.nombre });

  // ---- 2. Los tres documentos, en un solo batch (atomico) ----
  const wsId = generarId('ws_');
  const refWorkspace = db.collection('workspaces').doc(wsId);

  const lote = db.batch();

  lote.create(refWorkspace, {
    nombre,
    ownerUid: uid,
    plan: 'free',
    // OJO: el contrato v2 muestra "planStatus": "activo" en el ejemplo de
    // respuesta, pero 'activo' NO esta en el enum del modelo (invariante 21:
    // 'sin_plan' | 'pendiente' | 'activa' | 'pausada' | 'cancelada'). Un
    // workspace recien creado, sin ninguna suscripcion, es 'sin_plan', y el
    // modelo dice que con 'sin_plan' se puede procesar igual. Usamos el enum
    // del modelo, que es el que comparten workspaces.planStatus y
    // suscripcion/actual.estado.
    planStatus: 'sin_plan',
    creadoEn: FieldValue.serverTimestamp(),
    actualizadoEn: FieldValue.serverTimestamp(),
  });

  lote.create(refWorkspace.collection('members').doc(uid), {
    uid,
    email,
    nombre: nombreDeLaPersona,
    rol: 'admin',           // el que lo crea es admin, siempre
    agregadoPor: uid,       // se invito solo
    agregadoEn: FieldValue.serverTimestamp(),
  });

  // El doc de suscripcion existe DESDE EL DIA UNO aunque Mercado Pago sea un
  // stretch goal: asi el panel del admin siempre encuentra algo que leer y no
  // hay que programar la pantalla "todavia no hay suscripcion".
  lote.create(refWorkspace.collection('suscripcion').doc('actual'), {
    plan: 'free',
    estado: 'sin_plan',
    preapprovalId: null,
    montoMensual: 0,
    vence: null,
    eventosProcesados: [],
    actualizadoEn: FieldValue.serverTimestamp(),
  });

  await lote.commit();

  // ---- 3. Los claims ----
  // Si esto falla, la persona quedaria con un workspace que existe pero al que
  // no puede entrar (las reglas le pediran el claim y no lo va a tener) y sin
  // forma de arreglarlo desde la app. Preferimos deshacer y que reintente.
  try {
    await sincronizarClaims(uid, { tipo: 'alta', wsId, rol: 'admin', nombre });
  } catch (err) {
    console.error('[workspaces] Fallaron los claims al crear', wsId, '- deshago el alta:', err);
    await borrarWorkspaceAMedias(refWorkspace);
    throw err;
  }

  // ---- 4. El evento de auditoria ----
  // Va al final y en su propia escritura: si fallara, no queremos perder el
  // workspace por un renglon del feed.
  await escribirEvento(wsId, {
    tipo: 'workspace.creado',
    actorUid: uid,
    resumen: `${nombreDeLaPersona} creó el espacio "${nombre}"`,
    itemId: null,
  });

  return res.status(201).json({
    ok: true,
    workspace: {
      wsId,
      nombre,
      ownerUid: uid,
      plan: 'free',
      planStatus: 'sin_plan',
      rol: 'admin',
      creadoEn: new Date().toISOString(),
    },
    // Sin esto, el cliente navega a la pantalla del workspace con el token
    // VIEJO (que todavia no tiene el claim ws) y Firestore le tira
    // permission-denied en la primera query. Martin tiene que hacer
    // await user.getIdToken(true) ANTES de navegar.
    debeRefrescarToken: true,
  });
});

// ===========================================================================
//  POST /v1/workspaces/:wsId/miembros  — invitar por email
// ===========================================================================
rutasDeWorkspaces.post('/:wsId/miembros', requireAuth, exigirMiembro, exigirAdmin, async (req, res) => {
  const wsId = req.params.wsId;
  const admin = req.usuario;

  // ---- 1. Validar el body ----
  // El email se normaliza SIEMPRE a minusculas y sin espacios: Firebase Auth
  // guarda los emails en minuscula, y si buscaramos "Martin@Ejemplo.com" tal
  // cual vino del formulario, getUserByEmail no lo encontraria y le diriamos a
  // un usuario que existe que no tiene cuenta.
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const rol = req.body?.rol === 'admin' ? 'admin' : 'miembro'; // default 'miembro'

  if (!emailValido(email)) {
    fallar('DATOS_INVALIDOS', 'Ese email no parece una dirección válida.');
  }
  if (req.body?.rol !== undefined && req.body.rol !== 'admin' && req.body.rol !== 'miembro') {
    fallar('DATOS_INVALIDOS', "El rol solo puede ser 'admin' o 'miembro'.");
  }

  // ---- 2. Limite del plan ----
  const refWorkspace = db.collection('workspaces').doc(wsId);
  if ((req.workspace.plan || 'free') === 'free') {
    const conteo = await refWorkspace.collection('members').count().get();
    if (conteo.data().count >= MAX_MIEMBROS_PLAN_FREE) {
      fallar('LIMITE_PLAN', `El plan gratuito permite ${MAX_MIEMBROS_PLAN_FREE} personas por espacio.`);
    }
  }

  // ---- 3. Buscar (o crear) la cuenta en Firebase Auth ----
  let usuarioInvitado;
  let cuentaCreada = false;
  let passwordTemporal = null;

  try {
    usuarioInvitado = await auth.getUserByEmail(email);
  } catch (err) {
    if (err.code !== 'auth/user-not-found') throw err;

    if (SOLO_REGISTRADOS) {
      fallar('USUARIO_NO_REGISTRADO');
    }

    // Creamos la cuenta con una contrasena temporal al azar. emailVerified en
    // false a proposito: no verificamos nada, solo la damos de alta.
    passwordTemporal = generarPasswordTemporal();
    usuarioInvitado = await auth.createUser({
      email,
      password: passwordTemporal,
      displayName: email.split('@')[0],
      emailVerified: false,
    });
    cuentaCreada = true;
    console.log(`[workspaces] Cuenta creada para ${email} al invitarla a ${wsId}`);
  }

  const uidInvitado = usuarioInvitado.uid;

  // ---- 4. Que no este ya adentro ----
  const refMiembro = refWorkspace.collection('members').doc(uidInvitado);
  const snapMiembro = await refMiembro.get();
  if (snapMiembro.exists) fallar('MIEMBRO_DUPLICADO');

  // ---- 5. El nombre visible ----
  // Se copia de usuarios/{uid}.nombre (mismo rango 2..60 que el modelo) para
  // que la lista del panel no tenga que leer el doc personal de cada persona,
  // que ademas las reglas no le dejarian leer.
  const snapUsuarioInvitado = await db.collection('usuarios').doc(uidInvitado).get();
  const nombreInvitado = snapUsuarioInvitado.exists
    ? snapUsuarioInvitado.get('nombre') || nombrePresentable(usuarioInvitado)
    : nombrePresentable(usuarioInvitado);

  // ---- 6. Escribir members ----
  await refMiembro.create({
    uid: uidInvitado,
    email,
    nombre: nombreInvitado,
    rol,
    agregadoPor: admin.uid,
    agregadoEn: FieldValue.serverTimestamp(),
  });

  // ---- 7. Claims del INVITADO (no del admin) ----
  // Esta llamada tambien CREA usuarios/{uidInvitado} si no existia: es el caso
  // de la cuenta recien creada en el paso 3, que todavia no paso nunca por
  // POST /v1/auth/registro.
  try {
    await sincronizarClaims(uidInvitado, {
      tipo: 'alta',
      wsId,
      rol,
      nombre: req.workspace.nombre || '',
    });
  } catch (err) {
    // Si los claims fallan, sacamos el doc de members: si lo dejaramos, la
    // persona figuraria en la lista del panel pero no podria leer nada, y el
    // admin no tendria forma de entender por que.
    console.error('[workspaces] Fallaron los claims al invitar a', uidInvitado, '- deshago:', err);
    await refMiembro.delete().catch(() => {});
    throw err;
  }

  await escribirEvento(wsId, {
    tipo: 'miembro.agregado',
    actorUid: admin.uid,
    resumen: `${admin.email} agregó a ${email} como ${rol}`,
    itemId: null,
  });

  const respuesta = {
    ok: true,
    miembro: {
      uid: uidInvitado,
      email,
      nombre: nombreInvitado,
      rol,
      agregadoPor: admin.uid,
      agregadoEn: new Date().toISOString(),
    },
  };

  // La contrasena temporal se devuelve UNA sola vez, en el pedido que creo la
  // cuenta. No se guarda en Firestore ni se loguea: si el admin la pierde, la
  // persona usa "olvidé mi contraseña" desde la pantalla de login.
  if (cuentaCreada) {
    respuesta.cuentaCreada = true;
    respuesta.passwordTemporal = passwordTemporal;
    respuesta.aviso =
      'Le creamos la cuenta. Pasale esta contraseña temporal: tiene que cambiarla al entrar.';
  }

  return res.status(201).json(respuesta);
});

// ===========================================================================
//  DELETE /v1/workspaces/:wsId/miembros/:uid  — sacar a alguien del equipo
// ===========================================================================
rutasDeWorkspaces.delete('/:wsId/miembros/:uid', requireAuth, exigirMiembro, exigirAdmin, async (req, res) => {
  const wsId = req.params.wsId;
  const uidASacar = req.params.uid;
  const admin = req.usuario;

  const refWorkspace = db.collection('workspaces').doc(wsId);
  const refMiembro = refWorkspace.collection('members').doc(uidASacar);

  const snapMiembro = await refMiembro.get();
  if (!snapMiembro.exists) fallar('MIEMBRO_NO_ENCONTRADO');

  // ---- Reglas de negocio (invariante 15: el workspace nunca queda sin admin) ----
  if (uidASacar === req.workspace.ownerUid) {
    fallar('ACCION_NO_PERMITIDA', 'No se puede sacar al dueño del espacio.');
  }

  if (uidASacar === admin.uid) {
    // Sacarse uno mismo se permite SOLO si queda otro admin. Contamos con una
    // agregacion (count) para no bajar todos los documentos.
    const otrosAdmins = await refWorkspace
      .collection('members')
      .where('rol', '==', 'admin')
      .count()
      .get();
    if (otrosAdmins.data().count <= 1) {
      fallar('ACCION_NO_PERMITIDA', 'Sos el único administrador: nombrá a otro antes de salir.');
    }
  }

  const datosMiembro = snapMiembro.data();

  // ---- 1. EL CORTE REAL: borrar members/{uid} ----
  // Este es el paso que corta el acceso al BACKEND al instante, porque todos
  // los endpoints leen este documento en cada pedido.
  await refMiembro.delete();

  // ---- 2. Claims ----
  // Reconstruye el mapa del ex-miembro sin este workspace y, si lo tenia
  // abierto, le mueve 'workspaceActual'.
  await sincronizarClaims(uidASacar, { tipo: 'baja', wsId });

  // ---- 3. Revocar los refresh tokens ----
  // Impide que saque un token NUEVO con el claim viejo. NO invalida el que ya
  // tiene en la mano: ese vale hasta 1 hora y durante esa hora puede seguir
  // LEYENDO items 'equipo' directo de Firestore con un cliente hecho a mano.
  // Es una limitacion conocida del modelo de custom claims y la decimos, no la
  // escondemos: la alternativa seria que cada regla hiciera un get() del doc de
  // members, que se factura por documento y por regla.
  await auth.revokeRefreshTokens(uidASacar);

  // ---- 4. Cuantos items quedan de esa persona ----
  // Los items NO se borran: el conocimiento es del equipo, no de la persona.
  // El numero se muestra en el panel para que el admin sepa que queda.
  const conteoItems = await refWorkspace
    .collection('items')
    .where('creadoPor', '==', uidASacar)
    .count()
    .get();
  const itemsQueQuedan = conteoItems.data().count;

  await escribirEvento(wsId, {
    tipo: 'miembro.eliminado',
    actorUid: admin.uid,
    resumen: `${admin.email} sacó del equipo a ${datosMiembro.email || uidASacar}`,
    itemId: null,
  });

  return res.status(200).json({
    ok: true,
    quitado: {
      uid: uidASacar,
      email: datosMiembro.email || '',
      itemsQueQuedan,
    },
    corteDeAcceso: {
      backend: 'inmediato',
      lecturaDirectaFirestore: 'hasta 60 minutos (vence el ID token)',
      tokensRevocados: true,
    },
  });
});

// ===========================================================================
//  AYUDANTES
// ===========================================================================

/**
 * Genera un id corto y legible tipo 'ws_7Kd2mQ9xLb'.
 * No usamos nanoid para no sumar una dependencia por doce caracteres.
 * El alfabeto no tiene 0/O/1/l/I para que nadie se equivoque al dictar un id
 * por telefono o al copiarlo de una captura de pantalla.
 * El resto (% alfabeto.length) mete un sesgo minimo en la distribucion; con
 * randomBytes y 12 caracteres el riesgo de choque es despreciable, y ademas
 * .create() falla si el id ya existiera.
 */
function generarId(prefijo, largo = 12) {
  const alfabeto = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = randomBytes(largo);
  let salida = '';
  for (const b of bytes) salida += alfabeto[b % alfabeto.length];
  return prefijo + salida;
}

/**
 * Contrasena temporal para las cuentas que creamos al invitar.
 * 16 caracteres al azar: Firebase pide 6 como minimo y no queremos algo que
 * se pueda adivinar mientras la persona tarda en cambiarla.
 */
function generarPasswordTemporal() {
  return randomBytes(12).toString('base64url'); // ~16 caracteres
}

/**
 * Validacion de email a proposito FLOJA: solo descarta lo obviamente roto
 * (sin @, sin punto en el dominio, con espacios). La validacion de verdad la
 * hace Firebase Auth cuando busca o crea la cuenta; una regex "perfecta" de
 * email es imposible y siempre termina rechazando direcciones validas.
 */
function emailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

/**
 * Escribe un renglon en el feed de auditoria del workspace.
 * SOLO el admin puede leer esa subcoleccion (regla `allow read: if esAdmin`),
 * y es append-only: nadie edita ni borra un evento.
 * Los tipos llevan punto SIEMPRE ('workspace.creado', 'miembro.agregado', ...)
 * y la lista es identica en el modelo y en el contrato.
 */
export async function escribirEvento(wsId, evento) {
  await db.collection('workspaces').doc(wsId).collection('eventos').add({
    tipo: evento.tipo,
    actorUid: evento.actorUid,
    resumen: evento.resumen,
    itemId: evento.itemId ?? null,
    creadoEn: FieldValue.serverTimestamp(),
  });
}

/**
 * Deshace un workspace que quedo a medias porque fallaron los claims.
 * Es best-effort: si tambien fallara el borrado, lo importante es que el error
 * original llegue al cliente, asi que se loguea y se sigue.
 */
async function borrarWorkspaceAMedias(refWorkspace) {
  try {
    const lote = db.batch();
    lote.delete(refWorkspace.collection('suscripcion').doc('actual'));
    const miembros = await refWorkspace.collection('members').get();
    for (const doc of miembros.docs) lote.delete(doc.ref);
    lote.delete(refWorkspace);
    await lote.commit();
  } catch (err) {
    console.error('[workspaces] No pude deshacer el workspace a medias:', err);
  }
}
