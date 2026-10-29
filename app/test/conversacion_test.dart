// ============================================================================
//  conversacion_test.dart — las pruebas de las preguntas de SEGUIMIENTO
//
//  Corren con 'flutter test' en la compu, sin Firebase y sin internet, igual
//  que widget_test.dart. Por eso prueban lo que NO toca la red:
//    - los campos EXACTOS del documento de una primera pregunta (los 4 de
//      siempre) y de un seguimiento (los 4 + conversacionId y anteriorRespId):
//      son los que mira la regla de Firestore con hasOnly;
//    - de que vuelta se cuelga la pregunta nueva (segunda, tercera, y despues
//      de una que fallo);
//    - la validacion de 3 a 500 caracteres;
//    - cuando se habilita la caja "Preguntá algo más sobre esto…", tambien
//      con el reloj del celular corrido, despues de salir y volver a entrar
//      a la conversacion, sin red y con DEMASIADOS_PEDIDOS (Retry-After);
//    - que el historial tenga una fila por conversacion, aunque la raiz haya
//      quedado afuera de la query;
//    - como se dibuja una vuelta (progreso, error, respuesta con fuentes).
//  La pantalla entera (los dos StreamBuilder sobre Firestore y el POST) solo
//  se puede probar en el emulador o en un celular, con el backend andando:
//  esta en el checklist de QA.
//
//  FieldValue.serverTimestamp(), Timestamp y FirebaseException se pueden
//  crear sin inicializar Firebase: son objetos comunes de Dart que recien
//  viajan al servidor cuando se guarda algo.
// ============================================================================

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neurodesk/pantallas/chat.dart';
import 'package:neurodesk/tema.dart';

/// Una vuelta de mentira: importan el id, el estado y las horas.
///   creadoEn   = hora del SERVIDOR (la del documento);
///   mandadaEn  = hora del CELULAR en que esta app la mando;
///   vistaDesde = hora del CELULAR en que esta app la vio por primera vez.
Vuelta vuelta(
  String id,
  String estado, {
  DateTime? creadoEn,
  DateTime? mandadaEn,
  DateTime? vistaDesde,
  bool pendienteDeSubir = false,
}) {
  return Vuelta(
    id: id,
    pregunta: 'Pregunta $id',
    estado: estado,
    creadoEn: creadoEn,
    mandadaEn: mandadaEn,
    vistaDesde: vistaDesde,
    pendienteDeSubir: pendienteDeSubir,
  );
}

/// Los documentos que trae la query del historial: id -> datos, de la mas
/// nueva a la mas vieja.
MapEntry<String, Map<String, dynamic>> raizDoc(String id) =>
    MapEntry<String, Map<String, dynamic>>(id, <String, dynamic>{'pregunta': 'Raíz $id'});

MapEntry<String, Map<String, dynamic>> seguimientoDoc(String id, String raizId) =>
    MapEntry<String, Map<String, dynamic>>(id, <String, dynamic>{
      'pregunta': 'Seguimiento $id',
      'conversacionId': raizId,
      'anteriorRespId': raizId,
    });

/// Los seis campos que la regla deja escribir en un seguimiento.
const Set<String> camposPermitidosEnSeguimiento = <String>{
  'pregunta',
  'autorUid',
  'estado',
  'creadoEn',
  'conversacionId',
  'anteriorRespId',
};

/// Arma una pantalla minima alrededor de un widget suelto.
Widget enPantalla(Widget hijo) {
  return MaterialApp(
    theme: temaNeuroDesk(),
    home: Scaffold(body: ListView(children: <Widget>[hijo])),
  );
}

