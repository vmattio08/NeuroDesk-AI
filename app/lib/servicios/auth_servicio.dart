// ============================================================================
//  auth_servicio.dart — todo lo de la sesion en un solo lugar
//
//  Entrar, registrarse, salir, conseguir el ID token y —la parte fina— VIGILAR
//  el propio documento usuarios/{uid} para refrescar el token cuando el
//  backend cambia los custom claims.
//
//  POR QUE ESTA CLASE ES ESTATICA Y NO UN OBJETO QUE SE PASA POR EL ARBOL:
//  no usamos ningun gestor de estado (ni Provider ni Riverpod). Con metodos
//  estaticos cualquier pantalla llama AuthServicio.algo() sin que haya que
//  pasarlo de widget en widget. Es la opcion mas simple y la sabemos explicar.
//
//  ------------------------------------------------------------------------
//  EL PROBLEMA DEL TOKEN VIEJO (esto hay que saber contarlo en la defensa):
//  Las reglas de Firestore no leen el rol de la base: lo leen del CUSTOM CLAIM
//  firmado que viaja adentro del ID token. Ese token dura 1 HORA. Entonces, si
//  un admin te invita a un workspace, tu token sigue sin el claim hasta una
//  hora despues y Firestore te contesta permission-denied aunque ya seas
//  miembro. La solucion del contrato: cada vez que el backend toca los claims
//  escribe 'claimsActualizadoEn' en usuarios/{uid}; la app escucha SU PROPIO
//  documento y, cuando ese campo cambia, llama a getIdToken(true), que pide un
//  token nuevo con los claims al dia. Eso es lo que hace vigilarClaims().
//  ------------------------------------------------------------------------
// ============================================================================

import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';

class AuthServicio {
  static final FirebaseAuth _auth = FirebaseAuth.instance;
  static final FirebaseFirestore _db = FirebaseFirestore.instance;

  /// La suscripcion al propio doc de usuario. Se guarda para poder cancelarla
  /// al cerrar sesion: si no, queda un listener escuchando el documento de
  /// alguien que ya no esta logueado y Firestore devuelve permission-denied.
  static StreamSubscription<DocumentSnapshot<Map<String, dynamic>>>? _vigilancia;

  /// Ultimo valor visto de claimsActualizadoEn. Sirve para no refrescar el
  /// token en CADA cambio del documento (el usuario tambien edita 'nombre' y
  /// 'workspaceActual'), solo cuando de verdad cambiaron los claims.
  static Timestamp? _ultimoClaims;

  // --- lecturas rapidas -----------------------------------------------------

  static User? get usuarioActual => _auth.currentUser;

  /// El stream maestro de la app: null = no hay nadie logueado.
  /// La pantalla que decide que mostrar (la "Puerta" de main.dart) escucha
  /// este stream, asi que el login y el logout redibujan solos.
  static Stream<User?> get cambiosDeSesion => _auth.authStateChanges();

  /// El documento personal usuarios/{uid}: nombre, workspaces, workspaceActual.
  /// Lo CREA el backend; el cliente solo puede editar nombre y workspaceActual.
  static Stream<DocumentSnapshot<Map<String, dynamic>>> streamMiFicha(String uid) {
    return _db.collection('usuarios').doc(uid).snapshots();
  }

  /// El ID token para el header Authorization.
  /// `forzarRefresco: true` va DESPUES de que el backend toca los claims.
  static Future<String?> tokenActual({bool forzarRefresco = false}) async {
    try {
      final User? u = _auth.currentUser;
      if (u == null) return null;
      return await u.getIdToken(forzarRefresco);
    } catch (e) {
      debugPrint('[NeuroDesk] no se pudo conseguir el token: $e');
      return null;
    }
  }

  /// Fuerza un token nuevo. Se usa cuando el backend responde
  /// debeRefrescarToken: true o cuando Firestore tira un permission-denied raro.
  static Future<void> refrescarToken() async {
    await tokenActual(forzarRefresco: true);
  }

  // --- entrar / registrarse / salir ------------------------------------------

  /// Login con email y contrasena.
  /// Deja que la FirebaseAuthException suba: la pantalla la atrapa y la
  /// traduce con traducirErrorDeAuth(). Asi el texto en castellano se escribe
  /// una sola vez y se usa en el login y en el registro.
  static Future<UserCredential> entrar(String email, String contrasena) {
    return _auth.signInWithEmailAndPassword(
      email: email.trim().toLowerCase(),
      password: contrasena,
    );
  }

