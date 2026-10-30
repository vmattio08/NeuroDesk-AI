// ============================================================================
//  chat.dart — preguntarle a la IA, ver la respuesta CON LAS FUENTES y seguir
//  la charla con preguntas de seguimiento
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
//
//  ============ CONVERSACIONES (PREGUNTAS DE SEGUIMIENTO) ====================
//  Despues de una respuesta se puede seguir preguntando ("¿y para cuando lo
//  necesitan?") sin repetir de que se estaba hablando. Una conversacion NO es
//  una coleccion nueva: es una CADENA de documentos de la misma coleccion
//  respuestas. Asi la lectura (autor o admin), el update cerrado y los campos
//  que escribe solo el backend siguen siendo exactamente las reglas de siempre.
//     - La PRIMERA pregunta (la "raiz") es igual que siempre: los cuatro
//       campos y nada mas. Ni siquiera conversacionId: null (null no es
//       string y la regla lo rechaza): los campos nuevos se OMITEN.
//     - Cada pregunta de SEGUIMIENTO suma dos campos, siempre juntos:
//         conversacionId = respId de la raiz (con eso la conversacion entera
//                          se lista con UNA query);
//         anteriorRespId = respId de la vuelta anterior (con eso el backend
//                          arma el historial hacia atras, hasta 3 vueltas).
//     - preguntaBuscada la escribe SOLO el backend: es la pregunta reescrita
//       para que se entienda sola, la que uso de verdad para buscar. La
//       mostramos abajo de la pregunta ("La entendí como: ...").
//  El historial le da CONTEXTO a la IA, no PERMISOS: en cada vuelta el
//  backend vuelve a calcular en vivo que puede ver quien pregunta.
//
//  La pantalla de la conversacion escucha DOS cosas con StreamBuilder:
//     a) el documento de la raiz, por su id (la raiz no tiene conversacionId,
//        asi que no sale en la query de abajo);
//     b) los seguimientos:
//          .where('autorUid', isEqualTo: miUid)
//          .where('conversacionId', isEqualTo: raizId)
//          .orderBy('creadoEn')
//        El where por autorUid es obligatorio aunque la conversacion sea toda
//        mia: conversacionId no es secreto (cualquiera puede escribir el id de
//        mi raiz en SU documento) y las reglas no filtran, rechazan la query
//        entera. Esta query usa el indice compuesto autorUid + conversacionId
//        + creadoEn (firestore.indexes.json). Si el indice todavia no esta
//        publicado, Firestore contesta FAILED_PRECONDITION: en ese caso (o con
//        permission-denied) se sigue viendo la raiz con un aviso y un boton
//        "Reintentar", nunca una pantalla roja.
//
//  ========= LO QUE LA APP RECUERDA AUNQUE SALGAS DE LA PANTALLA =============
//  Un POST a /preguntar que falla ANTES de que el backend toque el documento
//  (sin red, backend caido, DEMASIADOS_PEDIDOS) deja la vuelta en 'buscando'
//  para siempre en Firestore: nadie la va a pasar a 'error'. Lo que paso con
//  cada POST se anota en RegistroDePedidos (abajo de todo), que dura lo que
//  dura la app abierta y no lo que dura una pantalla. Ahi tambien vive la
//  espera de DEMASIADOS_PEDIDOS (contrato N6: el boton se apaga los segundos
//  que diga Retry-After) y la hora del CELULAR en que salio cada pregunta,
//  que es con la que se decide si una vuelta quedo colgada.
//
//  ================= CADA FUENTE CON DUENO ==================================
//  Cada fuente dice de quien es, de cuando y con que candado ("Valentino
//  Mattio · 24/08 · Del equipo", "Tu nota privada · 27/08", "Privada de
//  Martín Sosa · 27/08 · la ves porque sos admin"), y al tocarla se abre
//  "Lo que leyó NeuroDesk" con la parte citada en cian (detalle_item.dart).
//  Para eso se lee cada item citado UNA vez por conversacion (LecturasDeItems
//  en equipo.dart: hasta 6 por respuesta, guardadas en memoria porque la
//  pantalla se redibuja sola) y los nombres salen de members y exMiembros.
//
//  ================= LA PRIVACIDAD, DICHA DE FRENTE =========================
//  Un "no encontré" de un miembro no es una falla: la IA busco SOLO en lo que
//  esa persona puede ver. Por eso cada respuesta dice con que se respondio
//  ("Respondido solo con lo que vos podés ver" / "Como sos admin, busqué en
//  todo el espacio..."), y una pregunta sin fuentes avisa que quedo anotada
//  para el admin, que la ve en "Lo que falta" del panel (el Radar).
// ============================================================================

import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';

import '../servicios/api.dart';
import '../servicios/auth_servicio.dart';
import '../servicios/equipo.dart';
import '../tema.dart';
import 'detalle_item.dart';

class ChatPantalla extends StatefulWidget {
  const ChatPantalla({
    super.key,
    required this.wsId,
    required this.wsNombre,
    required this.miUid,
    this.esAdmin = false,
  });

  final String wsId;
  final String wsNombre;
  final String miUid;

  /// Solo para el aviso de abajo del historial (quien puede ver las
  /// preguntas). No autoriza nada: eso lo hacen el backend y las reglas.
  final bool esAdmin;

  /// El aviso del historial: las preguntas NO son secretas para el admin
  /// (la regla de respuestas le deja leerlas todas, y el panel le muestra las
  /// que quedaron sin respuesta). Es mejor decirlo que esconderlo.
  static String avisoDelHistorial({required bool esAdmin}) => esAdmin
      ? 'Como sos admin, desde el panel ves las preguntas de todo el equipo.'
      : 'El administrador del equipo puede ver las preguntas que hacés acá.';

  /// El largo de una pregunta: el MISMO rango que la regla de Firestore
  /// (pregunta.size() >= 3 y <= 500) y que el backend.
  static const int minPregunta = 3;
  static const int maxPregunta = 500;

  /// Revisa la pregunta ANTES de crear el documento. Devuelve el aviso para
  /// la persona, o null si esta bien.
  ///
  /// POR QUE ACA Y NO SOLO EN LA REGLA: la regla tambien la rechazaria, pero
  /// con un permission-denied que no le dice nada a nadie. Y es la MISMA
  /// funcion para la primera pregunta y para los seguimientos: las dos cajas
  /// no pueden terminar con limites distintos.
  static String? validarPregunta(String texto) {
    final String limpio = texto.trim();
    if (limpio.length < minPregunta) {
      return 'Escribí una pregunta un poco más larga.';
    }
    if (limpio.length > maxPregunta) {
      return 'La pregunta no puede pasar de $maxPregunta caracteres.';
    }
    return null;
  }

  /// Los campos de una PRIMERA pregunta: EXACTAMENTE los cuatro de siempre.
  /// Ni conversacionId ni anteriorRespId, tampoco en null: la regla acepta
  /// "no estan" o "estan los dos con texto", y null no es ninguna de las dos.
  static Map<String, Object> camposDePrimeraPregunta({
    required String pregunta,
    required String miUid,
  }) {
    return <String, Object>{
      'pregunta': pregunta,
      'autorUid': miUid,
      'estado': 'buscando',
      'creadoEn': FieldValue.serverTimestamp(),
    };
  }

  /// true si el documento es la RAIZ de una conversacion: la primera
  /// pregunta, la que no tiene conversacionId. Las preguntas viejas (de antes
  /// de los seguimientos) tampoco lo tienen, asi que siguen apareciendo.
  static bool esRaiz(Map<String, dynamic> datos) {
    final Object? conversacion = datos['conversacionId'];
    return conversacion is! String || conversacion.isEmpty;
  }

  /// Cuantos seguimientos tiene cada raiz entre los documentos que trajo el
  /// historial (raizId -> cantidad). Las raices no suman.
  static Map<String, int> contarSeguimientos(
    Iterable<Map<String, dynamic>> documentos,
  ) {
    final Map<String, int> cuenta = <String, int>{};
    for (final Map<String, dynamic> datos in documentos) {
      final Object? raiz = datos['conversacionId'];
      if (raiz is String && raiz.isNotEmpty) {
        cuenta[raiz] = (cuenta[raiz] ?? 0) + 1;
      }
    }
    return cuenta;
  }

  /// Las filas del historial: UNA por conversacion, armadas con los
  /// documentos que trajo la query (id -> datos, de la mas nueva a la mas
  /// vieja).
  ///   1) Las raices que entraron, en el orden de la query: como siempre, la
  ///      conversacion mas nueva arriba.
  ///   2) Despues, las conversaciones cuya raiz quedo AFUERA de la query pero
  ///      tienen seguimientos adentro. Van al final porque su raiz es mas
  ///      vieja que todo lo que trajo la query, y se dibujan con su
  ///      seguimiento MAS VIEJO que si entro hasta que se lee la raiz.
  ///
  /// POR QUE EL PASO 2: los seguimientos ocupan lugar en la misma query. Sin
  /// el, una conversacion con 60 seguimientos seguidos llenaba la ventana
  /// entera, no quedaba ninguna raiz y la lista decia "Preguntá lo que
  /// quieras", como si no hubiera historial. Y con conversaciones largas se
  /// perdian filas: tres conversaciones de 20 preguntas mostraban solo dos.
  static List<FilaDelHistorial> filasDelHistorial(
    List<MapEntry<String, Map<String, dynamic>>> documentos,
  ) {
    final Map<String, int> cuenta = contarSeguimientos(
      documentos.map((MapEntry<String, Map<String, dynamic>> d) => d.value),
    );

    final List<FilaDelHistorial> filas = <FilaDelHistorial>[];
    final Set<String> raicesQueEntraron = <String>{};
    for (final MapEntry<String, Map<String, dynamic>> d in documentos) {
      if (!esRaiz(d.value)) continue;
      raicesQueEntraron.add(d.key);
      filas.add(
        FilaDelHistorial(
          raizId: d.key,
          datos: d.value,
          seguimientos: cuenta[d.key] ?? 0,
          raizEnLaVentana: true,
        ),
      );
    }

    // raizId -> su seguimiento mas viejo dentro de la query. Pisar la clave
    // deja el mas viejo (la query viene de la mas nueva a la mas vieja) y no
    // le cambia el lugar al mapa: quedan ordenadas por su actividad mas nueva.
    final Map<String, Map<String, dynamic>> sinSuRaiz = <String, Map<String, dynamic>>{};
    for (final MapEntry<String, Map<String, dynamic>> d in documentos) {
      final Object? raiz = d.value['conversacionId'];
      if (raiz is String && raiz.isNotEmpty && !raicesQueEntraron.contains(raiz)) {
        sinSuRaiz[raiz] = d.value;
      }
    }
    sinSuRaiz.forEach((String raizId, Map<String, dynamic> masViejo) {
      filas.add(
        FilaDelHistorial(
          raizId: raizId,
          datos: masViejo,
          seguimientos: cuenta[raizId] ?? 0,
          raizEnLaVentana: false,
        ),
      );
    });
    return filas;
  }

