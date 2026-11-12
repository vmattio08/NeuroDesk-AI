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
//
//  EL ESPACIO DE BIENVENIDA (11/2026). Para la prueba cruzada entre equipos,
//  quien se registra tiene que poder entrar directo a un espacio con
//  contenido, sin esperar a que un admin lo invite. Con la variable de entorno
//  ESPACIO_DE_BIENVENIDA = un wsId, despues de dejar listo usuarios/{uid}, el
//  registro lo suma como 'miembro' a ESE espacio, si y solo si:
//    - el espacio existe;
//    - la persona no esta en NINGUN espacio (usuarios.workspaces vacio);
//    - no figura en exMiembros de ese espacio: si un admin la saco, no vuelve
//      sola (seria saltearse la decision del admin con solo volver a entrar);
//    - el plan del espacio tiene lugar (plan 'free': 5 personas).
//  El alta es la MISMA que la del POST de miembros (sumarMiembro, en
//  rutas/workspaces.js): ficha en members, usuarios.workspaces, claim,
//  claimsActualizadoEn, y ademas workspaceActual para que la app arranque
//  ahi. Si algo de esto falla, el registro IGUAL responde OK y la persona
//  queda sin espacio, como antes: entrar a la app es mas importante que la
//  bienvenida. Sin la variable, todo es exactamente como antes.
//  Para un producto real se borra la variable: nadie entra a un equipo ajeno
//  sin que lo inviten.
// ============================================================================

import express from 'express';
import { db, FieldValue } from '../firebase.js';
import { fallar } from '../errores.js';
import { requireAuth } from '../middleware/auth.js';
import { nombrePresentable } from '../claims.js';
import { sumarMiembro, hayLugarEnElPlan, escribirEvento } from './workspaces.js';

export const rutasDeAuth = express.Router();

// Mismo rango que el modelo, el contrato y firestore.rules (invariante 22).
const NOMBRE_MIN = 2;
const NOMBRE_MAX = 60;

// El wsId del espacio de bienvenida, o null = apagado. Se valida la FORMA
// antes de usarlo para armar una ruta: un valor con una barra adentro
// ('ws/otra') haria que .doc() apunte a otro lugar del arbol. Mal escrito,
// queda apagado y se avisa una sola vez al arrancar.
const FORMATO_WS_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ESPACIO_DE_BIENVENIDA = (() => {
  const valor = (process.env.ESPACIO_DE_BIENVENIDA ?? '').trim();
  if (!valor) return null;
  if (!FORMATO_WS_ID.test(valor)) {
    console.warn('[auth] ESPACIO_DE_BIENVENIDA no tiene forma de wsId: el registro no suma a nadie.');
    return null;
  }
  console.log(`[auth] Espacio de bienvenida: ${valor} (quien se registra sin espacio entra ahi como miembro)`);
  return valor;
})();

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

  // Lo que queda despues de los pasos 2 y 3: con que HTTP se responde, si el
  // doc se creo en ESTE pedido y lo que dice el doc (para la bienvenida y para
  // la respuesta).
  let resultado;

  // ---- 2. Idempotencia, primera pasada ----
  // La app reintenta este POST cuando Render estaba dormido, asi que llegan
  // dos y tres llamadas del mismo usuario. Si el doc ya existe devolvemos 200
  // con creado:false y NO pisamos nada: el 'nombre' es un campo que el cliente
  // puede editar despues, y seria muy feo que un reintento se lo revirtiera al
  // valor del formulario de registro.
  const snapPrevio = await refUsuario.get();
  if (snapPrevio.exists) {
    resultado = { http: 200, creado: false, datos: snapPrevio.data() };
  } else {
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
      // No guardamos los serverTimestamp: en este punto todavia son un
      // marcador de posicion, no una fecha. El cliente los lee del documento
      // con su listener, que es la fuente de verdad de la UI.
      resultado = {
        http: 201,
        creado: true,
        datos: { email, nombre, workspaces: {}, workspaceActual: null },
      };
    } catch (err) {
      // 6 = ALREADY_EXISTS en gRPC. El otro pedido gano la carrera: no es un
      // error para la persona, es exactamente el resultado que queriamos.
      if (err.code !== 6 && err.code !== 'already-exists') throw err; // lo agarra el middleware final
      const snap = await refUsuario.get();
      resultado = { http: 200, creado: false, datos: snap.data() };
    }
  }

  // ---- 4. El espacio de bienvenida (solo si la variable tiene valor) ----
  // Corre tambien cuando el doc ya existia, a proposito: si el primer intento
  // creo el doc y se corto antes de sumarla (Render reiniciado), el reintento
  // de la app termina el trabajo. Nunca hace fallar el registro.
  const espacioDeBienvenida = await sumarAlEspacioDeBienvenida({ uid, email, datos: resultado.datos });

  let usuario = usuarioParaLaRespuesta(uid, resultado.datos);
  if (espacioDeBienvenida) {
    // Se volvio a escribir el doc (workspaces, workspaceActual): la respuesta
    // dice lo que quedo de verdad. Si esta lectura fallara, el alta ya esta
    // hecha y el listener de la app ve el doc igual.
    try {
      const snap = await refUsuario.get();
      if (snap.exists) usuario = usuarioParaLaRespuesta(uid, snap.data());
    } catch (err) {
      console.warn(`[auth] No pude releer usuarios/${uid} despues de la bienvenida: ${err?.code ?? err?.name ?? 'error'}`);
    }
  }

  const cuerpo = {
    ok: true,
    creado: resultado.creado,
    usuario,
    // wsId del espacio al que se sumo EN ESTE PEDIDO, o null (variable
    // apagada, ya tenia espacio, la habian sacado, no hay lugar o fallo).
    espacioDeBienvenida,
  };
  // Como en POST /v1/workspaces (contrato, N3): si tocamos su claim, la app
  // tiene que hacer getIdToken(true) antes de entrar al espacio, o Firestore
  // le tira permission-denied con el token viejo.
  if (espacioDeBienvenida) cuerpo.debeRefrescarToken = true;

  return res.status(resultado.http).json(cuerpo);
});

