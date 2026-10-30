// ============================================================================
//  detalle_item_test.dart — las pruebas de "LO QUE LEYO NEURODESK" (la pantalla
//  que se abre al tocar una fuente o una fila del muro)
//
//  Sin Firebase y sin internet. Prueban:
//    - el corte del texto en las marcas <<<PAGINA:n>>> (igual que el backend);
//    - el corte de una pagina larga en bloques, sin perder ni repetir nada;
//    - encontrar el fragmento citado (con el "…" del final, con otros
//      espacios, en la pagina que dice la cita) y no resaltar si no esta;
//    - "como se leyo" cada tipo de item;
//    - la pantalla ya armada: una tarjeta por pagina, la cita en cian, el
//      aviso si no se encontro, y que un texto enorme NO se dibuja entero;
//    - que el salto a la cita deje la parte en cian a la vista en un celular
//      chico, aunque el bloque sea mas alto que la pantalla.
//  La escucha del item en vivo (StreamBuilder sobre Firestore) se prueba en
//  el emulador.
// ============================================================================

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:neurodesk/pantallas/detalle_item.dart';
import 'package:neurodesk/tema.dart';

/// Como guarda el backend el texto de un PDF de 3 paginas: unirPaginas() de
/// texto.js pega "\n<<<PAGINA:n>>>\n" antes de cada pagina.
const String pdfDeTresPaginas = '<<<PAGINA:1>>>\n'
    'Mesas de examen, turno diciembre 2026.\n'
    'Matemática (6.º 1.ª): lunes 14/12, 8:00 hs, aula 12.\n\n'
    '<<<PAGINA:2>>>\n'
    'Programación II (6.º 1.ª): miércoles 16/12, 10:00 hs, laboratorio 2. Tribunal: Prof. Bonelli.\n'
    'Redes de Datos (6.º 1.ª): jueves 17/12, 8:00 hs, laboratorio 1.\n\n'
    '<<<PAGINA:3>>>\n'
    'Las notas se publican en cartelera el lunes 21/12.';

Widget enPantalla(Widget hijo) {
  return MaterialApp(theme: temaNeuroDesk(), home: Scaffold(body: hijo));
}