  /// El texto de la espera de DEMASIADOS_PEDIDOS, con el plural bien puesto.
  /// Es el mismo en las dos cajas (la del chat y la de seguimiento).
  static String avisoDeEspera(int segundos) {
    final String cuanto = segundos == 1 ? '1 segundo' : '$segundos segundos';
    return 'Esperá $cuanto para volver a preguntar…';
  }

  @override
  State<ChatPantalla> createState() => _ChatPantallaState();
}

/// Una fila del historial del chat: una conversacion entera.
class FilaDelHistorial {
  const FilaDelHistorial({
    required this.raizId,
    required this.datos,
    required this.seguimientos,
    required this.raizEnLaVentana,
  });

  /// El id de la raiz, que es el id de la conversacion: lo que abre la fila.
  final String raizId;

  /// Lo que se dibuja: la raiz si entro en la query; si no, el seguimiento
  /// mas viejo que si entro (hasta que llega la raiz, leida por id).
  final Map<String, dynamic> datos;

  /// Cuantos seguimientos de esta conversacion trajo la query.
  final int seguimientos;

  /// false = la raiz quedo afuera de la query, y [seguimientos] es un minimo.
  final bool raizEnLaVentana;
}

class _ChatPantallaState extends State<ChatPantalla> {
  final TextEditingController _pregunta = TextEditingController();

  /// El historial. Se crea UNA vez, en initState.
  ///
  /// El where por autorUid no es un capricho: la regla de respuestas deja leer
  /// solo las propias (y al admin, todas). Sin ese where, la query traeria
  /// tambien las de los demas y fallaria ENTERA con permission-denied. Las
  /// reglas no filtran: rechazan.
  ///
  /// El historial muestra una fila por CONVERSACION y el agrupado se hace aca,
  /// en la app (ChatPantalla.filasDelHistorial): Firestore no tiene un "where
  /// el campo NO existe", y a la raiz se la reconoce justamente porque NO
  /// tiene conversacionId. Por eso el limite es 60 y no 20: los seguimientos
  /// ocupan lugar en la misma query. Si la raiz entro, la cantidad de
  /// preguntas sale exacta (un seguimiento siempre es MAS NUEVO que su raiz,
  /// asi que entraron todos). Si una conversacion larga dejo a su raiz
  /// AFUERA, igual tiene su fila: la raiz se lee una vez por id (_leerRaiz) y
  /// la cantidad se muestra como un minimo.
  late final Stream<QuerySnapshot<Map<String, dynamic>>> _historial;

  /// Las raices que quedaron afuera de la query, leidas UNA vez por id. Se
  /// guarda el Future y no el resultado para que redibujar la lista no vuelva
  /// a leer: el mismo motivo por el que los streams se crean en initState.
  final Map<String, Future<DocumentSnapshot<Map<String, dynamic>>>> _raicesLeidas =
      <String, Future<DocumentSnapshot<Map<String, dynamic>>>>{};

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
        .limit(60)
        .snapshots();
    // Para la cuenta regresiva del boton cuando el backend dice
    // DEMASIADOS_PEDIDOS (la anota la conversacion, pero el limite es por
    // persona: vale tambien para la primera pregunta).
    RegistroDePedidos.cambios.addListener(_redibujar);
  }

  @override
  void dispose() {
    RegistroDePedidos.cambios.removeListener(_redibujar);
    _pregunta.dispose();
    super.dispose();
  }

  void _redibujar() {
    if (mounted) setState(() {});
  }

  Future<DocumentSnapshot<Map<String, dynamic>>> _leerRaiz(String raizId) {
    return _raicesLeidas.putIfAbsent(
      raizId,
      () => FirebaseFirestore.instance
          .collection('workspaces')
          .doc(widget.wsId)
          .collection('respuestas')
          .doc(raizId)
          .get(),
    );
  }

  /// Crea el documento de la PRIMERA pregunta y abre la conversacion que lo
  /// escucha. El POST a /preguntar lo dispara ESA pantalla, no esta: asi el
  /// pedido y el lugar donde se ve el resultado son el mismo widget, y si algo
  /// falla el error se muestra donde la persona esta mirando.
  Future<void> _preguntar() async {
    if (_enviando) return;
    // El boton ya esta apagado mientras dura la espera de DEMASIADOS_PEDIDOS;
    // esto es por las dudas.
    if (RegistroDePedidos.segundosDeEspera(DateTime.now()) != null) return;

    final String texto = _pregunta.text.trim();
    final String? problema = ChatPantalla.validarPregunta(texto);
    if (problema != null) {
      mostrarAviso(context, problema, esError: true);
      return;
    }

    setState(() => _enviando = true);
    final ScaffoldMessengerState mensajero = ScaffoldMessenger.of(context);
    DocumentReference<Map<String, dynamic>>? ref;

    try {
      ref = FirebaseFirestore.instance
          .collection('workspaces')
          .doc(widget.wsId)
          .collection('respuestas')
          .doc();

      // EXACTAMENTE los cuatro campos permitidos.
      await ref
          .set(ChatPantalla.camposDePrimeraPregunta(pregunta: texto, miUid: widget.miUid))
          .timeout(const Duration(seconds: 12));

      if (!mounted) return;
      _pregunta.clear();

      _abrirConversacion(raizId: ref.id, pregunta: texto, preguntarAlAbrir: true);
    } on TimeoutException {
      // Sin red, Firestore guarda la pregunta en el celular y la sube sola
      // cuando vuelve la conexion, pero el POST no sale nunca: quedaria en
      // 'buscando' para siempre. La anotamos con su error para que, si la
      // persona la abre desde el historial, la vea fallada y no girando.
      if (ref != null) {
        RegistroDePedidos.anotarError(
          ref.id,
          'Sin conexión: esta pregunta no llegó al servidor.',
        );
      }
      mostrarAvisoEn(
        mensajero,
        'Sin conexión: para preguntar hace falta internet.',
        esError: true,
      );
    } catch (e) {
      debugPrint('[NeuroDesk] no se pudo crear la respuesta: $e');
      mostrarAvisoEn(
        mensajero,
        'No pudimos registrar la pregunta. Probá de nuevo.',
        esError: true,
      );
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  /// Abre una conversacion. Si su PRIMERA pregunta fallo y la persona toca
  /// "Volver a preguntar", la conversacion se cierra devolviendo el texto, y
  /// lo dejamos escrito en la caja para que no lo tenga que tipear de nuevo.
  void _abrirConversacion({
    required String raizId,
    required String pregunta,
    required bool preguntarAlAbrir,
  }) {
    Navigator.of(context)
        .push<String>(
          MaterialPageRoute<String>(
            builder: (_) => ConversacionPantalla(
              wsId: widget.wsId,
              miUid: widget.miUid,
              raizId: raizId,
              pregunta: pregunta,
              preguntarAlAbrir: preguntarAlAbrir,
              esAdmin: widget.esAdmin,
            ),
          ),
        )
        .then((String? paraVolverAPreguntar) {
      if (!mounted || paraVolverAPreguntar == null) return;
      // Si la persona ya habia empezado a escribir otra cosa, no se la pisamos.
      if (_pregunta.text.trim().isEmpty) _pregunta.text = paraVolverAPreguntar;
    });
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
                  // Una fila por conversacion. Los seguimientos se ven
                  // adentro de su conversacion, no como filas sueltas.
                  final List<FilaDelHistorial> filas = ChatPantalla.filasDelHistorial(
                    snapshot.data!.docs
                        .map((QueryDocumentSnapshot<Map<String, dynamic>> doc) =>
                            MapEntry<String, Map<String, dynamic>>(doc.id, doc.data()))
                        .toList(),
                  );
                  // Vacio de verdad: con que la query traiga un solo
                  // documento ya hay al menos una fila.
                  if (filas.isEmpty) {
                    return const VacioMensaje(
                      icono: Icons.forum_outlined,
                      titulo: 'Preguntá lo que quieras',
                      detalle:
                          'La IA responde SOLO con lo que subió tu equipo, y te '
                          'muestra de qué ítem sacó cada dato.',
                    );
                  }
                  return ListView.builder(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    itemCount: filas.length,
                    itemBuilder: (BuildContext context, int i) => _filaDelHistorial(filas[i]),
                  );
                },
              ),
            ),
            // Justo arriba de donde se escribe: es el momento en que importa
            // saber quien mas puede leer la pregunta.
            AvisoDelHistorial(texto: ChatPantalla.avisoDelHistorial(esAdmin: widget.esAdmin)),
            _cajaDeTexto(),
          ],
        ),
      ),
    );
  }

  Widget _filaDelHistorial(FilaDelHistorial fila) {
    if (fila.raizEnLaVentana) return _dibujarFila(fila, fila.datos);
    // La raiz quedo afuera de la query: se lee UNA vez por id (la regla deja
    // leer las propias). Mientras tanto, o si no se puede leer, la fila se
    // dibuja con el seguimiento mas viejo que si llego: nunca una fila roja.
    return FutureBuilder<DocumentSnapshot<Map<String, dynamic>>>(
      future: _leerRaiz(fila.raizId),
      builder: (
        BuildContext context,
        AsyncSnapshot<DocumentSnapshot<Map<String, dynamic>>> snapshot,
      ) {
        if (snapshot.hasError) {
          debugPrint('[NeuroDesk] no se pudo leer la raiz ${fila.raizId}: ${snapshot.error}');
          return _dibujarFila(fila, fila.datos);
        }
        return _dibujarFila(fila, snapshot.data?.data() ?? fila.datos);
      },
    );
  }

  Widget _dibujarFila(FilaDelHistorial fila, Map<String, dynamic> d) {
    final String pregunta = (d['pregunta'] ?? '').toString();
    final String estado = (d['estado'] ?? 'buscando').toString();
    final String fecha = fechaCorta(d['creadoEn']);

    final String detalle;
    if (!fila.raizEnLaVentana) {
      // La raiz y quizas algunos seguimientos quedaron afuera de la query: no
      // sabemos cuantas preguntas son en total, si que son por lo menos estas.
      detalle = '$fecha · al menos ${fila.seguimientos + 1} preguntas';
    } else if (fila.seguimientos == 0) {
      detalle = fecha;
    } else {
      // "3 preguntas" = la raiz + 2 seguimientos: avisa que adentro hay una
      // charla y no una sola respuesta.
      detalle = '$fecha · ${fila.seguimientos + 1} preguntas';
    }

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
        detalle,
        style: const TextStyle(color: grisApagado, fontSize: 12),
      ),
      // Abriendo desde el historial NO se vuelve a preguntar: seria gastar
      // creditos de IA de nuevo por mirar algo ya respondido.
      onTap: () => _abrirConversacion(
        raizId: fila.raizId,
        pregunta: pregunta,
        preguntarAlAbrir: false,
      ),
    );
  }

  Widget _cajaDeTexto() {
    // DEMASIADOS_PEDIDOS (contrato N6): el boton se apaga los segundos que
    // dijo Retry-After y muestra la cuenta regresiva. El limite es por
    // persona, asi que vale aunque lo haya disparado un seguimiento.
    final int? espera = RegistroDePedidos.segundosDeEspera(DateTime.now());
    final bool frenada = espera != null;

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
              maxLength: ChatPantalla.maxPregunta,
              style: const TextStyle(color: grisClaro),
              decoration: InputDecoration(
                hintText: espera != null
                    ? ChatPantalla.avisoDeEspera(espera)
                    : 'Ej: ¿Cuándo es la mesa de Matemática?',
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
            // El FAB no cambia de color solo cuando esta deshabilitado: en la
            // espera lo apagamos a mano para que se note que no se puede.
            backgroundColor: frenada ? grisApagado.withValues(alpha: 0.25) : cian,
            foregroundColor: frenada ? grisApagado : azulNoche,
            // Deshabilitado mientras se manda: el doble tap crearia DOS
            // documentos de respuesta y gastaria dos veces los creditos.
            onPressed: _enviando || frenada ? null : _preguntar,
            child: _enviando
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2.5, color: azulNoche),
                  )
                : (frenada
                    ? Text('$espera', style: const TextStyle(fontWeight: FontWeight.w700))
                    : const Icon(Icons.send)),
          ),
        ],
      ),
    );
  }
}

