// ============================================================================
//  main.dart — el arranque BLINDADO
//
//  Este archivo se escribe UNA vez y no se toca mas. Su unico trabajo es que
//  la app NUNCA muestre el cuadro rojo de Flutter, pase lo que pase. En la
//  defensa oral, una pantalla roja llena de texto en ingles arruina la demo
//  aunque el resto ande perfecto.
//
//  LAS TRES CAPAS ANTI-PANTALLA-ROJA (son tres porque atrapan cosas distintas;
//  ninguna reemplaza a las otras):
//
//   1) ErrorWidget.builder  -> es lo que se DIBUJA cuando un build() explota.
//      Por defecto Flutter dibuja el cuadro rojo. Nosotros dibujamos una
//      pantalla amigable en castellano. Es la unica de las tres que cambia lo
//      que se VE.
//
//   2) FlutterError.onError -> se dispara cuando el framework detecta un error
//      (en un build, un layout, un gesto...). No dibuja nada: sirve para
//      loguearlo. Si algun dia sumamos Crashlytics, se engancha aca.
//
//   3) PlatformDispatcher.instance.onError -> atrapa los errores ASINCRONICOS
//      que se escaparon de todos los try/catch (un Future que quedo sin await,
//      un stream sin onError). Son los que en Dart "tumban la zona" y matan la
//      app entera. Devolvemos true = "lo manejamos nosotros, no lo propagues".
//
//  Ninguna de las tres es una excusa para no poner try/catch: son la red de
//  abajo del trapecio, no el trapecio.
// ============================================================================

import 'dart:ui';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import 'pantallas/home.dart';
import 'pantallas/login.dart';
import 'pantallas/sin_workspace.dart';
import 'servicios/api.dart';
import 'servicios/auth_servicio.dart';
import 'tema.dart';

// ---------------------------------------------------------------------------
// firebase_options.dart NO esta en el repo A PROPOSITO: lo genera el comando
// `flutterfire configure` en cada maquina y trae los ids del proyecto de
// Firebase. Esta explicado en el README.
//
// En Android alcanza con el archivo android/app/google-services.json que
// tambien genera ese comando, y por eso Firebase.initializeApp() anda sin
// pasarle opciones. Para correr en WEB o en iOS hay que descomentar estas dos
// lineas (la de arriba y la de abajo, marcada con [1]):
//
// import 'firebase_options.dart';
// ---------------------------------------------------------------------------

Future<void> main() async {
  // Obligatorio antes de cualquier await previo a runApp: engancha Flutter con
  // el motor. Sin esto, Firebase.initializeApp() tira un error de binding.
  WidgetsFlutterBinding.ensureInitialized();

  // ---- CAPA 1: que se dibuja cuando un build() explota ----------------------
  ErrorWidget.builder = (FlutterErrorDetails detalles) {
    debugPrint('[NeuroDesk] build roto: ${detalles.exception}');
    return const _PantallaAmigableDeError(
      titulo: 'Se rompio esta pantalla',
      detalle: 'Volve atras y proba de nuevo. Tus datos estan guardados.',
    );
  };

  // ---- CAPA 2: log de los errores del framework -----------------------------
  FlutterError.onError = (FlutterErrorDetails detalles) {
    // presentError es el log lindo de siempre: lo dejamos para poder debuggear.
    FlutterError.presentError(detalles);
    debugPrint('[NeuroDesk] error de Flutter: ${detalles.exception}');
  };

  // ---- CAPA 3: los errores asincronicos que se escaparon --------------------
  PlatformDispatcher.instance.onError = (Object error, StackTrace pila) {
    debugPrint('[NeuroDesk] error asincronico sin atrapar: $error');
    debugPrint('$pila');
    return true; // true = ya lo manejamos, no mates la app.
  };

  // ---- Firebase -------------------------------------------------------------
  bool firebaseListo = true;
  try {
    // [1] Para web/iOS: await Firebase.initializeApp(
    //         options: DefaultFirebaseOptions.currentPlatform);
    await Firebase.initializeApp();

    // Persistencia offline: los items que ya se vieron quedan en el telefono,
    // asi la lista abre al instante y se puede seguir usando en el patio de la
    // escuela sin senal. Firestore encola las escrituras y las manda solas
    // cuando vuelve la conexion.
    FirebaseFirestore.instance.settings = const Settings(
      persistenceEnabled: true,
      cacheSizeBytes: Settings.CACHE_SIZE_UNLIMITED,
    );
  } catch (e) {
    // Si Firebase no arranca no hay app posible, pero igual mostramos una
    // pantalla explicando por que, en vez de un crash al abrir.
    firebaseListo = false;
    debugPrint('[NeuroDesk] no arranco Firebase: $e');
  }

  // Empujon a Render para que se despierte mientras la persona escribe su mail
  // (el plan free duerme a los 15 minutos y el primer pedido tarda hasta 60 s).
  // Sin await A PROPOSITO: no queremos frenar el arranque de la app por esto.
  if (firebaseListo) {
    unawaited(Api.despertarBackend());
  }

  runApp(AppNeuroDesk(firebaseListo: firebaseListo));
}

