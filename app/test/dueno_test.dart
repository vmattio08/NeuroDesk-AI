// ============================================================================
//  dueno_test.dart — las pruebas de "CADA DATO CON DUENO"
//
//  Corren con 'flutter test' en la compu, sin Firebase y sin internet, igual
//  que los otros tests. Prueban lo que no toca la red:
//    - como se resuelve el nombre de un autor (contrato B): members, despues
//      exMiembros con "(ya no está en el equipo)", y si no "Ex integrante";
//    - la linea "de quien, de cuando y con que candado" de cada fuente y la
//      de cada fila del muro;
//    - la fecha corta ("hoy", "ayer", "24/08");
//    - que cada item citado se lea UNA sola vez por conversacion;
//    - los textos nuevos de una respuesta (miembro / admin / sin fuentes) y
//      la fuente que se toca y dice de quien es; a un miembro no le llega el
//      texto de admin aunque su pregunta vieja tenga chunksMirados cargado;
//    - la linea del historial que avisa que el admin ve las preguntas.
//  Las escuchas de Firestore (EquipoEnVivo) y la lectura real de un item solo
//  se prueban en el emulador o en un celular: estan en el checklist de QA.
// ============================================================================

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neurodesk/pantallas/chat.dart';
import 'package:neurodesk/servicios/equipo.dart';
import 'package:neurodesk/tema.dart';

/// El equipo de la demo: Valentino (admin), Martin y Camila estan; Lucas se
/// fue y quedo en exMiembros; uid_viejo se fue antes de que existiera.
const NombresDelEquipo equipo = NombresDelEquipo(
  miembros: <String, String>{
    'uid_valentino': 'Valentino Mattio',
    'uid_martin': 'Martín Sosa',
    'uid_camila': 'Camila Duarte',
  },
  exMiembros: <String, String>{'uid_lucas': 'Lucas'},
  listo: true,
);

/// Un "hoy" fijo para que las fechas no dependan del reloj de la compu.
final DateTime hoy = DateTime(2026, 10, 29, 15, 30);

Map<String, dynamic> item({
  required String autor,
  String visibilidad = 'equipo',
  String tipo = 'nota',
  Object? creadoEn,
}) {
  return <String, dynamic>{
    'titulo': 'Algo',
    'tipo': tipo,
    'visibilidad': visibilidad,
    'creadoPor': autor,
    'creadoEn': creadoEn ?? Timestamp.fromDate(DateTime(2026, 8, 24, 9, 12)),
  };
}

Widget enPantalla(Widget hijo) {
  return MaterialApp(
    theme: temaNeuroDesk(),
    home: Scaffold(body: ListView(children: <Widget>[hijo])),
  );
}

