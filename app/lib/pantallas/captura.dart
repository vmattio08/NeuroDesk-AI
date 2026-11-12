// ============================================================================
//  captura.dart — la CARGA UNIVERSAL: un titulo, un texto si queres, y abajo
//  todo lo que quieras adjuntar (fotos, PDF, Word y links) en una sola pantalla
//
//  ================== LA REGLA DE ORO DEL PROYECTO, ACA =====================
//  El orden es SIEMPRE este, y no se puede dar vuelta:
//
//     1) La app CREA el item en Firestore con estado 'pendiente'.
//     2) RECIEN DESPUES le manda los archivos al backend con ese itemId.
//
//  Por que en ese orden:
//   - La fila aparece al instante en el celular y en el panel del admin,
//     aunque el backend de Render este dormido (tarda hasta 60 s en
//     despertar). El dato ya esta guardado y no se pierde.
//   - Si el POST falla, se corta la luz o el celular se queda sin señal, el
//     item queda visible en 'pendiente' con el boton Reintentar. No se perdio
//     nada y no costo un peso.
//   - El backend NUNCA crea el item: si el itemId no existe, contesta 404
//     ITEM_NO_ENCONTRADO. Eso deja UN solo dueño de la creacion (el cliente) y
//     evita el bug clasico de que se creen dos items por el mismo contenido.
//
//  ================== QUE TIPO DE ITEM SE GUARDA ============================
//  La persona ya no elige el tipo: lo decide la app con lo que cargo
//  (tipoSegunLoCargado), para que lo de siempre siga igual que siempre:
//     solo texto                       -> 'nota'   (textoOriginal)
//     un solo link y nada mas          -> 'link'   (url)
//     un solo archivo y nada mas       -> 'pdf' | 'word' | 'foto'
//                                         (nombreArchivo + la parte 'archivo')
//     cualquier mezcla, o mas de uno   -> 'mixto'  (en pantalla: «Varios»)
//  Asi un PDF suelto sigue siendo un 'pdf' con su "pág. 3", y el backend, el
//  panel y el reproceso de los tipos viejos no cambian en nada.
//
//  ================== LOS CAMPOS QUE ESCRIBE EL CLIENTE =====================
//  Las reglas usan hasOnly(): si mandamos UN campo de mas, se rechaza la
//  escritura ENTERA con permission-denied. Los unicos permitidos son:
//     titulo, tipo, visibilidad, workspaceId, creadoPor, creadoEn, estado,
//     y segun el tipo: url (link), nombreArchivo (pdf/word/foto),
//     textoOriginal (nota, y el 'mixto' si tiene texto), links ('mixto').
//  El 'mixto' NO lleva url ni nombreArchivo: sus archivos viajan en las
//  partes 'archivos' del multipart y sus links en la lista 'links'.
//  NO va 'texto', NO va 'cantChunks', NO va 'actualizadoEn'. Esos los escribe
//  el backend. Ese fue exactamente el bug que rompio la version 1 del proyecto.
//  Todo eso lo arma camposDelItem, que se prueba sin Firebase.
//
//  textoOriginal (lo que escribe la PERSONA) y texto (lo que extrae el
//  BACKEND) son dos campos distintos A PROPOSITO: asi el tipo 'nota' funciona
//  sin abrirle al cliente el campo que alimenta a la IA.
//
//  ================== POR QUE BYTES Y NO ARCHIVOS ===========================
//  La app tambien compila para la WEB, y en el navegador no existe dart:io
//  (ni File ni rutas de disco). Cada adjunto se guarda como sus BYTES:
//  image_picker los da con XFile.readAsBytes() y file_picker con
//  PlatformFile.bytes. El mismo codigo anda en Android y en la web.
// ============================================================================

import 'dart:async';
import 'dart:typed_data';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../servicios/api.dart';
import '../servicios/auth_servicio.dart';
import '../tema.dart';

/// Un archivo ya elegido en la pantalla de carga: que es y sus bytes.
class Adjunto {
  const Adjunto({required this.tipo, required this.archivo});

  /// 'foto', 'pdf' o 'word': el mismo valor que tendria el item si fuera
  /// lo unico que se carga.
  final String tipo;
  final ArchivoParaSubir archivo;

  String get nombre => archivo.nombre;
  int get tamano => archivo.tamano;
}

class CapturaPantalla extends StatefulWidget {
  const CapturaPantalla({super.key, required this.wsId, required this.miUid});

  final String wsId;
  final String miUid;

  // Los mismos limites que validan las reglas de Firestore y el backend.
  // El cliente los valida ANTES de mandar para no gastar los datos del celular
  // en un pedido que el servidor va a rechazar igual. El backend los vuelve a
  // validar SIEMPRE, porque un cliente se puede modificar.
  static const int maxCaracteresNota = 50000;
  static const int maxCaracteresTitulo = 140;
  static const int maxCaracteresLink = 2000;
  static const int maxCaracteresNombreArchivo = 200;
  static const int maxArchivos = 8;
  static const int maxLinks = 5;
  static const int maxBytesArchivo = 10 * 1024 * 1024; // 10 MB cada uno
  static const int maxBytesTotal = 25 * 1024 * 1024; // 25 MB entre todos

