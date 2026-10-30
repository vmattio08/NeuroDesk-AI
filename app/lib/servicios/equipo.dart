// ============================================================================
//  equipo.dart — de QUIEN es cada cosa: los nombres del equipo y la linea
//  "de quien, de cuando y con que candado" de cada item
//
//  Es lo que convierte la app en una app de EQUIPO y no de notas personales:
//  cada fila del muro y cada fuente de una respuesta dicen quien la aporto.
//
//  ===================== EL NOMBRE DE UN AUTOR (contrato B) ==================
//  Los items guardan solo el uid del autor (creadoPor), nunca su nombre: si lo
//  guardaran, cambiarse el nombre dejaria cien copias viejas. El nombre se
//  resuelve EN VIVO y en este orden, IGUAL en la app y en el panel:
//     1) members/{uid}.nombre                          -> "Valentino Mattio"
//     2) si ya no esta en el equipo: exMiembros[uid].nombre del documento del
//        espacio + " (ya no está en el equipo)"      -> "Lucas (ya no está en el equipo)"
//     3) si tampoco esta ahi (se fue antes de que existiera exMiembros)
//                                                      -> "Ex integrante"
//  exMiembros lo escribe SOLO el backend, en el DELETE de miembros y ANTES de
//  borrar members/{uid}. Guarda el nombre y la fecha, nunca el email: el
//  documento del espacio lo lee cualquier miembro. Si la persona vuelve a
//  entrar, el backend le borra la clave.
//
//  POR QUE EXISTE EL PASO 2: "Lucas se fue; lo que sabia, no". Los items de
//  alguien que sacaron del equipo se quedan y la IA los sigue citando. Sin
//  exMiembros, la cita diria "Ex integrante" (o un codigo) en vez de su nombre.
//
//  QUIEN PUEDE LEER ESTO: members/{uid} y workspaces/{wsId} los lee CUALQUIER
//  miembro (reglas de Firestore), asi que anda igual para el admin y para un
//  miembro comun. Nadie escribe nada desde aca.
// ============================================================================

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';

/// Los nombres del equipo, listos para resolver "de quien es" un uid.
///
/// Es una clase comun (sin Firebase) para poder probarla en la compu: la
/// arman las escuchas de EquipoEnVivo con lo que traen de Firestore.
class NombresDelEquipo {
  const NombresDelEquipo({
    this.miembros = const <String, String>{},
    this.exMiembros = const <String, String>{},
    this.listo = false,
  });

  /// uid -> nombre de los que ESTAN en el equipo (members).
  final Map<String, String> miembros;

  /// uid -> nombre de los que se fueron (workspaces/{wsId}.exMiembros).
  final Map<String, String> exMiembros;

  /// false mientras no llegaron los miembros y el documento del espacio (o si
  /// no se pudieron leer). POR QUE: sin esto, en el primer instante TODOS
  /// saldrian como "Ex integrante", que es justo lo que no son.
  final bool listo;

  /// Lo que se le agrega al nombre de alguien que ya no esta.
  static const String sufijoExMiembro = ' (ya no está en el equipo)';

  /// Ultimo recurso: se fue antes de que el backend guardara exMiembros.
  static const String sinNombre = 'Ex integrante';

  /// El nombre para mostrar, en el orden del contrato B. null mientras no
  /// llegaron los datos: la pantalla muestra lo demas (fecha y candado) y el
  /// nombre aparece solo un instante despues.
  String? nombreDe(String? uid) {
    if (!listo) return null;
    final String id = uid ?? '';
    final String actual = (miembros[id] ?? '').trim();
    if (actual.isNotEmpty) return actual;
    final String viejo = (exMiembros[id] ?? '').trim();
    if (viejo.isNotEmpty) return '$viejo$sufijoExMiembro';
    return sinNombre;
  }

  /// Arma los nombres con lo que trajeron las dos escuchas.
  ///
  /// [miembros] = los documentos de members (id -> datos), o null si todavia
  /// no llegaron o fallaron. [espacio] = los datos de workspaces/{wsId}.
  /// [espacioListo] = ya se sabe si hay exMiembros (llego el documento o fallo
  /// su lectura, en cuyo caso se sigue sin ellos).
  factory NombresDelEquipo.desdeDatos({
    required Iterable<MapEntry<String, Map<String, dynamic>>>? miembros,
    Map<String, dynamic>? espacio,
    bool espacioListo = true,
  }) {
    final Map<String, String> nombres = <String, String>{};
    for (final MapEntry<String, Map<String, dynamic>> m
        in miembros ?? const <MapEntry<String, Map<String, dynamic>>>[]) {
      final Object? nombre = m.value['nombre'];
      if (nombre is String) nombres[m.key] = nombre;
    }
    return NombresDelEquipo(
      miembros: nombres,
      exMiembros: leerExMiembros(espacio),
      listo: miembros != null && espacioListo,
    );
  }

