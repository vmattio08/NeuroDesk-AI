// ============================================================================
//  chat.dart — preguntarle a la IA y ver la respuesta CON LAS FUENTES
//
//  Esta pantalla es el producto: no es "un chat con IA", es "un chat que
//  responde SOLO con lo que subio tu equipo y te muestra de donde lo saco".
//  Por eso las fuentes se muestran siempre, aunque la respuesta sea corta.
//
//  ================= EL MISMO PATRON QUE EN LOS ITEMS =======================
//     1) El CLIENTE crea workspaces/{wsId}/respuestas/{respId} con EXACTAMENTE
//        cuatro campos: pregunta, autorUid, estado 'buscando' y creadoEn.
//        (Las reglas usan hasOnly + hasAll: ni uno mas, ni uno menos. Nada de
//        'workspaceId' —el wsId va solo en el path— y nada de 'respuesta': el
//        campo aparece recien cuando lo escribe el backend.)
//     2) RECIEN DESPUES se hace POST /preguntar con ese respId.
//
//  Asi la pregunta y el spinner aparecen al instante aunque Render este
//  dormido y tarde 60 segundos en contestar.
//
//  ================= POR QUE NO HAY POLLING =================================
//  La app NO le pregunta al backend "¿ya esta?" cada dos segundos. Escucha el
//  documento con .snapshots() y el estado va cambiando solo:
//        buscando -> redactando -> listo | error
//  Es literalmente la maquina de estados del modelo de datos dibujada en
//  pantalla, y es tiempo real de verdad (el requisito de la materia).
// ============================================================================

import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';

import '../servicios/api.dart';
import '../servicios/auth_servicio.dart';
import '../tema.dart';

class ChatPantalla extends StatefulWidget {
  const ChatPantalla({
    super.key,
    required this.wsId,
    required this.wsNombre,
    required this.miUid,
  });

  final String wsId;
  final String wsNombre;
  final String miUid;

  @override
  State<ChatPantalla> createState() => _ChatPantallaState();
}

class _ChatPantallaState extends State<ChatPantalla> {
  static const int minPregunta = 3;
  static const int maxPregunta = 500;

  final TextEditingController _pregunta = TextEditingController();

  /// El historial. Se crea UNA vez, en initState.
  ///
  /// El where por autorUid no es un capricho: la regla de respuestas deja leer
  /// solo las propias (y al admin, todas). Sin ese where, la query traeria
  /// tambien las de los demas y fallaria ENTERA con permission-denied. Las
  /// reglas no filtran: rechazan.
  late final Stream<QuerySnapshot<Map<String, dynamic>>> _historial;

  bool _enviando = false;

  @override
  void initState() {
    super.initState();
    _historial = FirebaseFirestore.instance
        .collection('workspaces')
        .doc(widget.wsId)
        .collection('respuestas')
        .where('autorUid', isEqualTo: widget.miUid)
        .orderBy('creadoEn', descending: true)
        .limit(20)
        .snapshots();
  }

  @override
  void dispose() {
    _pregunta.dispose();
    super.dispose();
  }

