// ============================================================================
//  carga_test.dart — las pruebas de la CARGA UNIVERSAL, de los «Varios»
//  ('mixto') y de la app en la web
//
//  Corren con 'flutter test' en la compu, sin Firebase y sin internet, igual
//  que los otros tests. Prueban:
//    - que tipo de item sale segun lo que se cargo (nota, link, pdf, word,
//      foto o mixto) y los topes (8 archivos, 5 links, 10 MB c/u, 25 MB en
//      total), antes de mandar nada;
//    - los campos EXACTOS del documento que crea la app (hasOnly): el 'mixto'
//      lleva textoOriginal y links solo si hay, y nunca url ni nombreArchivo;
//    - el pedido multipart de /procesar armado sin mandarlo: 'archivo' para
//      un archivo solo, 'archivos' para el 'mixto', con nombre y tipo;
//    - "Lo que leyó NeuroDesk" de un 'mixto': el texto separado por partes
//      (con las paginas adentro del PDF), la parte que fallo avisada en su
//      lugar, y la cita resaltada EN SU PARTE aunque el mismo renglon este
//      en otra;
//    - la etiqueta de cada fuente con su parte ("PDF «x.pdf» · pág. 3");
//    - la fila del muro de un «Varios»;
//    - el registro con espacio de bienvenida, el popup de Google en la web y
//      el marco de ancho maximo de la app en una pantalla de compu.
//  La subida de verdad (Firestore + Render) se prueba en el emulador y en el
//  navegador: esta en el checklist de QA del README.
// ============================================================================

import 'dart:convert';
import 'dart:typed_data';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'package:neurodesk/pantallas/captura.dart';
import 'package:neurodesk/pantallas/chat.dart';
import 'package:neurodesk/pantallas/detalle_item.dart';
import 'package:neurodesk/pantallas/home.dart';
import 'package:neurodesk/servicios/api.dart';
import 'package:neurodesk/servicios/auth_servicio.dart';
import 'package:neurodesk/tema.dart';

/// Como guarda el backend el texto de un 'mixto' (contrato B): cada parte
/// precedida por <<<PARTE:etiqueta>>> en su propio renglon, y adentro de las
/// fotos y del PDF las marcas <<<PAGINA:n>>> de siempre. Las dos fotos son
/// del mismo pizarron: el primer renglon se repite A PROPOSITO.
const String mixtoDeLaDemo = '<<<PARTE:Texto>>>\n'
    'Reunión de padres de sexto: jueves 20 a las 18 hs.\n'
    '<<<PARTE:Foto 1>>>\n'
    '<<<PAGINA:1>>>\n'
    'Pizarrón: traer la autorización firmada.\n'
    '<<<PARTE:Foto 2>>>\n'
    '<<<PAGINA:1>>>\n'
    'Pizarrón: traer la autorización firmada.\n'
    'Es en el aula 12.\n'
    '<<<PARTE:PDF «cronograma.pdf»>>>\n'
    '<<<PAGINA:1>>>\n'
    'Matemática (6.º 1.ª): lunes 14/12, 8:00 hs.\n'
    '<<<PAGINA:2>>>\n'
    'Programación II (6.º 1.ª): miércoles 16/12, laboratorio 2.\n';

/// La lista 'partes' que acompaña a ese texto. El link fallo: no tiene
/// seccion en el texto, pero tiene que aparecer avisado en su lugar.
final List<Map<String, dynamic>> partesDeLaDemo = <Map<String, dynamic>>[
  <String, dynamic>{'etiqueta': 'Texto', 'tipo': 'texto', 'origen': 'nota', 'paginas': null, 'caracteres': 51, 'error': null},
  <String, dynamic>{'etiqueta': 'Foto 1', 'tipo': 'foto', 'origen': 'ocr-space', 'paginas': 1, 'caracteres': 40, 'error': null},
  <String, dynamic>{'etiqueta': 'Foto 2', 'tipo': 'foto', 'origen': 'ocr-space', 'paginas': 1, 'caracteres': 58, 'error': null},
  <String, dynamic>{'etiqueta': 'PDF «cronograma.pdf»', 'tipo': 'pdf', 'origen': 'pdf-texto', 'paginas': 2, 'caracteres': 101, 'error': null},
  <String, dynamic>{'etiqueta': 'Link «ejemplo.com»', 'tipo': 'link', 'origen': 'link', 'paginas': null, 'caracteres': 0, 'error': 'La página no se pudo abrir.'},
];