// ============================================================================
//  LA CONVERSACION — la raiz y sus seguimientos en vivo, y la caja de abajo
//  para seguir preguntando
// ============================================================================
class ConversacionPantalla extends StatefulWidget {
  const ConversacionPantalla({
    super.key,
    required this.wsId,
    required this.miUid,
    required this.raizId,
    required this.pregunta,
    required this.preguntarAlAbrir,
    this.esAdmin = false,
  });

  final String wsId;
  final String miUid;

  /// Si quien mira es admin HOY. Solo sirve para no mostrarle a un miembro lo
  /// que es del admin (ver datosParaMostrar); no autoriza nada. El default es
  /// false a proposito: si alguien se olvida de pasarlo, la pantalla falla
  /// escondiendo, nunca mostrando de mas.
  final bool esAdmin;

  /// respId de la PRIMERA pregunta: es el id de toda la conversacion.
  final String raizId;

  /// La pregunta de la raiz, para dibujarla aunque el documento llegue vacio.
  final String pregunta;

  /// true cuando la raiz se acaba de crear: hay que disparar su POST.
  final bool preguntarAlAbrir;

  /// Los datos de una vuelta tal como se dibujan. A quien HOY no es admin se
  /// le saca chunksMirados (el total del espacio): el backend nunca se lo
  /// escribe a un miembro, pero el seed lo cargo en las preguntas viejas de
  /// Martin y de Camila, y con eso la tarjeta decia "Como sos admin..." y
  /// contaba cuantos fragmentos privados ajenos hay. Asi, aunque un documento
  /// venga mal cargado, a un miembro no le llega ni el texto de admin ni el
  /// numero. Al admin se le muestra tal cual.
  static Map<String, dynamic> datosParaMostrar(
    Map<String, dynamic> datos, {
    required bool esAdmin,
  }) {
    if (esAdmin || datos['chunksMirados'] == null) return datos;
    return <String, dynamic>{...datos, 'chunksMirados': null};
  }

  /// La vuelta de la que se cuelga la proxima pregunta: la ULTIMA 'listo'.
  ///
  /// POR QUE LA ULTIMA 'listo' Y NO LA ULTIMA A SECAS: el backend arma el
  /// historial con pregunta + respuesta de cada vuelta y rechaza
  /// (DATOS_INVALIDOS) una anterior que no este 'listo'. Si la ultima fallo y
  /// nos colgaramos de ella, la nueva fallaria tambien, y la siguiente, y la
  /// conversacion quedaria muerta para siempre. Una vuelta que fallo no tiene
  /// respuesta: no es parte del historial. En el caso normal (todo anduvo
  /// bien) la ultima 'listo' ES la ultima.
  static Vuelta? ultimaVueltaLista(List<Vuelta> vueltas) {
    for (int i = vueltas.length - 1; i >= 0; i--) {
      if (vueltas[i].estaLista) return vueltas[i];
    }
    return null;
  }

  /// Los campos EXACTOS del documento de una pregunta de seguimiento: los
  /// cuatro de siempre + conversacionId (la raiz) + anteriorRespId (la vuelta
  /// de la que se cuelga). Ni uno mas: la regla usa hasOnly, y preguntaBuscada
  /// la escribe SOLO el backend.
  ///
  /// Devuelve null si no hay ninguna vuelta 'listo' de la que colgarse (fallo
  /// la primera pregunta): el backend la rechazaria, asi que ni la creamos.
  static Map<String, Object>? camposDeSeguimiento({
    required String raizId,
    required List<Vuelta> vueltas,
    required String pregunta,
    required String miUid,
  }) {
    final Vuelta? anterior = ultimaVueltaLista(vueltas);
    if (anterior == null) return null;
    return <String, Object>{
      'pregunta': pregunta,
      'autorUid': miUid,
      'estado': 'buscando',
      'creadoEn': FieldValue.serverTimestamp(),
      'conversacionId': raizId,
      'anteriorRespId': anterior.id,
    };
  }

  /// Si la caja de abajo se habilita. Hacen falta las TRES cosas:
  ///   1) que la ULTIMA vuelta haya terminado: 'listo' o 'error', o que su
  ///      POST haya fallado antes de que el backend la tocara (conErrorLocal),
  ///      o que nunca haya llegado al servidor (Vuelta.sinSubir), o que haya
  ///      quedado colgada (Vuelta.quedoColgada). Mientras se esta
  ///      respondiendo, la pregunta nueva no tendria de que colgarse.
  ///   2) que haya alguna vuelta 'listo' de la que colgarse (si fallo la
  ///      primera pregunta no hay conversacion que seguir).
  ///   3) que no estemos en la espera de DEMASIADOS_PEDIDOS: [frenadaHasta]
  ///      es la hora del celular hasta la que el backend pidio no preguntar.
  ///      Sin esto la caja se habilitaba en el mismo instante del 429 y cada
  ///      reintento dejaba OTRA pregunta huerfana en 'buscando'.
  static bool puedeSeguirPreguntando(
    List<Vuelta> vueltas, {
    Set<String> conErrorLocal = const <String>{},
    DateTime? ahora,
    DateTime? frenadaHasta,
  }) {
    if (vueltas.isEmpty) return false;
    final DateTime momento = ahora ?? DateTime.now();
    if (frenadaHasta != null && momento.isBefore(frenadaHasta)) return false;
    final Vuelta ultima = vueltas.last;
    final bool termino = !ultima.enCurso ||
        conErrorLocal.contains(ultima.id) ||
        ultima.sinSubir ||
        ultima.quedoColgada(momento);
    return termino && ultimaVueltaLista(vueltas) != null;
  }

  /// El aviso cuando falla la query de los seguimientos. El codigo crudo
  /// ('failed-precondition', 'permission-denied') va al log, no a la pantalla.
  static String avisoSiNoCarganLosSeguimientos(Object error) {
    final String codigo = error is FirebaseException ? error.code : '';
    if (codigo == 'failed-precondition') {
      // Falta el indice compuesto, o se esta armando: Firestore tarda unos
      // minutos en dejarlo listo despues de publicarlo.
      return 'Las preguntas de seguimiento todavía se están preparando en el '
          'servidor. Probá de nuevo en unos minutos.';
    }
    if (codigo == 'permission-denied') {
      return 'No pudimos abrir el resto de esta conversación. Si sigue '
          'pasando, salí y volvé a entrar.';
    }
    return 'No pudimos cargar el resto de esta conversación. Revisá tu '
        'conexión y probá de nuevo.';
  }

  @override
  State<ConversacionPantalla> createState() => _ConversacionPantallaState();
}

class _ConversacionPantallaState extends State<ConversacionPantalla> {
  late final CollectionReference<Map<String, dynamic>> _respuestas;

  /// El documento de la raiz, creado UNA vez en initState.
  late final Stream<DocumentSnapshot<Map<String, dynamic>>> _raiz;

  /// Los seguimientos. NO es final: el boton "Reintentar" la vuelve a crear,
  /// porque un listener de Firestore que fallo no se recupera solo.
  late Stream<QuerySnapshot<Map<String, dynamic>>> _seguimientos;