  /// Crea el documento de la respuesta y abre la pantalla que la escucha.
  /// El POST a /preguntar lo dispara ESA pantalla, no esta: asi el pedido y el
  /// lugar donde se ve el resultado son el mismo widget, y si algo falla el
  /// error se muestra donde la persona esta mirando.
  Future<void> _preguntar() async {
    if (_enviando) return;

    final String texto = _pregunta.text.trim();
    if (texto.length < minPregunta) {
      mostrarAviso(context, 'Escribi una pregunta un poco mas larga.', esError: true);
      return;
    }
    if (texto.length > maxPregunta) {
      mostrarAviso(context, 'La pregunta no puede pasar de 500 caracteres.', esError: true);
      return;
    }

    setState(() => _enviando = true);
    final NavigatorState navegador = Navigator.of(context);
    final ScaffoldMessengerState mensajero = ScaffoldMessenger.of(context);

    try {
      final DocumentReference<Map<String, dynamic>> ref = FirebaseFirestore.instance
          .collection('workspaces')
          .doc(widget.wsId)
          .collection('respuestas')
          .doc();

      // EXACTAMENTE los cuatro campos permitidos.
      await ref.set(<String, Object?>{
        'pregunta': texto,
        'autorUid': widget.miUid,
        'estado': 'buscando',
        'creadoEn': FieldValue.serverTimestamp(),
      }).timeout(const Duration(seconds: 12));

      if (!mounted) return;
      _pregunta.clear();

      navegador.push(
        MaterialPageRoute<void>(
          builder: (_) => RespuestaPantalla(
            wsId: widget.wsId,
            respId: ref.id,
            pregunta: texto,
            preguntarAlAbrir: true,
          ),
        ),
      );
    } on TimeoutException {
      mostrarAvisoEn(
        mensajero,
        'Sin conexion: para preguntar hace falta internet.',
        esError: true,
      );
    } catch (e) {
      debugPrint('[NeuroDesk] no se pudo crear la respuesta: $e');
      mostrarAvisoEn(
        mensajero,
        'No pudimos registrar la pregunta. Proba de nuevo.',
        esError: true,
      );
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: azulNoche,
        foregroundColor: grisClaro,
        title: const Text('Preguntale al equipo'),
      ),
      body: SafeArea(
        child: Column(
          children: <Widget>[
            Expanded(
              child: StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
                stream: _historial,
                builder: (
                  BuildContext context,
                  AsyncSnapshot<QuerySnapshot<Map<String, dynamic>>> snapshot,
                ) {
                  if (snapshot.hasError) {
                    return ErrorMensaje(error: snapshot.error!);
                  }
                  if (!snapshot.hasData) {
                    return const Center(
                      child: CircularProgressIndicator(color: cianElectrico),
                    );
                  }
                  final List<QueryDocumentSnapshot<Map<String, dynamic>>> docs =
                      snapshot.data!.docs;
                  if (docs.isEmpty) {
                    return const VacioMensaje(
                      icono: Icons.forum_outlined,
                      titulo: 'Preguntá lo que quieras',
                      detalle:
                          'La IA responde SOLO con lo que subio tu equipo, y te '
                          'muestra de que item saco cada dato.',
                    );
                  }
                  return ListView.builder(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    itemCount: docs.length,
                    itemBuilder: (BuildContext context, int i) =>
                        _filaDelHistorial(docs[i]),
                  );
                },
              ),
            ),
            _cajaDeTexto(),
          ],
        ),
      ),
    );
  }

  Widget _filaDelHistorial(QueryDocumentSnapshot<Map<String, dynamic>> doc) {
    final Map<String, dynamic> d = doc.data();
    final String pregunta = (d['pregunta'] ?? '').toString();
    final String estado = (d['estado'] ?? 'buscando').toString();

    return ListTile(
      leading: Icon(
        estado == 'listo'
            ? Icons.check_circle
            : (estado == 'error' ? Icons.error : Icons.hourglass_top),
        color: estado == 'listo'
            ? colorListo
            : (estado == 'error' ? colorError : colorProcesando),
      ),
      title: Text(
        pregunta,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(color: grisClaro, fontSize: 14.5),
      ),
      subtitle: Text(
        fechaCorta(d['creadoEn']),
        style: const TextStyle(color: grisApagado, fontSize: 12),
      ),
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => RespuestaPantalla(
            wsId: widget.wsId,
            respId: doc.id,
            pregunta: pregunta,
            // Abriendo desde el historial NO se vuelve a preguntar: seria
            // gastar creditos de IA de nuevo por mirar algo ya respondido.
            preguntarAlAbrir: false,
          ),
        ),
      ),
    );
  }

  Widget _cajaDeTexto() {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
      color: superficie,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: <Widget>[
          Expanded(
            child: TextField(
              controller: _pregunta,
              maxLines: 4,
              minLines: 1,
              maxLength: maxPregunta,
              style: const TextStyle(color: grisClaro),
              decoration: InputDecoration(
                hintText: 'Ej: ¿Cuando es la mesa de Matematica?',
                hintStyle: const TextStyle(color: grisApagado),
                counterText: '', // el contador de 500 ensucia la barra
                filled: true,
                fillColor: azulNoche,
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(24),
                  borderSide: BorderSide.none,
                ),
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
              ),
            ),
          ),
          const SizedBox(width: 8),
          FloatingActionButton.small(
            backgroundColor: cian,
            foregroundColor: azulNoche,
            // Deshabilitado mientras se manda: el doble tap crearia DOS
            // documentos de respuesta y gastaria dos veces los creditos.
            onPressed: _enviando ? null : _preguntar,
            child: _enviando
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2.5, color: azulNoche),
                  )
                : const Icon(Icons.send),
          ),
        ],
      ),
    );
  }
}

