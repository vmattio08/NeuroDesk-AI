// ============================================================================
//  candado_y_rol_test.dart — el CANDADO EN VIVO y el ARREGLO DE LA KEY
//
//  Sin Firebase y sin internet. Prueban:
//    - que opcion de candado ofrece el menu de cada fila (contrato A): solo
//      el autor comparte; el autor o el admin pasan a privado;
//    - el aviso propio del candado en los errores donde el mensaje general
//      del backend se entenderia mal;
//    - la key de la pantalla principal, que junta el espacio y el rol;
//    - el bug que arregla esa key: con la key vieja (solo el espacio), pasar
//      a un admin a miembro con la app abierta dejaba un TabController de 3
//      con 2 pestanas y la pantalla se rompia. Se reproduce con una pantalla
//      de mentira que arma sus pestanas IGUAL que HomePantalla (en initState),
//      porque HomePantalla de verdad necesita Firebase para arrancar.
// ============================================================================

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neurodesk/main.dart';
import 'package:neurodesk/pantallas/home.dart';

/// Una pantalla con el mismo patron que HomePantalla: la cantidad de
/// pestanas se decide UNA vez, en initState, segun el rol.
class _PantallaConPestanas extends StatefulWidget {
  const _PantallaConPestanas({super.key, required this.rol, required this.alCrear});

  final String rol;
  final VoidCallback alCrear;

  @override
  State<_PantallaConPestanas> createState() => _PantallaConPestanasState();
}

class _PantallaConPestanasState extends State<_PantallaConPestanas>
    with SingleTickerProviderStateMixin {
  late final TabController _pestanas;

  bool get _esAdmin => widget.rol == 'admin';

  @override
  void initState() {
    super.initState();
    widget.alCrear();
    _pestanas = TabController(length: _esAdmin ? 3 : 2, vsync: this);
  }

  @override
  void dispose() {
    _pestanas.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        bottom: TabBar(
          controller: _pestanas,
          tabs: <Widget>[
            const Tab(text: 'Del equipo'),
            const Tab(text: 'Mis notas'),
            if (_esAdmin) const Tab(text: 'Todo'),
          ],
        ),
      ),
      body: TabBarView(
        controller: _pestanas,
        children: <Widget>[
          const Text('equipo'),
          const Text('mias'),
          if (_esAdmin) const Text('todo'),
        ],
      ),
    );
  }
}