  /// El 'tipo' de un documento por su nombre: 'pdf' para .pdf, 'word' para
  /// .docx y null para cualquier otra cosa.
  ///
  /// POR QUE SE MIRA LA EXTENSION ACA, si el selector ya filtra: el
  /// allowedExtensions de file_picker es un PEDIDO, no una garantia. En
  /// Android se traduce a tipos MIME y algunos exploradores de archivos (o
  /// Drive) dejan elegir cualquier cosa igual.
  ///
  /// El .doc da null A PROPOSITO: es el formato binario viejo de Word y el
  /// backend no lo sabe leer. Mejor frenarlo antes de gastar datos.
  ///
  /// Es estatica y publica para probarla con 'flutter test' sin armar la
  /// pantalla y sin Firebase (igual que los helpers de AuthServicio).
  static String? tipoDeDocumento(String nombreArchivo) {
    final String nombre = nombreArchivo.trim().toLowerCase();
    if (nombre.endsWith('.pdf')) return 'pdf';
    if (nombre.endsWith('.docx')) return 'word';
    return null;
  }

  /// El 'tipo' del item segun lo que se cargo, o null si no hay nada.
  /// [tiposDeArchivos] son los tipos de los adjuntos ('foto', 'pdf', 'word').
  /// La tabla esta en el encabezado de este archivo.
  static String? tipoSegunLoCargado({
    required bool hayTexto,
    required int cantLinks,
    required List<String> tiposDeArchivos,
  }) {
    final int archivos = tiposDeArchivos.length;
    if (!hayTexto && cantLinks == 0 && archivos == 0) return null;
    if (cantLinks == 0 && archivos == 0) return 'nota';
    if (!hayTexto && cantLinks == 1 && archivos == 0) return 'link';
    if (!hayTexto && cantLinks == 0 && archivos == 1) return tiposDeArchivos.single;
    return 'mixto';
  }

  /// El link limpio si sirve, o null: http o https, con un dominio, sin
  /// espacios y de hasta 2000 caracteres (el tope de 'url' en el modelo).
  /// El backend igual lo vuelve a revisar contra SSRF antes de abrirlo.
  static String? linkValido(String texto) {
    final String t = texto.trim();
    if (t.isEmpty || t.length > maxCaracteresLink || RegExp(r'\s').hasMatch(t)) return null;
    final Uri? uri = Uri.tryParse(t);
    if (uri == null) return null;
    final String esquema = uri.scheme.toLowerCase();
    if (esquema != 'http' && esquema != 'https') return null;
    if (uri.host.isEmpty) return null;
    // El esquema va en minuscula: la regla de Firestore mira 'https?://' tal
    // cual, y un "HTTPS://..." pegado de algun lado haria rechazar el item
    // entero. El resto del link no se toca (las rutas distinguen mayusculas).
    return esquema + t.substring(esquema.length);
  }

  /// El aviso si un archivo NO entra, o null si entra. Mira los tres topes
  /// en el orden en que la persona los entiende mejor: cuantos, cuanto pesa
  /// ese, cuanto suman todos.
  static String? avisoSiNoEntra({
    required String nombre,
    required int bytesDelNuevo,
    required int archivosYaElegidos,
    required int bytesYaElegidos,
  }) {
    if (archivosYaElegidos >= maxArchivos) {
      return 'Ya hay $maxArchivos archivos: es el máximo por carga.';
    }
    if (bytesDelNuevo > maxBytesArchivo) {
      return '«$nombre» pesa ${tamanoLegible(bytesDelNuevo)} y el máximo es 10 MB por archivo.';
    }
    if (bytesYaElegidos + bytesDelNuevo > maxBytesTotal) {
      return 'Con «$nombre» se pasaría de 25 MB entre todos los archivos. '
          'Sacá alguno o guardalo en otra carga.';
    }
    return null;
  }

  /// EXACTAMENTE los campos que permiten las reglas para ese tipo, ni uno
  /// mas (hasOnly). [nombreArchivo] solo se usa en 'pdf', 'word' y 'foto'.
  static Map<String, Object?> camposDelItem({
    required String titulo,
    required String tipo,
    required String visibilidad,
    required String wsId,
    required String miUid,
    String texto = '',
    List<String> links = const <String>[],
    String nombreArchivo = '',
  }) {
    final bool esArchivoSolo = tipo == 'pdf' || tipo == 'word' || tipo == 'foto';
    return <String, Object?>{
      'titulo': titulo,
      'tipo': tipo,
      'visibilidad': visibilidad,
      'workspaceId': wsId, // tiene que coincidir con el del path
      'creadoPor': miUid, // la regla exige que sea request.auth.uid
      // serverTimestamp OBLIGATORIO: la regla compara contra request.time, asi
      // que el reloj del celular (que puede estar mal) no sirve.
      'creadoEn': FieldValue.serverTimestamp(),
      'estado': 'pendiente', // nace pendiente. No puede nacer 'listo'.
      if (tipo == 'nota') 'textoOriginal': texto,
      if (tipo == 'link') 'url': links.single,
      if (esArchivoSolo) 'nombreArchivo': recortarNombre(nombreArchivo),
      // El 'mixto': texto y links son OPCIONALES. Si no hay, el campo NO va
      // (ni vacio ni en null): la regla pide 1 a 50.000 caracteres y 1 a 5
      // links, y un campo vacio la haria rechazar la escritura entera.
      if (tipo == 'mixto' && texto.isNotEmpty) 'textoOriginal': texto,
      if (tipo == 'mixto' && links.isNotEmpty) 'links': List<String>.of(links),
    };
  }