// ============================================================================
//  LA RESPUESTA — escucha el documento y muestra el progreso en vivo
// ============================================================================
class RespuestaPantalla extends StatefulWidget {
  const RespuestaPantalla({
    super.key,
    required this.wsId,
    required this.respId,
    required this.pregunta,
    required this.preguntarAlAbrir,
  });

  final String wsId;
  final String respId;
  final String pregunta;

  /// true cuando la pregunta se acaba de crear: hay que disparar el POST.
  final bool preguntarAlAbrir;

  @override
  State<RespuestaPantalla> createState() => _RespuestaPantallaState();
}

class _RespuestaPantallaState extends State<RespuestaPantalla> {
  /// El stream del documento, creado UNA vez en initState.
  late final Stream<DocumentSnapshot<Map<String, dynamic>>> _doc;

  /// Mensaje del POST cuando falla ANTES de que el backend escriba errorMsg.
  /// Si el backend ya lo escribio, mostramos el del documento: el contrato
  /// dice explicitamente que no se muestra dos veces el mismo error con
  /// palabras distintas.
  String? _errorDelPedido;

  @override
  void initState() {
    super.initState();
    _doc = FirebaseFirestore.instance
        .collection('workspaces')
        .doc(widget.wsId)
        .collection('respuestas')
        .doc(widget.respId)
        .snapshots();

    if (widget.preguntarAlAbrir) {
      // No se hace await: la pantalla ya se dibuja con el estado 'buscando'
      // que dejo escrito el cliente. La respuesta llega por el stream.
      _mandarPregunta();
    }
  }

  Future<void> _mandarPregunta() async {
    try {
      final RespuestaApi r = await Api.preguntar(
        wsId: widget.wsId,
        respId: widget.respId,
        pregunta: widget.pregunta,
      );
      if (!mounted) return;
      if (r.ok || r.sigueProcesando) return; // el stream va a mostrar el final
      if (r.sesionVencida) {
        await AuthServicio.salir();
        return;
      }
      setState(() => _errorDelPedido = r.mensaje);
    } catch (e) {
      debugPrint('[NeuroDesk] /preguntar exploto: $e');
      if (!mounted) return;
      setState(() => _errorDelPedido = 'No pudimos preguntar. Proba de nuevo.');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: azulNoche,
        foregroundColor: grisClaro,
        title: const Text('Respuesta'),
      ),
      body: StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
        stream: _doc,
        builder: (
          BuildContext context,
          AsyncSnapshot<DocumentSnapshot<Map<String, dynamic>>> snapshot,
        ) {
          if (snapshot.hasError) {
            return ErrorMensaje(error: snapshot.error!);
          }
          if (!snapshot.hasData) {
            return const Center(child: CircularProgressIndicator(color: cianElectrico));
          }

          final Map<String, dynamic> d =
              snapshot.data!.data() ?? <String, dynamic>{};
          final String estado = (d['estado'] ?? 'buscando').toString();
          final String respuesta = (d['respuesta'] ?? '').toString();
          final String errorMsg = (d['errorMsg'] ?? '').toString();
          final String confianza = (d['confianza'] ?? '').toString();
          final List<dynamic> fuentes =
              (d['fuentes'] is List) ? d['fuentes'] as List<dynamic> : <dynamic>[];

          return ListView(
            padding: const EdgeInsets.all(16),
            children: <Widget>[
              // --- la pregunta ------------------------------------------------
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: azulRoyal.withValues(alpha: 0.18),
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Text(
                  (d['pregunta'] ?? widget.pregunta).toString(),
                  style: const TextStyle(
                    color: grisClaro,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              const SizedBox(height: 18),

              // --- el progreso en vivo ---------------------------------------
              if (estado == 'buscando' || estado == 'redactando')
                _Progreso(estado: estado),

              // --- el error ---------------------------------------------------
              if (estado == 'error' || _errorDelPedido != null) ...<Widget>[
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: colorError.withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Text(
                    // El del documento gana: es el que escribio el backend
                    // sabiendo que paso de verdad.
                    errorMsg.isNotEmpty
                        ? errorMsg
                        : (_errorDelPedido ?? 'No pudimos responder.'),
                    style: const TextStyle(color: colorError),
                  ),
                ),
                const SizedBox(height: 12),
                FilledButton.icon(
                  style: FilledButton.styleFrom(
                    backgroundColor: cian,
                    foregroundColor: azulNoche,
                  ),
                  // "Volver a preguntar" crea una respuesta NUEVA: el
                  // documento viejo quedo en 'error' y el cliente no puede
                  // cambiarle el estado (allow update: if false).
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.refresh),
                  label: const Text('Volver a preguntar'),
                ),
              ],

              // --- la respuesta -----------------------------------------------
              if (estado == 'listo') ...<Widget>[
                if (confianza.isNotEmpty) _ChipDeConfianza(confianza: confianza),
                const SizedBox(height: 10),
                SelectableText(
                  respuesta.isEmpty
                      ? 'No encontre esto en la base del equipo.'
                      : respuesta,
                  style: const TextStyle(color: grisClaro, fontSize: 16, height: 1.5),
                ),
                const SizedBox(height: 22),

                if (fuentes.isEmpty)
                  const Text(
                    'Sin fuentes: no hay nada cargado que hable de esto, o lo que '
                    'hay es privado de otra persona.',
                    style: TextStyle(color: grisApagado, fontSize: 13),
                  )
                else ...<Widget>[
                  const Text(
                    'De donde lo saque',
                    style: TextStyle(
                      color: grisClaro,
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const SizedBox(height: 10),
                  for (final dynamic f in fuentes) _Fuente(datos: f),
                ],

                // Los dos numeros del filtro de privacidad. Se muestran a
                // proposito: si la misma pregunta la hace el admin,
                // "visibles" es mas grande. Es el requisito de roles hecho
                // numero, y se puede mostrar en vivo en la defensa.
                if (d['chunksMirados'] != null) ...<Widget>[
                  const SizedBox(height: 20),
                  Text(
                    'Mire ${d['chunksMirados']} fragmentos del equipo y pude usar '
                    '${d['chunksVisibles']}: el resto es privado de otras personas.',
                    style: const TextStyle(color: grisApagado, fontSize: 12),
                  ),
                ],
              ],
            ],
          );
        },
      ),
    );
  }
}

