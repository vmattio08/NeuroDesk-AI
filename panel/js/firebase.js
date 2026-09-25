// ============================================================================
//  firebase.js  —  el UNICO archivo del panel que habla con el SDK de Firebase.
//  Panel web de NeuroDesk AI.
//
//  Todo el panel arranca por aca: initializeApp() + initializeFirestore() con
//  cache persistente, y despues re-exporta las funciones del SDK que usan las
//  pantallas. Ninguna otra pantalla importa de gstatic: importan de este
//  archivo. Ver el comentario "POR QUE RE-EXPORTAMOS" mas abajo.
//
//  No hay npm install, no hay bundler, no hay React: son modulos ES nativos
//  del navegador. Se abre el HTML desde un servidor local y anda.
// ============================================================================


// ############################################################################
// ##                                                                        ##
// ##   >>>>>>>>>>   COMPLETAR ACA ANTES DE ABRIR EL PANEL   <<<<<<<<<<       ##
// ##                                                                        ##
// ##   Estos datos salen de la consola de Firebase:                         ##
// ##     Configuracion del proyecto  ->  Tus apps  ->  App web  ->          ##
// ##     "Configuracion del SDK"  ->  opcion "Config"                       ##
// ##                                                                        ##
// ##   SE COPIA TAL CUAL, sin comillas raras y sin cambiar los nombres de    ##
// ##   las claves. Si algo queda con el texto PEGAR_..., el panel muestra    ##
// ##   un cartel avisando y no intenta conectarse (ver faltaConfig).        ##
// ##                                                                        ##
// ##   ¿ESTO ES UN SECRETO? NO. Y hay que saber contestarlo en la defensa:   ##
// ##   la config de una app web de Firebase VIAJA SIEMPRE al navegador, es   ##
// ##   publica por diseño, y cualquiera que abra el panel la puede leer con  ##
// ##   Ctrl+U. No es una contraseña: es la direccion del proyecto. Lo que    ##
// ##   protege los datos son las REGLAS de Firestore (firebase/firestore.    ##
// ##   rules) y el backend, que verifica el ID token en cada pedido.         ##
// ##   Los que SI son secretos —la service account, la clave de NVIDIA, la   ##
// ##   de OCR.space y la de Mercado Pago— viven en el .env del backend y no  ##
// ##   tocan nunca este archivo.                                             ##
// ##                                                                        ##
// ############################################################################
export const configFirebase = {
  apiKey:            'PEGAR_API_KEY',
  authDomain:        'PEGAR_PROYECTO.firebaseapp.com',
  projectId:         'PEGAR_PROYECTO',
  storageBucket:     'PEGAR_PROYECTO.appspot.com',   // no lo usamos (Storage esta descartado), pero va igual
  messagingSenderId: 'PEGAR_SENDER_ID',
  appId:             'PEGAR_APP_ID'
};


// ----------------------------------------------------------------------------
// VERSION DEL SDK.
// Aparece en las tres lineas de import de abajo. Si alguna vez hay que
// cambiarla, se cambia EN LAS TRES: si quedan dos versiones distintas
// conviviendo, el SDK tira errores rarisimos ("Firebase App named DEFAULT
// already exists" o "Type does not match the expected instance").
// Version congelada para la entrega: 12.9.0 (igual que Flutter 3.44.7, no se
// actualiza hasta despues del 16/10).
// Si el navegador tira 404 en estos imports, es que esa version no existe en
// gstatic: probar con otra de https://firebase.google.com/support/release-notes/js
// ----------------------------------------------------------------------------
import { initializeApp } from
  'https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js';

import {
  getAuth, setPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js';

import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, query, where, orderBy, limit,
  onSnapshot, getDoc, getDocs, updateDoc, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js';


// ----------------------------------------------------------------------------
// faltaConfig  —  ¿todavia estan los PEGAR_...?
// Sin esto, el sintoma de no haber completado la config es un
// "auth/api-key-not-valid" en la consola que no le dice nada a nadie y que nos
// costo media clase la primera vez. Con esto, el login muestra un cartel que
// dice exactamente que archivo abrir.
// ----------------------------------------------------------------------------
export const faltaConfig = Object.values(configFirebase)
  .some((v) => String(v).startsWith('PEGAR_'));


// ----------------------------------------------------------------------------
// ARRANQUE
// ----------------------------------------------------------------------------
export const app = initializeApp(configFirebase);

export const auth = getAuth(app);

// La sesion queda guardada en el navegador: si el admin cierra la pestaña y
// vuelve, sigue logueado. Es una promesa, pero no hace falta esperarla antes
// de usar auth: el SDK encola lo que venga despues.
setPersistence(auth, browserLocalPersistence);

// FIRESTORE CON CACHE PERSISTENTE.
//
// initializeFirestore() (y NO getFirestore()) es la unica forma de pasarle
// opciones. Tiene que correr ANTES de cualquier lectura; como este archivo es
// el primero que importa todo el mundo, eso queda garantizado solo.
//
// persistentLocalCache = IndexedDB. Que nos da, en concreto:
//   1) La tabla de items se dibuja AL INSTANTE al recargar la pagina, con los
//      datos de la ultima vez, y despues se actualiza sola cuando llega el
//      servidor. Sin esto, cada F5 son 200 lecturas facturadas de nuevo.
//   2) Si se cae el wifi de la escuela, el panel sigue mostrando la ultima
//      foto de los datos en vez de una pantalla vacia. Eso es exactamente lo
//      que dice el badge "Sin conexion" de la pantalla de items, que sale de
//      metadata.fromCache.
//
// persistentMultipleTabManager: sin esto, si el admin abre el panel en DOS
// pestañas, la segunda no puede tomar el lock de IndexedDB y la cache se
// desactiva sola (el SDK avisa con un warning que nadie lee). Con el manager
// multi-pestaña, las dos comparten la misma cache.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});


// ----------------------------------------------------------------------------
// POR QUE RE-EXPORTAMOS LAS FUNCIONES DEL SDK
//
// Las pantallas necesitan collection, query, where, onSnapshot, etc. Si cada
// una las importara de gstatic, la URL con el numero de version quedaria
// repetida en cinco archivos y actualizar el SDK seria buscar y reemplazar a
// mano (y olvidarse de uno, que es peor: dos versiones del SDK conviviendo).
//
// Asi, la URL de gstatic aparece SOLO en este archivo, y las pantallas hacen:
//     import { db, collection, query, onSnapshot } from '../firebase.js';
//
// No es una "capa de abstraccion": no envolvemos nada, no renombramos nada,
// son las mismas funciones del SDK pasando de largo. Un solo lugar con la
// version, y nada mas.
// ----------------------------------------------------------------------------
export {
  // auth
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  // firestore
  collection, doc, query, where, orderBy, limit,
  onSnapshot, getDoc, getDocs, updateDoc, serverTimestamp
};