  /// Crear la cuenta en Firebase Auth y dejarle el nombre puesto.
  ///
  /// OJO: esto NO crea el documento usuarios/{uid}. Ese documento lo crea
  /// SOLO el backend con POST /v1/auth/registro (las reglas tienen
  /// allow create: if false). La app lo pide despues, ya con el token en la
  /// mano, en la pantalla "Preparando tu cuenta..." de main.dart.
  ///
  /// El nombre se guarda en el displayName porque viaja adentro del token: si
  /// la llamada al backend se corta y hay que reintentarla mas tarde, el
  /// nombre no se perdio aunque la persona haya cerrado la app.
  static Future<UserCredential> registrarse(
    String email,
    String contrasena,
    String nombre,
  ) async {
    final UserCredential credencial = await _auth.createUserWithEmailAndPassword(
      email: email.trim().toLowerCase(),
      password: contrasena,
    );
    await credencial.user?.updateDisplayName(nombre.trim());
    // Token nuevo para que el displayName recien puesto viaje adentro.
    await tokenActual(forzarRefresco: true);
    return credencial;
  }

  /// El nombre que le mandamos al backend en /v1/auth/registro.
  /// Si por lo que sea no hay displayName (una cuenta vieja), usamos la parte
  /// del email antes del arroba. Tiene que medir 2 a 60 caracteres: ese rango
  /// exacto esta en el modelo, en las reglas y en el contrato.
  static String nombreParaRegistro() {
    final User? u = _auth.currentUser;
    String nombre = (u?.displayName ?? '').trim();
    if (nombre.length < 2) {
      final String email = u?.email ?? '';
      nombre = email.contains('@') ? email.split('@').first : email;
    }
    if (nombre.length < 2) nombre = 'Usuario';
    if (nombre.length > 60) nombre = nombre.substring(0, 60);
    return nombre;
  }

  /// Cerrar sesion. Primero se corta la vigilancia y despues se sale: al reves,
  /// el listener queda un instante escuchando un documento que ya no podemos
  /// leer y salta un permission-denied en la consola.
  static Future<void> salir() async {
    await dejarDeVigilarClaims();
    await _auth.signOut();
  }

  // --- vigilancia de los claims ----------------------------------------------

  /// Escucha usuarios/{uid} y, cuando cambia claimsActualizadoEn, pide un
  /// token nuevo. Es idempotente: llamarla dos veces no deja dos listeners.
  static void vigilarClaims(String uid) {
    if (_vigilancia != null) return;
    _ultimoClaims = null;

    _vigilancia = _db.collection('usuarios').doc(uid).snapshots().listen(
      (DocumentSnapshot<Map<String, dynamic>> doc) async {
        final Map<String, dynamic>? datos = doc.data();
        if (datos == null) return;

        final Object? marca = datos['claimsActualizadoEn'];
        if (marca is! Timestamp) return;

        // La primera vez solo anotamos el valor: el token recien emitido ya
        // trae los claims al dia, no hace falta pedir otro.
        if (_ultimoClaims == null) {
          _ultimoClaims = marca;
          return;
        }

        if (marca != _ultimoClaims) {
          _ultimoClaims = marca;
          debugPrint('[NeuroDesk] cambiaron los claims: pido un token nuevo.');
          await refrescarToken();
        }
      },
      // TODO stream lleva su onError. Si este se cae en silencio, la persona
      // se queda con el rol viejo y no hay forma de darse cuenta.
      onError: (Object e) {
        debugPrint('[NeuroDesk] se corto la vigilancia de claims: $e');
      },
    );
  }

  static Future<void> dejarDeVigilarClaims() async {
    await _vigilancia?.cancel();
    _vigilancia = null;
    _ultimoClaims = null;
  }

  // --- traduccion de errores --------------------------------------------------

  /// Firebase devuelve codigos en ingles como 'user-not-found'. Mostrarle eso
  /// a la persona es lo mismo que no decirle nada.
  ///
  /// NOTA DE SEGURIDAD: para 'user-not-found' y 'wrong-password' devolvemos EL
  /// MISMO texto a proposito. Si dijeramos "ese mail no existe", cualquiera
  /// podria probar mails hasta descubrir quien tiene cuenta. Firebase moderno
  /// ya devuelve 'invalid-credential' para los dos casos por este mismo motivo.
  static String traducirErrorDeAuth(FirebaseAuthException e) {
    switch (e.code) {
      case 'invalid-email':
        return 'Ese email no parece valido. Revisalo.';
      case 'user-disabled':
        return 'Esta cuenta esta deshabilitada. Hablá con el administrador.';
      case 'user-not-found':
      case 'wrong-password':
      case 'invalid-credential':
        return 'El email o la contrasena no coinciden.';
      case 'email-already-in-use':
        return 'Ya existe una cuenta con ese email. Proba iniciar sesion.';
      case 'weak-password':
        return 'La contrasena es muy corta: poné al menos 6 caracteres.';
      case 'operation-not-allowed':
        return 'El registro con email no esta habilitado en el proyecto.';
      case 'too-many-requests':
        return 'Demasiados intentos. Esperá un minuto y proba de nuevo.';
      case 'network-request-failed':
        return 'No hay conexion. Revisá tu internet.';
      default:
        // El codigo crudo va al log para nosotros, no a la pantalla.
        debugPrint('[NeuroDesk] error de auth sin traducir: ${e.code}');
        return 'No pudimos completar la accion. Proba de nuevo en un rato.';
    }
  }
}
