// ============================================================================
//  NeuroDesk AI — api/src/rutas/auth.js
//  POST /v1/auth/registro  — la UNICA forma de crear usuarios/{uid}.
//
//  POR QUE ESTE ENDPOINT EXISTE (cambio de la v2):
//  antes el doc usuarios/{uid} lo podian crear los dos, el cliente y el
//  backend, y competian. Si ganaba el cliente, el doc quedaba SIN el campo
//  'claimsActualizadoEn'; despues el backend, que es idempotente, veia el doc
//  ya creado y "no pisaba nada"; y el listener que refresca el token —que se
//  dispara justamente cuando cambia ese campo— no se disparaba NUNCA. Resultado:
//  la persona creaba un workspace, el backend le escribia el claim, pero su
//  token seguia sin el claim y Firestore le tiraba permission-denied en la
//  primera pantalla. Imposible de debuggear desde la app.
//  Ahora firestore.rules tiene `allow create: if false` en usuarios y el unico
//  camino es este endpoint.
//
//  EL uid Y EL EMAIL SALEN DEL TOKEN, NUNCA DEL BODY (invariante 19). Del body
//  viene una sola cosa: el nombre que la persona escribio en el formulario.
//
//  PARA MARTIN: como el cliente ya no puede crear el doc, si esta llamada
//  falla hay que REINTENTARLA antes de dejar entrar a la app. Mientras tanto se
//  muestra "Preparando tu cuenta..." — puede tardar 60 segundos si Render
//  estaba dormido.
// ============================================================================

import express from 'express';
import { db, FieldValue } from '../firebase.js';
import { fallar } from '../errores.js';
import { requireAuth } from '../middleware/auth.js';
import { nombrePresentable } from '../claims.js';

export const rutasDeAuth = express.Router();

// Mismo rango que el modelo, el contrato y firestore.rules (invariante 22).
const NOMBRE_MIN = 2;
const NOMBRE_MAX = 60;

rutasDeAuth.post('/registro', requireAuth, async (req, res) => {
  const { uid, email } = req.usuario;

  // ---- 1. De donde sale el nombre ----
  // Orden de preferencia: lo que escribio la persona > el displayName que trae
  // el token cuando el login fue con Google > el pedazo del email antes del @.
  // El ultimo caso existe para que el registro NUNCA falle por un nombre: si
  // rebotara, la persona quedaria con cuenta en Auth y sin doc en Firestore,
  // que es el peor estado posible (no puede entrar y no se puede volver a
  // registrar porque el email ya esta tomado).
  const delBody = typeof req.body?.nombre === 'string' ? req.body.nombre.trim() : '';
  const delToken = (req.usuario.nombre || '').trim();
  const nombre = delBody || delToken || nombrePresentable({ email, displayName: '' });

  if (nombre.length < NOMBRE_MIN || nombre.length > NOMBRE_MAX) {
    fallar(
      'DATOS_INVALIDOS',
      `El nombre tiene que medir entre ${NOMBRE_MIN} y ${NOMBRE_MAX} caracteres.`
    );
  }

  const refUsuario = db.collection('usuarios').doc(uid);

  // ---- 2. Idempotencia, primera pasada ----
  // La app reintenta este POST cuando Render estaba dormido, asi que llegan
  // dos y tres llamadas del mismo usuario. Si el doc ya existe devolvemos 200
  // con creado:false y NO pisamos nada: el 'nombre' es un campo que el cliente
  // puede editar despues, y seria muy feo que un reintento se lo revirtiera al
  // valor del formulario de registro.
  const snapPrevio = await refUsuario.get();
  if (snapPrevio.exists) {
    return res.status(200).json({
      ok: true,
      creado: false,
      usuario: usuarioParaLaRespuesta(uid, snapPrevio.data()),
    });
  }

  // ---- 3. El alta ----
  const datosNuevos = {
    email,                    // del token verificado
    nombre,                   // del formulario
    workspaces: {},           // todavia no pertenece a ninguno
    workspaceActual: null,    // null EXPLICITO: el modelo lo declara `string | null`
    // Se inicializa aunque todavia no haya ningun claim que sincronizar: si
    // quedara ausente, el primer onSnapshot del cliente veria "el campo no
    // existe -> el campo aparece" y ese es justamente el disparador que
    // queremos que signifique "refresca el token". Arrancando con un valor,
    // el unico cambio posible es uno de verdad.
    claimsActualizadoEn: FieldValue.serverTimestamp(),
    creadoEn: FieldValue.serverTimestamp(),
  };

  try {
    // .create() (y no .set()) a proposito: create FALLA si el documento ya
    // existe. Es la unica forma de cerrar la carrera entre dos POST que
    // llegaron juntos (los dos leyeron "no existe" en el paso 2).
    await refUsuario.create(datosNuevos);
  } catch (err) {
    // 6 = ALREADY_EXISTS en gRPC. El otro pedido gano la carrera: no es un
    // error para la persona, es exactamente el resultado que queriamos.
    if (err.code === 6 || err.code === 'already-exists') {
      const snap = await refUsuario.get();
      return res.status(200).json({
        ok: true,
        creado: false,
        usuario: usuarioParaLaRespuesta(uid, snap.data()),
      });
    }
    throw err; // cualquier otra cosa la agarra el middleware final
  }

  // No devolvemos los serverTimestamp: en este punto todavia son un
  // marcador de posicion, no una fecha. El cliente los lee del documento con
  // su listener, que es la fuente de verdad de la UI.
  return res.status(201).json({
    ok: true,
    creado: true,
    usuario: {
      uid,
      email,
      nombre,
      workspaces: {},
      workspaceActual: null,
    },
  });
});

/** Arma el objeto 'usuario' de la respuesta desde el documento ya guardado. */
function usuarioParaLaRespuesta(uid, datos) {
  return {
    uid,
    email: datos.email || '',
    nombre: datos.nombre || '',
    workspaces: datos.workspaces || {},
    // `?? null` y no `|| null`: si algun dia workspaceActual fuera la cadena
    // vacia queremos verla, no convertirla en null en silencio.
    workspaceActual: datos.workspaceActual ?? null,
  };
}