  // Los errores de cada POST, las tardanzas y la hora en que salio cada
  // pregunta NO viven aca sino en RegistroDePedidos: este State se arma de
  // nuevo cada vez que se abre la conversacion, y lo que guardara se perderia
  // al salir y volver a entrar.

  final TextEditingController _texto = TextEditingController();
  final FocusNode _foco = FocusNode();
  final ScrollController _scroll = ScrollController();

  /// true mientras se crea el documento de un seguimiento (corta el doble tap,
  /// que crearia DOS preguntas y gastaria dos veces los creditos).
  bool _enviando = false;

  /// Reloj de la espera. Una vuelta que se colgo no avisa nada (justamente
  /// nadie la toca), asi que cada 20 segundos volvemos a dibujar para que la
  /// regla de Vuelta.esperaMaxima se aplique sola. Es barato: los streams NO
  /// se vuelven a crear (viven en el State), solo se rearma el arbol.
  late final Timer _reloj;

  /// Los items que citan las respuestas, leidos UNA vez por item mientras
  /// dure esta pantalla. Sin esta memoria, cada redibujo (el reloj de arriba,
  /// cada cambio de los streams) volveria a leer hasta 6 items por respuesta.
  late final LecturasDeItems _lecturas;

  @override
  void initState() {
    super.initState();
    _respuestas = FirebaseFirestore.instance
        .collection('workspaces')
        .doc(widget.wsId)
        .collection('respuestas');
    _raiz = _respuestas.doc(widget.raizId).snapshots();
    _seguimientos = _escucharSeguimientos();
    _lecturas = LecturasDeItems.deFirestore(widget.wsId);

    _reloj = Timer.periodic(const Duration(seconds: 20), (_) => _redibujar());

    // Cuando cambia algo del registro (un POST que fallo, aunque haya sido
    // desde otra pantalla de esta misma conversacion, una tardanza o la
    // cuenta regresiva de DEMASIADOS_PEDIDOS) redibujamos.
    RegistroDePedidos.cambios.addListener(_redibujar);

    if (widget.preguntarAlAbrir) {
      // No se hace await: la pantalla ya se dibuja con el estado 'buscando'
      // que dejo escrito el cliente. La respuesta llega por el stream.
      _mandarPregunta(widget.raizId, widget.pregunta);
    }
  }