  /// nombreArchivo tiene un tope de 200 caracteres en las reglas: uno mas
  /// largo haria rechazar el item entero. Se corta por el medio y se deja la
  /// extension, que es lo que dice que es.
  static String recortarNombre(String nombre) {
    if (nombre.length <= maxCaracteresNombreArchivo) return nombre;
    final int punto = nombre.lastIndexOf('.');
    final String ext = (punto > 0 && nombre.length - punto <= 10) ? nombre.substring(punto) : '';
    return '${nombre.substring(0, maxCaracteresNombreArchivo - ext.length - 1)}…$ext';
  }

  /// 850 KB, 1,2 MB: con coma, como se escribe en castellano.
  static String tamanoLegible(int bytes) {
    if (bytes < 1024 * 1024) {
      final int kb = (bytes / 1024).ceil();
      return '$kb KB';
    }
    return '${(bytes / 1024 / 1024).toStringAsFixed(1).replaceAll('.', ',')} MB';
  }

  /// Lo que dice la pantalla antes de guardar: como se va a guardar.
  static String comoSeVaAGuardar(String tipo, int partes) {
    switch (tipo) {
      case 'mixto':
        return 'Se guarda como «Varios»: $partes partes que la IA lee por separado.';
      case 'nota':
        return 'Se guarda como nota.';
      case 'link':
        return 'Se guarda como link: la IA lee la página.';
      default:
        return 'Se guarda como ${nombreDeTipo(tipo)}.';
    }
  }

  @override
  State<CapturaPantalla> createState() => _CapturaPantallaState();
}

class _CapturaPantallaState extends State<CapturaPantalla> {
  final TextEditingController _titulo = TextEditingController();
  final TextEditingController _texto = TextEditingController();

  final List<Adjunto> _adjuntos = <Adjunto>[];
  final List<String> _links = <String>[];

  String _visibilidad = 'equipo'; // equipo | privado
  bool _guardando = false;

  /// true mientras esta abierto un selector (camara, galeria, archivos): un
  /// segundo toque abriria otro encima.
  bool _eligiendo = false;

  int get _bytesElegidos =>
      _adjuntos.fold<int>(0, (int suma, Adjunto a) => suma + a.tamano);

  bool get _hayTexto => _texto.text.trim().isNotEmpty;

  /// El tipo que tendria el item si se guardara ahora.
  String? get _tipo => CapturaPantalla.tipoSegunLoCargado(
        hayTexto: _hayTexto,
        cantLinks: _links.length,
        tiposDeArchivos: _adjuntos.map((Adjunto a) => a.tipo).toList(),
      );

  bool get _puedeSumarArchivos =>
      !_guardando && !_eligiendo && _adjuntos.length < CapturaPantalla.maxArchivos;

  /// Si el texto tenia algo la ultima vez que se dibujo (ver _alCambiarElTexto).
  bool _teniaTexto = false;

  @override
  void initState() {
    super.initState();
    // El texto cambia el tipo (texto solo = nota; texto + foto = Varios):
    // la linea "Se guarda como..." tiene que enterarse.
    _texto.addListener(_alCambiarElTexto);
  }

  void _alCambiarElTexto() {
    // Solo se redibuja cuando pasa de vacio a algo o al reves: con cada
    // letra seria un setState por tecla sin ningun cambio a la vista.
    if (_hayTexto != _teniaTexto && mounted) {
      setState(() => _teniaTexto = _hayTexto);
    }
  }

  @override
  void dispose() {
    _texto.removeListener(_alCambiarElTexto);
    _titulo.dispose();
    _texto.dispose();
    super.dispose();
  }

  // ==========================================================================
  //  SUMAR Y SACAR ADJUNTOS
  // ==========================================================================

  /// Suma un archivo si entra; si no, devuelve el aviso de por que no.
  String? _sumar(String tipo, String nombre, Uint8List bytes, String tipoMime) {
    final String? aviso = CapturaPantalla.avisoSiNoEntra(
      nombre: nombre,
      bytesDelNuevo: bytes.length,
      archivosYaElegidos: _adjuntos.length,
      bytesYaElegidos: _bytesElegidos,
    );
    if (aviso != null) return aviso;
    _adjuntos.add(
      Adjunto(
        tipo: tipo,
        archivo: ArchivoParaSubir(nombre: nombre, bytes: bytes, tipoMime: tipoMime),
      ),
    );
    // Titulo sugerido con lo PRIMERO que se adjunta, si todavia no hay uno:
    // el nombre del documento sin la extension, o "Foto 14/10 13:42".
    if (_titulo.text.trim().isEmpty) {
      _titulo.text = tipo == 'foto'
          ? 'Foto ${fechaCorta(Timestamp.now())}'
          : nombre.replaceAll(RegExp(r'\.(pdf|docx)$', caseSensitive: false), '');
    }
    return null;
  }

