// ============================================================================
//  widget_test.dart — las pruebas que corren con 'flutter test'
//
//  POR QUE ESTE ARCHIVO SE LLAMA ASI: 'flutter create' crea un
//  test/widget_test.dart de ejemplo (el del contador, que busca un MyApp que
//  aca no existe) SOLO si no hay uno. Reemplazandolo en vez de borrarlo, si
//  alguien vuelve a correr 'flutter create .' no reaparece el test roto.
//
//  QUE SE PRUEBA Y QUE NO: estas pruebas corren en la compu, sin celular, sin
//  Firebase y sin internet. Por eso prueban lo que NO depende de Firebase:
//    - que la app arranque y muestre la pantalla amigable si Firebase falla
//      (la capa anti pantalla roja de main.dart);
//    - que el login dibuje el logo OFICIAL (el PNG de la marca) y no un icono;
//    - la regla del nombre que se le manda a POST /v1/auth/registro;
//    - la traduccion de errores de Firebase y de Google a castellano;
//    - el boton "Documento" de la captura: que decida 'pdf' o 'word' por la
//      extension, que frene el .doc viejo, y que la pantalla se dibuje (la
//      captura solo toca Firebase al guardar, no al dibujarse).
//  El login con Google de verdad (hoja de cuentas, SHA-1, token) solo se
//  puede probar en un celular: esta en el checklist de QA del README.
//
//  OJO: AuthServicio tiene 'static final _auth = FirebaseAuth.instance', pero
//  en Dart los static final se crean recien la primera vez que se usan. Las
//  funciones que probamos no los tocan, asi que Firebase nunca se inicializa.
// ============================================================================

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_sign_in/google_sign_in.dart';

import 'package:neurodesk/main.dart';
import 'package:neurodesk/pantallas/captura.dart';
import 'package:neurodesk/pantallas/login.dart';
import 'package:neurodesk/servicios/auth_servicio.dart';
import 'package:neurodesk/tema.dart';