  @override
  void dispose() {
    RegistroDePedidos.cambios.removeListener(_redibujar);
    _reloj.cancel();
    _texto.dispose();
    _foco.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _redibujar() {
    if (mounted) setState(() {});
  }

  /// La query de los seguimientos (la explicacion del where por autorUid y
  /// del indice esta arriba de todo, en la cabecera del archivo).
  Stream<QuerySnapshot<Map<String, dynamic>>> _escucharSeguimientos() {
    return _respuestas
        .where('autorUid', isEqualTo: widget.miUid)
        .where('conversacionId', isEqualTo: widget.raizId)
        .orderBy('creadoEn')
        .snapshots();
  }

  void _reintentarSeguimientos() {
    setState(() => _seguimientos = _escucharSeguimientos());
  }

  /// POST /preguntar de UNA vuelta (la raiz o un seguimiento: el endpoint y
  /// el body son los mismos; el backend se da cuenta de que es un seguimiento
  /// leyendo anteriorRespId en el documento).
  ///
  /// Lo que pasa se anota en RegistroDePedidos SIEMPRE, aunque la persona ya
  /// se haya ido de esta pantalla: si vuelve a entrar, la pantalla nueva lo
  /// lee de ahi. (Antes se descartaba con el chequeo de mounted y, al volver,
  /// la vuelta giraba otra vez como si nada.) El setState lo hace el aviso
  /// del registro, solo en las pantallas que siguen abiertas.
  Future<void> _mandarPregunta(String respId, String pregunta) async {
    // La hora DEL CELULAR en que sale el pedido: con esa se decide si la
    // vuelta quedo colgada, sin mezclarla con la hora del servidor.
    RegistroDePedidos.anotarMandada(respId, DateTime.now());
    try {
      final RespuestaApi r = await Api.preguntar(
        wsId: widget.wsId,
        respId: respId,
        pregunta: pregunta,
      );
      if (r.ok) return; // el stream va a mostrar el final
      if (r.sigueProcesando || r.codigo == 'PROCESO_EN_CURSO') {
        // Tardo mas de 90 s, o el backend ya la estaba procesando: NO es un
        // error. Avisamos que tarda y seguimos escuchando el documento.
        RegistroDePedidos.anotarTardanza(respId);
        return;
      }
      if (r.vaMuyRapido) {
        // Contrato N6: las cajas se apagan los segundos que diga Retry-After.
        RegistroDePedidos.frenar(r.esperarSegundos, DateTime.now());
      }
      RegistroDePedidos.anotarError(respId, r.mensaje);
      if (r.sesionVencida && mounted) {
        mostrarAviso(context, r.mensaje, esError: true);
        // Volvemos al principio: la Puerta de main.dart muestra el login ahi
        // abajo, y quedarse en esta pantalla sin sesion es mirar errores.
        Navigator.of(context).popUntil((Route<dynamic> ruta) => ruta.isFirst);
        await AuthServicio.salir();
      }
    } catch (e) {
      debugPrint('[NeuroDesk] /preguntar exploto: $e');
      RegistroDePedidos.anotarError(respId, 'No pudimos preguntar. Probá de nuevo.');
    }
  }

  /// La caja de abajo: crea el documento del seguimiento y despues hace el
  /// POST, en ese orden, igual que con la primera pregunta.
  ///
  /// [vueltas] es la conversacion tal cual se esta viendo: de ahi sale a que
  /// vuelta se cuelga la pregunta nueva.
  Future<void> _enviarSeguimiento(List<Vuelta> vueltas) async {
    if (_enviando) return;
    // La caja ya esta apagada mientras dura la espera de DEMASIADOS_PEDIDOS;
    // esto es por las dudas.
    if (RegistroDePedidos.segundosDeEspera(DateTime.now()) != null) return;

    final String texto = _texto.text.trim();
    final String? problema = ChatPantalla.validarPregunta(texto);
    if (problema != null) {
      mostrarAviso(context, problema, esError: true);
      return;
    }

    final Map<String, Object>? campos = ConversacionPantalla.camposDeSeguimiento(
      raizId: widget.raizId,
      vueltas: vueltas,
      pregunta: texto,
      miUid: widget.miUid,
    );
    if (campos == null) {
      // No deberia pasar (la caja no se habilita sin una vuelta 'listo'), pero
      // si pasa, mejor un aviso que un documento que el backend va a rechazar.
      mostrarAviso(
        context,
        'Esta conversación no tiene ninguna respuesta de la cual seguir. '
        'Volvé al chat y preguntá de nuevo.',
        esError: true,
      );
      return;
    }

    setState(() => _enviando = true);
    final ScaffoldMessengerState mensajero = ScaffoldMessenger.of(context);
    final DocumentReference<Map<String, dynamic>> ref = _respuestas.doc();
    // ANTES del set: apenas se escribe, la vuelta ya aparece en la pantalla
    // (Firestore la muestra sin esperar al servidor) y la pantalla tiene que
    // saber que la esta subiendo esta app. Si no, la confundiria con una
    // pregunta vieja que nunca llego al servidor (Vuelta.sinSubir).
    RegistroDePedidos.anotarMandada(ref.id, DateTime.now());

    try {
      await ref.set(campos).timeout(const Duration(seconds: 12));
      // Sin await, igual que con la raiz: la respuesta llega por el stream.
      // Y ANTES del chequeo de mounted: si la persona ya se fue de la
      // pantalla, el POST sale igual y la respuesta la espera cuando vuelva
      // (si no, la pregunta quedaria en 'buscando' para siempre).
      _mandarPregunta(ref.id, texto);
      if (!mounted) return;
      _texto.clear();
      _foco.unfocus(); // baja el teclado para que se vea el "Buscando..."
      _bajarAlFinal();
    } on TimeoutException {
      // Sin red, Firestore igual guarda la escritura en el telefono y la
      // muestra (por eso aparece la vuelta), pero el POST no puede salir. La
      // marcamos con su error para que no quede girando y la caja no se trabe.
      // En el registro y no en este State: vale aunque la persona ya se haya
      // ido de la pantalla y vuelva a entrar.
      RegistroDePedidos.anotarError(
        ref.id,
        'Sin conexión: esta pregunta no llegó al servidor.',
      );
      mostrarAvisoEn(
        mensajero,
        'Sin conexión: para preguntar hace falta internet.',
        esError: true,
      );
    } catch (e) {
      debugPrint('[NeuroDesk] no se pudo crear el seguimiento: $e');
      mostrarAvisoEn(
        mensajero,
        'No pudimos registrar la pregunta. Probá de nuevo.',
        esError: true,
      );
    } finally {
      if (mounted) setState(() => _enviando = false);
    }
  }

  /// "Volver a preguntar" de la ULTIMA vuelta, cuando fallo. El documento
  /// viejo queda en 'error' (el cliente no le puede cambiar el estado: allow
  /// update: if false), asi que volver a preguntar SIEMPRE es una vuelta nueva.
  void _volverAPreguntar(Vuelta vuelta, {required bool comoSeguimiento}) {
    if (!comoSeguimiento) {
      // Fallo la PRIMERA pregunta: no hay ninguna respuesta de la cual colgar
      // un seguimiento. Volvemos al chat con el texto, para hacerla de nuevo
      // como una conversacion nueva.
      Navigator.of(context).pop(vuelta.pregunta);
      return;
    }
    // Fallo un seguimiento: dejamos la pregunta escrita en la caja. Al
    // mandarla se cuelga de la ultima vuelta 'listo'.
    _texto.text = vuelta.pregunta;
    _texto.selection = TextSelection.collapsed(offset: _texto.text.length);
    _foco.requestFocus();
  }

  /// Tocar una fuente abre "Lo que leyó NeuroDesk" con la parte citada en
  /// cian. Es lo que hace verdad "citas que te llevan al ítem original".
  void _abrirFuente(Map<dynamic, dynamic> fuente) {
    final String itemId = (fuente['itemId'] ?? '').toString();
    if (itemId.isEmpty) return;
    final Object? pagina = fuente['pagina'];
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DetalleItemPantalla(
          wsId: widget.wsId,
          itemId: itemId,
          miUid: widget.miUid,
          titulo: (fuente['titulo'] ?? '').toString(),
          fragmento: (fuente['fragmento'] ?? '').toString(),
          pagina: pagina is num ? pagina.toInt() : null,
        ),
      ),
    );
  }

  /// Lleva la lista al final despues de mandar una pregunta, para que se vea
  /// la vuelta nueva con su "Buscando...". Va despues del frame porque recien
  /// ahi la lista sabe cuanto mide con la vuelta nueva adentro.
  void _bajarAlFinal() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 300),
        curve: Curves.easeOut,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: azulNoche,
        foregroundColor: grisClaro,
        title: const Text('Conversación'),
      ),
      body: SafeArea(
        // Los nombres del equipo EN VIVO, para el "de quien es" de cada
        // fuente: si el admin saca a alguien mientras esta pantalla esta
        // abierta, la fuente siguiente ya dice "(ya no está en el equipo)".
        child: EquipoEnVivo(
          wsId: widget.wsId,
          builder: (BuildContext context, NombresDelEquipo nombres) {
            return StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
              stream: _raiz,
              builder: (
                BuildContext context,
                AsyncSnapshot<DocumentSnapshot<Map<String, dynamic>>> snapshot,
              ) {
                if (snapshot.hasError) {
                  return ErrorMensaje(
                    error: snapshot.error!,
                    titulo: 'No pudimos cargar esta conversación',
                  );
                }
                if (!snapshot.hasData) {
                  return const Center(child: CircularProgressIndicator(color: cianElectrico));
                }
                final Map<String, dynamic>? datos = snapshot.data!.data();
                if (datos == null) {
                  return const VacioMensaje(
                    icono: Icons.search_off,
                    titulo: 'Esta conversación ya no existe',
                    detalle: 'Puede que la hayan borrado. Volvé al chat y preguntá de nuevo.',
                  );
                }
                return _conversacion(
                  _armarVuelta(
                    widget.raizId,
                    datos,
                    pendiente: snapshot.data!.metadata.hasPendingWrites,
                    ahora: DateTime.now(),
                    preguntaPorDefecto: widget.pregunta,
                  ),
                  DuenosDeLasFuentes(
                    miUid: widget.miUid,
                    nombres: nombres,
                    lecturas: _lecturas,
                    alAbrir: _abrirFuente,
                  ),
                );
              },
            );
          },
        ),
      ),
    );
  }

  /// La Vuelta de un documento MAS lo que sabe esta app y no esta en el
  /// documento: si todavia no llego al servidor (hasPendingWrites), a que hora
  /// del celular la mando esta app y desde cuando la esta viendo. Con eso se
  /// decide si quedo colgada sin comparar el reloj del celular con la hora
  /// del servidor (ver Vuelta.quedoColgada).
  Vuelta _armarVuelta(
    String id,
    Map<String, dynamic> datos, {
    required bool pendiente,
    required DateTime ahora,
    String preguntaPorDefecto = '',
  }) {
    return Vuelta.desdeDatos(
      id,
      ConversacionPantalla.datosParaMostrar(datos, esAdmin: widget.esAdmin),
      preguntaPorDefecto: preguntaPorDefecto,
      pendienteDeSubir: pendiente,
      mandadaEn: RegistroDePedidos.mandadaEn[id],
      vistaDesde: RegistroDePedidos.vistaPorPrimeraVez(id, ahora),
    );
  }

  /// La conversacion ya con la raiz cargada: la raiz + los seguimientos (en el
  /// orden de creadoEn) + la caja de abajo. [duenos] es lo que necesitan las
  /// fuentes para decir de quien son y abrirse.
  Widget _conversacion(Vuelta raiz, DuenosDeLasFuentes duenos) {
    return StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
      stream: _seguimientos,
      builder: (
        BuildContext context,
        AsyncSnapshot<QuerySnapshot<Map<String, dynamic>>> snapshot,
      ) {
        final DateTime ahora = DateTime.now();
        final List<Vuelta> vueltas = <Vuelta>[raiz];
        String? avisoDeCarga;

        // 'waiting' = todavia no llego nada de ESTE stream. Se mira primero
        // porque, al tocar "Reintentar", el StreamBuilder conserva el error
        // del stream viejo hasta que el nuevo contesta: sin esto el aviso
        // seguiria ahi y no se veria que esta cargando de nuevo.
        // Mientras espera, se dibuja la raiz sola con un spinner abajo.
        final bool esperando = snapshot.connectionState == ConnectionState.waiting;

        if (!esperando && snapshot.hasError) {
          // Sin la query igual se ve la raiz: la pantalla no se cae entera
          // porque falte el indice nuevo o no esten publicadas las reglas.
          debugPrint('[NeuroDesk] no cargaron los seguimientos: ${snapshot.error}');
          avisoDeCarga =
              ConversacionPantalla.avisoSiNoCarganLosSeguimientos(snapshot.error!);
        } else if (!esperando && snapshot.hasData) {
          for (final QueryDocumentSnapshot<Map<String, dynamic>> doc
              in snapshot.data!.docs) {
            // La raiz nunca tiene conversacionId; si alguien se lo cargara a
            // mano desde la consola, igual no la dibujamos dos veces.
            if (doc.id == raiz.id) continue;
            vueltas.add(
              _armarVuelta(
                doc.id,
                doc.data(),
                pendiente: doc.metadata.hasPendingWrites,
                ahora: ahora,
              ),
            );
          }
        }
        // Mientras no sepamos cuales son TODAS las vueltas no se puede seguir:
        // la pregunta nueva se colgaria de una que quizas no es la ultima.
        final bool cargoTodo = !esperando && !snapshot.hasError && snapshot.hasData;

        final Set<String> conErrorLocal = RegistroDePedidos.errores.keys.toSet();
        final int? espera = RegistroDePedidos.segundosDeEspera(ahora);
        final bool hayDeDondeColgarse =
            ConversacionPantalla.ultimaVueltaLista(vueltas) != null;
        final bool puedeSeguir = cargoTodo &&
            ConversacionPantalla.puedeSeguirPreguntando(
              vueltas,
              conErrorLocal: conErrorLocal,
              ahora: ahora,
              frenadaHasta: RegistroDePedidos.frenadaHasta,
            );

        final Vuelta ultima = vueltas.last;
        final bool ultimaFallo = ultima.fallo ||
            (ultima.enCurso &&
                (conErrorLocal.contains(ultima.id) ||
                    ultima.sinSubir ||
                    ultima.quedoColgada(ahora)));

        final List<Widget> hijos = <Widget>[];
        for (int i = 0; i < vueltas.length; i++) {
          final Vuelta vuelta = vueltas[i];
          final bool esLaUltima = i == vueltas.length - 1;
          if (i > 0) hijos.add(const Divider(height: 40, color: superficie));
          hijos.add(
            TarjetaDeVuelta(
              vuelta: vuelta,
              errorDelPedido: RegistroDePedidos.errores[vuelta.id],
              tardando: RegistroDePedidos.tardando.contains(vuelta.id),
              colgada: vuelta.quedoColgada(ahora),
              duenos: duenos,
              // "Volver a preguntar" solo en la ULTIMA y solo si fallo: en una
              // del medio no tiene sentido, la charla ya siguio despues.
              alVolverAPreguntar: esLaUltima && ultimaFallo && !_enviando
                  ? () => _volverAPreguntar(vuelta, comoSeguimiento: hayDeDondeColgarse)
                  : null,
            ),
          );
        }
        if (avisoDeCarga != null) {
          hijos.add(
            _AvisoDeSeguimientos(
              texto: avisoDeCarga,
              alReintentar: _reintentarSeguimientos,
            ),
          );
        } else if (!cargoTodo) {
          hijos.add(
            const Padding(
              padding: EdgeInsets.only(top: 24),
              child: Center(
                child: SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2.5, color: cianElectrico),
                ),
              ),
            ),
          );
        }

        // El texto gris de la caja dice POR QUE no se puede escribir todavia.
        final String pista;
        if (avisoDeCarga != null) {
          pista = 'Esta conversación no se puede seguir por ahora';
        } else if (!cargoTodo) {
          pista = 'Cargando la conversación…';
        } else if (espera != null) {
          pista = ChatPantalla.avisoDeEspera(espera);
        } else if (!puedeSeguir && !_enviando) {
          pista = 'Esperá a que termine la respuesta…';
        } else {
          pista = CajaDeSeguimiento.textoDeLaCaja;
        }

        return Column(
          children: <Widget>[
            Expanded(
              child: ListView(
                controller: _scroll,
                padding: const EdgeInsets.all(16),
                children: hijos,
              ),
            ),
            // Si fallo la PRIMERA pregunta no hay de donde seguir: el camino es
            // el "Volver a preguntar" de la raiz, y la caja ni se muestra.
            if (hayDeDondeColgarse || !ultimaFallo)
              CajaDeSeguimiento(
                controlador: _texto,
                foco: _foco,
                habilitada: puedeSeguir && !_enviando,
                enviando: _enviando,
                segundosDeEspera: espera,
                pista: pista,
                alEnviar: () => _enviarSeguimiento(vueltas),
              ),
          ],
        );
      },
    );
  }
}

// ============================================================================
//  UNA VUELTA — una pregunta de la conversacion y lo que contesto la IA
// ============================================================================

/// Un documento de respuestas ya leido, con default para cada campo: un
/// documento cargado a mano desde la consola, o escrito por una version vieja
/// de la app, no puede romper la pantalla.
class Vuelta {
  const Vuelta({
    required this.id,
    required this.pregunta,
    required this.estado,
    this.respuesta = '',
    this.errorMsg = '',
    this.confianza = '',
    this.fuentes = const <dynamic>[],
    this.chunksVisibles,
    this.chunksMirados,
    this.preguntaBuscada,
    this.creadoEn,
    this.pendienteDeSubir = false,
    this.mandadaEn,
    this.vistaDesde,
  });