/// `unawaited` propio para no depender de dart:async solo por esta linea.
/// Deja escrito que el Future se ignora A PROPOSITO (y no por olvido).
void unawaited(Future<void> futuro) {
  futuro.catchError((Object e) {
    debugPrint('[NeuroDesk] tarea de fondo fallo: $e');
  });
}

class AppNeuroDesk extends StatelessWidget {
  const AppNeuroDesk({super.key, required this.firebaseListo});

  final bool firebaseListo;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'NeuroDesk AI',
      debugShowCheckedModeBanner: false,
      theme: temaNeuroDesk(),
      home: firebaseListo
          ? const Puerta()
          : const _PantallaAmigableDeError(
              titulo: 'No pudimos conectar con el servidor',
              detalle:
                  'Cerra la app y volve a abrirla. Si sigue igual, revisa la '
                  'configuracion de Firebase (google-services.json).',
            ),
    );
  }
}

// ============================================================================
//  LA PUERTA — decide que pantalla va
//
//  Es el unico lugar de la app donde se decide "login / sin workspace / home".
//  Si esa decision estuviera repartida en varias pantallas, cada una podria
//  contestar distinto y la app terminaria navegando sola a lugares raros.
//
//  El camino completo:
//    sin sesion            -> LoginPantalla
//    sesion sin ficha      -> "Preparando tu cuenta..." (POST /v1/auth/registro)
//    ficha sin workspaces  -> SinWorkspacePantalla
//    todo ok               -> HomePantalla
// ============================================================================
class Puerta extends StatefulWidget {
  const Puerta({super.key});

  @override
  State<Puerta> createState() => _PuertaState();
}

class _PuertaState extends State<Puerta> {
  // REGLA DE ORO DEL PROYECTO: el stream se crea UNA vez, en initState.
  // Si se creara adentro de build(), cada setState armaria un stream NUEVO:
  // se desuscribe del viejo, se suscribe de nuevo, parpadea el spinner y —con
  // Firestore— se paga una lectura de mas cada vez.
  late final Stream<User?> _sesion;

  @override
  void initState() {
    super.initState();
    _sesion = AuthServicio.cambiosDeSesion;
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<User?>(
      stream: _sesion,
      builder: (BuildContext context, AsyncSnapshot<User?> snapshot) {
        // 1) El error PRIMERO, siempre. Es la parte que mas se olvida.
        if (snapshot.hasError) {
          return const Scaffold(
            body: ErrorMensaje(error: 'auth'),
          );
        }
        // 2) Todavia no sabemos si hay sesion: spinner.
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const _PantallaCargando(texto: 'Abriendo NeuroDesk...');
        }
        // 3) No hay nadie logueado.
        final User? usuario = snapshot.data;
        if (usuario == null) {
          // La vigilancia del doc se corta en el dispose() de _PuertaDelUsuario
          // (y tambien en AuthServicio.salir()): en build() no se hacen cosas
          // con efectos, porque build() se puede llamar muchas veces seguidas.
          return const LoginPantalla();
        }
        // 4) Hay sesion: seguimos en la puerta de adentro, que es otro
        //    StatefulWidget para poder crear SU stream en SU initState.
        //    La key con el uid es importante: si se cambia de cuenta, Flutter
        //    tiene que tirar el State viejo (con el stream del uid anterior) y
        //    crear uno nuevo. Sin la key reusaria el State y seguiria
        //    escuchando la ficha del usuario anterior.
        return _PuertaDelUsuario(key: ValueKey<String>(usuario.uid), uid: usuario.uid);
      },
    );
  }
}

/// Segunda mitad de la puerta: ya hay sesion, ahora miramos la ficha
/// usuarios/{uid} para saber a que workspace entrar.
class _PuertaDelUsuario extends StatefulWidget {
  const _PuertaDelUsuario({super.key, required this.uid});

