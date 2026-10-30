// ============================================================================
//  captura.dart — cargar una nota, una foto, un documento (PDF o Word) o un link
//
//  ================== LA REGLA DE ORO DEL PROYECTO, ACA =====================
//  El orden es SIEMPRE este, y no se puede dar vuelta:
//
//     1) La app CREA el item en Firestore con estado 'pendiente'.
//     2) RECIEN DESPUES le manda el archivo al backend con ese itemId.
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
//  ================== LOS CAMPOS QUE ESCRIBE EL CLIENTE =====================
//  Las reglas usan hasOnly(): si mandamos UN campo de mas, se rechaza la
//  escritura ENTERA con permission-denied. Los unicos permitidos son:
//     titulo, tipo, visibilidad, workspaceId, creadoPor, creadoEn, estado,
//     y segun el tipo: url (link), nombreArchivo (pdf/word/foto), textoOriginal (nota).
//  NO va 'texto', NO va 'cantChunks', NO va 'actualizadoEn'. Esos los escribe
//  el backend. Ese fue exactamente el bug que rompio la version 1 del proyecto.
//
//  textoOriginal (lo que escribe la PERSONA) y texto (lo que extrae el
//  BACKEND) son dos campos distintos A PROPOSITO: asi el tipo 'nota' funciona
//  sin abrirle al cliente el campo que alimenta a la IA.
//
//  ================== EL BOTON "DOCUMENTO" (PDF O WORD) =====================
//  Un solo boton acepta .pdf y .docx, pero 'documento' NO es un tipo de item:
//  el tipo que se guarda es 'pdf' o 'word' y lo decide la EXTENSION del
//  archivo elegido (ver tipoDeDocumento). Los dos viajan igual: el item nace
//  'pendiente' con su nombreArchivo y despues el archivo va por multipart.
//  El .doc viejo (Word 97-2003) se frena aca: es otro formato y el backend
//  solo sabe leer .docx.
// ============================================================================

import 'dart:async';
import 'dart:io';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../servicios/api.dart';
import '../servicios/auth_servicio.dart';
import '../tema.dart';

class CapturaPantalla extends StatefulWidget {
  const CapturaPantalla({super.key, required this.wsId, required this.miUid});

  final String wsId;
  final String miUid;

  /// El 'tipo' del item para un archivo elegido con el boton "Documento":
  /// 'pdf' para .pdf, 'word' para .docx y null para cualquier otra cosa.
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

  @override
  State<CapturaPantalla> createState() => _CapturaPantallaState();
}

class _CapturaPantallaState extends State<CapturaPantalla> {
  // Los mismos limites que validan las reglas de Firestore y el backend.
  // El cliente los valida ANTES de mandar para no gastar los datos del celular
  // en un pedido que el servidor va a rechazar igual. El backend los vuelve a
  // validar SIEMPRE, porque un cliente se puede modificar.
  static const int maxCaracteresNota = 50000;
  static const int maxCaracteresTitulo = 140;
  static const int maxBytesArchivo = 10 * 1024 * 1024; // 10 MB

  final TextEditingController _titulo = TextEditingController();
  final TextEditingController _texto = TextEditingController();
  final TextEditingController _url = TextEditingController();

  // Lo que se eligio en los chips: nota | foto | documento | link.
  // No se escribe tal cual en Firestore: 'documento' no es un tipo de item
  // (ver _tipoDelItem). Por eso se llama _opcion y no _tipo.
  String _opcion = 'nota';
  String _visibilidad = 'equipo'; // equipo | privado
  File? _archivo;
  String _nombreArchivo = '';
  // 'pdf' o 'word': sale de la extension del documento elegido. Vacio
  // mientras no haya documento (se limpia junto con _archivo).
  String _tipoDeDocumento = '';
  bool _guardando = false;

  /// El 'tipo' que se escribe en Firestore. Para nota, foto y link es la
  /// opcion del chip; para "Documento" es lo que dijo la extension del archivo.
  String get _tipoDelItem => _opcion == 'documento' ? _tipoDeDocumento : _opcion;

  /// Foto y documento viajan con archivo (multipart). Nota y link no: el
  /// backend lee su texto del propio documento de Firestore.
  bool get _llevaArchivo => _opcion == 'foto' || _opcion == 'documento';

  @override
  void dispose() {
    _titulo.dispose();
    _texto.dispose();
    _url.dispose();
    super.dispose();
  }

  // ==========================================================================
  //  ELEGIR EL ARCHIVO
  // ==========================================================================