  /// [pendienteDeSubir], [mandadaEn] y [vistaDesde] NO salen del documento:
  /// los sabe la app (ver _ConversacionPantallaState._armarVuelta).
  factory Vuelta.desdeDatos(
    String id,
    Map<String, dynamic> d, {
    String preguntaPorDefecto = '',
    bool pendienteDeSubir = false,
    DateTime? mandadaEn,
    DateTime? vistaDesde,
  }) {
    final String pregunta = (d['pregunta'] ?? '').toString();
    final Object? fuentes = d['fuentes'];
    final Object? buscada = d['preguntaBuscada'];
    final Object? creado = d['creadoEn'];
    return Vuelta(
      id: id,
      pregunta: pregunta.isEmpty ? preguntaPorDefecto : pregunta,
      estado: (d['estado'] ?? 'buscando').toString(),
      respuesta: (d['respuesta'] ?? '').toString(),
      errorMsg: (d['errorMsg'] ?? '').toString(),
      confianza: (d['confianza'] ?? '').toString(),
      fuentes: fuentes is List ? fuentes : const <dynamic>[],
      chunksVisibles: d['chunksVisibles'],
      chunksMirados: d['chunksMirados'],
      preguntaBuscada:
          buscada is String && buscada.trim().isNotEmpty ? buscada.trim() : null,
      // Mientras el servidor no confirma la escritura, el serverTimestamp
      // llega en null (escritura optimista): ahi no sabemos la hora todavia.
      creadoEn: creado is Timestamp ? creado.toDate() : null,
      pendienteDeSubir: pendienteDeSubir,
      mandadaEn: mandadaEn,
      vistaDesde: vistaDesde,
    );
  }

  /// Cuanto puede estar una vuelta en 'buscando' o 'redactando' antes de que
  /// la demos por perdida.
  ///
  /// POR QUE HACE FALTA: si se corta la red justo despues de crear el
  /// documento, o el servidor se reinicia en el medio, la vuelta se queda en
  /// 'buscando' para siempre (nadie la va a tocar). Sin esta regla la caja de
  /// abajo quedaria deshabilitada para siempre y la conversacion, muerta.
  /// POR QUE 3 MINUTOS: la app corta el pedido a los 90 s y el backend tiene
  /// sus propios timeouts de IA; si a los 3 minutos sigue sin terminar, ya
  /// nadie la esta procesando.
  static const Duration esperaMaxima = Duration(minutes: 3);

  /// Margen para cuando NO queda otra que comparar la hora del SERVIDOR
  /// (creadoEn) con el reloj del CELULAR: un celular con la hora puesta a
  /// mano puede estar corrido varios minutos. Ver quedoColgada.
  static const Duration margenDelReloj = Duration(minutes: 10);

  final String id;
  final String pregunta;

  /// buscando | redactando | listo | error
  final String estado;

  final String respuesta;
  final String errorMsg;

  /// 'alta' | 'media' | 'baja' (STRING, igual en el modelo y en el contrato).
  final String confianza;

  final List<dynamic> fuentes;
  final Object? chunksVisibles;

  /// null cuando quien pregunto no es admin.
  final Object? chunksMirados;

  /// La pregunta reescrita con la que busco el backend. null en una primera
  /// pregunta o si la reformulacion fallo y se uso el respaldo.
  final String? preguntaBuscada;

  /// Hora del SERVIDOR (el serverTimestamp que exige la regla).
  final DateTime? creadoEn;

  /// true si el documento todavia no llego al servidor: Firestore lo muestra
  /// desde el celular (escritura pendiente, por ejemplo sin red).
  final bool pendienteDeSubir;

  /// Hora DEL CELULAR en que esta app mando esta pregunta. null si no la
  /// mando esta app abierta (se cerro y se volvio a abrir, o la hizo otro
  /// celular con la misma cuenta).
  final DateTime? mandadaEn;

  /// Hora DEL CELULAR en que esta app vio este documento por primera vez.
  final DateTime? vistaDesde;

  bool get estaLista => estado == 'listo';
  bool get fallo => estado == 'error';
  bool get enCurso => estado == 'buscando' || estado == 'redactando';

  /// En curso, pero NUNCA llego al servidor y no la esta subiendo esta app:
  /// se hizo sin red y despues se cerro la app. El POST no va a salir nunca
  /// (lo manda solo la pantalla que la creo), asi que no hay que esperarla:
  /// ni spinner eterno ni caja trabada mientras dure la falta de red.
  bool get sinSubir => enCurso && pendienteDeSubir && mandadaEn == null;

  /// true si sigue en curso pero ya nadie la esta respondiendo.
  ///
  /// UN SOLO RELOJ SIEMPRE QUE SE PUEDA. creadoEn es la hora del SERVIDOR y
  /// [ahora] la del CELULAR. Si el celular esta adelantado 4 minutos,
  /// comparar esas dos daba por colgada una pregunta recien hecha: aparecia
  /// "quedó sin respuesta", se habilitaba la caja y una pregunta nueva se
  /// colgaba de la MISMA anterior que la vuelta que se seguia respondiendo
  /// (la conversacion se partia en dos). Por eso, en este orden:
  ///   1) si la mando esta app, se mide desde [mandadaEn]: celular contra
  ///      celular, el desfasaje no importa;
  ///   2) si no, desde que esta app la vio por primera vez ([vistaDesde]),
  ///      tambien con el reloj del celular: como mucho se la espera
  ///      [esperaMaxima] desde que se abre la conversacion;
  ///   3) la hora del servidor, solo para lo que es viejo seguro: creada hace
  ///      mas de [esperaMaxima] + [margenDelReloj]. Asi una pregunta de ayer
  ///      que quedo colgada no gira 3 minutos cada vez que se abre la app.
  /// Sin ninguna hora (todavia no la confirmo el servidor) se la sigue
  /// esperando.
  bool quedoColgada(DateTime ahora) {
    if (!enCurso) return false;
    final DateTime? mandada = mandadaEn;
    if (mandada != null) return ahora.difference(mandada) > esperaMaxima;
    final DateTime? vista = vistaDesde;
    if (vista != null && ahora.difference(vista) > esperaMaxima) return true;
    final DateTime? creada = creadoEn;
    return creada != null && ahora.difference(creada) > esperaMaxima + margenDelReloj;
  }

  /// La pregunta reescrita, SOLO si dice algo distinto de lo que escribio la
  /// persona (si son iguales, mostrarla dos veces es ruido).
  String? get comoLaEntendio {
    final String? buscada = preguntaBuscada;
    if (buscada == null) return null;
    return buscada.toLowerCase() == pregunta.trim().toLowerCase() ? null : buscada;
  }
}

/// Una vuelta dibujada: la pregunta, el progreso o el error, y la respuesta
/// con su chip de confianza y sus fuentes. Es lo que antes era toda la
/// pantalla "Respuesta", ahora una vez por cada pregunta de la conversacion.
///
/// Es publica y recibe la Vuelta ya leida (no el documento) para poder
/// probarla en la compu sin Firebase.
class TarjetaDeVuelta extends StatelessWidget {
  const TarjetaDeVuelta({
    super.key,
    required this.vuelta,
    this.errorDelPedido,
    this.tardando = false,
    this.colgada = false,
    this.alVolverAPreguntar,
    this.duenos,
  });

  /// true si esta vuelta la respondio el backend para un ADMIN: chunksMirados
  /// lo escribe el backend SOLO cuando pregunto un admin (a un miembro no se
  /// le dice cuanto hay en total, porque eso revela cuanto contenido privado
  /// ajeno existe). Ademas, la conversacion se lo saca a la vuelta si quien
  /// mira HOY no es admin (ConversacionPantalla.datosParaMostrar): un dato mal
  /// cargado no alcanza para que un miembro vea el texto de admin.
  static bool preguntoUnAdmin(Vuelta v) => v.chunksMirados != null;

  /// Con que se respondio. Es lo que hace que un "no encontré" de un miembro
  /// se lea como lo que es (privacidad) y no como una falla de la IA.
  static String alcance(Vuelta v) => preguntoUnAdmin(v)
      ? 'Como sos admin, busqué en todo el espacio, incluido lo privado de cada uno.'
      : 'Respondido solo con lo que vos podés ver.';

  /// Una pregunta sin fuentes no se pierde: el admin la ve en "Lo que falta"
  /// del panel (el Radar), agrupada con las demas que nadie pudo contestar.
  static String avisoSinFuentes(Vuelta v) => preguntoUnAdmin(v)
      ? 'Quedó anotada en "Lo que falta", en el panel: desde ahí podés cargar '
          'la respuesta para el equipo.'
      : 'Quedó anotada para el administrador del equipo, así sabe qué falta cargar.';

  /// Los dos numeros del filtro, que solo ve el admin, SIN contradecirse.
  ///
  /// Antes decia "Miré 40 fragmentos y pude usar 40: el resto es privado de
  /// otras personas", y no habia ningun resto: el admin puede usar todo. Ahora
  /// se dice el numero solo, y "el resto" aparece solo si de verdad quedo
  /// algo afuera (fragmentos de un item que ya no esta). null = no mostrar.
  static String? numerosDelFiltro(Vuelta v) {
    final Object? mirados = v.chunksMirados;
    if (mirados is! num) return null;
    final int total = mirados.toInt();
    if (total <= 0) return 'Todavía no hay nada cargado en el espacio.';
    final Object? visibles = v.chunksVisibles;
    if (visibles is! num || visibles.toInt() >= total) {
      return total == 1
          ? 'Miré el único fragmento del espacio.'
          : 'Miré los $total fragmentos del espacio.';
    }
    return 'Miré $total fragmentos del espacio y pude usar ${visibles.toInt()}: '
        'los demás son de contenido que ya no está disponible.';
  }

  final Vuelta vuelta;

  /// Mensaje del POST cuando fallo ANTES de que el backend escribiera errorMsg.
  final String? errorDelPedido;

  /// El POST corto por tiempo (SIGUE_PROCESANDO) y el backend puede seguir.
  final bool tardando;

  /// Vuelta.quedoColgada dio true: sigue en curso pero ya nadie la responde.
  final bool colgada;

  /// null = sin boton "Volver a preguntar".
  final VoidCallback? alVolverAPreguntar;