  /// Lee exMiembros del documento del espacio con default para todo: un mapa
  /// mal armado (cargado a mano desde la consola) no puede romper la pantalla.
  /// Entradas sin nombre se ignoran (esa persona cae en "Ex integrante").
  static Map<String, String> leerExMiembros(Map<String, dynamic>? espacio) {
    final Object? crudo = espacio?['exMiembros'];
    if (crudo is! Map) return const <String, String>{};
    final Map<String, String> salida = <String, String>{};
    crudo.forEach((Object? uid, Object? datos) {
      if (uid is! String || datos is! Map) return;
      final Object? nombre = datos['nombre'];
      if (nombre is String && nombre.trim().isNotEmpty) salida[uid] = nombre.trim();
    });
    return salida;
  }
}

/// Escucha EN VIVO a los miembros del espacio y el documento del espacio
/// (por exMiembros) y le pasa los nombres ya resueltos al [builder].
///
/// POR QUE EN VIVO Y NO LEIDOS UNA VEZ: en la demo el admin saca a Lucas
/// mientras Martin tiene el chat abierto, y la fuente siguiente tiene que
/// decir "Lucas (ya no está en el equipo)" sin cerrar nada.
///
/// Los dos streams se crean UNA vez, en initState (la regla de oro del
/// proyecto). Si dos pantallas escuchan lo mismo a la vez, el SDK de
/// Firestore comparte la escucha: la segunda sale de la memoria del telefono.
class EquipoEnVivo extends StatefulWidget {
  const EquipoEnVivo({super.key, required this.wsId, required this.builder});

  final String wsId;
  final Widget Function(BuildContext context, NombresDelEquipo nombres) builder;

  @override
  State<EquipoEnVivo> createState() => _EquipoEnVivoState();
}

class _EquipoEnVivoState extends State<EquipoEnVivo> {
  late final Stream<QuerySnapshot<Map<String, dynamic>>> _miembros;
  late final Stream<DocumentSnapshot<Map<String, dynamic>>> _espacio;

  @override
  void initState() {
    super.initState();
    final DocumentReference<Map<String, dynamic>> espacio =
        FirebaseFirestore.instance.collection('workspaces').doc(widget.wsId);
    // Sin where: la regla de members deja leer la lista entera a cualquier
    // miembro (es la que dice "quien subio esto"). Son 10 documentos como
    // mucho (el tope del plan).
    _miembros = espacio.collection('members').snapshots();
    _espacio = espacio.snapshots();
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
      stream: _miembros,
      builder: (
        BuildContext context,
        AsyncSnapshot<QuerySnapshot<Map<String, dynamic>>> miembros,
      ) {
        return StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
          stream: _espacio,
          builder: (
            BuildContext context,
            AsyncSnapshot<DocumentSnapshot<Map<String, dynamic>>> espacio,
          ) {
            // Si fallan los miembros (por ejemplo, a esta persona la acaban
            // de sacar), NO inventamos nombres: queda listo=false y cada
            // pantalla muestra solo la fecha y el candado. Si falla el
            // documento del espacio, seguimos sin exMiembros.
            final NombresDelEquipo nombres = NombresDelEquipo.desdeDatos(
              miembros: miembros.hasData && !miembros.hasError
                  ? miembros.data!.docs.map(
                      (QueryDocumentSnapshot<Map<String, dynamic>> d) =>
                          MapEntry<String, Map<String, dynamic>>(d.id, d.data()),
                    )
                  : null,
              espacio: espacio.data?.data(),
              espacioListo: espacio.hasData || espacio.hasError,
            );
            return widget.builder(context, nombres);
          },
        );
      },
    );
  }
}

// ============================================================================
//  LAS ETIQUETAS: de quien, de cuando y con que candado
//  Funciones sin Firebase, para probarlas con 'flutter test'.
// ============================================================================