void main() {
  group('NombresDelEquipo.nombreDe (contrato B)', () {
    test('1) el nombre de members', () {
      expect(equipo.nombreDe('uid_valentino'), 'Valentino Mattio');
    });

    test('2) si ya no esta: el de exMiembros con "(ya no está en el equipo)"', () {
      expect(equipo.nombreDe('uid_lucas'), 'Lucas (ya no está en el equipo)');
    });

    test('3) si tampoco esta en exMiembros (se fue antes): "Ex integrante"', () {
      expect(equipo.nombreDe('uid_viejo'), 'Ex integrante');
      expect(equipo.nombreDe(null), 'Ex integrante');
      expect(equipo.nombreDe(''), 'Ex integrante');
    });

    test('si volvio a entrar, gana members aunque haya quedado en exMiembros', () {
      const NombresDelEquipo volvio = NombresDelEquipo(
        miembros: <String, String>{'uid_lucas': 'Lucas Pereyra'},
        exMiembros: <String, String>{'uid_lucas': 'Lucas'},
        listo: true,
      );
      expect(volvio.nombreDe('uid_lucas'), 'Lucas Pereyra');
    });

    test('mientras no llegaron los datos devuelve null (nadie sale como "Ex integrante")', () {
      const NombresDelEquipo cargando = NombresDelEquipo();
      expect(cargando.nombreDe('uid_valentino'), isNull);
      expect(cargando.nombreDe('uid_viejo'), isNull);
    });

    test('un nombre vacio en members no cuenta: sigue la cadena del contrato', () {
      const NombresDelEquipo raro = NombresDelEquipo(
        miembros: <String, String>{'uid_x': '   '},
        exMiembros: <String, String>{'uid_x': 'Equis'},
        listo: true,
      );
      expect(raro.nombreDe('uid_x'), 'Equis (ya no está en el equipo)');
    });
  });

  group('NombresDelEquipo: leer lo que trae Firestore', () {
    test('leerExMiembros: solo las entradas con nombre, sin romperse con nada raro', () {
      final Map<String, String> ex = NombresDelEquipo.leerExMiembros(<String, dynamic>{
        'nombre': '6to 1ra',
        'exMiembros': <String, dynamic>{
          'uid_lucas': <String, dynamic>{'nombre': ' Lucas ', 'salioEn': Timestamp.now()},
          'uid_sin_nombre': <String, dynamic>{'salioEn': Timestamp.now()},
          'uid_nombre_raro': <String, dynamic>{'nombre': 42},
          'uid_no_mapa': 'Lucas',
        },
      });
      expect(ex, <String, String>{'uid_lucas': 'Lucas'});
      // Nunca se lee el email: el contrato dice que ni siquiera esta.
    });

    test('leerExMiembros: sin el campo, o con algo que no es un mapa, da vacio', () {
      expect(NombresDelEquipo.leerExMiembros(null), isEmpty);
      expect(NombresDelEquipo.leerExMiembros(<String, dynamic>{}), isEmpty);
      expect(NombresDelEquipo.leerExMiembros(<String, dynamic>{'exMiembros': 'x'}), isEmpty);
    });

    test('desdeDatos: listo solo cuando llegaron los miembros Y el documento del espacio', () {
      final List<MapEntry<String, Map<String, dynamic>>> miembros =
          <MapEntry<String, Map<String, dynamic>>>[
        const MapEntry<String, Map<String, dynamic>>(
          'uid_martin',
          <String, dynamic>{'nombre': 'Martín Sosa', 'email': 'no@se.usa', 'rol': 'miembro'},
        ),
        const MapEntry<String, Map<String, dynamic>>('uid_roto', <String, dynamic>{'rol': 'miembro'}),
      ];
      final NombresDelEquipo listos = NombresDelEquipo.desdeDatos(
        miembros: miembros,
        espacio: <String, dynamic>{
          'exMiembros': <String, dynamic>{
            'uid_lucas': <String, dynamic>{'nombre': 'Lucas'},
          },
        },
      );
      expect(listos.listo, isTrue);
      expect(listos.nombreDe('uid_martin'), 'Martín Sosa');
      expect(listos.nombreDe('uid_lucas'), 'Lucas (ya no está en el equipo)');

      expect(NombresDelEquipo.desdeDatos(miembros: null).listo, isFalse);
      expect(
        NombresDelEquipo.desdeDatos(miembros: miembros, espacioListo: false).listo,
        isFalse,
      );
    });
  });

  group('fechaDeAporte', () {
    test('hoy, ayer, dd/MM y con el año si es de otro año', () {
      expect(fechaDeAporte(DateTime(2026, 10, 29, 8), ahora: hoy), 'hoy');
      expect(fechaDeAporte(DateTime(2026, 10, 28, 23, 59), ahora: hoy), 'ayer');
      expect(fechaDeAporte(DateTime(2026, 8, 24), ahora: hoy), '24/08');
      expect(fechaDeAporte(DateTime(2025, 12, 3), ahora: hoy), '03/12/2025');
      expect(fechaDeAporte(Timestamp.fromDate(DateTime(2026, 10, 14, 13)), ahora: hoy), '14/10');
    });

    test('"ayer" del 1 de marzo es el 28 de febrero (sin restar horas)', () {
      expect(fechaDeAporte(DateTime(2026, 2, 28, 22), ahora: DateTime(2026, 3, 1, 9)), 'ayer');
    });

    test('sin fecha (serverTimestamp todavia sin confirmar) dice "ahora"', () {
      expect(fechaDeAporte(null, ahora: hoy), 'ahora');
      expect(fechaDeAporte('2026-08-24', ahora: hoy), 'ahora');
    });
  });

  group('etiquetaDelDueno (las fuentes y el detalle)', () {
    test('de otro, del equipo: "Valentino Mattio · 24/08 · Del equipo"', () {
      expect(
        etiquetaDelDueno(item: item(autor: 'uid_valentino'), miUid: 'uid_martin', nombres: equipo, ahora: hoy),
        'Valentino Mattio · 24/08 · Del equipo',
      );
    });

    test('mia y privada: "Tu nota privada · 24/08" (y el genero sigue al tipo)', () {
      expect(
        etiquetaDelDueno(
          item: item(autor: 'uid_martin', visibilidad: 'privado'),
          miUid: 'uid_martin',
          nombres: equipo,
          ahora: hoy,
        ),
        'Tu nota privada · 24/08',
      );
      expect(
        etiquetaDelDueno(
          item: item(autor: 'uid_martin', visibilidad: 'privado', tipo: 'pdf'),
          miUid: 'uid_martin',
          nombres: equipo,
          ahora: hoy,
        ),
        'Tu PDF privado · 24/08',
      );
    });

    test('mia y del equipo: "Vos · 24/08 · Del equipo"', () {
      expect(
        etiquetaDelDueno(item: item(autor: 'uid_martin'), miUid: 'uid_martin', nombres: equipo, ahora: hoy),
        'Vos · 24/08 · Del equipo',
      );
    });

    test('privada de otro (solo la puede leer un admin): lo dice de frente', () {
      expect(
        etiquetaDelDueno(
          item: item(autor: 'uid_martin', visibilidad: 'privado'),
          miUid: 'uid_valentino',
          nombres: equipo,
          ahora: hoy,
        ),
        'Privada de Martín Sosa · 24/08 · la ves porque sos admin',
      );
    });

    test('de alguien que se fue: "Lucas (ya no está en el equipo) · 24/08 · Del equipo"', () {
      expect(
        etiquetaDelDueno(item: item(autor: 'uid_lucas'), miUid: 'uid_martin', nombres: equipo, ahora: hoy),
        'Lucas (ya no está en el equipo) · 24/08 · Del equipo',
      );
      expect(
        etiquetaDelDueno(item: item(autor: 'uid_viejo'), miUid: 'uid_martin', nombres: equipo, ahora: hoy),
        'Ex integrante · 24/08 · Del equipo',
      );
    });

    test('mientras cargan los nombres: fecha y candado, sin inventar un nombre', () {
      expect(
        etiquetaDelDueno(
          item: item(autor: 'uid_valentino'),
          miUid: 'uid_martin',
          nombres: const NombresDelEquipo(),
          ahora: hoy,
        ),
        '24/08 · Del equipo',
      );
    });

    test('sin visibilidad se trata como privado (el mismo default que las reglas)', () {
      final Map<String, dynamic> sinCandado = item(autor: 'uid_martin')..remove('visibilidad');
      expect(
        etiquetaDelDueno(item: sinCandado, miUid: 'uid_valentino', nombres: equipo, ahora: hoy),
        startsWith('Privada de Martín Sosa'),
      );
    });
  });

  group('autorDeLaFila (el muro)', () {
    test('"de Martín Sosa · 14/10", "Tuyo · hoy" y el que se fue', () {
      final Timestamp el14 = Timestamp.fromDate(DateTime(2026, 10, 14, 11));
      expect(
        autorDeLaFila(item: item(autor: 'uid_martin', creadoEn: el14), miUid: 'uid_camila', nombres: equipo, ahora: hoy),
        'de Martín Sosa · 14/10',
      );
      expect(
        autorDeLaFila(
          item: item(autor: 'uid_camila', creadoEn: Timestamp.fromDate(hoy)),
          miUid: 'uid_camila',
          nombres: equipo,
          ahora: hoy,
        ),
        'Tuyo · hoy',
      );
      expect(
        autorDeLaFila(item: item(autor: 'uid_lucas', creadoEn: el14), miUid: 'uid_camila', nombres: equipo, ahora: hoy),
        'de Lucas (ya no está en el equipo) · 14/10',
      );
    });

    test('mientras cargan los nombres, solo la fecha', () {
      expect(
        autorDeLaFila(item: item(autor: 'uid_martin'), miUid: 'uid_camila', nombres: const NombresDelEquipo(), ahora: hoy),
        '24/08',
      );
    });
  });

  group('LecturasDeItems: cada item citado se lee UNA vez', () {
    test('dos fuentes del mismo item y muchos redibujos: una sola lectura', () async {
      int lecturas = 0;
      final LecturasDeItems memoria = LecturasDeItems((String id) async {
        lecturas++;
        return LecturaDeItem.datos(item(autor: 'uid_valentino'));
      });
      final List<LecturaDeItem> resultados = await Future.wait(<Future<LecturaDeItem>>[
        memoria.leer('itm_1'),
        memoria.leer('itm_1'),
      ]);
      await memoria.leer('itm_1');
      expect(lecturas, 1);
      expect(resultados.every((LecturaDeItem l) => l.datos != null), isTrue);
      expect(memoria.yaLeida('itm_1')?.datos, isNotNull);
      expect(memoria.yaLeida('itm_otro'), isNull);
    });

    test('si fallo la red se vuelve a intentar; "sin acceso" no se insiste', () async {
      int intentos = 0;
      final LecturasDeItems memoria = LecturasDeItems((String id) async {
        intentos++;
        if (id == 'itm_borrado') return const LecturaDeItem.sinAcceso();
        return intentos == 1 ? const LecturaDeItem.fallo() : LecturaDeItem.datos(item(autor: 'uid_x'));
      });
      expect((await memoria.leer('itm_1')).fallo, isTrue);
      expect((await memoria.leer('itm_1')).datos, isNotNull); // segundo intento
      expect(intentos, 2);

      expect((await memoria.leer('itm_borrado')).sinAcceso, isTrue);
      await memoria.leer('itm_borrado');
      expect(intentos, 3);
    });
  });

  group('una respuesta dice con QUE se respondio', () {
    const Vuelta deMiembro = Vuelta(
      id: 'r1',
      pregunta: '¿Qué diferencia hay entre textoOriginal y texto?',
      estado: 'listo',
      respuesta: 'No encontré esto en la base del equipo.',
      confianza: 'baja',
      chunksVisibles: 30,
    );
    const Vuelta deAdmin = Vuelta(
      id: 'r2',
      pregunta: '¿Cuándo es la mesa de Programación II?',
      estado: 'listo',
      respuesta: 'El miércoles 16/12 a las 10 [1].',
      confianza: 'alta',
      fuentes: <dynamic>[
        <String, dynamic>{'n': 1, 'itemId': 'itm_seed_01', 'titulo': 'Cronograma'},
      ],
      chunksMirados: 40,
      chunksVisibles: 40,
    );

    test('miembro: "Respondido solo con lo que vos podés ver."', () {
      expect(TarjetaDeVuelta.alcance(deMiembro), 'Respondido solo con lo que vos podés ver.');
      expect(TarjetaDeVuelta.numerosDelFiltro(deMiembro), isNull);
    });

    test('admin: busco en todo, y los numeros ya no dicen "el resto es privado" sin resto', () {
      expect(
        TarjetaDeVuelta.alcance(deAdmin),
        'Como sos admin, busqué en todo el espacio, incluido lo privado de cada uno.',
      );
      expect(TarjetaDeVuelta.numerosDelFiltro(deAdmin), 'Miré los 40 fragmentos del espacio.');
      expect(TarjetaDeVuelta.numerosDelFiltro(deAdmin), isNot(contains('resto')));
    });

    test('numerosDelFiltro: "el resto" solo si de verdad quedo algo afuera', () {
      const Vuelta conHuerfanos = Vuelta(
        id: 'r3',
        pregunta: 'x',
        estado: 'listo',
        chunksMirados: 48,
        chunksVisibles: 46,
      );
      expect(TarjetaDeVuelta.numerosDelFiltro(conHuerfanos), startsWith('Miré 48 fragmentos del espacio y pude usar 46'));
      const Vuelta uno = Vuelta(id: 'r4', pregunta: 'x', estado: 'listo', chunksMirados: 1, chunksVisibles: 1);
      expect(TarjetaDeVuelta.numerosDelFiltro(uno), 'Miré el único fragmento del espacio.');
      const Vuelta vacio = Vuelta(id: 'r5', pregunta: 'x', estado: 'listo', chunksMirados: 0, chunksVisibles: 0);
      expect(TarjetaDeVuelta.numerosDelFiltro(vacio), 'Todavía no hay nada cargado en el espacio.');
    });

    testWidgets('miembro sin fuentes: queda anotada para el admin y sin el chip rojo', (WidgetTester tester) async {
      await tester.pumpWidget(enPantalla(const TarjetaDeVuelta(vuelta: deMiembro)));
      expect(find.text('Respondido solo con lo que vos podés ver.'), findsOneWidget);
      expect(find.textContaining('Quedó anotada para el administrador del equipo'), findsOneWidget);
      expect(find.text('Confianza baja'), findsNothing);
      expect(find.textContaining('Sin fuentes'), findsNothing); // el texto viejo
      expect(find.textContaining('Miré'), findsNothing); // al miembro no se le dan numeros
    });

    testWidgets('admin sin fuentes: le dice que esta en "Lo que falta" del panel', (WidgetTester tester) async {
      await tester.pumpWidget(
        enPantalla(
          const TarjetaDeVuelta(
            vuelta: Vuelta(
              id: 'r6',
              pregunta: '¿Cuándo es la reunión de padres?',
              estado: 'listo',
              respuesta: 'No encontré esto en la base del equipo.',
              chunksMirados: 40,
              chunksVisibles: 40,
            ),
          ),
        ),
      );
      expect(find.textContaining('Lo que falta'), findsOneWidget);
      expect(find.textContaining('Como sos admin'), findsOneWidget);
    });

    testWidgets('admin con fuentes: alcance, fuentes y numeros sin contradecirse', (WidgetTester tester) async {
      await tester.pumpWidget(enPantalla(const TarjetaDeVuelta(vuelta: deAdmin)));
      expect(find.textContaining('Como sos admin, busqué en todo el espacio'), findsOneWidget);
      expect(find.text('Miré los 40 fragmentos del espacio.'), findsOneWidget);
      expect(find.textContaining('el resto es privado'), findsNothing);
      expect(find.text('Confianza alta'), findsOneWidget);
      expect(find.textContaining('Quedó anotada'), findsNothing);
    });

    // El caso de las preguntas viejas del seed: Martin y Camila (miembros)
    // tenian chunksMirados cargado. La conversacion se lo saca a quien HOY no
    // es admin, asi que no les llega ni el texto de admin ni el numero.
    final Map<String, dynamic> deCamilaMalCargada = <String, dynamic>{
      'pregunta': '¿Qué le toca hacer a cada uno en el trabajo práctico?',
      'autorUid': 'uid_camila',
      'estado': 'listo',
      'respuesta': 'Valentino se ocupa del backend [1].',
      'confianza': 'media',
      'fuentes': <dynamic>[
        <String, dynamic>{'n': 1, 'itemId': 'itm_seed_07', 'titulo': 'Reparto de tareas'},
      ],
      'chunksMirados': 40,
      'chunksVisibles': 35,
    };

    test('miembro con chunksMirados mal cargado: ni "Como sos admin" ni numeros', () {
      final Vuelta v = Vuelta.desdeDatos(
        'resp_seed_02',
        ConversacionPantalla.datosParaMostrar(deCamilaMalCargada, esAdmin: false),
      );
      expect(TarjetaDeVuelta.preguntoUnAdmin(v), isFalse);
      expect(TarjetaDeVuelta.alcance(v), 'Respondido solo con lo que vos podés ver.');
      expect(TarjetaDeVuelta.numerosDelFiltro(v), isNull);
      // El documento original no se toca: es una copia.
      expect(deCamilaMalCargada['chunksMirados'], 40);
    });

    test('al admin se le muestran los datos tal cual', () {
      final Map<String, dynamic> paraElAdmin = ConversacionPantalla.datosParaMostrar(deCamilaMalCargada, esAdmin: true);
      expect(identical(paraElAdmin, deCamilaMalCargada), isTrue);
      final Vuelta v = Vuelta.desdeDatos('resp_seed_02', paraElAdmin);
      expect(TarjetaDeVuelta.numerosDelFiltro(v), startsWith('Miré 40 fragmentos del espacio'));
    });

    testWidgets('miembro con chunksMirados mal cargado: en pantalla tampoco aparece', (WidgetTester tester) async {
      final Vuelta v = Vuelta.desdeDatos(
        'resp_seed_02',
        ConversacionPantalla.datosParaMostrar(deCamilaMalCargada, esAdmin: false),
      );
      await tester.pumpWidget(enPantalla(TarjetaDeVuelta(vuelta: v)));
      expect(find.text('Respondido solo con lo que vos podés ver.'), findsOneWidget);
      expect(find.textContaining('Como sos admin'), findsNothing);
      expect(find.textContaining('Miré'), findsNothing);
    });
  });

  group('la fuente dice de quien es y se puede tocar', () {
    final Timestamp el24 = Timestamp.fromDate(DateTime(2026, 8, 24, 9, 12));
    final Map<String, Map<String, dynamic>> itemsDelEquipo = <String, Map<String, dynamic>>{
      'itm_seed_01': item(autor: 'uid_valentino', tipo: 'pdf', creadoEn: el24),
      'itm_lucas': item(autor: 'uid_lucas', tipo: 'pdf', creadoEn: el24),
      'itm_mio': item(autor: 'uid_martin', visibilidad: 'privado', creadoEn: el24),
    };

    Vuelta conFuentes(List<String> ids) {
      return Vuelta(
        id: 'r1',
        pregunta: '¿Cuándo es la mesa de Programación II?',
        estado: 'listo',
        respuesta: 'El miércoles 16/12 [1].',
        confianza: 'alta',
        fuentes: <dynamic>[
          for (int i = 0; i < ids.length; i++)
            <String, dynamic>{
              'n': i + 1,
              'itemId': ids[i],
              'titulo': 'Fuente ${ids[i]}',
              'pagina': 2,
              'fragmento': 'Programación II (6.º 1.ª): miércoles 16/12, 10:00 hs, laboratorio 2.',
            },
        ],
      );
    }

    testWidgets('con autor, fecha y candado; al tocarla abre esa fuente', (WidgetTester tester) async {
      int lecturas = 0;
      final List<Map<dynamic, dynamic>> abiertas = <Map<dynamic, dynamic>>[];
      final DuenosDeLasFuentes duenos = DuenosDeLasFuentes(
        miUid: 'uid_martin',
        nombres: equipo,
        lecturas: LecturasDeItems((String id) async {
          lecturas++;
          final Map<String, dynamic>? datos = itemsDelEquipo[id];
          return datos == null ? const LecturaDeItem.sinAcceso() : LecturaDeItem.datos(datos);
        }),
        alAbrir: abiertas.add,
      );

      await tester.pumpWidget(
        enPantalla(TarjetaDeVuelta(vuelta: conFuentes(<String>['itm_seed_01', 'itm_lucas', 'itm_mio', 'itm_borrado']), duenos: duenos)),
      );
      await tester.pump(); // termina la lectura (de mentira) de los items

      final String fecha = fechaDeAporte(el24);
      expect(find.text('Valentino Mattio · $fecha · Del equipo'), findsOneWidget);
      expect(find.text('Lucas (ya no está en el equipo) · $fecha · Del equipo'), findsOneWidget);
      expect(find.text('Tu nota privada · $fecha'), findsOneWidget);
      // Lo pasaron a privado o lo borraron despues de la respuesta.
      expect(find.text('Ya no tenés acceso a esta fuente'), findsOneWidget);

      await tester.tap(find.text('Fuente itm_seed_01'));
      expect(abiertas.single['itemId'], 'itm_seed_01');
      expect(abiertas.single['pagina'], 2);

      // La pantalla se redibuja sola (el reloj de 20 s): NO vuelve a leer.
      await tester.pumpWidget(
        enPantalla(TarjetaDeVuelta(vuelta: conFuentes(<String>['itm_seed_01', 'itm_lucas', 'itm_mio', 'itm_borrado']), duenos: duenos)),
      );
      await tester.pump();
      expect(lecturas, 4);
      expect(find.text('Valentino Mattio · $fecha · Del equipo'), findsOneWidget);
    });

    testWidgets('sin duenos (como antes) se dibuja igual y no se puede tocar', (WidgetTester tester) async {
      await tester.pumpWidget(enPantalla(TarjetaDeVuelta(vuelta: conFuentes(<String>['itm_seed_01']))));
      expect(find.text('Fuente itm_seed_01'), findsOneWidget);
      expect(find.text('pág. 2'), findsOneWidget);
      expect(find.byType(InkWell), findsNothing);
      expect(find.byIcon(Icons.chevron_right), findsNothing);
    });
  });

  group('el historial avisa quien puede ver las preguntas', () {
    test('miembro y admin', () {
      expect(
        ChatPantalla.avisoDelHistorial(esAdmin: false),
        'El administrador del equipo puede ver las preguntas que hacés acá.',
      );
      expect(ChatPantalla.avisoDelHistorial(esAdmin: true), contains('todo el equipo'));
    });

    testWidgets('la linea se dibuja con su texto', (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AvisoDelHistorial(texto: ChatPantalla.avisoDelHistorial(esAdmin: false)),
          ),
        ),
      );
      expect(find.text('El administrador del equipo puede ver las preguntas que hacés acá.'), findsOneWidget);
    });
  });
}
