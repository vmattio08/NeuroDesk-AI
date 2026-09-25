// ============================================================================
//  api.js  —  la UNICA funcion que le habla al backend: pedir().
//  Panel web de NeuroDesk AI.
//
//  El contrato lo pide asi, con todas las letras: "MANEJO DE ERRORES EN EL
//  CLIENTE, UNA SOLA VEZ. Una funcion pedir() envuelve todos los llamados:
//  try/catch, timeout, parseo de JSON, y si !body.ok muestra body.mensaje".
//  Si cada pantalla hiciera su propio fetch, el dia que cambie la forma del
//  error hay que tocar cinco archivos y siempre queda uno sin tocar.
//
//  RECORDATORIO DE ARQUITECTURA: el panel casi no usa el backend. Lee TODO de
//  Firestore directo (por eso es en tiempo real y por eso funciona con Render
//  dormido). Le pega al backend solo cuando hace falta una clave secreta o un
//  privilegio que el cliente no tiene: invitar y quitar miembros, procesar y
//  borrar items. Lo demas es onSnapshot.
// ============================================================================

import { auth, signOut } from './firebase.js';


// ############################################################################
// ##   >>>>>>>>>>   COMPLETAR / ELEGIR SEGUN DONDE SE ESTE PROBANDO   <<<<<  ##
// ##                                                                        ##
// ##   El contrato manda que la URL del backend viva en UNA sola constante,  ##
// ##   nunca hardcodeada en cada pantalla. Esta es esa constante.            ##
// ##                                                                        ##
// ##   Desarrollo (backend corriendo en la misma maquina):                   ##
// ##       http://localhost:8080                                            ##
// ##   Produccion (Render):                                                  ##
// ##       https://neurodesk-api.onrender.com                                ##
// ##                                                                        ##
// ##   OJO CON CORS: el backend acepta pedidos SOLO desde el origen del      ##
// ##   panel. En desarrollo ese origen es http://localhost:5500 (el puerto   ##
// ##   por defecto de Live Server de VS Code). Si abris el panel en otro     ##
// ##   puerto, el navegador va a bloquear la respuesta y en la consola vas   ##
// ##   a ver un error de CORS que NO es culpa de este archivo: hay que       ##
// ##   agregar ese origen a la lista del backend. Es lo primero que hay que  ##
// ##   sospechar cuando "el fetch no llega" pero el backend loguea el pedido.##
// ############################################################################
export const URL_API = 'http://localhost:8080';


// ----------------------------------------------------------------------------
// ErrorDeApi  —  un Error normal, pero que ademas trae el 'codigo' del
// contrato. Las pantallas hacen try/catch y muestran e.mensaje; si necesitan
// ramificar, ramifican por e.codigo y NUNCA comparando el texto del mensaje
// (el texto lo podemos cambiar cuando queramos; el codigo es el contrato).
// ----------------------------------------------------------------------------
export class ErrorDeApi extends Error {
  constructor({ codigo, mensaje, detalle = null, http = 0 }) {
    super(mensaje);          // asi e.message tambien sirve en la consola
    this.name = 'ErrorDeApi';
    this.codigo = codigo;
    this.mensaje = mensaje;  // el texto en castellano, listo para mostrar
    this.detalle = detalle;
    this.http = http;
  }
}