/// La fecha corta de un aporte: "hoy", "ayer", "24/08" o "24/08/2025".
///
/// Va sin la hora a proposito: en una fuente lo que importa es si el dato es
/// de esta semana o de hace dos meses. Acepta un Timestamp de Firestore o un
/// DateTime. Sin fecha (el serverTimestamp todavia no volvio del servidor)
/// devuelve "ahora", igual que fechaCorta de tema.dart.
String fechaDeAporte(Object? valor, {DateTime? ahora}) {
  final DateTime fecha;
  if (valor is Timestamp) {
    fecha = valor.toDate();
  } else if (valor is DateTime) {
    fecha = valor.toLocal();
  } else {
    return 'ahora';
  }
  final DateTime hoy = ahora ?? DateTime.now();
  bool mismoDia(DateTime a, DateTime b) =>
      a.year == b.year && a.month == b.month && a.day == b.day;
  if (mismoDia(fecha, hoy)) return 'hoy';
  // DateTime(a, m, d - 1) y no restar 24 horas: asi el 1/3 da 28/2 o 29/2
  // sin que importe cuantas horas tuvo el dia.
  if (mismoDia(fecha, DateTime(hoy.year, hoy.month, hoy.day - 1))) return 'ayer';
  final String dia = fecha.day.toString().padLeft(2, '0');
  final String mes = fecha.month.toString().padLeft(2, '0');
  return fecha.year == hoy.year ? '$dia/$mes' : '$dia/$mes/${fecha.year}';
}

/// "nota privada", "PDF privado"... para "Tu nota privada". El genero cambia
/// con el tipo, y "Tu contenido privado" es el default si aparece un tipo nuevo.
String _loQueEsPrivado(String tipo) {
  switch (tipo) {
    case 'nota':
      return 'nota privada';
    case 'foto':
      return 'foto privada';
    case 'pdf':
      return 'PDF privado';
    case 'word':
      return 'Word privado';
    case 'link':
      return 'link privado';
    default:
      return 'contenido privado';
  }
}

/// La linea "de quien, de cuando y con que candado" de un item ya leido.
/// La usan las fuentes de una respuesta y la pantalla del detalle:
///   Tu nota privada · 27/08
///   Vos · 27/08 · Del equipo
///   Valentino Mattio · 24/08 · Del equipo
///   Lucas (ya no está en el equipo) · 24/08 · Del equipo
///   Privada de Martín Sosa · 27/08 · la ves porque sos admin
///
/// "la ves porque sos admin" sale de las reglas y no de mirar el rol: un item
/// privado de OTRA persona solo se puede leer siendo admin. Si esta app lo
/// pudo leer, quien mira es admin. Mostrarlo es una decision de producto:
/// "privado" quiere decir "vos y el dueno del espacio", y se dice de frente.
///
/// Mientras no llegaron los nombres, va sin el nombre ("24/08 · Del equipo").
String etiquetaDelDueno({
  required Map<String, dynamic> item,
  required String miUid,
  required NombresDelEquipo nombres,
  DateTime? ahora,
}) {
  final String autor = (item['creadoPor'] ?? '').toString();
  // Mismo default que las reglas: sin visibilidad, se trata como privado.
  final bool esPrivado = (item['visibilidad'] ?? 'privado').toString() != 'equipo';
  final String fecha = fechaDeAporte(item['creadoEn'], ahora: ahora);
  final bool esMio = autor.isNotEmpty && autor == miUid;

  if (esMio) {
    return esPrivado
        ? 'Tu ${_loQueEsPrivado((item['tipo'] ?? '').toString())} · $fecha'
        : 'Vos · $fecha · Del equipo';
  }
  final String? nombre = nombres.nombreDe(autor);
  if (esPrivado) {
    return nombre == null
        ? 'Privada · $fecha · la ves porque sos admin'
        : 'Privada de $nombre · $fecha · la ves porque sos admin';
  }
  return nombre == null ? '$fecha · Del equipo' : '$nombre · $fecha · Del equipo';
}

/// La linea chica de cada fila del muro: "de Martín Sosa · 14/10" o
/// "Tuyo · hoy". El candado ya se ve con su icono al lado, por eso no va.
String autorDeLaFila({
  required Map<String, dynamic> item,
  required String miUid,
  required NombresDelEquipo nombres,
  DateTime? ahora,
}) {
  final String autor = (item['creadoPor'] ?? '').toString();
  final String fecha = fechaDeAporte(item['creadoEn'], ahora: ahora);
  if (autor.isNotEmpty && autor == miUid) return 'Tuyo · $fecha';
  final String? nombre = nombres.nombreDe(autor);
  return nombre == null ? fecha : 'de $nombre · $fecha';
}