  /// Muestra los avisos de lo que no entro: el primero, y cuantos mas hubo.
  void _avisarLoQueNoEntro(List<String> avisos) {
    if (avisos.isEmpty || !mounted) return;
    final String mas = avisos.length > 1 ? ' (y ${avisos.length - 1} más no entraron)' : '';
    mostrarAviso(context, '${avisos.first}$mas', esError: true);
  }

  /// Fotos de la CAMARA (solo en el celular: en la web no se muestra).
  ///
  /// imageQuality: 70 no es un capricho: OCR.space en su plan gratis acepta
  /// imagenes de hasta ~1 MB, y una foto de un celular moderno sale de 4 MB
  /// para arriba. Con calidad 70 y el ancho limitado a 1600 px el texto sigue
  /// siendo perfectamente legible para el OCR y sube en segundos con datos
  /// moviles.
  Future<void> _sacarFoto() async {
    await _elegirFotosCon(() async {
      final XFile? foto = await ImagePicker().pickImage(
        source: ImageSource.camera,
        imageQuality: 70,
        maxWidth: 1600,
      );
      return foto == null ? <XFile>[] : <XFile>[foto];
    });
  }

  /// Fotos de la GALERIA (o de la compu, en la web), varias a la vez.
  Future<void> _elegirFotos() async {
    final int lugar = CapturaPantalla.maxArchivos - _adjuntos.length;
    await _elegirFotosCon(() async {
      // pickMultiImage no acepta un limite menor que 2: si queda un solo
      // lugar, se elige una sola foto.
      if (lugar < 2) {
        final XFile? foto = await ImagePicker().pickImage(
          source: ImageSource.gallery,
          imageQuality: 70,
          maxWidth: 1600,
        );
        return foto == null ? <XFile>[] : <XFile>[foto];
      }
      return ImagePicker().pickMultiImage(imageQuality: 70, maxWidth: 1600, limit: lugar);
    });
  }

  Future<void> _elegirFotosCon(Future<List<XFile>> Function() elegir) async {
    if (!_puedeSumarArchivos) return;
    setState(() => _eligiendo = true);
    try {
      final List<XFile> fotos = await elegir();
      if (!mounted || fotos.isEmpty) return; // cancelo: no es un error

      final List<String> avisos = <String>[];
      for (final XFile foto in fotos) {
        // El tamano ANTES de leer los bytes: una foto de 40 MB no se carga
        // en memoria para despues rechazarla.
        final int tamano = await foto.length();
        if (tamano > CapturaPantalla.maxBytesArchivo) {
          avisos.add('«${foto.name}» pesa ${CapturaPantalla.tamanoLegible(tamano)} '
              'y el máximo es 10 MB por archivo.');
          continue;
        }
        final Uint8List bytes = await foto.readAsBytes();
        if (!mounted) return;
        final String tipoMime = (foto.mimeType ?? '').startsWith('image/')
            ? foto.mimeType!
            : Api.tipoMimeDe(foto.name);
        final String? aviso = _sumar('foto', foto.name, bytes, tipoMime);
        if (aviso != null) avisos.add(aviso);
      }
      if (!mounted) return;
      setState(() {});
      _avisarLoQueNoEntro(avisos);
    } catch (e) {
      debugPrint('[NeuroDesk] elegir foto fallo: $e');
      if (!mounted) return;
      mostrarAviso(
        context,
        kIsWeb ? 'No pudimos abrir las fotos.' : 'No pudimos abrir la cámara o la galería.',
        esError: true,
      );
    } finally {
      if (mounted) setState(() => _eligiendo = false);
    }
  }