void main() {
  group('candadoQueSePuedeCambiar (el menu de cada fila)', () {
    test('el autor de algo privado puede compartirlo con el equipo', () {
      expect(
        HomePantalla.candadoQueSePuedeCambiar(esMio: true, esAdmin: false, visibilidad: 'privado'),
        'equipo',
      );
      // Siendo admin tambien (es suyo).
      expect(
        HomePantalla.candadoQueSePuedeCambiar(esMio: true, esAdmin: true, visibilidad: 'privado'),
        'equipo',
      );
    });

    test('el autor o el admin pueden pasar a privado algo del equipo', () {
      expect(
        HomePantalla.candadoQueSePuedeCambiar(esMio: true, esAdmin: false, visibilidad: 'equipo'),
        'privado',
      );
      expect(
        HomePantalla.candadoQueSePuedeCambiar(esMio: false, esAdmin: true, visibilidad: 'equipo'),
        'privado',
      );
    });

    test('el admin NO comparte lo privado de otro, y un miembro no toca lo ajeno', () {
      expect(
        HomePantalla.candadoQueSePuedeCambiar(esMio: false, esAdmin: true, visibilidad: 'privado'),
        isNull,
      );
      expect(
        HomePantalla.candadoQueSePuedeCambiar(esMio: false, esAdmin: false, visibilidad: 'equipo'),
        isNull,
      );
      expect(
        HomePantalla.candadoQueSePuedeCambiar(esMio: false, esAdmin: false, visibilidad: 'privado'),
        isNull,
      );
    });
  });

  group('avisoDeErrorDelCandado (mensajes claros, decididos por el codigo)', () {
    test('NO_SOS_EL_AUTOR al compartir: solo el autor (el del catalogo habla del admin)', () {
      expect(
        HomePantalla.avisoDeErrorDelCandado('NO_SOS_EL_AUTOR', compartir: true),
        'Solo quien lo subió lo puede compartir con el equipo.',
      );
      // Al pasar a privado el del catalogo ("el autor o un administrador")
      // es verdad: se usa tal cual.
      expect(HomePantalla.avisoDeErrorDelCandado('NO_SOS_EL_AUTOR', compartir: false), isNull);
    });

    test('PROCESO_EN_CURSO: no dice "lo estamos procesando" sino que espere para cambiarlo', () {
      for (final bool compartir in <bool>[true, false]) {
        final String? aviso =
            HomePantalla.avisoDeErrorDelCandado('PROCESO_EN_CURSO', compartir: compartir);
        expect(aviso, contains('cuando termine'));
        expect(aviso, contains('quién lo ve'));
      }
    });

    test('un servidor sin la ruta nueva no invita a reintentar en un rato', () {
      expect(
        HomePantalla.avisoDeErrorDelCandado('RUTA_NO_ENCONTRADA', compartir: true),
        'Esta función todavía no está en el servidor. Probá de nuevo más tarde.',
      );
    });

    test('el resto usa el mensaje del catalogo tal cual (null)', () {
      for (final String codigo in <String>[
        'ITEM_NO_ENCONTRADO',
        'DATOS_INVALIDOS',
        'SIN_CONEXION',
        'TOKEN_INVALIDO',
        'NO_ES_MIEMBRO',
        '',
      ]) {
        expect(HomePantalla.avisoDeErrorDelCandado(codigo, compartir: true), isNull, reason: codigo);
        expect(HomePantalla.avisoDeErrorDelCandado(codigo, compartir: false), isNull, reason: codigo);
      }
    });
  });

  group('claveDelHome: el espacio Y el rol', () {
    test('cambia si cambia el rol o el espacio; es la misma si no cambia nada', () {
      expect(claveDelHome('ws_seed_6to1ra', 'admin'), claveDelHome('ws_seed_6to1ra', 'admin'));
      expect(claveDelHome('ws_seed_6to1ra', 'admin'), isNot(claveDelHome('ws_seed_6to1ra', 'miembro')));
      expect(claveDelHome('ws_a', 'miembro'), isNot(claveDelHome('ws_b', 'miembro')));
      expect(claveDelHome('ws_seed_6to1ra', 'admin'), const ValueKey<String>('ws_seed_6to1ra|admin'));
    });

    testWidgets('con la key nueva, pasar de admin a miembro arma una pantalla nueva y no se rompe',
        (WidgetTester tester) async {
      int creadas = 0;
      Widget armar(String rol) => MaterialApp(
            home: _PantallaConPestanas(
              key: claveDelHome('ws1', rol),
              rol: rol,
              alCrear: () => creadas++,
            ),
          );

      await tester.pumpWidget(armar('admin'));
      expect(find.text('Todo'), findsOneWidget);
      await tester.pumpWidget(armar('admin')); // nada cambio: la misma pantalla
      expect(creadas, 1);

      await tester.pumpWidget(armar('miembro'));
      expect(tester.takeException(), isNull);
      expect(creadas, 2);
      expect(find.text('Todo'), findsNothing);
      expect(find.text('Mis notas'), findsOneWidget);

      await tester.pumpWidget(armar('admin')); // y vuelta a admin
      expect(tester.takeException(), isNull);
      expect(find.text('Todo'), findsOneWidget);
    });

    testWidgets('con la key VIEJA (solo el espacio) la misma pantalla se rompia', (WidgetTester tester) async {
      Widget armar(String rol) => MaterialApp(
            home: _PantallaConPestanas(
              key: const ValueKey<String>('ws1'),
              rol: rol,
              alCrear: () {},
            ),
          );

      await tester.pumpWidget(armar('admin'));

      // Los errores de Flutter se juntan aca en vez de imprimirse: son los
      // que esperamos ver, y asi la salida de 'flutter test' queda limpia.
      final void Function(FlutterErrorDetails)? anterior = FlutterError.onError;
      final List<FlutterErrorDetails> errores = <FlutterErrorDetails>[];
      FlutterError.onError = errores.add;
      await tester.pumpWidget(armar('miembro'));
      FlutterError.onError = anterior;

      // El State viejo sigue vivo con su TabController de 3, pero ahora hay 2
      // pestanas: Flutter avisa que no coinciden (es la pantalla rota).
      expect(errores, isNotEmpty);
      expect(
        errores.first.exceptionAsString(),
        contains("Controller's length property (3) does not match"),
      );
    });
  });
}
