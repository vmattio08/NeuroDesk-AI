// ============================================================================
//  auth.js  —  entrar, salir, y el GUARDIA que solo deja pasar a los admins.
//  Panel web de NeuroDesk AI.
//
//  LO PRIMERO Y MAS IMPORTANTE (esto es una pregunta segura en la defensa):
//
//  El guardia de este archivo NO ES LA SEGURIDAD DEL SISTEMA. Es comodidad:
//  evita que alguien que no es admin entre a una pantalla que le va a dar
//  permission-denied en todo. Cualquiera puede abrir la consola del navegador
//  y saltearse esta funcion en diez segundos, porque corre en SU maquina.
//
//  La seguridad de verdad son DOS cosas, y ninguna vive en el navegador:
//    1) firebase/firestore.rules  — Firestore no le entrega un documento a
//       quien no tiene el claim correcto, aunque el JS diga lo contrario.
//       eventos/ y suscripcion/ estan cerrados a todo el que no sea admin.
//    2) el backend — verifica el ID token con verifyIdToken() y ademas LEE
//       workspaces/{wsId}/members/{uid} en cada pedido, que es lo unico que
//       corta al instante a alguien recien echado.
//
//  Si alguien "hackea" este archivo, lo unico que consigue es ver las
//  pantallas vacias con errores rojos en la consola.
// ============================================================================

import {
  auth, db,
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  doc, getDoc, onSnapshot, updateDoc
} from './firebase.js';


// ----------------------------------------------------------------------------
// esperarSesion()  —  ¿hay alguien logueado? (esperando a que el SDK conteste)
//
// LA TRAMPA: al cargar la pagina, auth.currentUser es null durante unos
// milisegundos SIEMPRE, incluso si la persona esta perfectamente logueada,
// porque el SDK todavia esta leyendo la sesion de IndexedDB. Si el guardia
// mira auth.currentUser directo, redirige al login en CADA F5 y parece que la
// sesion no se guarda nunca.
//
// La forma correcta es onAuthStateChanged, que dispara una primera vez cuando
// el SDK ya sabe la respuesta. Lo envolvemos en una promesa y nos damos de
// baja enseguida: aca solo queremos la PRIMERA respuesta, no un listener vivo.
// ----------------------------------------------------------------------------
export function esperarSesion() {
  return new Promise((resolver) => {
    const cortar = onAuthStateChanged(auth, (usuario) => {
      cortar();              // una sola vez y chau: esto no es un stream
      resolver(usuario);     // usuario, o null si no hay nadie
    });
  });
}


// ----------------------------------------------------------------------------
// entrar(email, contrasena)  —  el login.
//
// Devuelve el contexto ya armado (ver leerContexto). Si el mail o la clave
// estan mal, tira un Error con un mensaje en castellano listo para mostrar:
// los codigos de Firebase ('auth/invalid-credential') no se le muestran nunca
// a una persona.
// ----------------------------------------------------------------------------
export async function entrar(email, contrasena) {
  let credencial;
  try {
    credencial = await signInWithEmailAndPassword(auth, email.trim(), contrasena);
  } catch (e) {
    throw new Error(mensajeDeAuth(e.code));
  }

  // FORZAMOS el refresh del token (el true) justo despues de entrar.
  // Por que: los custom claims viajan ADENTRO del ID token y el token dura una
  // hora. Si al admin lo acaban de crear —o lo acaban de ascender a admin— con
  // el token viejo Firestore lo trata como si no fuera nadie y todas las
  // pantallas dan permission-denied. Pedir uno nuevo cuesta una llamada y nos
  // ahorra el bug mas confuso del proyecto.
  await credencial.user.getIdToken(true);

  return await leerContexto(credencial.user);
}


// ----------------------------------------------------------------------------
// salir()  —  logout.
// Antes de irse, corta la sesion; el guardia de la pagina se encarga del resto.
// ----------------------------------------------------------------------------
export async function salir() {
  await signOut(auth);
  location.replace('index.html');
}