  /// PDF o Word (.docx), varios a la vez.
  ///
  /// withData SOLO en la web: ahi file_picker siempre da los bytes (no hay
  /// rutas de disco). En Android se piden despues, de a uno y recien cuando
  /// se sabe que el archivo pesa menos de 10 MB: con withData en true,
  /// file_picker cargaria en memoria un PDF de 300 MB entero solo para que
  /// despues lo rechacemos.
  Future<void> _elegirDocumentos() async {
    if (!_puedeSumarArchivos) return;
    setState(() => _eligiendo = true);
    try {
      final FilePickerResult? elegidos = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: <String>['pdf', 'docx'],
        allowMultiple: true,
        withData: kIsWeb,
      );
      if (!mounted || elegidos == null || elegidos.files.isEmpty) return;

      final List<String> avisos = <String>[];
      for (final PlatformFile f in elegidos.files) {
        // El tipo se decide ANTES de mirar el tamano: si no es PDF ni Word no
        // tiene sentido medirlo, y el mensaje correcto es el del formato.
        final String? tipo = CapturaPantalla.tipoDeDocumento(f.name);
        if (tipo == null) {
          avisos.add(
            f.name.toLowerCase().endsWith('.doc')
                ? '«${f.name}» es un Word viejo (.doc). Abrilo en Word y guardalo como .docx.'
                : 'Solo se pueden subir archivos PDF o Word (.docx): «${f.name}» no es ninguno.',
          );
          continue;
        }
        if (f.size > CapturaPantalla.maxBytesArchivo) {
          avisos.add('«${f.name}» pesa ${CapturaPantalla.tamanoLegible(f.size)} '
              'y el máximo es 10 MB por archivo.');
          continue;
        }
        final Uint8List? bytes = kIsWeb ? f.bytes : await f.xFile.readAsBytes();
        if (!mounted) return;
        if (bytes == null) {
          avisos.add('No pudimos leer «${f.name}».');
          continue;
        }
        final String? aviso = _sumar(tipo, f.name, bytes, Api.tipoMimeDe(f.name));
        if (aviso != null) avisos.add(aviso);
      }
      if (!mounted) return;
      setState(() {});
      _avisarLoQueNoEntro(avisos);
    } catch (e) {
      debugPrint('[NeuroDesk] elegir documento fallo: $e');
      if (!mounted) return;
      mostrarAviso(context, 'No pudimos abrir el archivo.', esError: true);
    } finally {
      if (mounted) setState(() => _eligiendo = false);
    }
  }

  /// Sumar un link: se pega en un dialogo que lo revisa antes de aceptarlo.
  Future<void> _agregarLink() async {
    if (_guardando || _links.length >= CapturaPantalla.maxLinks) return;
    final String? link = await showDialog<String>(
      context: context,
      builder: (BuildContext ctx) => _DialogoDeLink(yaCargados: List<String>.of(_links)),
    );
    if (link == null || !mounted) return; // cancelo
    setState(() => _links.add(link));
  }

  // ==========================================================================
  //  GUARDAR: primero Firestore, despues el backend
  // ==========================================================================

  Future<void> _guardar() async {
    if (_guardando) return; // doble tap

    final String titulo = _titulo.text.trim();
    final String texto = _texto.text.trim();
    final String? tipo = _tipo;

    // --- validaciones locales, con mensajes en castellano --------------------
    if (titulo.isEmpty) {
      mostrarAviso(context, 'Poné un título para reconocerlo después.', esError: true);
      return;
    }
    if (titulo.length > CapturaPantalla.maxCaracteresTitulo) {
      mostrarAviso(context, 'El título no puede pasar de 140 caracteres.', esError: true);
      return;
    }
    if (texto.length > CapturaPantalla.maxCaracteresNota) {
      mostrarAviso(context, 'El texto no puede pasar de 50.000 caracteres.', esError: true);
      return;
    }
    if (tipo == null) {
      mostrarAviso(
        context,
        'Escribí un texto o adjuntá una foto, un documento o un link.',
        esError: true,
      );
      return;
    }
    // Ya se controla al sumar cada archivo; esto queda por las dudas, para
    // no mandar nunca un pedido que el backend va a rechazar entero.
    if (_bytesElegidos > CapturaPantalla.maxBytesTotal) {
      mostrarAviso(context, 'Los archivos pasan de 25 MB entre todos. Sacá alguno.', esError: true);
      return;
    }

    setState(() => _guardando = true);

    // El mensajero y el navegador se agarran ACA, antes del primer await.
    // Despues de cerrar la pantalla el context queda desactivado y buscarlos
    // con .of(context) tiraria una excepcion (ver el comentario de
    // mostrarAvisoEn en tema.dart).
    final ScaffoldMessengerState mensajero = ScaffoldMessenger.of(context);
    final NavigatorState navegador = Navigator.of(context);

    // Este es el documento que vamos a crear. Se pide el id ANTES de escribir
    // (doc() sin argumentos lo genera en el telefono, sin ir al servidor) para
    // poder mandarlo despues en la URL del POST.
    final DocumentReference<Map<String, dynamic>> ref = FirebaseFirestore.instance
        .collection('workspaces')
        .doc(widget.wsId)
        .collection('items')
        .doc();

    // Una copia de lo que se manda: si la persona sacara un adjunto mientras
    // se guarda (los botones estan apagados, pero por las dudas), el item y
    // el pedido tienen que hablar de lo mismo.
    final List<Adjunto> adjuntos = List<Adjunto>.of(_adjuntos);
    final List<String> links = List<String>.of(_links);
    final bool esArchivoSolo = tipo == 'pdf' || tipo == 'word' || tipo == 'foto';

    // EXACTAMENTE los campos permitidos. Uno de mas y hasOnly() rechaza todo.
    final Map<String, Object?> datos = CapturaPantalla.camposDelItem(
      titulo: titulo,
      tipo: tipo,
      visibilidad: _visibilidad,
      wsId: widget.wsId,
      miUid: widget.miUid,
      texto: texto,
      links: links,
      nombreArchivo: esArchivoSolo ? adjuntos.single.nombre : '',
    );

    try {
      // --- PASO 1: crear el item -------------------------------------------
      // OJO CON EL await Y LA PERSISTENCIA OFFLINE: si no hay internet,
      // Firestore guarda la escritura y la manda cuando vuelva la conexion,
      // PERO este Future no se completa hasta que el servidor confirma. O sea:
      // sin timeout, la app se quedaria colgada para siempre con el spinner.
      // Con el timeout salimos, avisamos, y el item igual se va a subir solo
      // (queda en 'pendiente' con su boton Reintentar).
      await ref.set(datos).timeout(const Duration(seconds: 12));

      if (!mounted) return;

      // --- PASO 2: avisarle al backend --------------------------------------
      // 'archivo' para un archivo solo; 'archivos' (aunque sea vacia) para el
      // 'mixto'; nada para nota y link (ver Api.procesarItem).
      final RespuestaApi r = await Api.procesarItem(
        wsId: widget.wsId,
        itemId: ref.id,
        archivo: esArchivoSolo ? adjuntos.single.archivo : null,
        archivos: tipo == 'mixto'
            ? adjuntos.map((Adjunto a) => a.archivo).toList()
            : null,
      );

      if (!mounted) return;

      if (r.ok) {
        navegador.pop();
        mostrarAvisoEn(mensajero, 'Listo: ya lo puede usar la IA.');
        return;
      }

      // No salio bien el POST. El item YA ESTA GUARDADO igual: cerramos la
      // pantalla y explicamos. La lista lo muestra en 'pendiente' o en 'error'
      // (si el backend llego a escribir el estado) con el boton Reintentar.
      if (r.sesionVencida) {
        await AuthServicio.salir();
        return;
      }
      navegador.pop();
      mostrarAvisoEn(
        mensajero,
        r.sigueProcesando
            ? 'Se guardó y sigue procesándose. Mirá el estado en la lista.'
            : '${r.mensaje} Quedó guardado: podés reintentar desde la lista.',
        esError: !r.sigueProcesando,
      );
    } on TimeoutException {
      if (!mounted) return;
      navegador.pop();
      mostrarAvisoEn(
        mensajero,
        // En la web la escritura pendiente vive en la memoria de la pestana
        // (ahi la persistencia va apagada, ver main.dart): si se cierra, se
        // pierde. Hay que decirlo.
        kIsWeb
            ? 'Sin conexión: se sube sola cuando vuelva internet. No cierres esta pestaña.'
            : 'Sin conexión: se guardó en el teléfono y se sube solo cuando vuelva internet.',
      );
    } catch (e) {
      // El caso tipico de aca es permission-denied: token viejo (todavia sin
      // el claim del workspace) o un campo de mas en el mapa de arriba.
      debugPrint('[NeuroDesk] no se pudo crear el item: $e');
      if (!mounted) return;
      mostrarAviso(
        context,
        'No pudimos guardarlo. Probá cerrar sesión y volver a entrar.',
        esError: true,
      );
    } finally {
      if (mounted) setState(() => _guardando = false);
    }
  }

  // ==========================================================================
  //  DIBUJO
  // ==========================================================================

  @override
  Widget build(BuildContext context) {
    final String? tipo = _tipo;
    final int partes = (_hayTexto ? 1 : 0) + _links.length + _adjuntos.length;
    // El aviso de OCR.space va si hay algo que puede pasar por el OCR: una
    // foto o un PDF (si es escaneado). Un Word solo, no.
    final bool puedeIrAlOcr = _adjuntos.any((Adjunto a) => a.tipo == 'foto' || a.tipo == 'pdf');

    return Scaffold(
      appBar: AppBar(
        backgroundColor: azulNoche,
        foregroundColor: grisClaro,
        title: const Text('Agregar contenido'),
      ),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              const _Etiqueta('Título'),
              const SizedBox(height: 8),
              TextField(
                controller: _titulo,
                maxLength: CapturaPantalla.maxCaracteresTitulo,
                style: const TextStyle(color: grisClaro),
                decoration: _decoracion('Ej: Cronograma de mesas de examen'),
              ),
              const SizedBox(height: 8),

              const _Etiqueta('Texto (opcional)'),
              const SizedBox(height: 8),
              TextField(
                controller: _texto,
                minLines: 4,
                maxLines: 9,
                maxLength: CapturaPantalla.maxCaracteresNota,
                style: const TextStyle(color: grisClaro),
                decoration: _decoracion('Escribí lo que quieras que la IA recuerde...'),
              ),
              const SizedBox(height: 12),

              // --- ADJUNTAR ---------------------------------------------------
              Row(
                children: <Widget>[
                  const Expanded(child: _Etiqueta('Adjuntar')),
                  Text(
                    '${_adjuntos.length}/${CapturaPantalla.maxArchivos} archivos · '
                    '${_links.length}/${CapturaPantalla.maxLinks} links',
                    style: const TextStyle(color: grisApagado, fontSize: 12),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: <Widget>[
                  // La camara solo en el celular. En la web, en una compu no
                  // hay camara que abrir (el navegador abriria el mismo
                  // selector de archivos que "Fotos"), y en un celular el
                  // selector de "Fotos" ya ofrece sacar una.
                  if (!kIsWeb)
                    _botonDeAdjuntar(
                      'Cámara',
                      Icons.photo_camera,
                      _puedeSumarArchivos ? _sacarFoto : null,
                    ),
                  _botonDeAdjuntar(
                    kIsWeb ? 'Fotos' : 'Galería',
                    Icons.photo_library,
                    _puedeSumarArchivos ? _elegirFotos : null,
                  ),
                  _botonDeAdjuntar(
                    'Documento',
                    Icons.insert_drive_file,
                    _puedeSumarArchivos ? _elegirDocumentos : null,
                  ),
                  _botonDeAdjuntar(
                    'Link',
                    Icons.link,
                    (_guardando || _links.length >= CapturaPantalla.maxLinks)
                        ? null
                        : _agregarLink,
                  ),
                ],
              ),
              const SizedBox(height: 6),
              const Text(
                'Fotos, PDF o Word (.docx) de hasta 10 MB cada uno y 25 MB entre '
                'todos. Si tenés un Word viejo (.doc), abrilo en Word y guardalo '
                'como .docx.',
                style: TextStyle(color: grisApagado, fontSize: 12),
              ),

              // La lista de lo adjuntado, cada uno con su boton para sacarlo.
              if (_adjuntos.isNotEmpty || _links.isNotEmpty) ...<Widget>[
                const SizedBox(height: 10),
                for (int i = 0; i < _adjuntos.length; i++) _filaDeAdjunto(i),
                for (int i = 0; i < _links.length; i++) _filaDeLink(i),
              ],

              if (_eligiendo) ...<Widget>[
                const SizedBox(height: 10),
                const LinearProgressIndicator(color: cianElectrico, backgroundColor: superficie),
              ],

              // Como se va a guardar: que la persona sepa ANTES de tocar
              // Guardar si va a ser una nota, un PDF o «Varios».
              if (tipo != null) ...<Widget>[
                const SizedBox(height: 14),
                Row(
                  children: <Widget>[
                    Icon(iconoDeTipo(tipo), size: 18, color: azulRoyal),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        CapturaPantalla.comoSeVaAGuardar(tipo, partes),
                        style: const TextStyle(color: grisClaro, fontSize: 13),
                      ),
                    ),
                  ],
                ),
              ],

              const SizedBox(height: 20),
              const _Etiqueta('¿Quién lo puede ver?'),
              const SizedBox(height: 8),
              // Esta es la diferencia de rol del requisito 2 de la materia,
              // puesta en manos de la persona: 'equipo' lo ve cualquier
              // miembro, 'privado' solo el autor y el admin. Y la IA, cuando
              // alguien pregunta, SOLO puede citar lo que esa persona ve.
              // El boton dice "Solo yo" para que entre corto; que el admin
              // tambien lo ve (las reglas lo dejan leer todo) lo avisa la
              // fuente de cada respuesta: "la ves porque sos admin".
              SegmentedButton<String>(
                segments: const <ButtonSegment<String>>[
                  ButtonSegment<String>(
                    value: 'equipo',
                    label: Text('Todo el equipo'),
                    icon: Icon(Icons.groups),
                  ),
                  ButtonSegment<String>(
                    value: 'privado',
                    label: Text('Solo yo'),
                    icon: Icon(Icons.lock),
                  ),
                ],
                selected: <String>{_visibilidad},
                onSelectionChanged: (Set<String> s) =>
                    setState(() => _visibilidad = s.first),
              ),

              if (puedeIrAlOcr) ...<Widget>[
                const SizedBox(height: 14),
                const Text(
                  'Aviso: para leer el texto de las fotos y de los PDF escaneados '
                  'usamos OCR.space, un servicio externo. Pasa también con los '
                  'ítems marcados como privados.',
                  style: TextStyle(color: grisApagado, fontSize: 12),
                ),
              ],

              const SizedBox(height: 24),
              FilledButton.icon(
                onPressed: (_guardando || _eligiendo) ? null : _guardar,
                style: FilledButton.styleFrom(
                  backgroundColor: cian,
                  foregroundColor: azulNoche,
                  padding: const EdgeInsets.symmetric(vertical: 16),
                ),
                icon: _guardando
                    ? const SizedBox(
                        width: 20,
                        height: 20,
                        child: CircularProgressIndicator(strokeWidth: 2.5, color: azulNoche),
                      )
                    : const Icon(Icons.cloud_upload),
                label: Text(_guardando ? 'Guardando...' : 'Guardar y procesar'),
              ),
              const SizedBox(height: 10),
              const Text(
                'Se guarda al instante y después la IA lo lee. Si el servidor está '
                'dormido puede tardar hasta un minuto: mientras tanto queda en '
                '"Pendiente" y no se pierde nada.',
                textAlign: TextAlign.center,
                style: TextStyle(color: grisApagado, fontSize: 12),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _botonDeAdjuntar(String texto, IconData icono, VoidCallback? alTocar) {
    return OutlinedButton.icon(
      onPressed: alTocar,
      style: OutlinedButton.styleFrom(
        foregroundColor: grisClaro,
        side: const BorderSide(color: grisApagado),
      ),
      icon: Icon(icono, size: 18),
      label: Text(texto),
    );
  }

  /// Una fila de la lista: la miniatura (o el icono), el nombre, que es y
  /// cuanto pesa, y la cruz para sacarlo.
  Widget _filaDeAdjunto(int i) {
    final Adjunto a = _adjuntos[i];
    final Widget miniatura = a.tipo == 'foto'
        ? ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: Image.memory(
              a.archivo.bytes,
              width: 44,
              height: 44,
              fit: BoxFit.cover,
              // cacheWidth: se decodifica chiquita. Sin esto, 8 fotos de 1600
              // px quedarian enteras en memoria solo para una miniatura.
              cacheWidth: 132,
              gaplessPlayback: true,
              // (_, _, _): desde Dart 3.7 el _ ignora el parametro y se
              // puede repetir; el viejo (_, __, ___) ya da aviso.
              errorBuilder: (_, _, _) =>
                  const Icon(Icons.broken_image, color: grisApagado),
            ),
          )
        : SizedBox(
            width: 44,
            height: 44,
            child: Icon(iconoDeTipo(a.tipo), color: azulRoyal),
          );
    return _FilaDeLaLista(
      miniatura: miniatura,
      titulo: a.nombre,
      detalle: '${nombreDeTipo(a.tipo)} · ${CapturaPantalla.tamanoLegible(a.tamano)}',
      alSacar: _guardando ? null : () => setState(() => _adjuntos.removeAt(i)),
    );
  }

  Widget _filaDeLink(int i) {
    return _FilaDeLaLista(
      miniatura: const SizedBox(
        width: 44,
        height: 44,
        child: Icon(Icons.link, color: azulRoyal),
      ),
      titulo: _links[i],
      detalle: 'Link',
      alSacar: _guardando ? null : () => setState(() => _links.removeAt(i)),
    );
  }

  InputDecoration _decoracion(String pista) {
    return InputDecoration(
      hintText: pista,
      hintStyle: const TextStyle(color: grisApagado),
      counterStyle: const TextStyle(color: grisApagado),
      filled: true,
      fillColor: superficie,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide.none,
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: cianElectrico, width: 1.6),
      ),
    );
  }
}