  /// Lo que necesitan las fuentes para decir de quien son y abrirse. null en
  /// los tests sin Firebase: ahi las fuentes se dibujan sin dueno.
  final DuenosDeLasFuentes? duenos;

  /// Que error mostrar, o null si no hay ninguno. El ORDEN importa:
  ///   1) 'listo' gana siempre: si el backend termino bien, un POST que se
  ///      corto por la red ya no importa.
  ///   2) 'error' del documento: su errorMsg gana sobre el del POST, porque lo
  ///      escribio el backend sabiendo que paso de verdad.
  ///   3) sigue en curso pero el POST fallo, nunca llego al servidor, o quedo
  ///      colgada.
  String? get _error {
    if (vuelta.fallo) {
      return vuelta.errorMsg.isNotEmpty
          ? vuelta.errorMsg
          : (errorDelPedido ?? 'No pudimos responder.');
    }
    if (!vuelta.enCurso) return null;
    if (errorDelPedido != null) return errorDelPedido;
    if (vuelta.sinSubir) {
      return 'Sin conexión: esta pregunta todavía no llegó al servidor.';
    }
    if (colgada) {
      return 'Esta pregunta quedó sin respuesta: se cortó en el camino '
          '(sin conexión o el servidor se reinició).';
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    final String? error = _error;
    final String? comoLaEntendio = vuelta.comoLaEntendio;
    final String? numeros = numerosDelFiltro(vuelta);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        // --- la pregunta ----------------------------------------------------
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: azulRoyal.withValues(alpha: 0.18),
            borderRadius: BorderRadius.circular(14),
          ),
          child: Text(
            vuelta.pregunta,
            style: const TextStyle(
              color: grisClaro,
              fontSize: 16,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),

        // --- como la entendio -----------------------------------------------
        // Solo en los seguimientos reformulados. Explica por que la IA
        // encontro lo que encontro: "¿y para cuando?" se busco como una
        // pregunta completa, con el tema de la charla adentro.
        if (comoLaEntendio != null) ...<Widget>[
          const SizedBox(height: 8),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Icon(Icons.manage_search, size: 16, color: grisApagado),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  'La entendí como: "$comoLaEntendio"',
                  style: const TextStyle(
                    color: grisApagado,
                    fontSize: 12.5,
                    fontStyle: FontStyle.italic,
                  ),
                ),
              ),
            ],
          ),
        ],
        const SizedBox(height: 18),

        // --- el progreso en vivo --------------------------------------------
        if (vuelta.enCurso && error == null) ...<Widget>[
          _Progreso(estado: vuelta.estado),
          if (tardando) ...<Widget>[
            const SizedBox(height: 10),
            const Text(
              'Está tardando más de lo normal. La respuesta va a aparecer sola '
              'cuando termine.',
              style: TextStyle(color: grisApagado, fontSize: 13),
            ),
          ],
        ],

        // --- el error -------------------------------------------------------
        if (error != null) ...<Widget>[
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: colorError.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Text(error, style: const TextStyle(color: colorError)),
          ),
          if (alVolverAPreguntar != null) ...<Widget>[
            const SizedBox(height: 12),
            FilledButton.icon(
              style: FilledButton.styleFrom(
                backgroundColor: cian,
                foregroundColor: azulNoche,
              ),
              onPressed: alVolverAPreguntar,
              icon: const Icon(Icons.refresh),
              label: const Text('Volver a preguntar'),
            ),
          ],
        ],

        // --- la respuesta ---------------------------------------------------
        if (vuelta.estaLista) ...<Widget>[
          // Sin fuentes no hay de que estar "seguro": el chip rojo de
          // "Confianza baja" al lado de un "no encontré" hacia parecer que
          // la IA andaba mal, cuando en realidad hizo lo correcto.
          if (vuelta.confianza.isNotEmpty && vuelta.fuentes.isNotEmpty)
            _ChipDeConfianza(confianza: vuelta.confianza),
          const SizedBox(height: 10),
          SelectableText(
            vuelta.respuesta.isEmpty
                ? 'No encontré esto en la base del equipo.'
                : vuelta.respuesta,
            style: const TextStyle(color: grisClaro, fontSize: 16, height: 1.5),
          ),
          const SizedBox(height: 12),

          // Con que se respondio: el filtro de permisos dicho como lo que es,
          // una virtud. Va en TODAS las respuestas, no solo en las vacias.
          _NotaChica(
            icono: preguntoUnAdmin(vuelta)
                ? Icons.admin_panel_settings_outlined
                : Icons.lock_person_outlined,
            texto: alcance(vuelta),
          ),

          if (vuelta.fuentes.isEmpty) ...<Widget>[
            const SizedBox(height: 8),
            _NotaChica(icono: Icons.flag_outlined, texto: avisoSinFuentes(vuelta)),
          ] else ...<Widget>[
            const SizedBox(height: 22),
            const Text(
              'De dónde lo saqué',
              style: TextStyle(
                color: grisClaro,
                fontSize: 15,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 10),
            for (final dynamic f in vuelta.fuentes) _Fuente(datos: f, duenos: duenos),
          ],

          // Los numeros del filtro, solo para el admin (el backend no se los
          // da a un miembro). Van por vuelta porque en cada vuelta el backend
          // vuelve a filtrar en vivo.
          if (numeros != null) ...<Widget>[
            const SizedBox(height: 16),
            Text(numeros, style: const TextStyle(color: grisApagado, fontSize: 12)),
          ],
        ],
      ],
    );
  }
}

/// La caja de abajo de la conversacion: "Preguntá algo más sobre esto…".
///
/// Es un widget aparte (y publico) para poder probarlo sin Firebase: el test
/// la arma deshabilitada y verifica que no se pueda escribir ni mandar.
class CajaDeSeguimiento extends StatelessWidget {
  const CajaDeSeguimiento({
    super.key,
    required this.controlador,
    required this.habilitada,
    required this.alEnviar,
    this.foco,
    this.enviando = false,
    this.segundosDeEspera,
    this.pista = textoDeLaCaja,
  });

  static const String textoDeLaCaja = 'Preguntá algo más sobre esto…';

  final TextEditingController controlador;

  /// false mientras la ultima vuelta no termino: no se puede escribir NI
  /// mandar (una pregunta nueva no tendria de que vuelta colgarse).
  final bool habilitada;

  final VoidCallback alEnviar;
  final FocusNode? foco;

  /// true mientras se crea el documento: el boton muestra un spinner.
  final bool enviando;

  /// Segundos que faltan de la espera de DEMASIADOS_PEDIDOS, o null. El
  /// boton muestra la cuenta regresiva: se ve aunque la caja tenga texto (la
  /// pista gris solo se ve con la caja vacia).
  final int? segundosDeEspera;

  /// El texto gris de adentro de la caja.
  final String pista;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
      color: superficie,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: <Widget>[
          Expanded(
            child: TextField(
              controller: controlador,
              focusNode: foco,
              enabled: habilitada,
              maxLines: 4,
              minLines: 1,
              maxLength: ChatPantalla.maxPregunta,
              style: const TextStyle(color: grisClaro),
              decoration: InputDecoration(
                hintText: pista,
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
          // IconButton y no FloatingActionButton: el FAB no cambia de color
          // cuando esta deshabilitado, y aca la persona TIENE que ver que
          // todavia no puede mandar.
          IconButton.filled(
            tooltip: 'Enviar',
            style: IconButton.styleFrom(
              backgroundColor: cian,
              foregroundColor: azulNoche,
              disabledBackgroundColor: grisApagado.withValues(alpha: 0.25),
              disabledForegroundColor: grisApagado,
            ),
            onPressed: habilitada ? alEnviar : null,
            icon: enviando
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2.5, color: grisClaro),
                  )
                : (segundosDeEspera != null
                    ? Text(
                        '$segundosDeEspera',
                        style: const TextStyle(fontWeight: FontWeight.w700),
                      )
                    : const Icon(Icons.send)),
          ),
        ],
      ),
    );
  }
}

// ============================================================================
//  LO QUE LA APP RECUERDA DE CADA PREGUNTA MIENTRAS ESTA ABIERTA
// ============================================================================

/// Lo que paso con cada POST a /preguntar, guardado mientras la app este
/// abierta y NO mientras dure una pantalla.
///
/// POR QUE: cada vez que se abre una conversacion desde el historial se arma
/// un State nuevo, y lo que guardaba el anterior se pierde. Un POST que fallo
/// ANTES de que el backend tocara el documento (sin red, backend caido,
/// DEMASIADOS_PEDIDOS, NO_ES_MIEMBRO) deja la vuelta en 'buscando' para
/// siempre en Firestore. Cuando esto vivia en el State, al salir y volver a
/// entrar la persona veia otra vez "Buscando..." con el spinner, el error ya
/// no estaba y la caja de abajo quedaba trabada.
///
/// Son mapas static porque los respId son unicos (los genera Firestore): no
/// se pisan entre conversaciones ni entre espacios de trabajo. No es un
/// gestor de estado: las pantallas abiertas escuchan [cambios] y se
/// redibujan con setState, como siempre. Si se cierra la app se pierde, y
/// para eso estan Vuelta.sinSubir y la regla de Vuelta.quedoColgada.
class RegistroDePedidos {
  RegistroDePedidos._();

  /// respId -> mensaje del POST que fallo ANTES de que el backend escribiera
  /// errorMsg. Si el backend si lo escribio, gana el del documento: el
  /// contrato dice que no se muestra dos veces el mismo error con palabras
  /// distintas.
  static final Map<String, String> errores = <String, String>{};

  /// respIds cuyo POST corto por tiempo (SIGUE_PROCESANDO) o que el backend
  /// ya estaba procesando (PROCESO_EN_CURSO). No es un error: el documento
  /// avisa como termina.
  static final Set<String> tardando = <String>{};

  /// respId -> hora DEL CELULAR en que esta app mando la pregunta.
  static final Map<String, DateTime> mandadaEn = <String, DateTime>{};

  /// respId -> hora DEL CELULAR en que esta app vio el documento la primera
  /// vez.
  static final Map<String, DateTime> _vistaDesde = <String, DateTime>{};