// ============================================================================
//  LEER UN ITEM POR ID, UNA SOLA VEZ (las fuentes de una respuesta)
// ============================================================================

/// Lo que se sabe de un item leido por su id.
class LecturaDeItem {
  /// Se pudo leer: estos son sus datos.
  const LecturaDeItem.datos(Map<String, dynamic> this.datos)
      : sinAcceso = false,
        fallo = false;

  /// No existe mas, o las reglas no dejan leerlo (lo borraron, o lo pasaron
  /// a privado y quien mira no es su autor ni admin).
  const LecturaDeItem.sinAcceso()
      : datos = null,
        sinAcceso = true,
        fallo = false;

  /// Otra cosa (sin red y sin copia en el telefono): no se sabe.
  const LecturaDeItem.fallo()
      : datos = null,
        sinAcceso = false,
        fallo = true;

  final Map<String, dynamic>? datos;
  final bool sinAcceso;
  final bool fallo;
}

/// Las lecturas de los items que cita una conversacion, guardadas en memoria.
///
/// POR QUE: cada respuesta trae hasta 6 fuentes, y la pantalla de la
/// conversacion se redibuja sola (cada 20 segundos y con cada cambio). Sin
/// esta memoria, cada redibujo volveria a leer los 6 items de Firestore.
/// Se guarda el Future (y no solo el resultado) para que dos fuentes del
/// mismo item no disparen dos lecturas a la vez.
///
/// La funcion que lee se recibe de afuera para poder probar las fuentes en
/// la compu sin Firebase (ver LecturasDeItems.deFirestore para la de verdad).
class LecturasDeItems {
  LecturasDeItems(this._leer);

  /// La de la app: un get() por id de workspaces/{wsId}/items/{itemId}.
  factory LecturasDeItems.deFirestore(String wsId) {
    final CollectionReference<Map<String, dynamic>> items = FirebaseFirestore.instance
        .collection('workspaces')
        .doc(wsId)
        .collection('items');
    return LecturasDeItems((String itemId) async {
      try {
        final DocumentSnapshot<Map<String, dynamic>> doc = await items.doc(itemId).get();
        final Map<String, dynamic>? datos = doc.data();
        if (!doc.exists || datos == null) {
          // Sin red, el get() contesta con lo que tiene el telefono: un "no
          // existe" que sale del cache no es palabra del servidor. Se trata
          // como una falla de red (se vuelve a intentar en el proximo
          // redibujo) y no como "sin acceso", que se recuerda para siempre.
          if (doc.metadata.isFromCache) return const LecturaDeItem.fallo();
          return const LecturaDeItem.sinAcceso();
        }
        return LecturaDeItem.datos(datos);
      } on FirebaseException catch (e) {
        // permission-denied = las reglas dicen que ya no lo podes ver. Es lo
        // que pasa si su autor lo paso a privado despues de la respuesta: la
        // respuesta vieja queda en tu historial, el item ya no.
        if (e.code == 'permission-denied' || e.code == 'not-found') {
          return const LecturaDeItem.sinAcceso();
        }
        debugPrint('[NeuroDesk] no se pudo leer el item $itemId: ${e.code}');
        return const LecturaDeItem.fallo();
      } catch (e) {
        debugPrint('[NeuroDesk] no se pudo leer el item $itemId: $e');
        return const LecturaDeItem.fallo();
      }
    });
  }

  final Future<LecturaDeItem> Function(String itemId) _leer;
  final Map<String, Future<LecturaDeItem>> _pedidas = <String, Future<LecturaDeItem>>{};
  final Map<String, LecturaDeItem> _listas = <String, LecturaDeItem>{};

  /// La lectura si ya termino (para dibujar sin un cuadro de espera).
  LecturaDeItem? yaLeida(String itemId) => _listas[itemId];

  /// Lee el item UNA vez. Si fallo por la red, se olvida, para que el proximo
  /// redibujo lo vuelva a intentar (un "sin acceso" si se recuerda: no cambia
  /// porque se insista).
  Future<LecturaDeItem> leer(String itemId) {
    return _pedidas.putIfAbsent(itemId, () async {
      final LecturaDeItem lectura = await _leer(itemId);
      if (lectura.fallo) {
        _pedidas.remove(itemId);
      } else {
        _listas[itemId] = lectura;
      }
      return lectura;
    });
  }
}