/// Una fila de la lista de adjuntos (archivo o link).
class _FilaDeLaLista extends StatelessWidget {
  const _FilaDeLaLista({
    required this.miniatura,
    required this.titulo,
    required this.detalle,
    required this.alSacar,
  });

  final Widget miniatura;
  final String titulo;
  final String detalle;
  final VoidCallback? alSacar;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.fromLTRB(8, 6, 2, 6),
      decoration: BoxDecoration(
        color: superficie,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        children: <Widget>[
          miniatura,
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  titulo,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: grisClaro, fontSize: 14),
                ),
                const SizedBox(height: 2),
                Text(detalle, style: const TextStyle(color: grisApagado, fontSize: 12)),
              ],
            ),
          ),
          IconButton(
            tooltip: 'Sacar',
            onPressed: alSacar,
            icon: const Icon(Icons.close, color: grisApagado),
          ),
        ],
      ),
    );
  }
}

/// El dialogo para pegar un link. Lo revisa ADENTRO del dialogo (con el
/// error abajo del campo) en vez de cerrarlo y mostrar un cartel: asi la
/// persona corrige lo que pego sin tener que volver a pegarlo.
class _DialogoDeLink extends StatefulWidget {
  const _DialogoDeLink({required this.yaCargados});

  final List<String> yaCargados;