  final String uid;

  @override
  State<_PuertaDelUsuario> createState() => _PuertaDelUsuarioState();
}

class _PuertaDelUsuarioState extends State<_PuertaDelUsuario> {
  late final Stream<DocumentSnapshot<Map<String, dynamic>>> _ficha;

  /// true mientras se esta llamando a POST /v1/auth/registro.
  bool _creandoFicha = false;

  /// Mensaje del ultimo intento fallido de crear la ficha.
  String? _errorDeFicha;

  @override
  void initState() {
    super.initState();
    _ficha = AuthServicio.streamMiFicha(widget.uid);
    // Desde aca y hasta el logout, la app escucha su propio doc para refrescar
    // el token cuando el backend cambia los claims.
    AuthServicio.vigilarClaims(widget.uid);
  }

  @override
  void dispose() {
    // Se cierra la sesion o se cambia de cuenta: hay que soltar el listener.
    // Un listener vivo sobre el doc de alguien que ya no esta logueado tira
    // permission-denied en loop en la consola.
    AuthServicio.dejarDeVigilarClaims();
    super.dispose();
  }

  /// Pide al backend que cree usuarios/{uid}. Es la UNICA forma de crearlo.
  /// Puede tardar hasta 60 segundos si Render estaba dormido, por eso la
  /// pantalla dice "Preparando tu cuenta..." y no un spinner pelado.
  Future<void> _crearFicha() async {
    if (_creandoFicha) return; // corta el doble tap
    setState(() {
      _creandoFicha = true;
      _errorDeFicha = null;
    });
    try {
      final RespuestaApi r =
          await Api.registrarUsuario(AuthServicio.nombreParaRegistro());
      if (!mounted) return; // la pantalla se pudo cerrar durante el await
      if (!r.ok) {
        setState(() => _errorDeFicha = r.mensaje);
      }
      // Si salio bien no hacemos nada: el StreamBuilder de abajo ve aparecer
      // el documento y redibuja solo. La fuente de verdad es Firestore.
    } catch (e) {
      if (!mounted) return;
      setState(() => _errorDeFicha = 'No pudimos preparar tu cuenta. Proba de nuevo.');
    } finally {
      if (mounted) setState(() => _creandoFicha = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
      stream: _ficha,
      builder: (
        BuildContext context,
        AsyncSnapshot<DocumentSnapshot<Map<String, dynamic>>> snapshot,
      ) {
        if (snapshot.hasError) {
          return Scaffold(
            body: ErrorMensaje(
              error: snapshot.error!,
              alReintentar: () => AuthServicio.salir(),
            ),
          );
        }
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const _PantallaCargando(texto: 'Cargando tu cuenta...');
        }

        final DocumentSnapshot<Map<String, dynamic>>? doc = snapshot.data;

        // --- La ficha todavia no existe: la crea el backend -----------------
        if (doc == null || !doc.exists) {
          return _PantallaPreparandoCuenta(
            trabajando: _creandoFicha,
            error: _errorDeFicha,
            alReintentar: _crearFicha,
          );
        }

        final Map<String, dynamic> datos = doc.data() ?? <String, dynamic>{};

        // 'workspaces' es un map wsId -> {rol, nombre}. Se lee con cuidado:
        // un documento a medio escribir no puede tumbar la app entera.
        final Map<String, dynamic> workspaces =
            (datos['workspaces'] is Map) ? Map<String, dynamic>.from(datos['workspaces'] as Map) : <String, dynamic>{};

        if (workspaces.isEmpty) {
          return SinWorkspacePantalla(
            nombre: (datos['nombre'] ?? '').toString(),
            email: (datos['email'] ?? AuthServicio.usuarioActual?.email ?? '').toString(),
          );
        }

        // Cual workspace abrir: el ultimo que uso, y si ese ya no existe (lo
        // sacaron del equipo), el primero de la lista. Sin este chequeo la app
        // entraria a un workspace donde ya no es miembro y Firestore le
        // contestaria permission-denied en todas las consultas.
        String wsId = (datos['workspaceActual'] ?? '').toString();
        if (!workspaces.containsKey(wsId)) {
          wsId = workspaces.keys.first;
        }

        final Map<String, dynamic> ws =
            (workspaces[wsId] is Map) ? Map<String, dynamic>.from(workspaces[wsId] as Map) : <String, dynamic>{};

        return HomePantalla(
          // Otra vez la key: si la persona cambia de workspace, el State viejo
          // (con los streams del workspace anterior) se tira y se crea uno
          // nuevo. Los streams se arman en initState, asi que sin esta key
          // seguirian apuntando al workspace de antes.
          key: ValueKey<String>(wsId),
          wsId: wsId,
          wsNombre: (ws['nombre'] ?? 'Mi equipo').toString(),
          // El rol de aca es solo para DIBUJAR (mostrar o no la pestana del
          // admin). El rol que MANDA lo chequea el backend leyendo
          // members/{uid} en cada pedido, y las reglas lo chequean con el
          // claim del token. La app nunca es la que autoriza.
          rol: (ws['rol'] ?? 'miembro').toString(),
          workspaces: workspaces,
          miUid: widget.uid,
        );
      },
    );
  }
}