void main() {
  // RegistroDePedidos es static (dura lo que la app abierta): cada test
  // arranca con el registro vacio y sin la cuenta regresiva corriendo.
  tearDown(RegistroDePedidos.olvidarTodo);

  group('ChatPantalla.validarPregunta (3 a 500, igual que la regla)', () {
    test('menos de 3 caracteres no pasa (sin contar espacios de los bordes)', () {
      expect(ChatPantalla.validarPregunta(''), isNotNull);
      expect(ChatPantalla.validarPregunta('ab'), isNotNull);
      expect(ChatPantalla.validarPregunta('    ab    '), isNotNull);
    });

    test('de 3 a 500 pasa', () {
      expect(ChatPantalla.validarPregunta('abc'), isNull);
      expect(ChatPantalla.validarPregunta('a' * 500), isNull);
      // Los espacios de los bordes no cuentan: se guarda el texto recortado.
      expect(ChatPantalla.validarPregunta('  ${'a' * 500}  '), isNull);
    });

    test('501 no pasa y el aviso dice el limite', () {
      expect(ChatPantalla.validarPregunta('a' * 501), contains('500'));
    });
  });

  group('campos del documento (los mira la regla con hasOnly)', () {
    test('primera pregunta: EXACTAMENTE los 4 de siempre, sin campos nuevos ni en null', () {
      final Map<String, Object> campos = ChatPantalla.camposDePrimeraPregunta(
        pregunta: '¿Cuándo es la mesa de Matemática?',
        miUid: 'uid-ana',
      );
      expect(campos.keys.toSet(), <String>{'pregunta', 'autorUid', 'estado', 'creadoEn'});
      expect(campos.containsKey('conversacionId'), isFalse);
      expect(campos.containsKey('anteriorRespId'), isFalse);
      expect(campos['estado'], 'buscando');
      expect(campos['autorUid'], 'uid-ana');
      expect(campos['creadoEn'], isA<FieldValue>());
    });

    test('segunda vuelta: conversacionId y anteriorRespId son los dos la raiz', () {
      final Map<String, Object>? campos = ConversacionPantalla.camposDeSeguimiento(
        raizId: 'raiz',
        vueltas: <Vuelta>[vuelta('raiz', 'listo')],
        pregunta: '¿Y para cuándo lo necesitan?',
        miUid: 'uid-ana',
      );
      expect(campos, isNotNull);
      expect(campos!.keys.toSet(), camposPermitidosEnSeguimiento);
      expect(campos['conversacionId'], 'raiz');
      expect(campos['anteriorRespId'], 'raiz');
      expect(campos['pregunta'], '¿Y para cuándo lo necesitan?');
      expect(campos['autorUid'], 'uid-ana');
      expect(campos['estado'], 'buscando');
      expect(campos['creadoEn'], isA<FieldValue>());
      // preguntaBuscada la escribe SOLO el backend.
      expect(campos.containsKey('preguntaBuscada'), isFalse);
    });

    test('tercera vuelta: conversacionId sigue siendo la raiz y anteriorRespId es la segunda', () {
      final Map<String, Object>? campos = ConversacionPantalla.camposDeSeguimiento(
        raizId: 'raiz',
        vueltas: <Vuelta>[vuelta('raiz', 'listo'), vuelta('seg1', 'listo')],
        pregunta: '¿Y cuánto sale?',
        miUid: 'uid-ana',
      );
      expect(campos!.keys.toSet(), camposPermitidosEnSeguimiento);
      expect(campos['conversacionId'], 'raiz');
      expect(campos['anteriorRespId'], 'seg1');
    });

    test('si la ultima fallo, la nueva se cuelga de la ultima LISTA (el backend rechaza una anterior que no este lista)', () {
      final Map<String, Object>? campos = ConversacionPantalla.camposDeSeguimiento(
        raizId: 'raiz',
        vueltas: <Vuelta>[
          vuelta('raiz', 'listo'),
          vuelta('seg1', 'listo'),
          vuelta('seg2', 'error'),
        ],
        pregunta: '¿Y cuánto sale?',
        miUid: 'uid-ana',
      );
      expect(campos!['conversacionId'], 'raiz');
      expect(campos['anteriorRespId'], 'seg1');
    });

    test('si fallo la primera pregunta no hay de donde colgarse: null (no se crea nada)', () {
      expect(
        ConversacionPantalla.camposDeSeguimiento(
          raizId: 'raiz',
          vueltas: <Vuelta>[vuelta('raiz', 'error')],
          pregunta: '¿Y para cuándo?',
          miUid: 'uid-ana',
        ),
        isNull,
      );
      expect(ConversacionPantalla.ultimaVueltaLista(<Vuelta>[]), isNull);
    });
  });

  group('ConversacionPantalla.puedeSeguirPreguntando (la caja de abajo)', () {
    final DateTime ahora = DateTime(2026, 10, 29, 12);

    test('deshabilitada mientras la ultima vuelta esta buscando o redactando', () {
      for (final String estado in <String>['buscando', 'redactando']) {
        expect(
          ConversacionPantalla.puedeSeguirPreguntando(
            <Vuelta>[vuelta('raiz', 'listo'), vuelta('seg1', estado, creadoEn: ahora)],
            ahora: ahora,
          ),
          isFalse,
          reason: 'la ultima esta en $estado',
        );
      }
      // La raiz recien creada, todavia respondiendose.
      expect(
        ConversacionPantalla.puedeSeguirPreguntando(
          <Vuelta>[vuelta('raiz', 'buscando')],
          ahora: ahora,
        ),
        isFalse,
      );
    });

    test('habilitada cuando la ultima termino: listo o error', () {
      expect(
        ConversacionPantalla.puedeSeguirPreguntando(
          <Vuelta>[vuelta('raiz', 'listo')],
          ahora: ahora,
        ),
        isTrue,
      );
      expect(
        ConversacionPantalla.puedeSeguirPreguntando(
          <Vuelta>[vuelta('raiz', 'listo'), vuelta('seg1', 'error')],
          ahora: ahora,
        ),
        isTrue,
      );
    });

    test('habilitada si el POST de la ultima fallo antes de que el backend la tocara', () {
      expect(
        ConversacionPantalla.puedeSeguirPreguntando(
          <Vuelta>[vuelta('raiz', 'listo'), vuelta('seg1', 'buscando', creadoEn: ahora)],
          conErrorLocal: <String>{'seg1'},
          ahora: ahora,
        ),
        isTrue,
      );
    });

    test('habilitada si la ultima quedo colgada mas de 3 minutos', () {
      final DateTime hace4Minutos = ahora.subtract(const Duration(minutes: 4));
      final DateTime hace1Minuto = ahora.subtract(const Duration(minutes: 1));
      expect(
        ConversacionPantalla.puedeSeguirPreguntando(
          <Vuelta>[
            vuelta('raiz', 'listo'),
            vuelta('seg1', 'buscando', creadoEn: hace4Minutos, mandadaEn: hace4Minutos),
          ],
          ahora: ahora,
        ),
        isTrue,
      );
      expect(
        ConversacionPantalla.puedeSeguirPreguntando(
          <Vuelta>[
            vuelta('raiz', 'listo'),
            vuelta('seg1', 'redactando', creadoEn: hace1Minuto, mandadaEn: hace1Minuto),
          ],
          ahora: ahora,
        ),
        isFalse,
      );
    });

    test('deshabilitada si fallo la primera pregunta (no hay ninguna vuelta lista)', () {
      expect(
        ConversacionPantalla.puedeSeguirPreguntando(
          <Vuelta>[vuelta('raiz', 'error')],
          ahora: ahora,
        ),
        isFalse,
      );
      expect(ConversacionPantalla.puedeSeguirPreguntando(<Vuelta>[], ahora: ahora), isFalse);
    });
  });

  group('Vuelta', () {
    test('desdeDatos: un documento vacio no rompe nada (todo con default)', () {
      final Vuelta v = Vuelta.desdeDatos('r1', <String, dynamic>{}, preguntaPorDefecto: 'La de la pantalla');
      expect(v.id, 'r1');
      expect(v.pregunta, 'La de la pantalla');
      expect(v.estado, 'buscando');
      expect(v.enCurso, isTrue);
      expect(v.fuentes, isEmpty);
      expect(v.preguntaBuscada, isNull);
      expect(v.creadoEn, isNull);
    });

    test('desdeDatos: lee lo que escribio el backend', () {
      final DateTime hora = DateTime(2026, 10, 29, 13, 42);
      final Vuelta v = Vuelta.desdeDatos('seg1', <String, dynamic>{
        'pregunta': '¿Y para cuándo?',
        'estado': 'listo',
        'respuesta': 'Para el viernes [1].',
        'confianza': 'alta',
        'fuentes': <dynamic>[
          <String, dynamic>{'n': 1, 'titulo': 'Presupuesto'},
        ],
        'chunksVisibles': 12,
        'chunksMirados': null,
        'preguntaBuscada': '  ¿Para cuándo necesitan el presupuesto?  ',
        'creadoEn': Timestamp.fromDate(hora),
        'conversacionId': 'raiz',
        'anteriorRespId': 'raiz',
      });
      expect(v.estaLista, isTrue);
      expect(v.respuesta, 'Para el viernes [1].');
      expect(v.fuentes, hasLength(1));
      expect(v.chunksMirados, isNull);
      expect(v.preguntaBuscada, '¿Para cuándo necesitan el presupuesto?');
      expect(v.creadoEn, hora);
    });

    test('desdeDatos: preguntaBuscada vacia o que no es texto queda en null', () {
      expect(Vuelta.desdeDatos('a', <String, dynamic>{'preguntaBuscada': '   '}).preguntaBuscada, isNull);
      expect(Vuelta.desdeDatos('a', <String, dynamic>{'preguntaBuscada': 42}).preguntaBuscada, isNull);
      expect(Vuelta.desdeDatos('a', <String, dynamic>{'fuentes': 'no es lista'}).fuentes, isEmpty);
    });

    test('comoLaEntendio: solo si dice algo distinto de la pregunta', () {
      const Vuelta igual = Vuelta(
        id: 'a',
        pregunta: '¿Cuándo es la mesa?',
        estado: 'listo',
        preguntaBuscada: '¿cuándo es la mesa?',
      );
      const Vuelta distinta = Vuelta(
        id: 'b',
        pregunta: '¿Y la de Física?',
        estado: 'listo',
        preguntaBuscada: '¿Cuándo es la mesa de Física?',
      );
      expect(igual.comoLaEntendio, isNull);
      expect(distinta.comoLaEntendio, '¿Cuándo es la mesa de Física?');
    });

    test('quedoColgada: solo en curso, con hora, y pasados los 3 minutos', () {
      final DateTime ahora = DateTime(2026, 10, 29, 12);
      final DateTime viejo = ahora.subtract(const Duration(minutes: 10));
      expect(vuelta('a', 'buscando', mandadaEn: viejo).quedoColgada(ahora), isTrue);
      expect(vuelta('a', 'listo', mandadaEn: viejo).quedoColgada(ahora), isFalse);
      expect(vuelta('a', 'error', mandadaEn: viejo).quedoColgada(ahora), isFalse);
      // Sin ninguna hora (el servidor todavia no confirmo y esta app no la
      // mando ni la vio antes): se la sigue esperando.
      expect(vuelta('a', 'buscando').quedoColgada(ahora), isFalse);
    });

    test('desdeDatos: lo que sabe la app (pendiente, mandada, vista) llega a la Vuelta', () {
      final DateTime mandada = DateTime(2026, 10, 29, 12);
      final DateTime vista = DateTime(2026, 10, 29, 12, 1);
      final Vuelta v = Vuelta.desdeDatos(
        'seg1',
        <String, dynamic>{'estado': 'buscando'},
        pendienteDeSubir: true,
        mandadaEn: mandada,
        vistaDesde: vista,
      );
      expect(v.pendienteDeSubir, isTrue);
      expect(v.mandadaEn, mandada);
      expect(v.vistaDesde, vista);
      // Pendiente, pero la esta subiendo esta app: NO es "sin subir".
      expect(v.sinSubir, isFalse);
    });
  });

  // ==========================================================================
  //  HALLAZGO: la regla de "colgada" comparaba el reloj del celular con la
  //  hora del SERVIDOR (creadoEn). Ahora se mide con UN solo reloj.
  // ==========================================================================
  group('quedoColgada con el reloj del celular corrido', () {
    final DateTime horaServidor = DateTime.utc(2026, 10, 29, 15);
    final Vuelta raiz = vuelta('raiz', 'listo');

    test('celular 4 min ADELANTADO: la vuelta que mando esta app NO se da por colgada y la caja sigue trabada', () {
      // El caso del revisor: el backend la esta respondiendo, creada hace 2 s
      // segun el servidor, vista desde un celular 4 minutos adelantado.
      const Duration desfasaje = Duration(minutes: 4);
      final DateTime mandadaSegunElCelular = horaServidor.add(desfasaje);
      final DateTime relojDelCelular = mandadaSegunElCelular.add(const Duration(seconds: 2));
      final Vuelta seg = vuelta(
        'seg1',
        'buscando',
        creadoEn: horaServidor,
        mandadaEn: mandadaSegunElCelular,
        vistaDesde: mandadaSegunElCelular,
      );

      expect(seg.quedoColgada(relojDelCelular), isFalse);
      expect(
        ConversacionPantalla.puedeSeguirPreguntando(<Vuelta>[raiz, seg], ahora: relojDelCelular),
        isFalse,
      );
      // Y se da por colgada a los 3 minutos medidos con el MISMO reloj.
      expect(seg.quedoColgada(mandadaSegunElCelular.add(const Duration(minutes: 3, seconds: 1))), isTrue);
    });

    test('celular ADELANTADO y la vuelta abierta desde el historial (no la mando esta app): tampoco', () {
      final DateTime relojDelCelular = horaServidor.add(const Duration(minutes: 4, seconds: 2));
      final Vuelta seg = vuelta(
        'seg1',
        'redactando',
        creadoEn: horaServidor,
        vistaDesde: relojDelCelular, // la ve por primera vez ahora
      );
      expect(seg.quedoColgada(relojDelCelular), isFalse);
      expect(
        ConversacionPantalla.puedeSeguirPreguntando(<Vuelta>[raiz, seg], ahora: relojDelCelular),
        isFalse,
      );
    });

    test('celular 10 min ATRASADO: la que mando esta app se da por colgada a los 3 minutos, no a los 13', () {
      final DateTime mandadaSegunElCelular = horaServidor.subtract(const Duration(minutes: 10));
      final Vuelta seg = vuelta(
        'seg1',
        'buscando',
        creadoEn: horaServidor,
        mandadaEn: mandadaSegunElCelular,
      );
      expect(seg.quedoColgada(mandadaSegunElCelular.add(const Duration(minutes: 2, seconds: 59))), isFalse);
      expect(seg.quedoColgada(mandadaSegunElCelular.add(const Duration(minutes: 3, seconds: 1))), isTrue);
    });

    test('no la mando esta app: a los 3 minutos de verla, o si el servidor dice que es vieja de verdad', () {
      final DateTime ahora = DateTime(2026, 10, 29, 12);
      // Vista hace 3 min y 1 s (con el reloj del celular): colgada.
      expect(
        vuelta('a', 'buscando', vistaDesde: ahora.subtract(const Duration(minutes: 3, seconds: 1)))
            .quedoColgada(ahora),
        isTrue,
      );
      // Recien vista, creada hace 12 min segun el servidor: puede ser que el
      // celular este corrido, se la sigue esperando.
      expect(
        vuelta('a', 'buscando', vistaDesde: ahora, creadoEn: ahora.subtract(const Duration(minutes: 12)))
            .quedoColgada(ahora),
        isFalse,
      );
      // Creada hace mas de 3 + 10 minutos (de ayer, por ejemplo): colgada
      // apenas se abre, sin hacer girar el spinner 3 minutos.
      expect(
        vuelta('a', 'buscando', vistaDesde: ahora, creadoEn: ahora.subtract(const Duration(minutes: 14)))
            .quedoColgada(ahora),
        isTrue,
      );
      expect(
        vuelta('a', 'buscando', vistaDesde: ahora, creadoEn: ahora.subtract(const Duration(days: 1)))
            .quedoColgada(ahora),
        isTrue,
      );
    });
  });

  // ==========================================================================
  //  HALLAZGO: al salir de la conversacion y volver a entrar, la app se
  //  olvidaba de que el POST habia fallado. Ahora vive en RegistroDePedidos.
  // ==========================================================================
  group('RegistroDePedidos: lo que paso con el POST dura mas que la pantalla', () {
    final DateTime ahora = DateTime(2026, 10, 29, 12);
    final Vuelta raiz = vuelta('raiz', 'listo');

    test('un error anotado lo sigue viendo la pantalla NUEVA: la caja se habilita', () {
      // El POST de seg1 fallo (backend caido) y la persona salio. Al volver a
      // entrar, el State es otro, pero el registro no.
      RegistroDePedidos.anotarMandada('seg1', ahora.subtract(const Duration(seconds: 30)));
      RegistroDePedidos.anotarError('seg1', 'No hay conexión con el servidor.');

      final Vuelta seg1 = Vuelta.desdeDatos(
        'seg1',
        <String, dynamic>{'pregunta': '¿Y quién lo aprobó?', 'estado': 'buscando'},
        mandadaEn: RegistroDePedidos.mandadaEn['seg1'],
        vistaDesde: RegistroDePedidos.vistaPorPrimeraVez('seg1', ahora),
      );
      expect(
        ConversacionPantalla.puedeSeguirPreguntando(
          <Vuelta>[raiz, seg1],
          conErrorLocal: RegistroDePedidos.errores.keys.toSet(),
          ahora: ahora,
        ),
        isTrue,
      );
    });

    testWidgets('y la tarjeta muestra el error, no el spinner', (WidgetTester tester) async {
      RegistroDePedidos.anotarError('seg1', 'No hay conexión con el servidor.');
      await tester.pumpWidget(
        enPantalla(
          TarjetaDeVuelta(
            vuelta: vuelta('seg1', 'buscando', mandadaEn: ahora),
            errorDelPedido: RegistroDePedidos.errores['seg1'],
            alVolverAPreguntar: () {},
          ),
        ),
      );
      expect(find.text('No hay conexión con el servidor.'), findsOneWidget);
      expect(find.text('Buscando en el conocimiento del equipo...'), findsNothing);
      expect(find.text('Volver a preguntar'), findsOneWidget);
    });

    test('vistaPorPrimeraVez guarda la PRIMERA hora y no la pisa', () {
      final DateTime primera = RegistroDePedidos.vistaPorPrimeraVez('x', ahora);
      final DateTime despues = RegistroDePedidos.vistaPorPrimeraVez(
        'x',
        ahora.add(const Duration(minutes: 5)),
      );
      expect(primera, ahora);
      expect(despues, ahora);
    });

    test('anotar un error o una tardanza avisa a las pantallas abiertas', () {
      int avisos = 0;
      void contar() => avisos++;
      RegistroDePedidos.cambios.addListener(contar);
      addTearDown(() => RegistroDePedidos.cambios.removeListener(contar));

      RegistroDePedidos.anotarError('a', 'falló');
      RegistroDePedidos.anotarTardanza('b');
      expect(avisos, 2);
      expect(RegistroDePedidos.tardando, contains('b'));
      // Anotar la hora de envio NO avisa: se llama desde initState.
      RegistroDePedidos.anotarMandada('c', ahora);
      expect(avisos, 2);
    });
  });

  group('sin red y con la app cerrada en el medio (Vuelta.sinSubir)', () {
    final DateTime ahora = DateTime(2026, 10, 29, 12);
    final Vuelta raiz = vuelta('raiz', 'listo');

    // La escritura quedo en la cola de Firestore: el serverTimestamp llega
    // en null y el documento tiene hasPendingWrites. La app se reinicio, asi
    // que nadie la mando en esta app abierta.
    final Vuelta pendiente = Vuelta.desdeDatos(
      'seg2',
      <String, dynamic>{
        'pregunta': '¿Y para cuándo?',
        'estado': 'buscando',
        'creadoEn': null,
        'conversacionId': 'raiz',
        'anteriorRespId': 'raiz',
      },
      pendienteDeSubir: true,
      vistaDesde: ahora,
    );

    test('no traba la caja aunque siga sin red (antes quedaba trabada sin limite)', () {
      expect(pendiente.creadoEn, isNull);
      expect(pendiente.sinSubir, isTrue);
      expect(
        ConversacionPantalla.puedeSeguirPreguntando(<Vuelta>[raiz, pendiente], ahora: ahora),
        isTrue,
      );
    });

    testWidgets('y la tarjeta dice "Sin conexión" en vez de "Buscando..."', (WidgetTester tester) async {
      await tester.pumpWidget(enPantalla(TarjetaDeVuelta(vuelta: pendiente, alVolverAPreguntar: () {})));
      expect(find.text('Sin conexión: esta pregunta todavía no llegó al servidor.'), findsOneWidget);
      expect(find.text('Buscando en el conocimiento del equipo...'), findsNothing);
    });

    testWidgets('la que esta subiendo ESTA app (pendiente y mandada) sigue con su spinner', (WidgetTester tester) async {
      final Vuelta subiendo = vuelta('seg3', 'buscando', mandadaEn: ahora, pendienteDeSubir: true);
      expect(subiendo.sinSubir, isFalse);
      expect(
        ConversacionPantalla.puedeSeguirPreguntando(<Vuelta>[raiz, subiendo], ahora: ahora),
        isFalse,
      );
      await tester.pumpWidget(enPantalla(TarjetaDeVuelta(vuelta: subiendo)));
      expect(find.text('Buscando en el conocimiento del equipo...'), findsOneWidget);
      expect(find.textContaining('Sin conexión'), findsNothing);
    });
  });

  // ==========================================================================
  //  HALLAZGO: DEMASIADOS_PEDIDOS habilitaba la caja al instante. El
  //  contrato (N6) pide apagar el boton los segundos que diga Retry-After.
  // ==========================================================================
  group('DEMASIADOS_PEDIDOS: las cajas esperan lo que diga Retry-After', () {
    final DateTime ahora = DateTime(2026, 10, 29, 12);
    final Vuelta raiz = vuelta('raiz', 'listo');
    // El 429 del limitador: el backend no toco el documento.
    final Vuelta rechazada = vuelta('seg1', 'buscando', mandadaEn: ahora);

    test('la caja NO se habilita hasta que pasa la espera', () {
      final DateTime hasta = ahora.add(const Duration(seconds: 20));
      expect(
        ConversacionPantalla.puedeSeguirPreguntando(
          <Vuelta>[raiz, rechazada],
          conErrorLocal: <String>{'seg1'},
          ahora: ahora,
          frenadaHasta: hasta,
        ),
        isFalse,
      );
      expect(
        ConversacionPantalla.puedeSeguirPreguntando(
          <Vuelta>[raiz, rechazada],
          conErrorLocal: <String>{'seg1'},
          ahora: ahora.add(const Duration(seconds: 19)),
          frenadaHasta: hasta,
        ),
        isFalse,
      );
      expect(
        ConversacionPantalla.puedeSeguirPreguntando(
          <Vuelta>[raiz, rechazada],
          conErrorLocal: <String>{'seg1'},
          ahora: ahora.add(const Duration(seconds: 20)),
          frenadaHasta: hasta,
        ),
        isTrue,
      );
    });

    test('frenar usa el Retry-After y la cuenta regresiva redondea para arriba', () {
      RegistroDePedidos.frenar(37, ahora);
      expect(RegistroDePedidos.frenadaHasta, ahora.add(const Duration(seconds: 37)));
      expect(RegistroDePedidos.segundosDeEspera(ahora), 37);
      expect(RegistroDePedidos.segundosDeEspera(ahora.add(const Duration(milliseconds: 36500))), 1);
      expect(RegistroDePedidos.segundosDeEspera(ahora.add(const Duration(seconds: 37))), isNull);
    });

    test('sin Retry-After espera 20 s, y uno absurdo se topea en 2 minutos', () {
      RegistroDePedidos.frenar(null, ahora);
      expect(RegistroDePedidos.frenadaHasta, ahora.add(const Duration(seconds: 20)));
      RegistroDePedidos.olvidarTodo();
      RegistroDePedidos.frenar(86400, ahora);
      expect(RegistroDePedidos.frenadaHasta, ahora.add(const Duration(seconds: 120)));
      RegistroDePedidos.olvidarTodo();
      RegistroDePedidos.frenar(0, ahora);
      expect(RegistroDePedidos.frenadaHasta, ahora.add(const Duration(seconds: 1)));
    });

    test('una espera mas corta no acorta la que ya estaba', () {
      RegistroDePedidos.frenar(60, ahora);
      RegistroDePedidos.frenar(20, ahora.add(const Duration(seconds: 5)));
      expect(RegistroDePedidos.frenadaHasta, ahora.add(const Duration(seconds: 60)));
    });

    test('el aviso dice cuanto falta, con el plural bien', () {
      expect(ChatPantalla.avisoDeEspera(12), 'Esperá 12 segundos para volver a preguntar…');
      expect(ChatPantalla.avisoDeEspera(1), 'Esperá 1 segundo para volver a preguntar…');
    });

    testWidgets('la caja muestra la cuenta regresiva en el boton y no deja mandar', (WidgetTester tester) async {
      bool mando = false;
      final TextEditingController texto = TextEditingController(text: '¿Y cuánto sale?');
      addTearDown(texto.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: CajaDeSeguimiento(
              controlador: texto,
              habilitada: false,
              segundosDeEspera: 12,
              pista: ChatPantalla.avisoDeEspera(12),
              alEnviar: () => mando = true,
            ),
          ),
        ),
      );
      expect(find.text('12'), findsOneWidget);
      expect(find.byIcon(Icons.send), findsNothing);
      expect(tester.widget<IconButton>(find.byType(IconButton)).onPressed, isNull);
      expect(mando, isFalse);
    });
  });

  group('historial: una fila por conversacion (solo las raices)', () {
    test('esRaiz: sin conversacionId es raiz; con conversacionId es seguimiento', () {
      expect(ChatPantalla.esRaiz(<String, dynamic>{'pregunta': 'x'}), isTrue);
      expect(ChatPantalla.esRaiz(<String, dynamic>{'conversacionId': null}), isTrue);
      expect(ChatPantalla.esRaiz(<String, dynamic>{'conversacionId': 'raiz'}), isFalse);
    });

    test('contarSeguimientos cuenta por raiz y las raices no suman', () {
      final Map<String, int> cuenta = ChatPantalla.contarSeguimientos(<Map<String, dynamic>>[
        <String, dynamic>{'pregunta': 'raiz A'},
        <String, dynamic>{'pregunta': 'raiz B'},
        <String, dynamic>{'conversacionId': 'A'},
        <String, dynamic>{'conversacionId': 'A'},
        <String, dynamic>{'conversacionId': 'B'},
      ]);
      expect(cuenta, <String, int>{'A': 2, 'B': 1});
    });

    test('filasDelHistorial: una fila por raiz, en el orden de la query y con su cuenta', () {
      // De la mas nueva a la mas vieja: s2 (de R1), R2, s1 (de R1), R1.
      final List<FilaDelHistorial> filas = ChatPantalla.filasDelHistorial(
        <MapEntry<String, Map<String, dynamic>>>[
          seguimientoDoc('s2', 'R1'),
          raizDoc('R2'),
          seguimientoDoc('s1', 'R1'),
          raizDoc('R1'),
        ],
      );
      expect(filas.map((FilaDelHistorial f) => f.raizId), <String>['R2', 'R1']);
      expect(filas.map((FilaDelHistorial f) => f.seguimientos), <int>[0, 2]);
      expect(filas.every((FilaDelHistorial f) => f.raizEnLaVentana), isTrue);
      expect(filas[1].datos['pregunta'], 'Raíz R1');
      expect(ChatPantalla.filasDelHistorial(<MapEntry<String, Map<String, dynamic>>>[]), isEmpty);
    });

    // HALLAZGO: los seguimientos ocupan lugar en la query (limit 60) y la
    // raiz podia quedar afuera.
    test('60 seguimientos mas nuevos que la ultima raiz: la conversacion igual tiene su fila', () {
      final List<MapEntry<String, Map<String, dynamic>>> ventana =
          List<MapEntry<String, Map<String, dynamic>>>.generate(
        60,
        (int i) => seguimientoDoc('s${60 - i}', 'raizA'), // s60 es el mas nuevo
      );
      final List<FilaDelHistorial> filas = ChatPantalla.filasDelHistorial(ventana);
      // Antes: cero filas y el cartel de "Preguntá lo que quieras".
      expect(filas, hasLength(1));
      expect(filas.single.raizId, 'raizA');
      expect(filas.single.raizEnLaVentana, isFalse);
      expect(filas.single.seguimientos, 60);
      // Mientras no llega la raiz, se dibuja con el seguimiento MAS VIEJO.
      expect(filas.single.datos['pregunta'], 'Seguimiento s1');
    });

    test('3 conversaciones de 20 seguimientos: se ven las 3 (antes solo 2)', () {
      final List<MapEntry<String, Map<String, dynamic>>> todos =
          <MapEntry<String, Map<String, dynamic>>>[];
      for (final String r in <String>['C', 'B', 'A']) {
        // de la mas nueva a la mas vieja: 20 seguimientos y despues la raiz
        for (int i = 20; i >= 1; i--) {
          todos.add(seguimientoDoc('$r$i', r));
        }
        todos.add(raizDoc(r));
      }
      final List<FilaDelHistorial> filas = ChatPantalla.filasDelHistorial(todos.take(60).toList());
      expect(filas.map((FilaDelHistorial f) => f.raizId), <String>['C', 'B', 'A']);
      expect(filas.map((FilaDelHistorial f) => f.raizEnLaVentana), <bool>[true, true, false]);
      // De A entraron 18 seguimientos (los lugares 43 a 60): la cuenta es un
      // minimo, y la fila lo dice ("al menos 19 preguntas").
      expect(filas[2].seguimientos, 18);
      expect(filas[2].datos['pregunta'], 'Seguimiento A3');
    });
  });

  test('avisoSiNoCarganLosSeguimientos: texto entendible y sin el codigo crudo', () {
    final String sinIndice = ConversacionPantalla.avisoSiNoCarganLosSeguimientos(
      FirebaseException(plugin: 'cloud_firestore', code: 'failed-precondition'),
    );
    final String sinPermiso = ConversacionPantalla.avisoSiNoCarganLosSeguimientos(
      FirebaseException(plugin: 'cloud_firestore', code: 'permission-denied'),
    );
    final String otro = ConversacionPantalla.avisoSiNoCarganLosSeguimientos('se corto');
    expect(sinIndice, contains('unos minutos'));
    expect(sinIndice, isNot(contains('failed-precondition')));
    expect(sinPermiso, isNot(contains('permission-denied')));
    expect(<String>{sinIndice, sinPermiso, otro}, hasLength(3));
  });

  group('CajaDeSeguimiento', () {
    testWidgets('deshabilitada: no se puede escribir ni mandar', (WidgetTester tester) async {
      bool mando = false;
      final TextEditingController texto = TextEditingController();
      addTearDown(texto.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: CajaDeSeguimiento(
              controlador: texto,
              habilitada: false,
              pista: 'Esperá a que termine la respuesta…',
              alEnviar: () => mando = true,
            ),
          ),
        ),
      );

      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isFalse);
      expect(tester.widget<IconButton>(find.byType(IconButton)).onPressed, isNull);
      expect(find.text('Esperá a que termine la respuesta…'), findsOneWidget);
      expect(mando, isFalse);
    });

    testWidgets('habilitada: dice "Preguntá algo más sobre esto…" y manda', (WidgetTester tester) async {
      bool mando = false;
      final TextEditingController texto = TextEditingController();
      addTearDown(texto.dispose);
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: CajaDeSeguimiento(
              controlador: texto,
              habilitada: true,
              alEnviar: () => mando = true,
            ),
          ),
        ),
      );

      expect(find.text('Preguntá algo más sobre esto…'), findsOneWidget);
      expect(tester.widget<TextField>(find.byType(TextField)).enabled, isTrue);
      await tester.tap(find.byType(IconButton));
      expect(mando, isTrue);
    });
  });

  group('TarjetaDeVuelta', () {
    testWidgets('lista: chip de confianza, respuesta, fuentes y como la entendio', (WidgetTester tester) async {
      await tester.pumpWidget(
        enPantalla(
          const TarjetaDeVuelta(
            vuelta: Vuelta(
              id: 'seg1',
              pregunta: '¿Y para cuándo lo necesitan?',
              estado: 'listo',
              respuesta: 'Para el viernes [1].',
              confianza: 'alta',
              fuentes: <dynamic>[
                <String, dynamic>{
                  'n': 1,
                  'titulo': 'Presupuesto de fuentes',
                  'pagina': 2,
                  'fragmento': 'Lo necesitan el viernes',
                },
              ],
              preguntaBuscada: '¿Para cuándo necesitan el presupuesto de fuentes ATX?',
            ),
          ),
        ),
      );

      expect(find.text('¿Y para cuándo lo necesitan?'), findsOneWidget);
      expect(find.text('Confianza alta'), findsOneWidget);
      expect(tester.widget<SelectableText>(find.byType(SelectableText)).data, 'Para el viernes [1].');
      expect(find.text('De dónde lo saqué'), findsOneWidget);
      expect(find.text('Presupuesto de fuentes'), findsOneWidget);
      expect(find.text('pág. 2'), findsOneWidget);
      expect(find.textContaining('La entendí como'), findsOneWidget);
      expect(find.text('Volver a preguntar'), findsNothing);
    });

    testWidgets('buscando: progreso en vivo y, si tarda, el aviso', (WidgetTester tester) async {
      await tester.pumpWidget(
        enPantalla(
          const TarjetaDeVuelta(
            vuelta: Vuelta(id: 'seg1', pregunta: '¿Y cuánto sale?', estado: 'redactando'),
            tardando: true,
          ),
        ),
      );

      expect(find.text('Redactando la respuesta...'), findsOneWidget);
      expect(find.textContaining('tardando más de lo normal'), findsOneWidget);
      expect(find.textContaining('La entendí como'), findsNothing);
    });

    testWidgets('error: gana el errorMsg del documento y el boton vuelve a preguntar', (WidgetTester tester) async {
      int veces = 0;
      await tester.pumpWidget(
        enPantalla(
          TarjetaDeVuelta(
            vuelta: const Vuelta(
              id: 'seg1',
              pregunta: '¿Y cuánto sale?',
              estado: 'error',
              errorMsg: 'La IA no respondió a tiempo.',
            ),
            errorDelPedido: 'Otro texto para el mismo error',
            alVolverAPreguntar: () => veces++,
          ),
        ),
      );

      expect(find.text('La IA no respondió a tiempo.'), findsOneWidget);
      expect(find.text('Otro texto para el mismo error'), findsNothing);
      await tester.tap(find.text('Volver a preguntar'));
      await tester.pump();
      expect(veces, 1);
    });

    testWidgets('en curso con el POST caido o colgada: error en vez de spinner eterno', (WidgetTester tester) async {
      await tester.pumpWidget(
        enPantalla(
          const TarjetaDeVuelta(
            vuelta: Vuelta(id: 'seg1', pregunta: '¿Y cuánto sale?', estado: 'buscando'),
            errorDelPedido: 'Sin conexión: esta pregunta no llegó al servidor.',
          ),
        ),
      );
      expect(find.text('Sin conexión: esta pregunta no llegó al servidor.'), findsOneWidget);
      expect(find.text('Buscando en el conocimiento del equipo...'), findsNothing);

      await tester.pumpWidget(
        enPantalla(
          const TarjetaDeVuelta(
            vuelta: Vuelta(id: 'seg2', pregunta: '¿Y cuánto sale?', estado: 'buscando'),
            colgada: true,
          ),
        ),
      );
      expect(find.textContaining('quedó sin respuesta'), findsOneWidget);
      expect(find.text('Buscando en el conocimiento del equipo...'), findsNothing);
    });

    testWidgets('lista gana sobre un POST que fallo por la red', (WidgetTester tester) async {
      await tester.pumpWidget(
        enPantalla(
          const TarjetaDeVuelta(
            vuelta: Vuelta(id: 'seg1', pregunta: '¿Y cuánto sale?', estado: 'listo', respuesta: '12.000 pesos.'),
            errorDelPedido: 'No hay conexión con el servidor.',
          ),
        ),
      );
      expect(find.text('No hay conexión con el servidor.'), findsNothing);
      expect(tester.widget<SelectableText>(find.byType(SelectableText)).data, '12.000 pesos.');
    });
  });
}