// ----------------------------------------------------------------------------
// pedir(metodo, ruta, cuerpo, opciones)
//
//   await pedir('POST', `/v1/workspaces/${wsId}/miembros`, { email, rol });
//
// Devuelve el JSON del backend ya parseado (con ok:true adentro).
// Si algo sale mal, TIRA un ErrorDeApi con la forma unica del contrato. La
// pantalla no tiene que mirar codigos HTTP ni parsear nada.
// ----------------------------------------------------------------------------
export async function pedir(metodo, ruta, cuerpo = null, opciones = {}) {
  const { segundos = 20 } = opciones;

  // -- 1. El token --------------------------------------------------------
  // Va en TODOS los endpoints menos /salud y el webhook de Mercado Pago.
  // getIdToken() sin argumentos usa el token cacheado y lo renueva solo si le
  // quedan menos de 5 minutos, asi que llamarlo en cada pedido no cuesta nada.
  const usuario = auth.currentUser;
  if (!usuario) {
    throw new ErrorDeApi({
      codigo: 'FALTA_TOKEN',
      mensaje: 'Tenés que iniciar sesión para hacer esto.'
    });
  }
  const token = await usuario.getIdToken();

  // -- 2. El timeout ------------------------------------------------------
  // fetch() NO tiene timeout: sin esto, si Render esta dormido el boton queda
  // girando para siempre. AbortController es la forma nativa de cortarlo.
  // El contrato avisa que el plan free de Render duerme a los 15 minutos y que
  // el primer pedido puede tardar entre 30 y 60 segundos: por eso 20 s de piso
  // y la posibilidad de pedir mas (por ejemplo 90 para /procesar).
  const controlador = new AbortController();
  const reloj = setTimeout(() => controlador.abort(), segundos * 1000);

  let respuesta;
  try {
    respuesta = await fetch(URL_API + ruta, {
      method: metodo,
      headers: {
        'Authorization': 'Bearer ' + token,
        ...(cuerpo ? { 'Content-Type': 'application/json' } : {})
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: controlador.signal
    });
  } catch (e) {
    // Aca caen: no hay internet, el backend no esta levantado, CORS, o el
    // timeout de arriba. El contrato dice que el cliente invente un error con
    // la MISMA forma en vez de mostrar una excepcion cruda.
    clearTimeout(reloj);
    const corto = e.name === 'AbortError';
    throw new ErrorDeApi({
      codigo: 'SIN_CONEXION',
      mensaje: corto
        ? 'El servidor está tardando demasiado. Puede estar despertándose: probá de nuevo en un minuto.'
        : 'No hay conexión con el servidor. Revisá tu internet y que el backend esté levantado.',
      detalle: e.message
    });
  } finally {
    clearTimeout(reloj);
  }

  // -- 3. El cuerpo -------------------------------------------------------
  // El contrato promete JSON SIEMPRE, hasta en los errores. Pero si el pedido
  // ni siquiera llego a Express (un proxy, un 502 de Render, un HTML de error),
  // JSON.parse revienta. Lo envolvemos para no mostrar nunca un "Unexpected
  // token < in JSON at position 0", que no le dice nada a nadie.
  let cuerpoRta;
  try {
    cuerpoRta = await respuesta.json();
  } catch {
    throw new ErrorDeApi({
      codigo: 'SIN_CONEXION',
      mensaje: 'El servidor respondió algo que no entendemos. Probá de nuevo en un rato.',
      http: respuesta.status
    });
  }

  // -- 4. ok:true / ok:false ----------------------------------------------
  // Segun el contrato el HTTP y el campo ok SIEMPRE concuerdan, asi que
  // alcanza con mirar ok. Miramos igual respuesta.ok por si alguna vez un
  // proxy devuelve un 500 con un JSON que no es nuestro.
  if (cuerpoRta && cuerpoRta.ok === true && respuesta.ok) {
    return cuerpoRta;
  }

  const error = new ErrorDeApi({
    codigo: cuerpoRta?.codigo || 'ERROR_INTERNO',
    mensaje: cuerpoRta?.mensaje || 'Algo salió mal de nuestro lado. Probá de nuevo.',
    detalle: cuerpoRta?.detalle ?? null,
    http: respuesta.status
  });

  // Los dos codigos que NO se muestran y se van: el token no sirve mas, asi
  // que seguir en el panel es mostrarle errores a alguien que ya no esta
  // logueado. Se cierra sesion y se vuelve al login.
  if (error.codigo === 'TOKEN_INVALIDO' || error.codigo === 'FALTA_TOKEN') {
    await signOut(auth).catch(() => {});
    location.replace('index.html?motivo=sesion');
    // Igual tiramos el error, para que el await del que llamo no siga de largo
    // mientras el navegador cambia de pagina.
  }

  throw error;
}


// ----------------------------------------------------------------------------
// despertarBackend()  —  GET /salud, sin token, sin esperar la respuesta.
//
// Render free duerme a los 15 minutos de no recibir trafico y el primer pedido
// tarda hasta 60 segundos. Si el admin entra al panel, mira la tabla dos
// minutos y recien ahi invita a alguien, el backend ya se desperto solo con
// este ping y la invitacion sale al toque.
//
// Es "dispara y olvida" a proposito: si falla, no pasa nada y no se le muestra
// ningun error a nadie. Por eso el .catch() vacio y por eso NO se hace await.
// ----------------------------------------------------------------------------
export function despertarBackend() {
  fetch(URL_API + '/salud')
    .then((r) => r.json())
    .then((s) => console.log('[panel] backend despierto:', s.servicio, s.version))
    .catch(() => console.log('[panel] el backend no responde todavía (¿está levantado?)'));
}