// ============================================================================
//  PANTALLAS CHIQUITAS DE APOYO
// ============================================================================

class _PantallaCargando extends StatelessWidget {
  const _PantallaCargando({required this.texto});

  final String texto;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            const CircularProgressIndicator(color: cianElectrico),
            const SizedBox(height: 20),
            Text(texto, style: const TextStyle(color: grisApagado)),
          ],
        ),
      ),
    );
  }
}

/// Se muestra cuando hay sesion pero todavia no existe usuarios/{uid}.
/// Puede tardar hasta un minuto si Render estaba dormido: por eso lo decimos.
class _PantallaPreparandoCuenta extends StatefulWidget {
  const _PantallaPreparandoCuenta({
    required this.trabajando,
    required this.error,
    required this.alReintentar,
  });

  final bool trabajando;
  final String? error;
  final Future<void> Function() alReintentar;

  @override
  State<_PantallaPreparandoCuenta> createState() => _PantallaPreparandoCuentaState();
}

class _PantallaPreparandoCuentaState extends State<_PantallaPreparandoCuenta> {
  @override
  void initState() {
    super.initState();
    // El primer intento sale solo, sin que la persona toque nada.
    // addPostFrameCallback: no se puede llamar a setState mientras se esta
    // construyendo el primer frame, asi que lo encolamos para apenas termine.
    WidgetsBinding.instance.addPostFrameCallback((_) => widget.alReintentar());
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              const Icon(Icons.psychology_alt, size: 64, color: cianElectrico),
              const SizedBox(height: 24),
              const Text(
                'Preparando tu cuenta...',
                style: TextStyle(
                  color: grisClaro,
                  fontSize: 20,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 12),
              const Text(
                'La primera vez puede tardar hasta un minuto: el servidor '
                'gratuito se duerme cuando no lo usa nadie.',
                textAlign: TextAlign.center,
                style: TextStyle(color: grisApagado),
              ),
              const SizedBox(height: 24),
              if (widget.trabajando)
                const CircularProgressIndicator(color: cianElectrico),
              if (!widget.trabajando && widget.error != null) ...<Widget>[
                Text(
                  widget.error!,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: colorError),
                ),
                const SizedBox(height: 16),
                FilledButton(
                  onPressed: () => widget.alReintentar(),
                  child: const Text('Reintentar'),
                ),
              ],
              const SizedBox(height: 24),
              TextButton(
                onPressed: () => AuthServicio.salir(),
                child: const Text('Cerrar sesion'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// La pantalla que reemplaza al cuadro rojo de Flutter (CAPA 1).
///
/// OJO: ErrorWidget.builder puede dispararse ANTES de que exista el
/// MaterialApp (por ejemplo si explota el primer build). Por eso este widget
/// NO usa Scaffold ni nada de Material: se arma con Directionality + ColoredBox
/// + Text, que funcionan solos. Si usara Scaffold, el widget de error tiraria
/// otro error y quedariamos en un bucle.
class _PantallaAmigableDeError extends StatelessWidget {
  const _PantallaAmigableDeError({required this.titulo, required this.detalle});

  final String titulo;
  final String detalle;

  @override
  Widget build(BuildContext context) {
    return Directionality(
      textDirection: TextDirection.ltr,
      child: ColoredBox(
        color: azulNoche,
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const Icon(Icons.sentiment_dissatisfied, color: cianElectrico, size: 56),
                const SizedBox(height: 20),
                Text(
                  titulo,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: grisClaro,
                    fontSize: 20,
                    fontWeight: FontWeight.w600,
                    decoration: TextDecoration.none,
                  ),
                ),
                const SizedBox(height: 12),
                Text(
                  detalle,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    color: grisApagado,
                    fontSize: 14,
                    decoration: TextDecoration.none,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