  /// Foto de la camara o de la galeria.
  ///
  /// imageQuality: 70 no es un capricho: OCR.space en su plan gratis acepta
  /// imagenes de hasta ~1 MB, y una foto de un celular moderno sale de 4 MB
  /// para arriba. Con calidad 70 y el ancho limitado a 1600 px el texto sigue
  /// siendo perfectamente legible para el OCR y sube en segundos con datos
  /// moviles.
  Future<void> _elegirFoto(ImageSource origen) async {
    try {
      final XFile? foto = await ImagePicker().pickImage(
        source: origen,
        imageQuality: 70,
        maxWidth: 1600,
      );
      if (foto == null) return; // la persona cancelo: no es un error
      if (!mounted) return;

      final File f = File(foto.path);
      if (!await _tamanoOk(f)) return;
      if (!mounted) return;

      setState(() {
        _archivo = f;
        _nombreArchivo = foto.name;
        if (_titulo.text.trim().isEmpty) _titulo.text = 'Foto ${fechaCorta(Timestamp.now())}';
      });
    } catch (e) {
      debugPrint('[NeuroDesk] elegir foto fallo: $e');
      if (!mounted) return;
      mostrarAviso(context, 'No pudimos abrir la cámara o la galería.', esError: true);
    }
  }

  /// PDF o Word (.docx) del telefono.
  Future<void> _elegirDocumento() async {
    try {
      final FilePickerResult? elegido = await FilePicker.platform.pickFiles(
        type: FileType.custom,
        allowedExtensions: <String>['pdf', 'docx'],
      );
      final String? ruta = elegido?.files.single.path;
      if (ruta == null) return; // la persona cancelo: no es un error
      if (!mounted) return;

      final String nombre = elegido!.files.single.name;

      // El tipo se decide ANTES de mirar el tamano: si no es PDF ni Word no
      // tiene sentido medirlo, y el mensaje correcto es el del formato.
      final String? tipo = CapturaPantalla.tipoDeDocumento(nombre);
      if (tipo == null) {
        mostrarAviso(
          context,
          nombre.toLowerCase().endsWith('.doc')
              ? 'Ese es un Word viejo (.doc). Abrilo en Word y guardalo como .docx.'
              : 'Solo se pueden subir archivos PDF o Word (.docx).',
          esError: true,
        );
        return;
      }

      final File f = File(ruta);
      if (!await _tamanoOk(f)) return;
      if (!mounted) return;

      setState(() {
        _archivo = f;
        _nombreArchivo = nombre;
        _tipoDeDocumento = tipo;
        if (_titulo.text.trim().isEmpty) {
          // Titulo sugerido: el nombre del archivo sin el .pdf o el .docx.
          _titulo.text = nombre.replaceAll(
            RegExp(r'\.(pdf|docx)$', caseSensitive: false),
            '',
          );
        }
      });
    } catch (e) {
      debugPrint('[NeuroDesk] elegir documento fallo: $e');
      if (!mounted) return;
      mostrarAviso(context, 'No pudimos abrir el archivo.', esError: true);
    }
  }

  /// El tope de 10 MB es el mismo de multer en el backend
  /// (ARCHIVO_MUY_GRANDE, HTTP 413). Chequearlo aca ahorra subir 20 MB por
  /// datos moviles para que el servidor los rechace al final.
  Future<bool> _tamanoOk(File f) async {
    final int bytes = await f.length();
    if (bytes <= maxBytesArchivo) return true;
    if (!mounted) return false;
    final String mb = (bytes / 1024 / 1024).toStringAsFixed(1);
    mostrarAviso(context, 'El archivo pesa $mb MB y el máximo es 10 MB.', esError: true);
    return false;
  }

  // ==========================================================================
  //  GUARDAR: primero Firestore, despues el backend
  // ==========================================================================