void main() {
  testWidgets('Si Firebase no arranco, se ve la pantalla amigable (no la roja)',
      (WidgetTester tester) async {
    await tester.pumpWidget(const AppNeuroDesk(firebaseListo: false));

    expect(find.text('No pudimos conectar con el servidor'), findsOneWidget);
  });

  // El login dibuja el PNG OFICIAL de la marca, no un icono de Material.
  // LoginPantalla no toca Firebase al dibujarse (solo al tocar un boton), asi
  // que se puede armar en la compu sin inicializar nada.
  testWidgets('El login muestra el logo oficial (el PNG) y no un icono generico',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(theme: temaNeuroDesk(), home: const LoginPantalla()),
    );

    expect(find.byType(LogoNeuroDesk), findsOneWidget);
    expect(find.image(const AssetImage(isotipoOscuro)), findsOneWidget);
    expect(find.byIcon(Icons.psychology), findsNothing);
    expect(find.text('Contraseña'), findsOneWidget);
  });

  group('armarNombreParaRegistro (el backend pide 2 a 60 caracteres)', () {
    test('usa el nombre de la cuenta, sin espacios de mas', () {
      expect(
        AuthServicio.armarNombreParaRegistro(
          displayName: '  Martin Ramirez ',
          email: 'martin@gmail.com',
        ),
        'Martin Ramirez',
      );
    });

    test('sin nombre (o de 1 letra) usa lo que esta antes del arroba', () {
      expect(
        AuthServicio.armarNombreParaRegistro(
          displayName: null,
          email: 'vale.mattio@gmail.com',
        ),
        'vale.mattio',
      );
      expect(
        AuthServicio.armarNombreParaRegistro(
          displayName: 'V',
          email: 'vale@gmail.com',
        ),
        'vale',
      );
    });

    test('si tampoco alcanza el email, queda "Usuario"', () {
      expect(
        AuthServicio.armarNombreParaRegistro(displayName: '', email: 'a@b.com'),
        'Usuario',
      );
      expect(AuthServicio.armarNombreParaRegistro(), 'Usuario');
    });

    test('un nombre larguisimo se corta en 60', () {
      final String largo = 'Juan Cruz ' * 10; // 100 caracteres
      final String nombre =
          AuthServicio.armarNombreParaRegistro(displayName: largo);
      expect(nombre.length, lessThanOrEqualTo(60));
      expect(nombre.length, greaterThanOrEqualTo(2));
      // Mismo chequeo que hace el backend: trim() y despues medir.
      expect(nombre, nombre.trim());
    });
  });

  group('traducirErrorDeAuth', () {
    test('con email: no revela si el mail existe', () {
      final String a = AuthServicio.traducirErrorDeAuth(
        FirebaseAuthException(code: 'user-not-found'),
      );
      final String b = AuthServicio.traducirErrorDeAuth(
        FirebaseAuthException(code: 'wrong-password'),
      );
      expect(a, b);
      expect(a, startsWith('El email o la contraseña no coinciden.'));
    });

    test('con Google, invalid-credential NO habla de contrasena', () {
      final String texto = AuthServicio.traducirErrorDeAuth(
        FirebaseAuthException(code: 'invalid-credential'),
        conGoogle: true,
      );
      expect(texto, isNot(contains('contraseña')));
      expect(texto, contains('Google'));
    });

    test('los codigos que no cambian con Google se traducen igual', () {
      final FirebaseAuthException sinRed =
          FirebaseAuthException(code: 'network-request-failed');
      expect(
        AuthServicio.traducirErrorDeAuth(sinRed, conGoogle: true),
        AuthServicio.traducirErrorDeAuth(sinRed),
      );
    });

    test('cuenta existente con otro proveedor tiene su propio mensaje', () {
      expect(
        AuthServicio.traducirErrorDeAuth(
          FirebaseAuthException(code: 'account-exists-with-different-credential'),
          conGoogle: true,
        ),
        startsWith('Ya tenés una cuenta con ese email.'),
      );
    });

    test('un codigo desconocido no muestra el codigo crudo', () {
      final String texto = AuthServicio.traducirErrorDeAuth(
        FirebaseAuthException(code: 'algo-que-no-existe'),
      );
      expect(texto, isNot(contains('algo-que-no-existe')));
    });
  });

  group('traducirErrorDeGoogle', () {
    test('mala configuracion (SHA-1, Play services) manda a entrar con email', () {
      for (final GoogleSignInExceptionCode codigo in <GoogleSignInExceptionCode>[
        GoogleSignInExceptionCode.clientConfigurationError,
        GoogleSignInExceptionCode.providerConfigurationError,
      ]) {
        expect(
          AuthServicio.traducirErrorDeGoogle(GoogleSignInException(code: codigo)),
          contains('Entrá con tu email'),
        );
      }
    });

    test('celular sin cuentas de Google', () {
      expect(
        AuthServicio.traducirErrorDeGoogle(
          const GoogleSignInException(
            code: GoogleSignInExceptionCode.unknownError,
            description: 'No credential available: no hay cuentas',
          ),
        ),
        startsWith('No hay ninguna cuenta de Google en este celular.'),
      );
    });

    test('todos los codigos tienen un texto en castellano (ninguno vacio)', () {
      for (final GoogleSignInExceptionCode codigo
          in GoogleSignInExceptionCode.values) {
        final String texto =
            AuthServicio.traducirErrorDeGoogle(GoogleSignInException(code: codigo));
        expect(texto, isNotEmpty);
        expect(texto, isNot(contains(codigo.name)));
      }
    });
  });

  // El boton "Documento" acepta PDF y Word, pero en Firestore se guarda 'pdf'
  // o 'word'. Si esto se equivoca, el item nace con el tipo cambiado y el
  // backend le aplica el extractor que no corresponde.
  group('CapturaPantalla.tipoDeDocumento (boton Documento)', () {
    test('.pdf es pdf y .docx es word, con mayusculas o sin', () {
      expect(CapturaPantalla.tipoDeDocumento('Cronograma.pdf'), 'pdf');
      expect(CapturaPantalla.tipoDeDocumento('ACTA FINAL.PDF'), 'pdf');
      expect(CapturaPantalla.tipoDeDocumento('Trabajo practico.docx'), 'word');
      expect(CapturaPantalla.tipoDeDocumento('Informe.DocX'), 'word');
    });

    test('el .doc viejo y cualquier otra cosa no pasan (null)', () {
      expect(CapturaPantalla.tipoDeDocumento('viejo.doc'), isNull);
      expect(CapturaPantalla.tipoDeDocumento('planilla.xlsx'), isNull);
      expect(CapturaPantalla.tipoDeDocumento('trampa.docx.exe'), isNull);
      expect(CapturaPantalla.tipoDeDocumento('sin extension'), isNull);
      expect(CapturaPantalla.tipoDeDocumento(''), isNull);
    });
  });

  test('iconoDeTipo: word tiene icono propio (no cae en el de la nota)', () {
    expect(iconoDeTipo('pdf'), Icons.picture_as_pdf);
    expect(iconoDeTipo('word'), Icons.description);
    expect(iconoDeTipo('word'), isNot(iconoDeTipo('nota')));
    expect(iconoDeTipo('word'), isNot(iconoDeTipo('pdf')));
  });

  testWidgets('Captura: el chip dice Documento y abre el selector de PDF o Word',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: temaNeuroDesk(),
        home: const CapturaPantalla(wsId: 'ws-prueba', miUid: 'uid-prueba'),
      ),
    );

    // Arranca en "Nota": el bloque del documento todavia no esta.
    expect(find.text('Documento'), findsOneWidget);
    expect(find.text('PDF'), findsNothing); // el chip viejo ya no existe
    expect(find.text('Elegir un PDF o un Word'), findsNothing);

    await tester.tap(find.text('Documento'));
    await tester.pump();

    expect(find.text('Elegir un PDF o un Word'), findsOneWidget);
    expect(find.textContaining('(.docx)'), findsOneWidget);
  });
}