// ----------------------------------------------------------------------------
// leerContexto(usuario)  —  arma el objeto con el que trabaja todo el panel.
//
// Junta dos fuentes distintas, y hay que tener clarisimo para que sirve cada
// una porque no son intercambiables:
//
//   (a) EL CLAIM DEL TOKEN  ->  request.auth.token.ws = { wsId: 'admin' | 'miembro' }
//       Es lo que MANDA. Es lo que leen las reglas de Firestore. Viene firmado
//       por Firebase, el navegador no lo puede falsificar (bueno: lo puede
//       cambiar en su copia local, pero entonces Firestore le niega todo).
//       Puede estar hasta 1 HORA desactualizado.
//
//   (b) EL DOCUMENTO usuarios/{uid}  ->  campo 'workspaces' = { wsId: {rol, nombre} }
//       Lo usamos SOLO para sacar el NOMBRE lindo de cada workspace ("Kiosco
//       Central" en vez de "ws_7Kd2mQ9xLb"). El 'rol' que trae este documento
//       NO se usa para decidir nada aca: para las reglas manda el claim.
//
// Si el doc no existe todavia (nunca paso por POST /v1/auth/registro), no
// rompemos: mostramos el wsId crudo. Es feo pero funciona.
// ----------------------------------------------------------------------------
export async function leerContexto(usuario) {
  const resultado = await usuario.getIdTokenResult();
  const mapaClaim = resultado.claims?.ws ?? {};   // { wsId: 'admin'|'miembro' }

  // Nombres de los workspaces, del doc personal. Si falla la lectura (offline,
  // reglas, doc inexistente) seguimos igual: los nombres son un lujo, no un
  // requisito.
  let mapaNombres = {};
  let nombrePersona = usuario.email;
  try {
    const ficha = await getDoc(doc(db, 'usuarios', usuario.uid));
    if (ficha.exists()) {
      mapaNombres = ficha.data().workspaces ?? {};
      nombrePersona = ficha.data().nombre || usuario.email;
    }
  } catch (e) {
    console.warn('[panel] no pude leer usuarios/{uid}, sigo con los ids crudos', e);
  }

  // Los workspaces donde ESTA PERSONA ES ADMIN. El panel es solo para eso.
  const workspacesAdmin = Object.keys(mapaClaim)
    .filter((wsId) => mapaClaim[wsId] === 'admin')
    .map((wsId) => ({
      wsId,
      nombre: mapaNombres[wsId]?.nombre || wsId
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  return {
    uid: usuario.uid,
    email: usuario.email,
    nombre: nombrePersona,
    usuario,                 // el objeto User del SDK, por si hace falta
    workspacesAdmin,
    esAdminDeAlguno: workspacesAdmin.length > 0
  };
}


// ----------------------------------------------------------------------------
// guardiaDeAdmin()  —  lo primero que corre app.html.
//
// Tres puertas, en este orden:
//   1) ¿hay sesion?            si no -> al login
//   2) ¿es admin de algo?      si no -> al login con un cartel explicando
//   3) ¿que workspace abrimos? el ultimo elegido, o el primero de la lista
//
// Devuelve el contexto + el wsId elegido. Si alguna puerta se cierra, redirige
// y devuelve null: el que llama tiene que hacer `if (!ctx) return;`.
// ----------------------------------------------------------------------------
export async function guardiaDeAdmin() {
  const usuario = await esperarSesion();
  if (!usuario) {
    location.replace('index.html');
    return null;
  }

  const ctx = await leerContexto(usuario);

  if (!ctx.esAdminDeAlguno) {
    // Ojo: puede ser que SI sea admin y el token este viejo (lo ascendieron
    // hace 5 minutos). Antes de echarlo, pedimos un token fresco y miramos de
    // nuevo. Es una sola llamada y evita el "pero si soy admin!" de la demo.
    await usuario.getIdToken(true);
    const ctx2 = await leerContexto(usuario);
    if (!ctx2.esAdminDeAlguno) {
      location.replace('index.html?motivo=no_admin');
      return null;
    }
    return { ...ctx2, wsId: elegirWorkspace(ctx2) };
  }

  return { ...ctx, wsId: elegirWorkspace(ctx) };
}


// ----------------------------------------------------------------------------
// elegirWorkspace()  —  cual de los workspaces abrimos.
// Se guarda el ultimo en localStorage para que el panel arranque donde quedo.
// Si el guardado ya no esta en la lista (lo bajaron de admin ahi), se cae al
// primero sin drama.
// ----------------------------------------------------------------------------
const CLAVE_WS = 'neurodesk.panel.wsId';

function elegirWorkspace(ctx) {
  const guardado = localStorage.getItem(CLAVE_WS);
  const sigueSiendoValido = ctx.workspacesAdmin.some((w) => w.wsId === guardado);
  return sigueSiendoValido ? guardado : ctx.workspacesAdmin[0].wsId;
}

export function recordarWorkspace(wsId) {
  localStorage.setItem(CLAVE_WS, wsId);
}


// ----------------------------------------------------------------------------
// guardarWorkspaceActual(uid, wsId)  —  espeja la eleccion en Firestore.
//
// El modelo de datos dice que 'workspaceActual' lo escribe EL CLIENTE, y las
// reglas se lo permiten (es uno de los dos unicos campos que el cliente puede
// tocar de su propio doc, junto con 'nombre'). Sirve para que la app Flutter
// arranque en el mismo workspace donde el admin lo dejo en el panel.
//
// Si falla, no pasa nada: es una comodidad, no un dato critico. Por eso el
// catch se come el error y solo lo loguea.
// ----------------------------------------------------------------------------
export async function guardarWorkspaceActual(uid, wsId) {
  try {
    await updateDoc(doc(db, 'usuarios', uid), { workspaceActual: wsId });
  } catch (e) {
    console.warn('[panel] no pude guardar workspaceActual', e);
  }
}


// ----------------------------------------------------------------------------
// vigilarClaims(uid, alCambiar)  —  el listener que el contrato pide tener
// SIEMPRE, en los dos clientes.
//
// El problema: los custom claims viajan adentro del ID token, que dura 1 hora.
// Si otro admin te baja a miembro, tu panel sigue funcionando hasta una hora
// (contra Firestore; contra el backend se corta al instante, porque el backend
// lee members/{uid} en cada pedido).
//
// La solucion del contrato: cada vez que el backend toca los claims de alguien
// escribe claimsActualizadoEn en usuarios/{uid}. Como cada uno puede leer su
// propio doc, escuchamos ese campo y, cuando cambia, pedimos un token nuevo.
// El cambio de rol se ve en el panel en SEGUNDOS en vez de en una hora.
//
// Devuelve la funcion para cortar el listener. Hay que llamarla al salir de la
// pagina: un listener vivo son lecturas facturadas para siempre.
// ----------------------------------------------------------------------------
export function vigilarClaims(uid, alCambiar) {
  let marcaAnterior = null;
  let primera = true;

  return onSnapshot(
    doc(db, 'usuarios', uid),
    async (foto) => {
      if (!foto.exists()) return;
      const marca = foto.data().claimsActualizadoEn?.toMillis?.() ?? null;

      // La primera foto es el estado actual, no un cambio: solo la guardamos.
      if (primera) {
        primera = false;
        marcaAnterior = marca;
        return;
      }

      if (marca !== marcaAnterior) {
        marcaAnterior = marca;
        console.log('[panel] cambiaron mis permisos, pido un token nuevo');
        await auth.currentUser?.getIdToken(true);
        alCambiar(await leerContexto(auth.currentUser));
      }
    },
    (e) => console.warn('[panel] se corto la vigilancia de permisos', e)
  );
}


// ----------------------------------------------------------------------------
// mensajeDeAuth()  —  codigo de Firebase -> castellano.
// Los dos primeros dicen lo mismo a proposito: no le confirmamos a nadie si un
// email existe o no en el sistema (si dijeramos "ese usuario no existe",
// cualquiera podria probar mails hasta encontrar los que si estan).
// ----------------------------------------------------------------------------
function mensajeDeAuth(codigo) {
  switch (codigo) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'El email o la contraseña no coinciden.';
    case 'auth/invalid-email':
      return 'Ese email está mal escrito.';
    case 'auth/user-disabled':
      return 'Esa cuenta está deshabilitada. Hablá con el administrador.';
    case 'auth/too-many-requests':
      return 'Muchos intentos seguidos. Esperá unos minutos y probá de nuevo.';
    case 'auth/network-request-failed':
      return 'No hay conexión. Revisá tu internet.';
    default:
      console.error('[panel] error de auth sin traducir:', codigo);
      return 'No pudimos entrar. Probá de nuevo en un rato.';
  }
}
