// ============================================================================
//  auth_servicio.dart — todo lo de la sesion en un solo lugar
//
//  Entrar (con email o con Google), registrarse, salir, conseguir el ID token
//  y —la parte fina— VIGILAR el propio documento usuarios/{uid} para refrescar
//  el token cuando el backend cambia los custom claims.
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
//
//  ------------------------------------------------------------------------
//  COMO FUNCIONA "CONTINUAR CON GOOGLE" (tambien para la defensa):
//  Android muestra la hoja con las cuentas de Google que ya estan en el
//  telefono. Google nos da un ID TOKEN firmado que prueba quien es la persona,
//  se lo pasamos a Firebase y Firebase lo verifica y crea (o encuentra) el
//  usuario. Desde ahi es IGUAL al login con email: la Puerta de main.dart ve la
//  sesion nueva, no encuentra la ficha usuarios/{uid} y llama a
//  POST /v1/auth/registro. Por eso no hay una "pantalla de registro con
//  Google" ni otra llamada al backend: se reusa el mismo camino.
//  ------------------------------------------------------------------------
// ============================================================================

import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';
import 'package:google_sign_in/google_sign_in.dart';

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

  /// La inicializacion de Google, guardada para hacerla UNA sola vez.
  /// La API 7.x de google_sign_in obliga a llamar initialize() exactamente una
  /// vez y a esperar que termine antes de authenticate() o signOut(). Guardando
  /// el Future, si dos lugares la piden a la vez, los dos esperan a la misma.
  static Future<void>? _googleIniciado;

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

  /// "Continuar con Google". Sirve para entrar Y para crear la cuenta: Google
  /// no distingue, y Firebase crea el usuario la primera vez que lo ve.
  ///
  /// Devuelve null si la persona cerro el selector de cuentas: eso NO es un
  /// error y la pantalla no tiene que mostrar ningun cartel.
  ///
  /// La PRIMERA VEZ no llamamos al backend desde aca A PROPOSITO: lo hace la
  /// Puerta de main.dart cuando ve que no existe usuarios/{uid}, igual que con
  /// el registro por email, y le manda nombreParaRegistro(), que con Google es
  /// el nombre de la cuenta. La Puerta mira si existe la FICHA (y no si
  /// Firebase dice "usuario nuevo"), asi que si el registro fallo una vez, el
  /// proximo ingreso lo vuelve a intentar solo. El endpoint es idempotente.
  ///
  /// Como el resto de esta clase, deja subir las excepciones para que la
  /// pantalla las traduzca: GoogleSignInException (antes de llegar a Firebase)
  /// con traducirErrorDeGoogle() y FirebaseAuthException con
  /// traducirErrorDeAuth(e, conGoogle: true).
  static Future<UserCredential?> entrarConGoogle() async {
    await _prepararGoogle();
    // En Android siempre da true; en otras plataformas (web) authenticate()
    // no existe y hay que usar el boton propio de Google. La entrega es
    // Android, pero mejor un mensaje claro que una excepcion rara.
    if (!GoogleSignIn.instance.supportsAuthenticate()) {
      throw const GoogleSignInException(
        code: GoogleSignInExceptionCode.providerConfigurationError,
        description: 'authenticate() no esta soportado en esta plataforma',
      );
    }

    final GoogleSignInAccount cuenta;
    try {
      // La 7.x devuelve una cuenta NO nula o tira una excepcion (la 6.x
      // devolvia null al cancelar).
      cuenta = await GoogleSignIn.instance.authenticate();
    } on GoogleSignInException catch (e) {
      if (e.code == GoogleSignInExceptionCode.canceled) {
        // OJO: segun el README de google_sign_in_android, una SHA-1 que no
        // esta registrada en Firebase TAMBIEN llega como 'canceled' (despues
        // de elegir la cuenta) y el plugin no lo puede distinguir. Por eso
        // queda en el log: si "no pasa nada" al elegir la cuenta, es eso.
        debugPrint('[NeuroDesk] Google cancelado: ${e.description}');
        return null;
      }
      rethrow;
    }

    // En la 7.x 'authentication' ya no es un Future y solo trae el idToken
    // (el accessToken es para llamar a APIs de Google: no lo necesitamos).
    final String? idToken = cuenta.authentication.idToken;
    if (idToken == null) {
      throw FirebaseAuthException(
        code: 'google-sin-token',
        message: 'Google no devolvio el ID token.',
      );
    }
    final OAuthCredential credencial =
        GoogleAuthProvider.credential(idToken: idToken);
    return _auth.signInWithCredential(credencial);
  }

  /// Llama a GoogleSignIn.instance.initialize() una sola vez en toda la vida
  /// de la app (ver _googleIniciado).
  ///
  /// Sin serverClientId A PROPOSITO: en Android el plugin lo lee solo del
  /// recurso default_web_client_id, que genera el plugin de Gradle
  /// com.google.gms.google-services a partir del google-services.json (el
  /// oauth_client con client_type 3, o sea el "client ID web"). Asi no queda
  /// ningun id pegado en el codigo. Si algun dia sale 'serverClientId must be
  /// provided on Android', falta ese client_type 3: hay que volver a bajar el
  /// google-services.json de la consola de Firebase.
  static Future<void> _prepararGoogle() async {
    final Future<void> enCurso =
        _googleIniciado ??= GoogleSignIn.instance.initialize();
    try {
      await enCurso;
    } catch (_) {
      // Si fallo, lo olvidamos para que el proximo toque lo vuelva a intentar
      // en vez de quedar roto hasta cerrar la app.
      _googleIniciado = null;
      rethrow;
    }
  }

  /// El nombre que le mandamos al backend en /v1/auth/registro, armado con la
  /// sesion actual (con Google, el displayName es el nombre de la cuenta).
  static String nombreParaRegistro() {
    final User? u = _auth.currentUser;
    return armarNombreParaRegistro(displayName: u?.displayName, email: u?.email);
  }

  /// La regla del nombre, separada de Firebase para poder probarla en
  /// test/widget_test.dart sin un celular.
  ///
  /// Tiene que medir 2 a 60 caracteres DESPUES de trim(): ese rango exacto
  /// esta en el modelo, en las reglas y en el contrato, y el backend hace
  /// trim() antes de medir. Si no hay displayName (una cuenta vieja, o una
  /// cuenta de Google sin nombre) usamos la parte del email antes del arroba.
  /// Siempre devuelve algo valido: el backend nunca contesta DATOS_INVALIDOS.
  static String armarNombreParaRegistro({String? displayName, String? email}) {
    String nombre = (displayName ?? '').trim();
    if (nombre.length < 2) {
      final String mail = (email ?? '').trim();
      nombre = mail.contains('@') ? mail.split('@').first : mail;
    }
    // trim() otra vez DESPUES de recortar: si el corte cae justo en un
    // espacio, el backend lo sacaria y el nombre podria quedar distinto.
    if (nombre.length > 60) nombre = nombre.substring(0, 60).trim();
    if (nombre.length < 2) nombre = 'Usuario';
    return nombre;
  }

  /// Cerrar sesion. Primero se corta la vigilancia y despues se sale: al reves,
  /// el listener queda un instante escuchando un documento que ya no podemos
  /// leer y salta un permission-denied en la consola.
  ///
  /// Despues de Firebase se "olvida" la cuenta de Google (ver
  /// _olvidarCuentaDeGoogle). Va en el finally para que corra aunque falle el
  /// signOut de Firebase, y DESPUES de Firebase (como en la doc de Firebase
  /// para Android) para que un problema de Google nunca deje a la persona
  /// sin poder cerrar sesion.
  static Future<void> salir() async {
    await dejarDeVigilarClaims();
    try {
      await _auth.signOut();
    } finally {
      await _olvidarCuentaDeGoogle();
    }
  }

  /// signOut() de Google limpia el estado del Credential Manager de Android
  /// (clearCredentialState): sin esto, Android puede ofrecer sola la misma
  /// cuenta la proxima vez. Si la persona entro con email no hace nada malo.
  ///
  /// NO usamos disconnect(): ese le revoca los permisos a la app y obliga a
  /// pasar otra vez por la pantalla de consentimiento. Es para un "borrar mi
  /// cuenta", no para un logout comun.
  ///
  /// Nunca tira: si falla, la sesion de Firebase ya se cerro igual.
  static Future<void> _olvidarCuentaDeGoogle() async {
    try {
      await _prepararGoogle();
      await GoogleSignIn.instance.signOut();
    } catch (e) {
      debugPrint('[NeuroDesk] no se pudo limpiar la sesion de Google: $e');
    }
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
  ///
  /// `conGoogle: true` cuando el error vino de entrarConGoogle(): algunos
  /// codigos significan OTRA cosa ahi. Por ejemplo 'invalid-credential' con
  /// Google no es "contrasena mal" (no hay contrasena), es que Firebase no
  /// acepto el token de Google; decirle "el email o la contrasena no
  /// coinciden" a alguien que toco el boton de Google lo confunde.
  static String traducirErrorDeAuth(
    FirebaseAuthException e, {
    bool conGoogle = false,
  }) {
    if (conGoogle) {
      switch (e.code) {
        case 'invalid-credential':
          return 'Google no pudo confirmar tu cuenta. Proba de nuevo.';
        case 'operation-not-allowed':
          return 'El ingreso con Google no esta habilitado en el proyecto.';
      }
      // El resto de los codigos dicen lo mismo con o sin Google: siguen abajo.
    }
    switch (e.code) {
      case 'invalid-email':
        return 'Ese email no parece valido. Revisalo.';
      case 'user-disabled':
        return 'Esta cuenta esta deshabilitada. Hablá con el administrador.';
      case 'user-not-found':
      case 'wrong-password':
      case 'invalid-credential':
        // La pista de Google no rompe la nota de seguridad: es la misma para
        // todos y no dice si ese mail tiene cuenta o no.
        return 'El email o la contrasena no coinciden. '
            'Si te registraste con Google, usa ese boton.';
      case 'email-already-in-use':
        return 'Ya existe una cuenta con ese email. Proba iniciar sesion '
            '(con tu contrasena o con Google).';
      case 'account-exists-with-different-credential':
        // Pasa si el email ya tiene cuenta en Firebase con otra forma de
        // entrar y Firebase no las puede unir sola.
        return 'Ya tenes una cuenta con ese email. Entra con tu email y '
            'contrasena.';
      case 'google-sin-token':
        // Este codigo es NUESTRO (lo tira entrarConGoogle), no de Firebase.
        return 'Google no nos paso los datos de tu cuenta. Proba de nuevo.';
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

  /// Los errores propios de Google, los que pasan ANTES de llegar a Firebase
  /// (no son FirebaseAuthException, por eso van en una funcion aparte).
  ///
  /// El default es obligatorio: la doc del paquete avisa que el enum puede
  /// sumar codigos nuevos en cualquier version.
  static String traducirErrorDeGoogle(GoogleSignInException e) {
    switch (e.code) {
      case GoogleSignInExceptionCode.canceled:
        // entrarConGoogle() ya convierte la cancelacion en null; esto queda
        // por si algun dia se llama desde otro lado.
        return 'Se cancelo el ingreso con Google.';
      case GoogleSignInExceptionCode.clientConfigurationError:
      case GoogleSignInExceptionCode.providerConfigurationError:
        // Casi siempre es configuracion: falta el client ID web en el
        // google-services.json, o el celular no tiene Google Play services.
        debugPrint('[NeuroDesk] Google mal configurado: ${e.description}');
        return 'El ingreso con Google no esta disponible en este celular. '
            'Entra con tu email.';
      case GoogleSignInExceptionCode.interrupted:
      case GoogleSignInExceptionCode.uiUnavailable:
        return 'Se interrumpio el ingreso con Google. Proba de nuevo.';
      case GoogleSignInExceptionCode.unknownError:
        // google_sign_in_android 7.2.11 usa unknownError + este texto cuando
        // el telefono no tiene ninguna cuenta de Google cargada.
        if ((e.description ?? '').startsWith('No credential available')) {
          return 'No hay ninguna cuenta de Google en este celular. Agrega una '
              'en Ajustes o entra con tu email.';
        }
        debugPrint('[NeuroDesk] Google error desconocido: ${e.description}');
        return 'No pudimos entrar con Google. Proba de nuevo en un rato.';
      default:
        debugPrint('[NeuroDesk] Google sin traducir: ${e.code} ${e.description}');
        return 'No pudimos entrar con Google. Proba de nuevo en un rato.';
    }
  }
}