/**
 * Suma a quien se acaba de registrar al espacio de bienvenida, si
 * corresponde (ver el encabezado del archivo).
 *
 * @returns {Promise<string|null>} el wsId si la sumo EN ESTE PEDIDO; si no, null.
 *
 * NUNCA tira: cualquier falla se loguea y devuelve null, porque el registro
 * tiene que responder OK igual. Al log van el uid y el wsId, nunca el email
 * ni el nombre (el log de Render lo puede ver cualquiera que mire la consola).
 */
async function sumarAlEspacioDeBienvenida({ uid, email, datos }) {
  const wsId = ESPACIO_DE_BIENVENIDA;
  if (!wsId) return null;

  // Solo quien no esta en NINGUN espacio. Un mapa roto (que no es un objeto)
  // cuenta como vacio: igual sincronizarClaims lo reconstruye bien.
  const suyos = datos?.workspaces;
  if (suyos && typeof suyos === 'object' && Object.keys(suyos).length > 0) return null;

  // El nombre visible para members y para el feed: el de su ficha personal,
  // que acabamos de dejar lista (el de la cuenta, si la ficha vino rota).
  const nombre = typeof datos?.nombre === 'string' && datos.nombre.trim().length >= NOMBRE_MIN
    ? datos.nombre.trim().slice(0, NOMBRE_MAX)
    : nombrePresentable({ email, displayName: '' });

  try {
    const refWorkspace = db.collection('workspaces').doc(wsId);
    const snapWorkspace = await refWorkspace.get();
    if (!snapWorkspace.exists) {
      console.warn(`[auth] El espacio de bienvenida ${wsId} no existe: ${uid} queda sin espacio.`);
      return null;
    }
    const workspace = { wsId, ...snapWorkspace.data() };

    // Si un admin la saco de este espacio, no vuelve sola.
    const exMiembros = workspace.exMiembros;
    if (exMiembros && typeof exMiembros === 'object' && Object.hasOwn(exMiembros, uid)) {
      console.log(`[auth] ${uid} figura en exMiembros de ${wsId}: no se la suma a la bienvenida.`);
      return null;
    }

    if (!(await hayLugarEnElPlan(refWorkspace, workspace))) {
      console.warn(`[auth] El espacio de bienvenida ${wsId} no tiene lugar en su plan: ${uid} queda sin espacio.`);
      return null;
    }

    // La misma alta que hace un admin desde el panel. agregadoPor es la
    // propia persona: entro sola, como quien crea un espacio.
    await sumarMiembro({
      wsId,
      workspace,
      uid,
      email,
      nombre,
      rol: 'miembro',
      agregadoPor: uid,
      abrirElEspacio: true,
    });
  } catch (err) {
    // El codigo y nada mas: un err completo puede traer datos de la cuenta.
    console.error(`[auth] No se pudo sumar a ${uid} al espacio de bienvenida ${wsId}: ${err?.codigo ?? err?.code ?? err?.name ?? 'error'}`);
    return null;
  }

  // El evento va aparte: si falla, el alta ya esta hecha y no se deshace por
  // un renglon del feed. Con el NOMBRE, nunca con un email: si el "nombre"
  // trae una @ (alguien escribio su mail en el formulario), va generico.
  try {
    await escribirEvento(wsId, {
      tipo: 'miembro.agregado',
      actorUid: uid,
      resumen: `${nombre.includes('@') ? 'Una persona nueva' : nombre} se sumó al equipo`,
      itemId: null,
    });
  } catch (err) {
    console.error(`[auth] No se pudo anotar la bienvenida de ${uid} en ${wsId}: ${err?.code ?? err?.name ?? 'error'}`);
  }

  console.log(`[auth] ${uid} entro como miembro al espacio de bienvenida ${wsId}`);
  return wsId;
}

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