  /// Hora DEL CELULAR hasta la que el backend pidio no preguntar
  /// (DEMASIADOS_PEDIDOS con su Retry-After). null = se puede preguntar.
  static DateTime? frenadaHasta;

  /// Avisa a las pantallas abiertas que algo de aca cambio.
  static final ValueNotifier<int> cambios = ValueNotifier<int>(0);

  /// El tic de un segundo de la cuenta regresiva; vive solo mientras dura.
  static Timer? _cuentaRegresiva;

  /// Si el 429 llega sin Retry-After, 20 s: lo mismo que manda el backend
  /// cuando el que nos limita es Google (RETRY_AFTER_IA_SEG en preguntar.js).
  static const int esperaSiNoDiceCuanto = 20;

  /// Tope por si llega un Retry-After absurdo: el limite del backend es por
  /// minuto, asi que una espera de mas de 2 minutos nunca es real.
  static const int topeDeEspera = 120;

  /// Sin avisar a nadie: se llama desde initState (con la pantalla todavia
  /// armandose) y no cambia nada de lo que se ve.
  static void anotarMandada(String respId, DateTime ahora) {
    mandadaEn[respId] = ahora;
  }

  /// La primera vez anota [ahora]; despues devuelve siempre esa misma hora.
  /// Sin avisar a nadie: se llama mientras se dibuja la conversacion.
  static DateTime vistaPorPrimeraVez(String respId, DateTime ahora) {
    return _vistaDesde.putIfAbsent(respId, () => ahora);
  }

  static void anotarError(String respId, String mensaje) {
    errores[respId] = mensaje;
    _avisar();
  }

  static void anotarTardanza(String respId) {
    tardando.add(respId);
    _avisar();
  }

  /// DEMASIADOS_PEDIDOS: no se puede preguntar durante [segundos] (el
  /// Retry-After que mando el backend), contados desde [ahora].
  static void frenar(int? segundos, DateTime ahora) {
    final int pedidos = segundos ?? esperaSiNoDiceCuanto;
    final int espera = pedidos < 1 ? 1 : (pedidos > topeDeEspera ? topeDeEspera : pedidos);
    final DateTime hasta = ahora.add(Duration(seconds: espera));
    final DateTime? antes = frenadaHasta;
    // Si ya habia una espera mas larga en curso, no se acorta.
    if (antes == null || hasta.isAfter(antes)) frenadaHasta = hasta;

    // Un tic por segundo para que las cajas muestren la cuenta regresiva y se
    // vuelvan a habilitar solas cuando termina.
    _cuentaRegresiva?.cancel();
    _cuentaRegresiva = Timer.periodic(const Duration(seconds: 1), (Timer tic) {
      if (segundosDeEspera(DateTime.now()) == null) {
        frenadaHasta = null;
        tic.cancel();
        _cuentaRegresiva = null;
      }
      _avisar();
    });
    _avisar();
  }

  /// Cuantos segundos faltan para poder preguntar, o null si no hay espera.
  static int? segundosDeEspera(DateTime ahora) {
    final DateTime? hasta = frenadaHasta;
    if (hasta == null || !ahora.isBefore(hasta)) return null;
    // Redondeado para arriba: con medio segundo por delante todavia no se
    // puede, y "esperá 0 segundos" no tendria sentido.
    return (hasta.difference(ahora).inMilliseconds / 1000).ceil();
  }

  static void _avisar() => cambios.value++;

  /// Solo para los tests: cada uno arranca con el registro vacio.
  @visibleForTesting
  static void olvidarTodo() {
    errores.clear();
    tardando.clear();
    mandadaEn.clear();
    _vistaDesde.clear();
    frenadaHasta = null;
    _cuentaRegresiva?.cancel();
    _cuentaRegresiva = null;
  }
}

/// El aviso cuando no carga la query de los seguimientos (por ejemplo, el
/// indice nuevo todavia no esta publicado). La raiz se sigue viendo arriba.
class _AvisoDeSeguimientos extends StatelessWidget {
  const _AvisoDeSeguimientos({required this.texto, required this.alReintentar});

  final String texto;
  final VoidCallback alReintentar;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 20),
      padding: const EdgeInsets.fromLTRB(14, 14, 14, 6),
      decoration: BoxDecoration(
        color: colorProcesando.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: colorProcesando.withValues(alpha: 0.4)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              const Icon(Icons.info_outline, size: 18, color: colorProcesando),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  texto,
                  style: const TextStyle(color: colorProcesando, fontSize: 13.5),
                ),
              ),
            ],
          ),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              style: TextButton.styleFrom(foregroundColor: cianElectrico),
              onPressed: alReintentar,
              icon: const Icon(Icons.refresh, size: 18),
              label: const Text('Reintentar'),
            ),
          ),
        ],
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

/// Lo que necesita una fuente para decir de quien es y abrirse: quien mira,
/// los nombres del equipo (en vivo), la memoria de items leidos y que hacer
/// al tocarla. Va en un solo objeto para no pasar cuatro cosas por cada
/// vuelta, y es publico para poder armarlo en los tests con una lectura de
/// mentira (sin Firebase).
class DuenosDeLasFuentes {
  const DuenosDeLasFuentes({
    required this.miUid,
    required this.nombres,
    required this.lecturas,
    required this.alAbrir,
  });

  final String miUid;
  final NombresDelEquipo nombres;
  final LecturasDeItems lecturas;

  /// Abre "Lo que leyó NeuroDesk" con esa fuente (el mapa de fuentes[]).
  final void Function(Map<dynamic, dynamic> fuente) alAbrir;
}

/// Una cita: [n] titulo, pagina, de quien es y el fragmento exacto que uso
/// la IA. Si hay [duenos], se puede tocar y abre el item.
class _Fuente extends StatelessWidget {
  const _Fuente({required this.datos, this.duenos});

  final dynamic datos;
  final DuenosDeLasFuentes? duenos;

  @override
  Widget build(BuildContext context) {
    // Lo que viene de Firestore es dynamic: si no es un mapa, no lo dibujamos
    // en vez de romper la pantalla entera.
    if (datos is! Map) return const SizedBox.shrink();
    final Map<dynamic, dynamic> f = datos as Map<dynamic, dynamic>;

    final String titulo = (f['titulo'] ?? 'Sin título').toString();
    final String fragmento = (f['fragmento'] ?? '').toString();
    final String itemId = (f['itemId'] ?? '').toString();
    final Object? pagina = f['pagina'];
    final Object? n = f['n'];
    // null = esta fuente no se puede abrir: los tests sin Firebase, o una
    // respuesta sin itemId (muy vieja o cargada a mano).
    final DuenosDeLasFuentes? d = itemId.isEmpty ? null : duenos;

    final Widget contenido = Padding(
      padding: const EdgeInsets.all(12),
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
                  'pág. $pagina',
                  style: const TextStyle(color: grisApagado, fontSize: 12),
                ),
              // La flechita dice "esto se toca" sin tener que explicarlo.
              if (d != null) const Icon(Icons.chevron_right, size: 20, color: cianElectrico),
            ],
          ),
          if (d != null) ...<Widget>[
            const SizedBox(height: 6),
            _LineaDelDueno(itemId: itemId, duenos: d),
          ],
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

    // Material + InkWell para que toda la tarjeta se pueda tocar con el
    // efecto de onda (un Container con color taparia la onda).
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: superficie,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: cian.withValues(alpha: 0.3)),
        ),
        child: d == null ? contenido : InkWell(onTap: () => d.alAbrir(f), child: contenido),
      ),
    );
  }
}

/// "Valentino Mattio · 24/08 · Del equipo" debajo del titulo de una fuente.
///
/// Lee el item UNA vez (LecturasDeItems guarda la lectura): la conversacion se
/// redibuja sola cada tanto y no tiene que volver a pedirlo. Si ya estaba
/// leido, se dibuja directo, sin un cuadro de "cargando" (initialData).
class _LineaDelDueno extends StatelessWidget {
  const _LineaDelDueno({required this.itemId, required this.duenos});

  final String itemId;
  final DuenosDeLasFuentes duenos;

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<LecturaDeItem>(
      future: duenos.lecturas.leer(itemId),
      initialData: duenos.lecturas.yaLeida(itemId),
      builder: (BuildContext context, AsyncSnapshot<LecturaDeItem> snapshot) {
        final LecturaDeItem? lectura = snapshot.data;
        // Mientras se lee, o si fallo la red: la fuente se ve igual, sin la
        // linea. Nunca un error rojo por un dato que es de adorno.
        if (lectura == null || lectura.fallo) return const SizedBox.shrink();
        if (lectura.sinAcceso) {
          // La respuesta es vieja: despues de responderla, el item se borro o
          // su autor lo paso a privado. La respuesta queda; el item ya no.
          return const _NotaChica(
            icono: Icons.lock_outline,
            texto: 'Ya no tenés acceso a esta fuente',
          );
        }
        final Map<String, dynamic> item = lectura.datos!;
        final bool privado = (item['visibilidad'] ?? 'privado').toString() != 'equipo';
        return _NotaChica(
          icono: privado ? Icons.lock : Icons.groups,
          texto: etiquetaDelDueno(item: item, miUid: duenos.miUid, nombres: duenos.nombres),
          color: privado ? colorProcesando : grisApagado,
        );
      },
    );
  }
}

/// Un renglon chico con icono: las notas grises de abajo de una respuesta.
class _NotaChica extends StatelessWidget {
  const _NotaChica({required this.icono, required this.texto, this.color = grisApagado});

  final IconData icono;
  final String texto;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.only(top: 1),
          child: Icon(icono, size: 15, color: color),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: Text(texto, style: TextStyle(color: color, fontSize: 12.5)),
        ),
      ],
    );
  }
}

/// La linea fija de abajo del historial: quien mas puede ver las preguntas.
/// Publica para probarla sin Firebase.
class AvisoDelHistorial extends StatelessWidget {
  const AvisoDelHistorial({super.key, required this.texto});

  final String texto;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: azulNoche,
      padding: const EdgeInsets.fromLTRB(16, 6, 16, 6),
      child: _NotaChica(icono: Icons.visibility_outlined, texto: texto),
    );
  }
}