  Future<void> _guardar() async {
    if (_guardando) return; // doble tap

    final String titulo = _titulo.text.trim();
    final String texto = _texto.text.trim();
    final String url = _url.text.trim();

    // --- validaciones locales, con mensajes en castellano --------------------
    if (titulo.isEmpty) {
      mostrarAviso(context, 'Poné un título para reconocerlo después.', esError: true);
      return;
    }
    if (titulo.length > maxCaracteresTitulo) {
      mostrarAviso(context, 'El título no puede pasar de 140 caracteres.', esError: true);
      return;
    }
    if (_opcion == 'nota' && texto.isEmpty) {
      mostrarAviso(context, 'Escribí el contenido de la nota.', esError: true);
      return;
    }
    if (_opcion == 'nota' && texto.length > maxCaracteresNota) {
      mostrarAviso(context, 'La nota no puede pasar de 50.000 caracteres.', esError: true);
      return;
    }
    if (_opcion == 'link' && !RegExp(r'^https?://.+').hasMatch(url)) {
      mostrarAviso(context, 'El enlace tiene que empezar con http:// o https://', esError: true);
      return;
    }
    if (_llevaArchivo && _archivo == null) {
      mostrarAviso(
        context,
        _opcion == 'documento'
            ? 'Elegí primero el PDF o el Word.'
            : 'Elegí primero el archivo.',
        esError: true,
      );
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

    // EXACTAMENTE los campos permitidos. Uno de mas y hasOnly() rechaza todo.
    final Map<String, Object?> datos = <String, Object?>{
      'titulo': titulo,
      'tipo': _tipoDelItem, // 'pdf' o 'word' si vino del boton Documento
      'visibilidad': _visibilidad,
      'workspaceId': widget.wsId, // tiene que coincidir con el del path
      'creadoPor': widget.miUid, // la regla exige que sea request.auth.uid
      // serverTimestamp OBLIGATORIO: la regla compara contra request.time, asi
      // que el reloj del celular (que puede estar mal) no sirve.
      'creadoEn': FieldValue.serverTimestamp(),
      'estado': 'pendiente', // nace pendiente. No puede nacer 'listo'.
      if (_opcion == 'nota') 'textoOriginal': texto,
      if (_opcion == 'link') 'url': url,
      if (_llevaArchivo) 'nombreArchivo': _nombreArchivo, // pdf, word y foto
    };

    try {
      // --- PASO 1: crear el item -------------------------------------------
      // OJO CON EL await Y LA PERSISTENCIA OFFLINE: si no hay internet,
      // Firestore guarda la escritura en el telefono y la manda cuando vuelva
      // la conexion, PERO este Future no se completa hasta que el servidor
      // confirma. O sea: sin timeout, la app se quedaria colgada para siempre
      // con el spinner. Con el timeout salimos, avisamos, y el item igual se
      // va a subir solo (queda en 'pendiente' con su boton Reintentar).
      await ref.set(datos).timeout(const Duration(seconds: 12));

      if (!mounted) return;

      // --- PASO 2: avisarle al backend --------------------------------------
      final RespuestaApi r = await Api.procesarItem(
        wsId: widget.wsId,
        itemId: ref.id,
        archivo: _llevaArchivo ? _archivo : null,
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
        'Sin conexión: se guardó en el teléfono y se sube solo cuando vuelva internet.',
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
              const _Etiqueta('¿Qué querés guardar?'),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                children: <Widget>[
                  _botonDeTipo('nota', 'Nota', Icons.sticky_note_2),
                  _botonDeTipo('foto', 'Foto', Icons.photo_camera),
                  // Icono generico de archivo: el chip vale para PDF y para
                  // Word. El especifico aparece cuando ya se eligio uno.
                  _botonDeTipo('documento', 'Documento', Icons.insert_drive_file),
                  _botonDeTipo('link', 'Link', Icons.link),
                ],
              ),
              const SizedBox(height: 20),

              const _Etiqueta('Título'),
              const SizedBox(height: 8),
              TextField(
                controller: _titulo,
                maxLength: maxCaracteresTitulo,
                style: const TextStyle(color: grisClaro),
                decoration: _decoracion('Ej: Cronograma de mesas de examen'),
              ),
              const SizedBox(height: 8),

              // --- el contenido cambia segun el tipo elegido -----------------
              if (_opcion == 'nota') ...<Widget>[
                const _Etiqueta('Contenido de la nota'),
                const SizedBox(height: 8),
                TextField(
                  controller: _texto,
                  maxLines: 9,
                  maxLength: maxCaracteresNota,
                  style: const TextStyle(color: grisClaro),
                  decoration: _decoracion('Escribí lo que quieras que la IA recuerde...'),
                ),
              ],

              if (_opcion == 'foto') ...<Widget>[
                const _Etiqueta('Foto'),
                const SizedBox(height: 8),
                Row(
                  children: <Widget>[
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: _guardando ? null : () => _elegirFoto(ImageSource.camera),
                        icon: const Icon(Icons.photo_camera),
                        label: const Text('Cámara'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: _guardando ? null : () => _elegirFoto(ImageSource.gallery),
                        icon: const Icon(Icons.photo_library),
                        label: const Text('Galería'),
                      ),
                    ),
                  ],
                ),
                if (_archivo != null) ...<Widget>[
                  const SizedBox(height: 12),
                  ClipRRect(
                    borderRadius: BorderRadius.circular(12),
                    child: Image.file(
                      _archivo!,
                      height: 180,
                      width: double.infinity,
                      fit: BoxFit.cover,
                      // Si el archivo desaparecio (la persona lo borro de la
                      // galeria mientras tanto), Image.file tira un error que
                      // pintaria el cuadro rojo adentro de la pantalla.
                      // (_, _, _): desde Dart 3.7 el _ ignora el parametro y
                      // se puede repetir; el viejo (_, __, ___) ya da aviso.
                      errorBuilder: (_, _, _) => const Text(
                        'No se puede mostrar la vista previa',
                        style: TextStyle(color: grisApagado),
                      ),
                    ),
                  ),
                ],
              ],

              if (_opcion == 'documento') ...<Widget>[
                const _Etiqueta('Archivo PDF o Word'),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  onPressed: _guardando ? null : _elegirDocumento,
                  // Ya elegido, el icono pasa a ser el del tipo que se va a
                  // guardar (el mismo de la lista): asi la persona ve si se
                  // tomo como PDF o como Word antes de tocar Guardar.
                  icon: Icon(
                    _archivo == null ? Icons.attach_file : iconoDeTipo(_tipoDeDocumento),
                  ),
                  label: Text(
                    _nombreArchivo.isEmpty ? 'Elegir un PDF o un Word' : _nombreArchivo,
                  ),
                ),
                const SizedBox(height: 6),
                const Text(
                  'PDF o Word (.docx) de hasta 10 MB. Si tenés un Word viejo '
                  '(.doc), abrilo en Word y guardalo como .docx.',
                  style: TextStyle(color: grisApagado, fontSize: 12),
                ),
              ],

              if (_opcion == 'link') ...<Widget>[
                const _Etiqueta('Dirección web'),
                const SizedBox(height: 8),
                TextField(
                  controller: _url,
                  keyboardType: TextInputType.url,
                  autocorrect: false,
                  style: const TextStyle(color: grisClaro),
                  decoration: _decoracion('https://...'),
                ),
              ],

              const SizedBox(height: 20),
              const _Etiqueta('¿Quién lo puede ver?'),
              const SizedBox(height: 8),
              // Esta es la diferencia de rol del requisito 2 de la materia,
              // puesta en manos de la persona: 'equipo' lo ve cualquier
              // miembro, 'privado' solo el autor y el admin. Y la IA, cuando
              // alguien pregunta, SOLO puede citar lo que esa persona ve.
              // "(y el admin)" esta escrito A PROPOSITO: es lo que pasa de
              // verdad (las reglas dejan al admin leer todo). Decirlo de
              // frente es mejor que un "Solo yo" que despues resulta falso.
              SegmentedButton<String>(
                segments: const <ButtonSegment<String>>[
                  ButtonSegment<String>(
                    value: 'equipo',
                    label: Text('Todo el equipo'),
                    icon: Icon(Icons.groups),
                  ),
                  ButtonSegment<String>(
                    value: 'privado',
                    label: Text('Solo yo (y el admin)'),
                    icon: Icon(Icons.lock),
                  ),
                ],
                selected: <String>{_visibilidad},
                onSelectionChanged: (Set<String> s) =>
                    setState(() => _visibilidad = s.first),
              ),

              // Va con "Documento" entero, aunque hayan elegido un Word: el
              // texto habla solo de fotos y de PDF escaneados (no miente), y
              // en un aviso de privacidad es preferible que sobre a que falte.
              if (_llevaArchivo) ...<Widget>[
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
                onPressed: _guardando ? null : _guardar,
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

  Widget _botonDeTipo(String valor, String etiqueta, IconData icono) {
    final bool elegido = _opcion == valor;
    return ChoiceChip(
      selected: elegido,
      onSelected: _guardando
          ? null
          : (_) => setState(() {
                _opcion = valor;
                // Al cambiar de opcion se limpia todo lo del archivo: si no,
                // alguien elige un PDF, cambia a "Foto" y guarda, y el PDF
                // viajaria como si fuera una foto. _tipoDeDocumento se
                // limpia junto con el archivo porque es un dato DEL archivo
                // (sale de su extension): sin archivo, no hay tipo.
                _archivo = null;
                _nombreArchivo = '';
                _tipoDeDocumento = '';
              }),
      avatar: Icon(icono, size: 18, color: elegido ? azulNoche : grisApagado),
      label: Text(etiqueta),
      selectedColor: cianElectrico,
      backgroundColor: superficie,
      labelStyle: TextStyle(
        color: elegido ? azulNoche : grisClaro,
        fontWeight: FontWeight.w600,
      ),
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
