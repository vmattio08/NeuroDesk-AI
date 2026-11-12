// ============================================================================
//  firebase_web.dart — la configuracion de Firebase para la app EN EL NAVEGADOR
//
//  POR QUE HACE FALTA: en Android, Firebase.initializeApp() lee solo el
//  android/app/google-services.json. En la web no hay ningun archivo que leer:
//  hay que pasarle las opciones a mano. main.dart las usa SOLO si kIsWeb.
//
//  DE DONDE SALEN: son las de la app web del proyecto ("NeuroDesk Panel"),
//  las MISMAS que usa panel/js/firebase.js. Una sola app web registrada para
//  el panel y para esta version: mismo proyecto, mismos usuarios, mismas
//  reglas.
//
//  NO SON UN SECRETO: viajan adentro de cualquier pagina web de Firebase (las
//  ve cualquiera con las herramientas del navegador), igual que el
//  google-services.json viaja adentro del APK. Lo que protege los datos son
//  las reglas de Firestore y el backend que verifica el ID token en cada
//  pedido, no esconder estos valores.
//
//  POR QUE UN ARCHIVO PROPIO Y NO firebase_options.dart: ese lo genera
//  flutterfire y esta en el .gitignore de la raiz (ver README 2.3). Este si se
//  versiona, asi el companero compila la web sin correr flutterfire.
// ============================================================================

import 'package:firebase_core/firebase_core.dart';

/// Las opciones de la app web de Firebase (copiadas de panel/js/firebase.js).
const FirebaseOptions opcionesDeFirebaseWeb = FirebaseOptions(
  apiKey: 'AIzaSyAar9DHKvZUxDnpUaDQhvfE3eojwTXvn20',
  authDomain: 'neurodesk-6to.firebaseapp.com',
  projectId: 'neurodesk-6to',
  // Storage esta descartado (pide tarjeta), pero va igual: es parte de la
  // configuracion de la app web y asi queda identica a la del panel.
  storageBucket: 'neurodesk-6to.firebasestorage.app',
  messagingSenderId: '455226002826',
  appId: '1:455226002826:web:6621104ade762da7d64c73',
);