Map<String, dynamic> itemMixto() => <String, dynamic>{
      'titulo': 'Reunión de padres',
      'tipo': 'mixto',
      'estado': 'listo',
      'visibilidad': 'equipo',
      'textoOriginal': 'Reunión de padres de sexto: jueves 20 a las 18 hs.',
      'links': <String>['https://ejemplo.com/aviso'],
      'texto': mixtoDeLaDemo,
      'partes': partesDeLaDemo,
    };

Widget enPantalla(Widget hijo) {
  return MaterialApp(theme: temaNeuroDesk(), home: Scaffold(body: hijo));
}

ArchivoParaSubir archivoDePrueba(String nombre, {int bytes = 16}) => ArchivoParaSubir(
      nombre: nombre,
      bytes: Uint8List(bytes),
      tipoMime: Api.tipoMimeDe(nombre),
    );

const int mb = 1024 * 1024;

/// Las 7 claves que lleva SIEMPRE el item que crea la app.
const Set<String> clavesDeSiempre = <String>{
  'titulo', 'tipo', 'visibilidad', 'workspaceId', 'creadoPor', 'creadoEn', 'estado',
};

void main() {
  // ==========================================================================
  //  A. LA CARGA UNIVERSAL
  // ==========================================================================
  group('tipoSegunLoCargado (la app decide el tipo)', () {
    String? tipo({bool texto = false, int links = 0, List<String> archivos = const <String>[]}) =>
        CapturaPantalla.tipoSegunLoCargado(hayTexto: texto, cantLinks: links, tiposDeArchivos: archivos);

    test('sin nada no hay item (null)', () {
      expect(tipo(), isNull);
    });

    test('lo de siempre sigue igual: texto solo, un link solo, un archivo solo', () {
      expect(tipo(texto: true), 'nota');
      expect(tipo(links: 1), 'link');
      expect(tipo(archivos: <String>['pdf']), 'pdf');
      expect(tipo(archivos: <String>['word']), 'word');
      expect(tipo(archivos: <String>['foto']), 'foto');
    });

    test('cualquier mezcla, o mas de uno, es mixto', () {
      expect(tipo(texto: true, archivos: <String>['foto']), 'mixto');
      expect(tipo(texto: true, links: 1), 'mixto');
      expect(tipo(links: 1, archivos: <String>['pdf']), 'mixto');
      expect(tipo(links: 2), 'mixto');
      expect(tipo(archivos: <String>['foto', 'foto']), 'mixto');
      expect(tipo(archivos: <String>['pdf', 'word']), 'mixto');
    });

    test('en pantalla, el mixto se llama «Varios» y tiene icono de capas', () {
      expect(nombreDeTipo('mixto'), 'Varios');
      expect(iconoDeTipo('mixto'), Icons.layers);
      expect(iconoDeTipo('mixto'), isNot(iconoDeTipo('nota')));
      expect(CapturaPantalla.comoSeVaAGuardar('mixto', 3),
          'Se guarda como «Varios»: 3 partes que la IA lee por separado.');
      expect(CapturaPantalla.comoSeVaAGuardar('pdf', 1), 'Se guarda como PDF.');
    });
  });

  group('camposDelItem (hasOnly: ni un campo de mas)', () {
    Map<String, Object?> campos(String tipo,
            {String texto = '', List<String> links = const <String>[], String nombre = ''}) =>
        CapturaPantalla.camposDelItem(
          titulo: 'Reunión de padres',
          tipo: tipo,
          visibilidad: 'equipo',
          wsId: 'ws_demo',
          miUid: 'uid_ana',
          texto: texto,
          links: links,
          nombreArchivo: nombre,
        );

    test('mixto con texto y links: textoOriginal y links, NUNCA url ni nombreArchivo', () {
      final Map<String, Object?> c = campos(
        'mixto',
        texto: 'Traer la autorización.',
        links: <String>['https://a.com', 'https://b.com'],
      );
      expect(c.keys.toSet(), <String>{...clavesDeSiempre, 'textoOriginal', 'links'});
      expect(c['tipo'], 'mixto');
      expect(c['textoOriginal'], 'Traer la autorización.');
      expect(c['links'], <String>['https://a.com', 'https://b.com']);
      expect(c.containsKey('url'), isFalse);
      expect(c.containsKey('nombreArchivo'), isFalse);
      expect(c['estado'], 'pendiente');
      expect(c['creadoEn'], isA<FieldValue>());
      expect(c['workspaceId'], 'ws_demo');
      expect(c['creadoPor'], 'uid_ana');
    });

    test('mixto solo con archivos: las 7 de siempre (los archivos van por multipart)', () {
      expect(campos('mixto').keys.toSet(), clavesDeSiempre);
    });

    test('mixto sin texto pero con links: links si, textoOriginal no (ni vacio)', () {
      final Map<String, Object?> c = campos('mixto', links: <String>['https://a.com']);
      expect(c.keys.toSet(), <String>{...clavesDeSiempre, 'links'});
    });

    test('los tipos de siempre, con su campo de siempre', () {
      expect(campos('nota', texto: 'Hola').keys.toSet(), <String>{...clavesDeSiempre, 'textoOriginal'});
      final Map<String, Object?> link = campos('link', links: <String>['https://a.com']);
      expect(link.keys.toSet(), <String>{...clavesDeSiempre, 'url'});
      expect(link['url'], 'https://a.com');
      final Map<String, Object?> pdf = campos('pdf', nombre: 'cronograma.pdf');
      expect(pdf.keys.toSet(), <String>{...clavesDeSiempre, 'nombreArchivo'});
      expect(pdf['nombreArchivo'], 'cronograma.pdf');
      expect(campos('foto', nombre: 'pizarron.jpg').keys.toSet(), <String>{...clavesDeSiempre, 'nombreArchivo'});
      expect(campos('word', nombre: 'acta.docx').keys.toSet(), <String>{...clavesDeSiempre, 'nombreArchivo'});
    });

    test('un nombre de archivo larguisimo se corta en 200 y conserva la extension', () {
      final String largo = '${'a' * 300}.pdf';
      final String corto = CapturaPantalla.recortarNombre(largo);
      expect(corto.length, lessThanOrEqualTo(200));
      expect(corto.endsWith('.pdf'), isTrue);
      expect(CapturaPantalla.recortarNombre('normal.pdf'), 'normal.pdf');
    });
  });

  group('los topes, ANTES de mandar', () {
    test('linkValido: solo http o https, con dominio y sin espacios', () {
      expect(CapturaPantalla.linkValido('https://ejemplo.com/x'), 'https://ejemplo.com/x');
      expect(CapturaPantalla.linkValido('  http://ejemplo.com  '), 'http://ejemplo.com');
      // El esquema en minuscula (la regla mira 'https?://'), la ruta tal cual.
      expect(CapturaPantalla.linkValido('HTTPS://Ejemplo.com/Acta'), 'https://Ejemplo.com/Acta');
      expect(CapturaPantalla.linkValido('www.ejemplo.com'), isNull);
      expect(CapturaPantalla.linkValido('ftp://ejemplo.com'), isNull);
      expect(CapturaPantalla.linkValido('javascript:alert(1)'), isNull);
      expect(CapturaPantalla.linkValido('https://'), isNull);
      expect(CapturaPantalla.linkValido('https://ejemplo.com/con espacio'), isNull);
      expect(CapturaPantalla.linkValido('https://e.com/${'x' * 2000}'), isNull);
      expect(CapturaPantalla.linkValido(''), isNull);
    });

    test('avisoSiNoEntra: 8 archivos, 10 MB cada uno, 25 MB entre todos', () {
      String? aviso({int ya = 0, int bytesYa = 0, required int nuevo}) => CapturaPantalla.avisoSiNoEntra(
            nombre: 'x.pdf',
            bytesDelNuevo: nuevo,
            archivosYaElegidos: ya,
            bytesYaElegidos: bytesYa,
          );
      expect(aviso(nuevo: 2 * mb), isNull);
      expect(aviso(ya: 8, nuevo: 1), contains('8 archivos'));
      expect(aviso(nuevo: 11 * mb), contains('10 MB'));
      expect(aviso(ya: 2, bytesYa: 20 * mb, nuevo: 6 * mb), contains('25 MB'));
      // Justo 25 MB entra (el tope es "hasta").
      expect(aviso(ya: 2, bytesYa: 20 * mb, nuevo: 5 * mb), isNull);
      // Justo 10 MB entra.
      expect(aviso(nuevo: 10 * mb), isNull);
    });

    test('tamanoLegible: con coma, como en castellano', () {
      expect(CapturaPantalla.tamanoLegible(850 * 1024), '850 KB');
      expect(CapturaPantalla.tamanoLegible((1.5 * mb).round()), '1,5 MB');
      expect(CapturaPantalla.tamanoLegible(12 * mb), '12,0 MB');
    });
  });

  group('el pedido de /procesar (multipart, armado sin mandar)', () {
    final Uri url = Uri.parse('https://api.ejemplo/v1/workspaces/ws/items/it/procesar');

    test('un archivo solo (pdf/word/foto) viaja en la parte "archivo"', () {
      final http.MultipartRequest p = Api.armarMultipart(
        url: url,
        token: 'tok',
        archivo: archivoDePrueba('cronograma.pdf', bytes: 40),
      );
      expect(p.method, 'POST');
      expect(p.headers['Authorization'], 'Bearer tok');
      expect(p.files.map((http.MultipartFile f) => f.field).toList(), <String>['archivo']);
      expect(p.files.single.filename, 'cronograma.pdf');
      expect(p.files.single.contentType.mimeType, 'application/pdf');
      expect(p.files.single.length, 40);
    });

    test('el mixto: cada archivo en una parte "archivos", con su nombre y su tipo, y sin "archivo"', () async {
      final http.MultipartRequest p = Api.armarMultipart(
        url: url,
        token: 'tok',
        archivos: <ArchivoParaSubir>[
          archivoDePrueba('pizarron.jpg'),
          archivoDePrueba('cronograma.pdf'),
          archivoDePrueba('acta.docx'),
        ],
      );
      expect(p.files.map((http.MultipartFile f) => f.field).toList(), <String>['archivos', 'archivos', 'archivos']);
      expect(p.files.map((http.MultipartFile f) => f.filename).toList(),
          <String>['pizarron.jpg', 'cronograma.pdf', 'acta.docx']);
      expect(p.files.map((http.MultipartFile f) => f.contentType.mimeType).toList(), <String>[
        'image/jpeg',
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ]);
      // Lo que viaja de verdad por la red (el cuerpo armado).
      final String cuerpo = latin1.decode(await p.finalize().toBytes());
      expect(cuerpo, contains('name="archivos"; filename="pizarron.jpg"'));
      expect(cuerpo, isNot(contains('name="archivo";')));
      expect(cuerpo.toLowerCase(), contains('content-type: image/jpeg'));
    });

    test('un mixto de texto y links solos va multipart igual, con 0 archivos', () async {
      final http.MultipartRequest p = Api.armarMultipart(url: url, token: 'tok', archivos: const <ArchivoParaSubir>[]);
      expect(p.files, isEmpty);
      // Un multipart vacio bien cerrado: solo el boundary final.
      final String cuerpo = latin1.decode(await p.finalize().toBytes());
      expect(cuerpo.trim(), endsWith('--'));
    });

    test('tipoMimeDe: por la extension, y lo desconocido como bytes sin tipo', () {
      expect(Api.tipoMimeDe('FOTO.JPG'), 'image/jpeg');
      expect(Api.tipoMimeDe('captura.png'), 'image/png');
      expect(Api.tipoMimeDe('Informe.DocX'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      expect(Api.tipoMimeDe('sin extension'), 'application/octet-stream');
    });
  });

  // ==========================================================================
  //  B. MOSTRAR LOS 'mixto'
  // ==========================================================================
  group('cortarEnPartes (las marcas <<<PARTE:etiqueta>>>)', () {
    test('un mixto da una seccion por parte, sin las marcas', () {
      final List<SeccionDeParte> s = TextoDelItem.cortarEnPartes(mixtoDeLaDemo);
      expect(s.map((SeccionDeParte x) => x.etiqueta).toList(),
          <String>['Texto', 'Foto 1', 'Foto 2', 'PDF «cronograma.pdf»']);
      expect(s.any((SeccionDeParte x) => x.texto.contains('<<<PARTE')), isFalse);
      // Adentro del PDF siguen las marcas de pagina.
      expect(s.last.texto, contains('<<<PAGINA:2>>>'));
    });

    test('sin marcas (los tipos de siempre) es UNA seccion sin etiqueta con todo', () {
      const String nota = 'Una nota común.\nCon dos renglones.';
      final List<SeccionDeParte> s = TextoDelItem.cortarEnPartes(nota);
      expect(s, hasLength(1));
      expect(s.single.etiqueta, isNull);
      expect(s.single.texto, nota);
    });

    test('partesDelItem: lee con cuidado lo que mande el backend', () {
      final List<ParteDelItem> p = TextoDelItem.partesDelItem(<String, dynamic>{
        'partes': <dynamic>[
          <String, dynamic>{'etiqueta': 'Foto 1', 'tipo': 'foto', 'paginas': 1.0, 'error': true},
          'no es un mapa',
          <String, dynamic>{'etiqueta': '   '}, // sin etiqueta no sirve
          <String, dynamic>{'etiqueta': 'Texto', 'tipo': 'texto'},
        ],
      });
      expect(p.map((ParteDelItem x) => x.etiqueta).toList(), <String>['Foto 1', 'Texto']);
      expect(p.first.paginas, 1);
      expect(p.first.tieneError, isTrue); // un error que no es texto igual se avisa
      expect(p.last.tieneError, isFalse);
      expect(p.last.tipoComoItem, 'nota');
      expect(TextoDelItem.partesDelItem(<String, dynamic>{'partes': 'roto'}), isEmpty);
      expect(TextoDelItem.partesDelItem(<String, dynamic>{}), isEmpty);
    });
  });

  group('armar un mixto: partes, paginas y la cita en SU parte', () {
    final List<ParteDelItem> partes = TextoDelItem.partesDelItem(itemMixto());

    test('cada parte con su encabezado, en el orden de la lista, y la que fallo tambien', () {
      final TextoArmado a = TextoDelItem.armar(mixtoDeLaDemo, partes: partes);
      final List<String> encabezados = a.bloques
          .where((BloqueDelTexto b) => b.encabezadoDeParte != null)
          .map((BloqueDelTexto b) => b.encabezadoDeParte!.etiqueta)
          .toList();
      expect(encabezados, <String>['Texto', 'Foto 1', 'Foto 2', 'PDF «cronograma.pdf»', 'Link «ejemplo.com»']);
      expect(a.tienePartes, isTrue);
      // El link fallo: no tiene texto, su bloque es solo el encabezado con el error.
      final BloqueDelTexto link = a.bloques.last;
      expect(link.texto, isEmpty);
      expect(link.encabezadoDeParte!.error, 'La página no se pudo abrir.');
      // Las paginas del PDF siguen separadas adentro de su parte.
      final List<int?> paginasDelPdf = a.bloques
          .where((BloqueDelTexto b) => b.parte == 'PDF «cronograma.pdf»' && b.esPrimeroDeLaPagina)
          .map((BloqueDelTexto b) => b.numeroDePagina)
          .toList();
      expect(paginasDelPdf, <int>[1, 2]);
    });

    test('el renglon repetido en dos fotos se resalta en la parte que dice la fuente', () {
      const String cita = 'Pizarrón: traer la autorización firmada.';
      final TextoArmado enLa2 = TextoDelItem.armar(mixtoDeLaDemo, partes: partes, fragmento: cita, parteCitada: 'Foto 2', paginaCitada: 1);
      expect(enLa2.bloques[enLa2.bloqueResaltado!].parte, 'Foto 2');
      // Sin parte (una fuente vieja), la primera vez que aparece: la Foto 1.
      final TextoArmado sinParte = TextoDelItem.armar(mixtoDeLaDemo, partes: partes, fragmento: cita);
      expect(sinParte.bloques[sinParte.bloqueResaltado!].parte, 'Foto 1');
    });

    test('una cita del PDF adentro del mixto queda en su parte y en su pagina', () {
      const String cita = 'Programación II (6.º 1.ª): miércoles 16/12, laboratorio 2.';
      final TextoArmado a = TextoDelItem.armar(
        mixtoDeLaDemo,
        partes: partes,
        fragmento: cita,
        parteCitada: 'PDF «cronograma.pdf»',
        paginaCitada: 2,
      );
      final BloqueDelTexto b = a.bloques[a.bloqueResaltado!];
      expect(b.parte, 'PDF «cronograma.pdf»');
      expect(b.numeroDePagina, 2);
      expect(b.texto.substring(b.resaltadoDesde!, b.resaltadoHasta!), cita);
    });

    test('sin la lista partes (todavia no la escribio el backend) igual se separa', () {
      final TextoArmado a = TextoDelItem.armar(mixtoDeLaDemo);
      expect(
        a.bloques.where((BloqueDelTexto b) => b.encabezadoDeParte != null).map((BloqueDelTexto b) => b.encabezadoDeParte!.etiqueta),
        <String>['Texto', 'Foto 1', 'Foto 2', 'PDF «cronograma.pdf»'],
      );
    });

    test('un texto con una parte que no esta en la lista no se esconde: va al final', () {
      final TextoArmado a = TextoDelItem.armar(
        '$mixtoDeLaDemo<<<PARTE:Foto 3>>>\nUna foto de mas.\n',
        partes: partes,
      );
      expect(a.bloques.last.parte, 'Foto 3');
      expect(a.bloques.last.texto, 'Una foto de mas.');
    });

    test('los tipos de siempre quedan igual: sin encabezados de parte', () {
      const String pdf = '<<<PAGINA:1>>>\nUno.\n<<<PAGINA:2>>>\nDos.';
      final TextoArmado a = TextoDelItem.armar(pdf, fragmento: 'Dos.', paginaCitada: 2);
      expect(a.tienePartes, isFalse);
      expect(a.bloques, hasLength(2));
      expect(a.bloques.every((BloqueDelTexto b) => b.parte == null), isTrue);
      expect(a.bloques[a.bloqueResaltado!].numeroDePagina, 2);
    });

    test('como se leyo un mixto y cada parte', () {
      expect(TextoDelItem.resumenDePartes(partes), '1 texto, 2 fotos, 1 PDF y 1 link');
      expect(TextoDelItem.comoSeLeyo(itemMixto()),
          'Varios: 1 texto, 2 fotos, 1 PDF y 1 link. Cada parte se leyó por separado.');
      expect(TextoDelItem.comoSeLeyo(<String, dynamic>{'tipo': 'mixto'}),
          'Varios: texto, archivos y links en una sola carga.');
      expect(TextoDelItem.comoSeLeyoLaParte(partes[1]), startsWith('Foto: el texto se sacó con OCR'));
      expect(TextoDelItem.comoSeLeyoLaParte(partes[3]), 'PDF de 2 páginas, leído con su texto. 101 caracteres.');
      expect(TextoDelItem.comoSeLeyoLaParte(partes[0]), 'Texto escrito en la app. 51 caracteres.');
    });
  });

  group('la pantalla de un mixto (CuerpoDelDetalle)', () {
    testWidgets('separado por partes, la que fallo avisada y la cita en cian en la Foto 2', (WidgetTester tester) async {
      // Una pantalla alta: el ListView arma solo lo que se ve, y queremos
      // ver todas las partes a la vez.
      tester.view.physicalSize = const Size(800, 3000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      const String cita = 'Pizarrón: traer la autorización firmada.';
      final Map<String, dynamic> datos = itemMixto();
      final TextoArmado armado = TextoDelItem.armar(
        mixtoDeLaDemo,
        partes: TextoDelItem.partesDelItem(datos),
        fragmento: cita,
        parteCitada: 'Foto 2',
        paginaCitada: 1,
      );
      await tester.pumpWidget(
        enPantalla(
          CuerpoDelDetalle(
            datos: datos,
            armado: armado,
            dueno: 'Valentino Mattio · 24/08 · Del equipo',
            fragmentoCitado: cita,
            paginaCitada: 1,
            parteCitada: 'Foto 2',
          ),
        ),
      );

      // Arriba: que es, sus links y que una parte fallo.
      expect(find.byIcon(Icons.layers), findsOneWidget);
      expect(find.text('Varios: 1 texto, 2 fotos, 1 PDF y 1 link. Cada parte se leyó por separado.'), findsOneWidget);
      expect(
        find.byWidgetPredicate((Widget w) => w is SelectableText && w.data == 'https://ejemplo.com/aviso'),
        findsOneWidget,
      );
      expect(find.text('1 de 5 partes no se pudo leer: está marcada abajo.'), findsOneWidget);
      expect(find.text('En cian, lo que citó la respuesta (en Foto 2, pág. 1).'), findsOneWidget);

      // Cada parte con su encabezado.
      for (final String parte in <String>['Texto', 'Foto 1', 'Foto 2', 'PDF «cronograma.pdf»', 'Link «ejemplo.com»']) {
        expect(find.text(parte), findsOneWidget, reason: 'falta el encabezado de $parte');
      }
      expect(find.text('No se pudo leer esta parte: La página no se pudo abrir.'), findsOneWidget);
      // Las paginas del PDF, adentro de su parte.
      expect(find.text('Página 2'), findsOneWidget);

      // El cian esta en UN solo lugar: el de la Foto 2 (el que dice "aula 12"
      // abajo), no en la Foto 1 que tiene el mismo renglon.
      final List<RichText> conCian = tester
          .widgetList<RichText>(find.byType(RichText))
          .where((RichText r) {
        bool hay = false;
        r.text.visitChildren((InlineSpan s) {
          if (s is TextSpan && s.text == cita && s.style == CuerpoDelDetalle.estiloResaltado) hay = true;
          return !hay;
        });
        return hay;
      }).toList();
      expect(conCian, hasLength(1));
      expect(conCian.single.text.toPlainText(), contains('aula 12'));
    });

    testWidgets('un mixto con todas sus partes fallidas igual muestra cada error', (WidgetTester tester) async {
      final Map<String, dynamic> datos = <String, dynamic>{
        'titulo': 'Todo mal',
        'tipo': 'mixto',
        'estado': 'error',
        'errorMsg': 'No se pudo leer ninguna parte.',
        'partes': <dynamic>[
          <String, dynamic>{'etiqueta': 'Foto 1', 'tipo': 'foto', 'error': 'La foto no tiene texto.'},
        ],
      };
      final TextoArmado armado = TextoDelItem.armar('', partes: TextoDelItem.partesDelItem(datos));
      await tester.pumpWidget(enPantalla(CuerpoDelDetalle(datos: datos, armado: armado, dueno: 'x')));
      expect(find.text('Foto 1'), findsOneWidget);
      expect(find.text('No se pudo leer esta parte: La foto no tiene texto.'), findsOneWidget);
      expect(find.text('No se pudo leer ninguna parte.'), findsOneWidget);
    });
  });

  group('la fuente dice en que parte esta', () {
    test('ubicacionDeLaFuente: parte, pagina, las dos o ninguna', () {
      expect(ubicacionDeLaFuente(<String, dynamic>{'pagina': 3}), 'pág. 3');
      expect(ubicacionDeLaFuente(<String, dynamic>{'parte': 'Foto 2', 'pagina': null}), 'Foto 2');
      expect(ubicacionDeLaFuente(<String, dynamic>{'parte': 'PDF «x.pdf»', 'pagina': 3}), 'PDF «x.pdf» · pág. 3');
      expect(ubicacionDeLaFuente(<String, dynamic>{'parte': null, 'pagina': null}), isNull);
      expect(ubicacionDeLaFuente(<String, dynamic>{'parte': '   '}), isNull);
      expect(ubicacionDeLaFuente(<String, dynamic>{}), isNull);
    });

    testWidgets('en la respuesta, la fuente de un mixto muestra su parte con la pagina', (WidgetTester tester) async {
      const Vuelta v = Vuelta(
        id: 'r1',
        pregunta: '¿Cuándo es Programación II?',
        estado: 'listo',
        respuesta: 'El miércoles 16/12 [1]. Hay que llevar la autorización [2].',
        confianza: 'alta',
        fuentes: <dynamic>[
          <String, dynamic>{'n': 1, 'titulo': 'Reunión de padres', 'parte': 'PDF «cronograma.pdf»', 'pagina': 2, 'fragmento': 'Programación II'},
          <String, dynamic>{'n': 2, 'titulo': 'Reunión de padres', 'parte': 'Foto 2', 'pagina': null, 'fragmento': 'Pizarrón'},
          <String, dynamic>{'n': 3, 'titulo': 'Un PDF de siempre', 'parte': null, 'pagina': 4, 'fragmento': 'x'},
        ],
        chunksVisibles: 10,
      );
      await tester.pumpWidget(
        MaterialApp(
          theme: temaNeuroDesk(),
          home: Scaffold(body: ListView(children: const <Widget>[TarjetaDeVuelta(vuelta: v)])),
        ),
      );
      expect(find.text('PDF «cronograma.pdf» · pág. 2'), findsOneWidget);
      expect(find.text('Foto 2'), findsOneWidget);
      expect(find.text('pág. 4'), findsOneWidget); // la de siempre, como antes
    });
  });

  test('la fila del muro de un «Varios» dice cuantas partes tiene', () {
    expect(HomePantalla.resumenDeVarios(itemMixto()), 'Varios · 5 partes');
    expect(
      HomePantalla.resumenDeVarios(<String, dynamic>{'tipo': 'mixto', 'partes': <dynamic>[<String, dynamic>{'etiqueta': 'Foto 1'}]}),
      'Varios · 1 parte',
    );
    // Todavia sin leer: no se sabe cuantas.
    expect(HomePantalla.resumenDeVarios(<String, dynamic>{'tipo': 'mixto', 'estado': 'pendiente'}), 'Varios');
    // Los tipos de siempre no cambian su fila.
    expect(HomePantalla.resumenDeVarios(<String, dynamic>{'tipo': 'pdf'}), isNull);
  });

  // ==========================================================================
  //  C y D. LA WEB Y EL REGISTRO
  // ==========================================================================
  group('registro con espacio de bienvenida', () {
    test('si el servidor lo sumo a un espacio, la app sabe cual (y pide token nuevo)', () {
      expect(AuthServicio.espacioDeBienvenida(<String, dynamic>{'ok': true, 'espacioDeBienvenida': 'ws_demo'}), 'ws_demo');
    });

    test('null, vacio, ausente (servidor viejo) o algo raro: no hay espacio', () {
      expect(AuthServicio.espacioDeBienvenida(<String, dynamic>{'ok': true, 'espacioDeBienvenida': null}), isNull);
      expect(AuthServicio.espacioDeBienvenida(<String, dynamic>{'ok': true, 'espacioDeBienvenida': '  '}), isNull);
      expect(AuthServicio.espacioDeBienvenida(<String, dynamic>{'ok': true}), isNull);
      expect(AuthServicio.espacioDeBienvenida(<String, dynamic>{'espacioDeBienvenida': 42}), isNull);
    });
  });

  group('Google en la web (el popup)', () {
    test('cerrar la ventana no es un error; que el navegador la bloquee si', () {
      expect(AuthServicio.esCancelacionDeGoogleEnLaWeb(FirebaseAuthException(code: 'popup-closed-by-user')), isTrue);
      expect(AuthServicio.esCancelacionDeGoogleEnLaWeb(FirebaseAuthException(code: 'cancelled-popup-request')), isTrue);
      expect(AuthServicio.esCancelacionDeGoogleEnLaWeb(FirebaseAuthException(code: 'popup-blocked')), isFalse);
    });

    test('los errores del popup, en castellano', () {
      expect(
        AuthServicio.traducirErrorDeAuth(FirebaseAuthException(code: 'popup-blocked'), conGoogle: true),
        contains('ventanas emergentes'),
      );
      expect(
        AuthServicio.traducirErrorDeAuth(FirebaseAuthException(code: 'unauthorized-domain'), conGoogle: true),
        contains('Entrá con tu email'),
      );
    });
  });

  group('MarcoDeLaApp (la app en una ventana de compu)', () {
    Future<double> anchoAdentro(WidgetTester tester, Size pantalla) async {
      tester.view.physicalSize = pantalla;
      tester.view.devicePixelRatio = 1;
      double ancho = 0;
      await tester.pumpWidget(
        MaterialApp(
          builder: (BuildContext context, Widget? child) => MarcoDeLaApp(child: child),
          home: Builder(
            builder: (BuildContext context) {
              ancho = MediaQuery.sizeOf(context).width;
              return const Scaffold(body: SizedBox.expand(key: Key('cuerpo')));
            },
          ),
        ),
      );
      return ancho;
    }

    testWidgets('en una compu ancha: una columna de 720 centrada, y la app lo sabe', (WidgetTester tester) async {
      addTearDown(tester.view.reset);
      expect(await anchoAdentro(tester, const Size(1400, 900)), anchoMaximoDeLaApp);
      expect(tester.getSize(find.byKey(const Key('cuerpo'))).width, anchoMaximoDeLaApp);
      expect(tester.getTopLeft(find.byKey(const Key('cuerpo'))).dx, (1400 - anchoMaximoDeLaApp) / 2);
    });

    testWidgets('en un celular no cambia nada', (WidgetTester tester) async {
      addTearDown(tester.view.reset);
      expect(await anchoAdentro(tester, const Size(390, 800)), 390);
      expect(tester.getSize(find.byKey(const Key('cuerpo'))).width, 390);
    });
  });
}