  @override
  State<_DialogoDeLink> createState() => _DialogoDeLinkState();
}

class _DialogoDeLinkState extends State<_DialogoDeLink> {
  final TextEditingController _url = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _url.dispose();
    super.dispose();
  }

  void _aceptar() {
    final String? link = CapturaPantalla.linkValido(_url.text);
    if (link == null) {
      setState(() => _error = 'Tiene que empezar con http:// o https://');
      return;
    }
    if (widget.yaCargados.contains(link)) {
      setState(() => _error = 'Ese link ya está en la lista.');
      return;
    }
    Navigator.of(context).pop(link);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: superficie,
      title: const Text('Agregar un link', style: TextStyle(color: grisClaro)),
      content: TextField(
        controller: _url,
        autofocus: true,
        keyboardType: TextInputType.url,
        autocorrect: false,
        style: const TextStyle(color: grisClaro),
        onSubmitted: (_) => _aceptar(),
        decoration: InputDecoration(
          hintText: 'https://...',
          hintStyle: const TextStyle(color: grisApagado),
          errorText: _error,
        ),
      ),
      actions: <Widget>[
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancelar'),
        ),
        FilledButton(
          onPressed: _aceptar,
          child: const Text('Agregar'),
        ),
      ],
    );
  }
}

class _Etiqueta extends StatelessWidget {
  const _Etiqueta(this.texto);

  final String texto;

  @override
  Widget build(BuildContext context) {
    return Text(
      texto,
      style: const TextStyle(
        color: grisClaro,
        fontSize: 14,
        fontWeight: FontWeight.w600,
      ),
    );
  }
}