/// El cartel de progreso: buscando -> redactando.
class _Progreso extends StatelessWidget {
  const _Progreso({required this.estado});

  final String estado;

  @override
  Widget build(BuildContext context) {
    final bool buscando = estado == 'buscando';
    return Row(
      children: <Widget>[
        const SizedBox(
          width: 18,
          height: 18,
          child: CircularProgressIndicator(strokeWidth: 2.5, color: cianElectrico),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Text(
            buscando
                ? 'Buscando en el conocimiento del equipo...'
                : 'Redactando la respuesta...',
            style: const TextStyle(color: cianElectrico, fontSize: 14),
          ),
        ),
      ],
    );
  }
}

class _ChipDeConfianza extends StatelessWidget {
  const _ChipDeConfianza({required this.confianza});

  final String confianza;

  @override
  Widget build(BuildContext context) {
    // 'confianza' es un STRING ('alta' | 'media' | 'baja'), igual en el modelo
    // y en el contrato. El numero crudo vive en fuentes[].similitud.
    final Color color = confianza == 'alta'
        ? colorListo
        : (confianza == 'media' ? colorProcesando : colorError);
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: color.withValues(alpha: 0.5)),
        ),
        child: Text(
          'Confianza $confianza',
          style: TextStyle(color: color, fontSize: 12, fontWeight: FontWeight.w600),
        ),
      ),
    );
  }
}

/// Una cita: [n] titulo, pagina y el fragmento exacto que uso la IA.
class _Fuente extends StatelessWidget {
  const _Fuente({required this.datos});

  final dynamic datos;

  @override
  Widget build(BuildContext context) {
    // Lo que viene de Firestore es dynamic: si no es un mapa, no lo dibujamos
    // en vez de romper la pantalla entera.
    if (datos is! Map) return const SizedBox.shrink();
    final Map<dynamic, dynamic> f = datos as Map<dynamic, dynamic>;

    final String titulo = (f['titulo'] ?? 'Sin titulo').toString();
    final String fragmento = (f['fragmento'] ?? '').toString();
    final Object? pagina = f['pagina'];
    final Object? n = f['n'];

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: superficie,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: cian.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: cian,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  '${n ?? '?'}',
                  style: const TextStyle(
                    color: azulNoche,
                    fontSize: 12,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  titulo,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: grisClaro,
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (pagina != null)
                Text(
                  'pag. $pagina',
                  style: const TextStyle(color: grisApagado, fontSize: 12),
                ),
            ],
          ),
          if (fragmento.isNotEmpty) ...<Widget>[
            const SizedBox(height: 8),
            Text(
              '"$fragmento"',
              style: const TextStyle(
                color: grisApagado,
                fontSize: 13,
                fontStyle: FontStyle.italic,
                height: 1.4,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