void main() {
  group('cortarEnPaginas (las marcas <<<PAGINA:n>>> del backend)', () {
    test('un PDF de 3 paginas da 3 paginas numeradas y sin las marcas', () {
      final List<PaginaDelTexto> paginas = TextoDelItem.cortarEnPaginas(pdfDeTresPaginas);
      expect(paginas.map((PaginaDelTexto p) => p.numero), <int>[1, 2, 3]);
      expect(paginas[1].texto, startsWith('Programación II'));
      expect(paginas.every((PaginaDelTexto p) => !p.texto.contains('<<<')), isTrue);
      // Sin los saltos de los bordes, que es como arma sus fragmentos el backend.
      expect(paginas.every((PaginaDelTexto p) => p.texto == p.texto.trim()), isTrue);
    });

    test('sin marcas (nota, link, Word) es una sola pagina sin numero', () {
      final List<PaginaDelTexto> paginas = TextoDelItem.cortarEnPaginas('  Una nota.\nDos renglones.  ');
      expect(paginas, hasLength(1));
      expect(paginas.single.numero, isNull);
      expect(paginas.single.texto, 'Una nota.\nDos renglones.');
    });

    test('lo de antes de la primera marca va sin numero y las paginas vacias no cuentan', () {
      final List<PaginaDelTexto> paginas = TextoDelItem.cortarEnPaginas(
        'Portada\n<<<PAGINA:1>>>\n   \n<<<PAGINA:2>>>\nContenido',
      );
      expect(paginas.map((PaginaDelTexto p) => p.numero), <int?>[null, 2]);
      expect(paginas.last.texto, 'Contenido');
    });

    test('un texto vacio no tiene paginas', () {
      expect(TextoDelItem.cortarEnPaginas(''), isEmpty);
      expect(TextoDelItem.cortarEnPaginas('<<<PAGINA:1>>>\n\n'), isEmpty);
    });
  });

  group('cortarEnBloques (nunca un solo Text gigante)', () {
    test('un texto corto es un solo bloque', () {
      expect(TextoDelItem.cortarEnBloques('Hola equipo.'), <Tramo>[const Tramo(0, 12)]);
    });

    test('un texto largo se corta en bloques de hasta el maximo, sin perder ni repetir nada', () {
      final String largo = List<String>.generate(400, (int i) => 'Renglón número $i del apunte.').join('\n');
      final List<Tramo> tramos = TextoDelItem.cortarEnBloques(largo, maximo: 500);
      expect(tramos.length, greaterThan(10));
      expect(tramos.every((Tramo t) => t.fin - t.inicio <= 500), isTrue);
      // Pegados, dan exactamente el texto original.
      expect(tramos.map((Tramo t) => largo.substring(t.inicio, t.fin)).join(), largo);
      // Y cortan en un fin de renglon, no en el medio de una palabra.
      for (final Tramo t in tramos.take(tramos.length - 1)) {
        expect(largo[t.fin - 1], '\n');
      }
    });

    test('prefiere cortar en un fin de parrafo', () {
      final String texto = '${'a' * 300}\n\n${'b' * 300}\n${'c' * 300}';
      final List<Tramo> tramos = TextoDelItem.cortarEnBloques(texto, maximo: 500);
      expect(texto.substring(tramos.first.inicio, tramos.first.fin), '${'a' * 300}\n\n');
    });

    test('sin ningun espacio corta igual (sin bucle infinito) y no parte un emoji', () {
      final String sinEspacios = 'x' * 1999 + '😀' * 10;
      final List<Tramo> tramos = TextoDelItem.cortarEnBloques(sinEspacios, maximo: 1000);
      expect(tramos.map((Tramo t) => sinEspacios.substring(t.inicio, t.fin)).join(), sinEspacios);
      // El corte de 2000 caeria entre las dos mitades del primer emoji.
      final Tramo segundo = tramos[1];
      expect(segundo.fin, 1999);
    });
  });

  group('buscarFragmento (la cita en cian)', () {
    const String pagina =
        'Programación II (6.º 1.ª): miércoles 16/12, 10:00 hs, laboratorio 2. Tribunal: Prof. Bonelli.';

    test('tal cual', () {
      final Tramo? t = TextoDelItem.buscarFragmento(pagina, 'miércoles 16/12, 10:00 hs, laboratorio 2.');
      expect(t, isNotNull);
      expect(pagina.substring(t!.inicio, t.fin), 'miércoles 16/12, 10:00 hs, laboratorio 2.');
    });

    test('con el "…" que le agrega el backend al recortar la cita', () {
      final Tramo? t = TextoDelItem.buscarFragmento(pagina, 'Programación II (6.º 1.ª): miércoles…');
      expect(pagina.substring(t!.inicio, t.fin), 'Programación II (6.º 1.ª): miércoles');
      expect(TextoDelItem.buscarFragmento(pagina, 'Programación II...'), isNotNull);
    });

    test('con otros espacios o saltos de renglon en el medio', () {
      const String conSaltos = 'Programación II (6.º 1.ª):\nmiércoles   16/12,\n10:00 hs';
      final Tramo? t = TextoDelItem.buscarFragmento(conSaltos, 'miércoles 16/12, 10:00 hs');
      expect(t, isNotNull);
      expect(conSaltos.substring(t!.inicio, t.fin), 'miércoles   16/12,\n10:00 hs');
    });

    test('si no esta (el item se volvio a procesar), null: se muestra sin resaltar', () {
      expect(TextoDelItem.buscarFragmento(pagina, 'jueves 17/12 en el aula 4'), isNull);
      expect(TextoDelItem.buscarFragmento(pagina, '   '), isNull);
      expect(TextoDelItem.buscarFragmento(pagina, '…'), isNull);
    });
  });

  group('ubicarCita y armar', () {
    test('busca primero en la pagina que dice la cita (un renglon repetido en dos paginas)', () {
      final List<PaginaDelTexto> paginas = TextoDelItem.cortarEnPaginas(
        '<<<PAGINA:1>>>\nE.E.S.T. N.º 5 - Mesas\nUno\n<<<PAGINA:2>>>\nE.E.S.T. N.º 5 - Mesas\nDos',
      );
      expect(TextoDelItem.ubicarCita(paginas, 'E.E.S.T. N.º 5 - Mesas', paginaCitada: 2)!.pagina, 1);
      expect(TextoDelItem.ubicarCita(paginas, 'E.E.S.T. N.º 5 - Mesas')!.pagina, 0);
      // La pagina citada no lo tiene: se busca en las demas.
      expect(TextoDelItem.ubicarCita(paginas, 'Dos', paginaCitada: 1)!.pagina, 1);
      expect(TextoDelItem.ubicarCita(paginas, null), isNull);
    });

    test('el PDF de la demo: la cita queda en la pagina 2', () {
      final TextoArmado armado = TextoDelItem.armar(
        pdfDeTresPaginas,
        fragmento: 'Programación II (6.º 1.ª): miércoles 16/12, 10:00 hs, laboratorio 2.',
        paginaCitada: 2,
      );
      expect(armado.tienePaginas, isTrue);
      expect(armado.bloques.map((BloqueDelTexto b) => b.numeroDePagina), <int>[1, 2, 3]);
      final BloqueDelTexto conCita = armado.bloques[armado.bloqueResaltado!];
      expect(conCita.numeroDePagina, 2);
      expect(
        conCita.texto.substring(conCita.resaltadoDesde!, conCita.resaltadoHasta),
        'Programación II (6.º 1.ª): miércoles 16/12, 10:00 hs, laboratorio 2.',
      );
    });

    test('una cita que cae entre dos bloques se pinta en los dos', () {
      final String texto = '${'a ' * 200}CITA QUE CRUZA ${'b ' * 200}';
      final int inicio = texto.indexOf('CITA');
      final TextoArmado armado = TextoDelItem.armar(
        texto,
        fragmento: 'CITA QUE CRUZA',
        maximo: inicio + 6, // el primer corte cae adentro de la cita
      );
      final List<BloqueDelTexto> pintados = armado.bloques
          .where((BloqueDelTexto b) => b.resaltadoDesde != null)
          .toList();
      expect(pintados.length, 2);
      final String pintado = pintados
          .map((BloqueDelTexto b) => b.texto.substring(b.resaltadoDesde!, b.resaltadoHasta))
          .join();
      expect(pintado, 'CITA QUE CRUZA');
      expect(armado.bloqueResaltado, armado.bloques.indexOf(pintados.first));
    });

    test('sin fragmento (abierto desde el muro) no hay nada resaltado', () {
      final TextoArmado armado = TextoDelItem.armar(pdfDeTresPaginas);
      expect(armado.cita, isNull);
      expect(armado.bloqueResaltado, isNull);
    });
  });

  group('lo demas del detalle', () {
    test('comoSeLeyo: cada origen en castellano', () {
      expect(
        TextoDelItem.comoSeLeyo(<String, dynamic>{'tipo': 'pdf', 'origen': 'pdf-texto', 'paginas': 3}),
        'PDF de 3 páginas, leído con su texto.',
      );
      expect(
        TextoDelItem.comoSeLeyo(<String, dynamic>{'tipo': 'foto', 'origen': 'ocr-space'}),
        contains('OCR'),
      );
      expect(
        TextoDelItem.comoSeLeyo(<String, dynamic>{'tipo': 'pdf', 'origen': 'ocr-space', 'paginas': 1}),
        startsWith('PDF escaneado de 1 página'),
      );
      expect(TextoDelItem.comoSeLeyo(<String, dynamic>{'tipo': 'word', 'origen': 'docx'}), contains('Word'));
      expect(TextoDelItem.comoSeLeyo(<String, dynamic>{'tipo': 'link', 'origen': 'link'}), startsWith('Página web'));
      expect(TextoDelItem.comoSeLeyo(<String, dynamic>{'tipo': 'nota', 'origen': 'nota'}), 'Nota escrita en la app.');
      // Sin el campo paginas, las cuenta de las marcas.
      expect(
        TextoDelItem.comoSeLeyo(<String, dynamic>{'tipo': 'pdf', 'origen': 'pdf-texto', 'texto': pdfDeTresPaginas}),
        'PDF de 3 páginas, leído con su texto.',
      );
      // Todavia no lo leyo: por el tipo.
      expect(TextoDelItem.comoSeLeyo(<String, dynamic>{'tipo': 'pdf'}), 'PDF.');
    });

    test('textoParaMostrar: lo que leyo la IA; si la nota no se proceso, lo que escribio la persona', () {
      expect(TextoDelItem.textoParaMostrar(<String, dynamic>{'tipo': 'nota', 'texto': 'leido', 'textoOriginal': 'escrito'}), 'leido');
      expect(TextoDelItem.textoParaMostrar(<String, dynamic>{'tipo': 'nota', 'textoOriginal': 'escrito'}), 'escrito');
      expect(TextoDelItem.textoParaMostrar(<String, dynamic>{'tipo': 'pdf'}), '');
    });

    test('conPuntos', () {
      expect(TextoDelItem.conPuntos(18422), '18.422');
      expect(TextoDelItem.conPuntos(300000), '300.000');
      expect(TextoDelItem.conPuntos(999), '999');
      expect(TextoDelItem.conPuntos(1000000), '1.000.000');
    });
  });

  group('la pantalla ya armada (CuerpoDelDetalle)', () {
    final Map<String, dynamic> cronograma = <String, dynamic>{
      'titulo': 'Cronograma de mesas de examen',
      'tipo': 'pdf',
      'origen': 'pdf-texto',
      'paginas': 3,
      'estado': 'listo',
      'visibilidad': 'equipo',
      'nombreArchivo': 'mesas-diciembre-2026.pdf',
      'caracteres': 18422,
      'texto': pdfDeTresPaginas,
    };

    testWidgets('una tarjeta por pagina y la cita pintada en cian', (WidgetTester tester) async {
      const String cita = 'Programación II (6.º 1.ª): miércoles 16/12, 10:00 hs, laboratorio 2.';
      final TextoArmado armado = TextoDelItem.armar(pdfDeTresPaginas, fragmento: cita, paginaCitada: 2);
      await tester.pumpWidget(
        enPantalla(
          CuerpoDelDetalle(
            datos: cronograma,
            armado: armado,
            dueno: 'Valentino Mattio · 24/08 · Del equipo',
            fragmentoCitado: cita,
            paginaCitada: 2,
          ),
        ),
      );

      expect(find.text('Cronograma de mesas de examen'), findsOneWidget);
      expect(find.text('PDF de 3 páginas, leído con su texto.'), findsOneWidget);
      expect(find.text('Valentino Mattio · 24/08 · Del equipo'), findsOneWidget);
      expect(find.text('18.422 caracteres leídos'), findsOneWidget);
      expect(find.text('Página 1'), findsOneWidget);
      expect(find.text('Página 2'), findsOneWidget);
      expect(find.text('En cian, lo que citó la respuesta.'), findsOneWidget);

      // El pedazo citado va en un TextSpan aparte, con el estilo resaltado.
      final Iterable<RichText> textos = tester.widgetList<RichText>(find.byType(RichText));
      final bool hayResaltado = textos.any((RichText r) {
        bool encontrado = false;
        r.text.visitChildren((InlineSpan s) {
          if (s is TextSpan && s.text == cita && s.style == CuerpoDelDetalle.estiloResaltado) {
            encontrado = true;
          }
          return !encontrado;
        });
        return encontrado;
      });
      expect(hayResaltado, isTrue);
    });

    testWidgets('si la cita no esta en el texto: sin resaltar y lo dice', (WidgetTester tester) async {
      final TextoArmado armado = TextoDelItem.armar(pdfDeTresPaginas, fragmento: 'algo que ya no está');
      await tester.pumpWidget(
        enPantalla(
          CuerpoDelDetalle(
            datos: cronograma,
            armado: armado,
            dueno: 'x',
            fragmentoCitado: 'algo que ya no está',
          ),
        ),
      );
      expect(find.textContaining('No encontramos la cita'), findsOneWidget);
      expect(find.text('En cian, lo que citó la respuesta.'), findsNothing);
    });

    testWidgets('texto sin marcas (la semilla) con cita de la pag. 2: lo aclara', (WidgetTester tester) async {
      const String sinMarcas = 'Artículo 4: el celular.\nArtículo 7: los laboratorios de informática se usan con autorización.';
      final TextoArmado armado = TextoDelItem.armar(
        sinMarcas,
        fragmento: 'Artículo 7: los laboratorios de informática se usan con autorización.',
        paginaCitada: 2,
      );
      await tester.pumpWidget(
        enPantalla(
          CuerpoDelDetalle(
            datos: <String, dynamic>{...cronograma, 'texto': sinMarcas},
            armado: armado,
            dueno: 'x',
            fragmentoCitado: 'Artículo 7: los laboratorios de informática se usan con autorización.',
            paginaCitada: 2,
          ),
        ),
      );
      expect(find.text('En cian, lo que citó la respuesta (es de la pág. 2).'), findsOneWidget);
      expect(find.textContaining('Página'), findsNothing);
    });

    testWidgets('un texto enorme (unos 215.000 caracteres) NO se arma entero', (WidgetTester tester) async {
      final String enorme = List<String>.generate(6000, (int i) => 'Renglón $i de un link larguísimo.').join('\n');
      expect(enorme.length, greaterThan(190000));
      final TextoArmado armado = TextoDelItem.armar(enorme);
      expect(armado.bloques.length, greaterThan(100));
      await tester.pumpWidget(
        enPantalla(
          CuerpoDelDetalle(
            datos: <String, dynamic>{'titulo': 'Link', 'tipo': 'link', 'origen': 'link', 'estado': 'listo', 'texto': enorme},
            armado: armado,
            dueno: 'x',
          ),
        ),
      );
      // El ListView.builder arma solo lo que entra en pantalla: muchos menos
      // textos que bloques.
      expect(tester.widgetList(find.byType(RichText)).length, lessThan(40));
      expect(find.textContaining('Renglón 5999'), findsNothing);
    });

    testWidgets('todavia sin leer: lo dice, y una nota muestra lo que escribio la persona', (WidgetTester tester) async {
      final Map<String, dynamic> pendiente = <String, dynamic>{
        'titulo': 'Materiales para el laboratorio',
        'tipo': 'nota',
        'estado': 'pendiente',
        'visibilidad': 'equipo',
        'textoOriginal': 'Traer 12 cables UTP.',
      };
      await tester.pumpWidget(
        enPantalla(
          CuerpoDelDetalle(
            datos: pendiente,
            armado: TextoDelItem.armar(TextoDelItem.textoParaMostrar(pendiente)),
            dueno: 'Vos · hoy · Del equipo',
          ),
        ),
      );
      expect(find.text('Pendiente'), findsOneWidget);
      expect(find.textContaining('Todavía no lo leyó la IA'), findsOneWidget);
      expect(find.textContaining('Traer 12 cables UTP.'), findsOneWidget);
    });

    testWidgets('sin acceso: "Ya no tenés acceso a esta fuente"', (WidgetTester tester) async {
      await tester.pumpWidget(enPantalla(const SinAccesoALaFuente()));
      expect(find.text('Ya no tenés acceso a esta fuente'), findsOneWidget);
    });
  });

  group('el salto a la cita en un celular chico (rectDelResaltado)', () {
    // Un bloque puede tener hasta 1500 caracteres y en un celular de 360 dp
    // es mas alto que la pantalla. Antes se llevaba a la vista el BLOQUE
    // entero (ensureVisible al 20%), y si la cita estaba al final del bloque
    // quedaba abajo, sin verse. Ahora se lleva a la vista el TRAMO en cian.
    testWidgets('con la cita al final de un bloque mas alto que la pantalla, el cian queda a la vista', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      final String pagina = List<String>.generate(27, (int i) => 'Renglón $i del reglamento de convivencia.').join('\n');
      const String citado = 'Renglón 26 del reglamento de convivencia.';
      final TextoArmado armado = TextoDelItem.armar('<<<PAGINA:1>>>\n$pagina', fragmento: citado, paginaCitada: 1);
      final int indice = armado.bloqueResaltado!;
      final ScrollController scroll = ScrollController();
      addTearDown(scroll.dispose);
      final GlobalKey clave = GlobalKey();
      await tester.pumpWidget(
        enPantalla(
          CuerpoDelDetalle(
            datos: <String, dynamic>{'titulo': 'Reglamento', 'tipo': 'pdf', 'origen': 'pdf-texto', 'estado': 'listo', 'paginas': 1},
            armado: armado,
            dueno: 'x',
            fragmentoCitado: citado,
            paginaCitada: 1,
            controlador: scroll,
            claveDelResaltado: clave,
          ),
        ),
      );
      final RenderBox bloque = clave.currentContext!.findRenderObject()! as RenderBox;
      expect(bloque.size.height, greaterThan(640), reason: 'el caso es un bloque mas alto que la pantalla');
      final Rect? cita = rectDelResaltado(bloque, armado.bloques[indice]);
      expect(cita, isNotNull);
      Rect enLaPantalla() => MatrixUtils.transformRect(bloque.getTransformTo(null), cita!);

      // Lo de antes: el bloque entero al 20%. La cita queda debajo del borde.
      await Scrollable.ensureVisible(clave.currentContext!, alignment: 0.2);
      await tester.pump();
      expect(enLaPantalla().top, greaterThan(640));

      // Lo de ahora (lo mismo que hace _buscarElResaltado): el TRAMO al 20%.
      final double destino = RenderAbstractViewport.of(bloque)
          .getOffsetToReveal(bloque, 0.2, rect: cita)
          .offset
          .clamp(scroll.position.minScrollExtent, scroll.position.maxScrollExtent);
      scroll.jumpTo(destino);
      await tester.pump();
      expect(enLaPantalla().top, greaterThanOrEqualTo(0));
      expect(enLaPantalla().bottom, lessThanOrEqualTo(640));
    });

    test('sin cian en el bloque no hay nada que medir', () {
      const BloqueDelTexto sinCita = BloqueDelTexto(
        numeroDePagina: null,
        texto: 'Nada citado.',
        esPrimeroDeLaPagina: true,
        esUltimoDeLaPagina: true,
      );
      expect(rectDelResaltado(null, sinCita), isNull);
    });
  });
}
