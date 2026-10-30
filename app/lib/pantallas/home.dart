// ============================================================================
//  home.dart — el muro de items del equipo
//
//  ============================ POR QUE DOS PESTANAS ========================
//  Esta es LA decision de diseno que hay que saber defender.
//
//  Las reglas de Firestore NO FILTRAN: se evaluan contra cada documento que la
//  query devolveria y, si UNO SOLO no pasa, se cae la query ENTERA con
//  permission-denied (no devuelve el resto). Como un miembro puede ver los
//  items 'equipo' MAS los suyos propios, una sola lista sin where() incluiria
//  los items privados de los demas y fallaria completa.
//
//  Por eso hay dos pestanas, cada una con SU query y SU StreamBuilder:
//     "Del equipo" -> where('visibilidad', isEqualTo: 'equipo')
//     "Mis notas"  -> where('creadoPor',  isEqualTo: miUid)
//  Y el ADMIN tiene una tercera, "Todo", sin ningun where, porque su claim ya
//  le da acceso a todo y la regla corta antes de mirar el documento.
//
//  NO unimos los dos streams en memoria a proposito: deduplicar, reordenar y
//  paginar dos streams es la parte mas dificil de todo el proyecto, se rompe
//  siempre y no suma nota.
//
//  ======================== POR QUE EL BADGE DE SIN CONEXION ================
//  Firestore tiene persistencia offline: si no hay internet, devuelve lo que
//  tiene guardado en el telefono y la lista se ve igual. Eso es comodo y a la
//  vez peligroso: la persona puede estar mirando datos de hace dos horas sin
//  enterarse. snapshot.metadata.isFromCache dice exactamente eso, y lo
//  mostramos con una banda amarilla arriba.
//
//  ======================== CADA FILA DICE DE QUIEN ES ======================
//  "de Martín Sosa · 14/10": el nombre sale de members (y de exMiembros si
//  esa persona ya no esta), resuelto en vivo por EquipoEnVivo (equipo.dart).
//  Tocar la fila abre "Lo que leyó NeuroDesk" (detalle_item.dart).
//
//  ======================== EL CANDADO EN VIVO ==============================
//  El menu de cada fila puede "Compartir con el equipo" o "Pasar a privado".
//  NO se cambia el campo desde la app aunque la regla lo deje: cada fragmento
//  del item guarda una COPIA de la visibilidad, que el buscador usa como
//  segunda cerradura. Si la app cambiara solo el item, la IA le seguiria
//  escondiendo la nota al equipo. Por eso va por el backend
//  (PATCH .../visibilidad), que cambia el item y TODOS sus fragmentos.
// ============================================================================

import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';

import '../servicios/api.dart';
import '../servicios/auth_servicio.dart';
import '../servicios/equipo.dart';
import '../tema.dart';
import 'captura.dart';
import 'chat.dart';
import 'detalle_item.dart';

class HomePantalla extends StatefulWidget {
  const HomePantalla({
    super.key,
    required this.wsId,
    required this.wsNombre,
    required this.rol,
    required this.workspaces,
    required this.miUid,
  });

  final String wsId;
  final String wsNombre;

  /// 'admin' o 'miembro'. SOLO sirve para dibujar (mostrar la pestana "Todo"):
  /// quien autoriza de verdad es el backend leyendo members/{uid} y las reglas
  /// de Firestore leyendo el claim del token.
  final String rol;

  /// El mapa completo wsId -> {rol, nombre}, para el selector de workspace.
  final Map<String, dynamic> workspaces;

  final String miUid;

  /// Que cambio de candado puede ofrecer el menu de una fila (contrato A),
  /// o null si ninguno:
  ///   'equipo'  -> "Compartir con el equipo": SOLO el autor, y solo si hoy
  ///                es privado. Ni el admin comparte lo privado de otro: seria
  ///                publicar algo que su autor guardo para si.
  ///   'privado' -> "Pasar a privado": el autor o un admin, si hoy es del
  ///                equipo.
  /// Esconder la opcion es comodidad, NO seguridad: el backend lo vuelve a
  /// chequear y contesta NO_SOS_EL_AUTOR.
  static String? candadoQueSePuedeCambiar({
    required bool esMio,
    required bool esAdmin,
    required String visibilidad,
  }) {
    if (visibilidad == 'equipo') return (esMio || esAdmin) ? 'privado' : null;
    return esMio ? 'equipo' : null;
  }

  /// El aviso de error PROPIO del candado, o null si sirve el mensaje del
  /// catalogo del backend tal cual (el mismo camino que reintentar y borrar).
  ///
  /// POR QUE HACE FALTA: los mensajes del catalogo estan escritos para todas
  /// las acciones y en estos tres casos se entienden mal:
  ///   - NO_SOS_EL_AUTOR dice "el autor o un administrador", que es verdad
  ///     para pasar a privado pero NO para compartir (eso es solo del autor);
  ///   - PROCESO_EN_CURSO dice "Ya lo estamos procesando", y aca la persona no
  ///     pidio procesar nada: pidio cambiar quien lo ve;
  ///   - RUTA_NO_ENCONTRADA es un servidor que todavia no tiene el candado
  ///     (por ejemplo, uno publicado antes de esta funcion), y "probá de nuevo
  ///     en un rato" haria reintentar algo que no va a andar.
  /// Se decide por el CODIGO, nunca por el texto del mensaje.
  static String? avisoDeErrorDelCandado(String codigo, {required bool compartir}) {
    switch (codigo) {
      case 'NO_SOS_EL_AUTOR':
        return compartir ? 'Solo quien lo subió lo puede compartir con el equipo.' : null;
      case 'PROCESO_EN_CURSO':
        return 'Se está procesando: cuando termine vas a poder cambiar quién lo ve.';
      case 'RUTA_NO_ENCONTRADA':
        return 'Esta función todavía no está en el servidor. Probá de nuevo más tarde.';
      default:
        return null;
    }
  }

  @override
  State<HomePantalla> createState() => _HomePantallaState();
}

class _HomePantallaState extends State<HomePantalla>
    with SingleTickerProviderStateMixin {
  // ---- LOS STREAMS SE CREAN UNA SOLA VEZ, ACA -------------------------------
  // Si se armaran adentro de build(), cada setState (por ejemplo el del badge
  // de conexion) crearia streams NUEVOS: la lista parpadearia y Firestore
  // cobraria las lecturas de nuevo cada vez.
  // No son final por UN solo motivo: el boton "Reintentar" de una lista que
  // fallo. Un listener de Firestore que recibio permission-denied queda
  // muerto y no revive solo (pasa justo despues de un cambio de rol, hasta
  // que el telefono tiene el token nuevo).
  late Stream<QuerySnapshot<Map<String, dynamic>>> _itemsDelEquipo;
  late Stream<QuerySnapshot<Map<String, dynamic>>> _misItems;
  Stream<QuerySnapshot<Map<String, dynamic>>>? _todosLosItems;

  late final CollectionReference<Map<String, dynamic>> _items;

  late final TabController _pestanas;

  StreamSubscription<List<ConnectivityResult>>? _subConexion;
  bool _sinInternet = false;

  /// Items con una accion en curso (reintentar / borrar). Sirve para
  /// deshabilitar el boton de ESE item y cortar el doble tap, que es el 90%
  /// de los errores de una demo en vivo.
  final Set<String> _ocupados = <String>{};

  bool get _esAdmin => widget.rol == 'admin';

  @override
  void initState() {
    super.initState();

    _items = FirebaseFirestore.instance
        .collection('workspaces')
        .doc(widget.wsId)
        .collection('items');

    _itemsDelEquipo = _escucharDelEquipo();
    _misItems = _escucharMios();
    // La tercera vista es SOLO para el admin: es la diferencia de rol que se
    // muestra en la demo. Un miembro no puede hacer esta query (le fallaria
    // entera por los items privados ajenos), asi que ni la creamos.
    _todosLosItems = _esAdmin ? _escucharTodos() : null;

    // La cantidad de pestanas se decide UNA vez, aca. Por eso la key de esta
    // pantalla en main.dart junta el espacio Y el rol: si cambia el rol con
    // la app abierta, se arma una pantalla nueva con 2 o 3 pestanas.
    _pestanas = TabController(length: _esAdmin ? 3 : 2, vsync: this);

    _vigilarConexion();
  }

  // includeMetadataChanges: true -> ademas de los cambios de datos, avisa
  // cuando el mismo dato pasa de venir del cache a venir del servidor. Sin
  // esto el badge de "sin conexion" se quedaria prendido aunque ya haya
  // vuelto internet, porque no habria un evento nuevo que lo apague.
  Stream<QuerySnapshot<Map<String, dynamic>>> _escucharDelEquipo() => _items
      .where('visibilidad', isEqualTo: 'equipo')
      .orderBy('creadoEn', descending: true)
      .limit(50)
      .snapshots(includeMetadataChanges: true);

  Stream<QuerySnapshot<Map<String, dynamic>>> _escucharMios() => _items
      .where('creadoPor', isEqualTo: widget.miUid)
      .orderBy('creadoEn', descending: true)
      .limit(50)
      .snapshots(includeMetadataChanges: true);

  Stream<QuerySnapshot<Map<String, dynamic>>> _escucharTodos() => _items
      .orderBy('creadoEn', descending: true)
      .limit(50)
      .snapshots(includeMetadataChanges: true);

  /// "Reintentar" de una lista que fallo: primero un token fresco (el caso
  /// tipico es un rol recien cambiado que el token todavia no trae) y
  /// despues una escucha NUEVA.
  Future<void> _volverAEscuchar(String cual) async {
    await AuthServicio.refrescarToken();
    if (!mounted) return;
    setState(() {
      if (cual == 'equipo') _itemsDelEquipo = _escucharDelEquipo();
      if (cual == 'mios') _misItems = _escucharMios();
      if (cual == 'todos' && _esAdmin) _todosLosItems = _escucharTodos();
    });
  }

  /// El cartel de "sin internet". connectivity_plus dice si hay red, no si hay
  /// INTERNET de verdad (el wifi de la escuela puede estar sin salida), pero
  /// alcanza para el caso comun: datos apagados o modo avion.
  void _vigilarConexion() {
    _subConexion = Connectivity().onConnectivityChanged.listen(
      (List<ConnectivityResult> estados) {
        final bool sinRed = estados.isEmpty ||
            estados.every((ConnectivityResult e) => e == ConnectivityResult.none);
        if (mounted && sinRed != _sinInternet) {
          setState(() => _sinInternet = sinRed);
        }
      },
      onError: (Object e) => debugPrint('[NeuroDesk] connectivity: $e'),
    );
  }

  @override
  void dispose() {
    // Toda suscripcion que se abre a mano se cierra a mano. Los StreamBuilder
    // se desuscriben solos; esta no, porque la abrimos nosotros con .listen().
    _subConexion?.cancel();
    _pestanas.dispose();
    super.dispose();
  }

  // ==========================================================================
  //  ACCIONES SOBRE UN ITEM
  // ==========================================================================

  /// Muestra el resultado de un pedido al backend y actua segun el codigo.
  /// Los cuatro codigos con tratamiento especial son los que pide el contrato.
  Future<void> _avisarSegunRespuesta(RespuestaApi r) async {
    if (!mounted) return;
    if (r.ok) return; // el exito se ve solo: el chip cambia en tiempo real

    if (r.sigueProcesando) {
      // Un timeout NO es un error: el backend puede seguir trabajando y el
      // StreamBuilder del item nos va a avisar como termino.
      mostrarAviso(context, r.mensaje);
      return;
    }
    if (r.sesionVencida) {
      mostrarAviso(context, r.mensaje, esError: true);
      await AuthServicio.salir();
      return;
    }
    if (r.noEsMiembro) {
      // Puede ser un token viejo (todavia sin el claim) o que lo hayan sacado
      // del equipo. Pedimos un token nuevo: si sigue fallando, es lo segundo.
      mostrarAviso(context, r.mensaje, esError: true);
      await AuthServicio.refrescarToken();
      return;
    }
    mostrarAviso(context, r.mensaje, esError: true);
  }

  /// El boton "Reintentar" de los items en 'pendiente' o en 'error'.
  Future<void> _reintentar(String itemId, Map<String, dynamic> datos) async {
    if (_ocupados.contains(itemId)) return;

    final String tipo = (datos['tipo'] ?? '').toString();
    final String textoExtraido = (datos['texto'] ?? '').toString();

    // LIMITACION HONESTA DEL PROYECTO: el archivo no se guarda en ningun lado
    // (Firebase Storage necesita tarjeta y esta descartado). Si un PDF, un
    // Word o una foto fallaron ANTES de que se le sacara el texto, no hay nada
    // que reprocesar: hay que volver a elegir el archivo. Se lo decimos en
    // castellano en vez de mandar un pedido que el backend va a rechazar con
    // ESTADO_INVALIDO.
    if ((tipo == 'pdf' || tipo == 'word' || tipo == 'foto') &&
        textoExtraido.isEmpty) {
      mostrarAviso(
        context,
        'El archivo no se guarda en el servidor. Volvé a subirlo desde el botón Agregar.',
        esError: true,
      );
      return;
    }

    setState(() => _ocupados.add(itemId));
    try {
      final RespuestaApi r =
          await Api.reprocesarItem(wsId: widget.wsId, itemId: itemId);
      await _avisarSegunRespuesta(r);
    } catch (e) {
      debugPrint('[NeuroDesk] reintentar exploto: $e');
      if (mounted) {
        mostrarAviso(context, 'No pudimos reintentar. Probá de nuevo.', esError: true);
      }
    } finally {
      if (mounted) setState(() => _ocupados.remove(itemId));
    }
  }

  /// Borrar de verdad: item + chunks. Solo por el backend (las reglas tienen
  /// allow delete: if false), porque borrar el item desde el cliente dejaria
  /// vivos los chunks con el texto adentro y la IA los podria seguir citando.
  Future<void> _borrar(String itemId, String titulo) async {
    if (_ocupados.contains(itemId)) return;

    final bool confirmado = await showDialog<bool>(
          context: context,
          builder: (BuildContext ctx) => AlertDialog(
            backgroundColor: superficie,
            title: const Text('¿Borrar este contenido?',
                style: TextStyle(color: grisClaro)),
            content: Text(
              '"$titulo" se borra junto con todo lo que la IA aprendió de él. '
              'No se puede deshacer.',
              style: const TextStyle(color: grisApagado),
            ),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: const Text('Cancelar'),
              ),
              FilledButton(
                style: FilledButton.styleFrom(backgroundColor: colorError),
                onPressed: () => Navigator.pop(ctx, true),
                child: const Text('Borrar'),
              ),
            ],
          ),
        ) ??
        false;

    // El await del dialogo tambien es un await: hay que chequear mounted.
    if (!confirmado || !mounted) return;

    setState(() => _ocupados.add(itemId));
    try {
      final RespuestaApi r =
          await Api.borrarItem(wsId: widget.wsId, itemId: itemId);
      await _avisarSegunRespuesta(r);
      // No sacamos la fila a mano: el snapshots() la hace desaparecer sola.
    } catch (e) {
      debugPrint('[NeuroDesk] borrar exploto: $e');
      if (mounted) {
        mostrarAviso(context, 'No pudimos borrarlo. Probá de nuevo.', esError: true);
      }
    } finally {
      if (mounted) setState(() => _ocupados.remove(itemId));
    }
  }

  /// El candado en vivo (contrato A): "Compartir con el equipo" o "Pasar a
  /// privado". Va por el backend y no tocando el campo desde la app: el
  /// backend cambia el item Y la copia del candado de cada fragmento, y deja
  /// el evento 'item.visibilidad'. No se reprocesa nada: el permiso se vuelve
  /// a leer en cada pregunta.
  ///
  /// [nueva] es 'equipo' o 'privado' (lo que dio candadoQueSePuedeCambiar).
  Future<void> _cambiarCandado(
    String itemId,
    String titulo,
    String nueva, {
    required bool esMio,
  }) async {
    if (_ocupados.contains(itemId)) return;
    final bool compartir = nueva == 'equipo';

    final String explicacion;
    if (compartir) {
      explicacion = '"$titulo" va a aparecer en "Del equipo" y, desde la próxima '
          'pregunta, la IA se lo va a poder citar a cualquier compañero. No hace '
          'falta volver a procesarlo.';
    } else {
      // Privado = su autor y los administradores (las reglas dejan al admin
      // leer todo). Se dice quien, segun quien lo esta cambiando.
      final String quienes = !esMio
          ? 'su autor y el administrador'
          : (_esAdmin ? 'vos y cualquier otro administrador' : 'vos y el administrador');
      explicacion = '"$titulo" deja de verse en "Del equipo" y la IA deja de '
          'citárselo al resto. Lo siguen viendo $quienes. Lo que la IA ya '
          'respondió con esto queda en el historial de cada uno.';
    }

    final bool confirmado = await showDialog<bool>(
          context: context,
          builder: (BuildContext ctx) => AlertDialog(
            backgroundColor: superficie,
            title: Text(
              compartir ? '¿Compartir con el equipo?' : '¿Pasar a privado?',
              style: const TextStyle(color: grisClaro),
            ),
            content: Text(explicacion, style: const TextStyle(color: grisApagado)),
            actions: <Widget>[
              TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: const Text('Cancelar'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(ctx, true),
                child: Text(compartir ? 'Compartir' : 'Pasar a privado'),
              ),
            ],
          ),
        ) ??
        false;

    // El await del dialogo tambien es un await: hay que chequear mounted.
    if (!confirmado || !mounted) return;

    setState(() => _ocupados.add(itemId));
    try {
      final RespuestaApi r = await Api.cambiarVisibilidad(
        wsId: widget.wsId,
        itemId: itemId,
        visibilidad: nueva,
      );
      if (!mounted) return;
      if (r.ok) {
        // La fila cambia sola (el stream ve el candado nuevo); el aviso
        // cuenta lo que no se ve: que cambio lo que la IA puede citar.
        mostrarAviso(
          context,
          compartir
              ? 'Listo: ahora lo ve todo el equipo y la IA se lo puede citar a cualquiera.'
              : 'Listo: ahora es privado. Lo ven su autor y el administrador.',
        );
        return;
      }
      // Los tres casos donde el mensaje del catalogo se entenderia mal (ver
      // avisoDeErrorDelCandado) llevan su propio aviso.
      final String? propio =
          HomePantalla.avisoDeErrorDelCandado(r.codigo, compartir: compartir);
      if (propio != null) {
        mostrarAviso(context, propio, esError: true);
        return;
      }
      // El resto (ITEM_NO_ENCONTRADO, sesion vencida, sin conexion...) con el
      // mensaje del catalogo, igual que reintentar y borrar.
      await _avisarSegunRespuesta(r);
    } catch (e) {
      debugPrint('[NeuroDesk] cambiar el candado exploto: $e');
      if (mounted) {
        mostrarAviso(context, 'No pudimos cambiar quién lo ve. Probá de nuevo.', esError: true);
      }
    } finally {
      if (mounted) setState(() => _ocupados.remove(itemId));
    }
  }

  /// Tocar una fila abre "Lo que leyó NeuroDesk". Solo se le pasa el id: la
  /// pantalla escucha el item en vivo (si se esta procesando, lo ve terminar).
  void _abrirDetalle(String itemId, String titulo) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DetalleItemPantalla(
          wsId: widget.wsId,
          itemId: itemId,
          miUid: widget.miUid,
          titulo: titulo,
        ),
      ),
    );
  }

  /// Cambiar de equipo: se escribe workspaceActual en la propia ficha.
  /// Es uno de los DOS unicos campos que el cliente puede editar de
  /// usuarios/{uid} (el otro es 'nombre'). No navegamos: la Puerta de
  /// main.dart ve el cambio en el stream de la ficha y redibuja el Home con
  /// una key nueva, que tira este State y crea los streams del otro workspace.
  Future<void> _cambiarDeWorkspace(String nuevoWsId) async {
    if (nuevoWsId == widget.wsId) return;
    try {
      await FirebaseFirestore.instance
          .collection('usuarios')
          .doc(widget.miUid)
          .update(<String, Object?>{'workspaceActual': nuevoWsId});
    } catch (e) {
      debugPrint('[NeuroDesk] no se pudo cambiar de workspace: $e');
      if (!mounted) return;
      mostrarAviso(context, 'No pudimos cambiar de equipo. Probá de nuevo.', esError: true);
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
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(
              widget.wsNombre,
              style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
              overflow: TextOverflow.ellipsis,
            ),
            Text(
              _esAdmin ? 'Sos administrador' : 'Miembro del equipo',
              style: const TextStyle(fontSize: 12, color: grisApagado),
            ),
          ],
        ),
        actions: <Widget>[
          IconButton(
            tooltip: 'Preguntarle a la IA',
            icon: const Icon(Icons.forum_outlined, color: cianElectrico),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => ChatPantalla(
                  wsId: widget.wsId,
                  wsNombre: widget.wsNombre,
                  miUid: widget.miUid,
                  esAdmin: _esAdmin,
                ),
              ),
            ),
          ),
          PopupMenuButton<String>(
            color: superficie,
            icon: const Icon(Icons.more_vert),
            onSelected: (String opcion) {
              if (opcion == '__salir__') {
                AuthServicio.salir();
              } else {
                _cambiarDeWorkspace(opcion);
              }
            },
            itemBuilder: (BuildContext ctx) => <PopupMenuEntry<String>>[
              // Los otros equipos de esta persona, sacados del mapa de su
              // ficha: no hace falta ninguna query para armar este menu.
              for (final MapEntry<String, dynamic> e in widget.workspaces.entries)
                PopupMenuItem<String>(
                  value: e.key,
                  child: Row(
                    children: <Widget>[
                      Icon(
                        e.key == widget.wsId
                            ? Icons.radio_button_checked
                            : Icons.radio_button_unchecked,
                        size: 18,
                        color: cianElectrico,
                      ),
                      const SizedBox(width: 10),
                      Flexible(
                        child: Text(
                          (e.value is Map ? (e.value as Map)['nombre'] : null)
                                  ?.toString() ??
                              'Equipo',
                          style: const TextStyle(color: grisClaro),
                        ),
                      ),
                    ],
                  ),
                ),
              const PopupMenuDivider(),
              const PopupMenuItem<String>(
                value: '__salir__',
                child: Row(
                  children: <Widget>[
                    Icon(Icons.logout, size: 18, color: grisApagado),
                    SizedBox(width: 10),
                    Text('Cerrar sesión', style: TextStyle(color: grisClaro)),
                  ],
                ),
              ),
            ],
          ),
        ],
        bottom: TabBar(
          controller: _pestanas,
          labelColor: cianElectrico,
          unselectedLabelColor: grisApagado,
          indicatorColor: cianElectrico,
          tabs: <Widget>[
            const Tab(text: 'Del equipo'),
            const Tab(text: 'Mis notas'),
            if (_esAdmin) const Tab(text: 'Todo'),
          ],
        ),
      ),
      body: Column(
        children: <Widget>[
          if (_sinInternet) const _BandaSinConexion(),
          Expanded(
            // Los nombres del equipo, en vivo, para el "de Martín · 14/10" de
            // cada fila. Va por fuera de las pestanas: una sola escucha para
            // las tres listas.
            child: EquipoEnVivo(
              wsId: widget.wsId,
              builder: (BuildContext context, NombresDelEquipo nombres) {
                Widget fila(QueryDocumentSnapshot<Map<String, dynamic>> doc) =>
                    _fila(doc, nombres);
                return TabBarView(
                  controller: _pestanas,
                  children: <Widget>[
                    _ListaDeItems(
                      stream: _itemsDelEquipo,
                      vacioTitulo: 'Todavía no hay nada compartido',
                      vacioDetalle:
                          'Lo que suban tus compañeros como "Todo el equipo" aparece acá.',
                      constructorDeFila: fila,
                      alReintentar: () => _volverAEscuchar('equipo'),
                    ),
                    _ListaDeItems(
                      stream: _misItems,
                      vacioTitulo: 'Todavía no subiste nada',
                      vacioDetalle:
                          'Tocá Agregar para guardar tu primera nota, foto, PDF o Word.',
                      constructorDeFila: fila,
                      alReintentar: () => _volverAEscuchar('mios'),
                    ),
                    if (_esAdmin)
                      _ListaDeItems(
                        stream: _todosLosItems!,
                        vacioTitulo: 'El equipo todavía no cargó nada',
                        vacioDetalle:
                            'Como administrador ves todo, incluso lo privado de cada uno.',
                        constructorDeFila: fila,
                        alReintentar: () => _volverAEscuchar('todos'),
                      ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: cian,
        foregroundColor: azulNoche,
        onPressed: () => Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => CapturaPantalla(
              wsId: widget.wsId,
              miUid: widget.miUid,
            ),
          ),
        ),
        icon: const Icon(Icons.add),
        label: const Text('Agregar'),
      ),
    );
  }

  /// Una fila del muro. Se pasa como funcion a las tres listas para que las
  /// tres se vean exactamente igual. [nombres] sale de EquipoEnVivo.
  Widget _fila(
    QueryDocumentSnapshot<Map<String, dynamic>> doc,
    NombresDelEquipo nombres,
  ) {
    final Map<String, dynamic> d = doc.data();

    // Todo se lee con default. Un item cargado a mano desde la consola de
    // Firebase, o escrito por una version vieja de la app, puede tener campos
    // faltantes: eso NO puede romper la lista de todo el equipo.
    final String titulo = (d['titulo'] ?? '(sin título)').toString();
    final String tipo = (d['tipo'] ?? 'nota').toString();
    final String estado = (d['estado'] ?? 'pendiente').toString();
    final String visibilidad = (d['visibilidad'] ?? 'privado').toString();
    final String errorMsg = (d['errorMsg'] ?? '').toString();
    final int cantChunks = (d['cantChunks'] is int) ? d['cantChunks'] as int : 0;
    final bool esMio = (d['creadoPor'] ?? '') == widget.miUid;
    final bool ocupado = _ocupados.contains(doc.id);
    final String? candado = HomePantalla.candadoQueSePuedeCambiar(
      esMio: esMio,
      esAdmin: _esAdmin,
      visibilidad: visibilidad,
    );
    // Mientras se procesa, el backend contesta PROCESO_EN_CURSO: cambiar el
    // candado en ese momento dejaria fragmentos a medio escribir con la copia
    // vieja. La opcion se ve, pero apagada.
    final bool candadoDisponible = estado != 'procesando';

    // Material + InkWell (y no un Container) para que toda la fila se pueda
    // tocar con el efecto de onda; el menu y el boton de adentro siguen
    // atendiendo sus propios toques.
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
      child: Material(
        color: superficie,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: BorderSide(color: colorDeEstado(estado).withValues(alpha: 0.35)),
        ),
        child: InkWell(
          onTap: () => _abrirDetalle(doc.id, titulo),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Icon(iconoDeTipo(tipo), color: azulRoyal, size: 22),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          Text(
                            titulo,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              color: grisClaro,
                              fontSize: 15.5,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(height: 6),
                          Wrap(
                            spacing: 8,
                            runSpacing: 6,
                            crossAxisAlignment: WrapCrossAlignment.center,
                            children: <Widget>[
                              ChipDeEstado(estado: estado),
                              Icon(
                                visibilidad == 'privado' ? Icons.lock : Icons.groups,
                                size: 14,
                                color: grisApagado,
                              ),
                              // "de Martín Sosa · 14/10": el equipo se ve en el muro.
                              Text(
                                autorDeLaFila(item: d, miUid: widget.miUid, nombres: nombres),
                                style: const TextStyle(color: grisApagado, fontSize: 12),
                              ),
                              // Con el singular bien puesto: "1 fragmentos" en
                              // la fila de una nota corta se veia en la demo.
                              if (estado == 'listo' && cantChunks > 0)
                                Text(
                                  cantChunks == 1
                                      ? '1 fragmento indexado'
                                      : '$cantChunks fragmentos indexados',
                                  style: const TextStyle(color: grisApagado, fontSize: 12),
                                ),
                            ],
                          ),
                        ],
                      ),
                    ),
                    // El menu de acciones solo aparece si la persona puede hacer
                    // algo: el autor o el admin. Igual el backend lo vuelve a
                    // chequear (NO_SOS_EL_AUTOR / ACCION_NO_PERMITIDA): esconder el
                    // boton es comodidad, NO seguridad.
                    if (esMio || _esAdmin)
                      PopupMenuButton<String>(
                        color: superficie,
                        enabled: !ocupado,
                        icon: ocupado
                            ? const SizedBox(
                                width: 18,
                                height: 18,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                  color: cianElectrico,
                                ),
                              )
                            : const Icon(Icons.more_horiz, color: grisApagado),
                        onSelected: (String opcion) {
                          if (opcion == 'reintentar') _reintentar(doc.id, d);
                          if (opcion == 'candado' && candado != null) {
                            _cambiarCandado(doc.id, titulo, candado, esMio: esMio);
                          }
                          if (opcion == 'borrar') _borrar(doc.id, titulo);
                        },
                        itemBuilder: (BuildContext ctx) => <PopupMenuEntry<String>>[
                          const PopupMenuItem<String>(
                            value: 'reintentar',
                            child: Text('Reintentar / volver a indexar',
                                style: TextStyle(color: grisClaro)),
                          ),
                          if (candado != null)
                            PopupMenuItem<String>(
                              value: 'candado',
                              enabled: candadoDisponible,
                              child: Row(
                                children: <Widget>[
                                  Icon(
                                    candado == 'equipo' ? Icons.groups : Icons.lock,
                                    size: 18,
                                    color: candadoDisponible ? cianElectrico : grisApagado,
                                  ),
                                  const SizedBox(width: 10),
                                  Flexible(
                                    child: Text(
                                      candado == 'equipo'
                                          ? 'Compartir con el equipo'
                                          : 'Pasar a privado',
                                      style: TextStyle(
                                        color: candadoDisponible ? grisClaro : grisApagado,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          const PopupMenuItem<String>(
                            value: 'borrar',
                            child: Text('Borrar', style: TextStyle(color: colorError)),
                          ),
                        ],
                      ),
                  ],
                ),

                // El motivo del error se muestra SIEMPRE que exista, aunque sea
                // largo. El contrato es claro: el error que se muestra es el del
                // DOCUMENTO (errorMsg), no el del HTTP, para no decir dos veces lo
                // mismo con palabras distintas.
                if (estado == 'error' && errorMsg.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 10),
                  Container(
                    width: double.infinity,
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: colorError.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Text(
                      errorMsg,
                      style: const TextStyle(color: colorError, fontSize: 12.5),
                    ),
                  ),
                ],

                // Boton grande de reintentar para los dos estados donde la persona
                // tiene algo que hacer.
                if (estado == 'error' || estado == 'pendiente') ...<Widget>[
                  const SizedBox(height: 10),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: ocupado ? null : () => _reintentar(doc.id, d),
                      icon: const Icon(Icons.refresh, size: 18),
                      label: Text(
                        estado == 'pendiente'
                            ? 'Nunca se procesó: tocá para procesarlo'
                            : 'Reintentar',
                      ),
                      style: TextButton.styleFrom(foregroundColor: cianElectrico),
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Una lista de items con su StreamBuilder. Las tres pestanas usan esta misma
/// clase con un stream distinto: la logica de "cargando / error / vacio / hay
/// datos" se escribe UNA sola vez.
class _ListaDeItems extends StatelessWidget {
  const _ListaDeItems({
    required this.stream,
    required this.vacioTitulo,
    required this.vacioDetalle,
    required this.constructorDeFila,
    this.alReintentar,
  });

  final Stream<QuerySnapshot<Map<String, dynamic>>> stream;
  final String vacioTitulo;
  final String vacioDetalle;
  final Widget Function(QueryDocumentSnapshot<Map<String, dynamic>>) constructorDeFila;

  /// El boton "Reintentar" del error: vuelve a crear la escucha.
  final VoidCallback? alReintentar;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
      stream: stream,
      builder: (
        BuildContext context,
        AsyncSnapshot<QuerySnapshot<Map<String, dynamic>>> snapshot,
      ) {
        // 'waiting' con un error = se toco "Reintentar" y la escucha NUEVA
        // todavia no contesto: el StreamBuilder conserva el error viejo hasta
        // entonces, y sin esto no se veria que esta cargando de nuevo.
        final bool reconectando = snapshot.connectionState == ConnectionState.waiting;
        // 1) El error PRIMERO. El sintoma tipico de olvidarse esta rama es
        //    "la lista aparece vacia" cuando en realidad hubo un
        //    permission-denied (token viejo o falta un .where()).
        if (snapshot.hasError && !reconectando) {
          return ErrorMensaje(error: snapshot.error!, alReintentar: alReintentar);
        }
        // 2) Primer frame (o reintento), sin datos todavia.
        if (!snapshot.hasData || snapshot.hasError) {
          return const Center(child: CircularProgressIndicator(color: cianElectrico));
        }

        final QuerySnapshot<Map<String, dynamic>> datos = snapshot.data!;

        // 3) Vacio de verdad.
        if (datos.docs.isEmpty) {
          return VacioMensaje(
            icono: Icons.inbox_outlined,
            titulo: vacioTitulo,
            detalle: vacioDetalle,
          );
        }

        // 4) Hay datos. isFromCache = esto salio del telefono, no del
        //    servidor: puede estar desactualizado y hay que decirlo.
        return Column(
          children: <Widget>[
            if (datos.metadata.isFromCache) const _BandaGuardadoLocal(),
            Expanded(
              child: ListView.builder(
                padding: const EdgeInsets.only(top: 6, bottom: 90),
                itemCount: datos.docs.length,
                itemBuilder: (BuildContext context, int i) =>
                    constructorDeFila(datos.docs[i]),
              ),
            ),
          ],
        );
      },
    );
  }
}

/// Banda amarilla: los datos salieron del cache del telefono.
class _BandaGuardadoLocal extends StatelessWidget {
  const _BandaGuardadoLocal();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: colorProcesando.withValues(alpha: 0.18),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      child: const Row(
        children: <Widget>[
          Icon(Icons.cloud_off, size: 16, color: colorProcesando),
          SizedBox(width: 8),
          Expanded(
            child: Text(
              'Estás viendo lo último guardado en el teléfono. Puede faltar algo nuevo.',
              style: TextStyle(color: colorProcesando, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }
}

/// Banda roja: el telefono no tiene red.
class _BandaSinConexion extends StatelessWidget {
  const _BandaSinConexion();

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: colorError.withValues(alpha: 0.18),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      child: const Row(
        children: <Widget>[
          Icon(Icons.wifi_off, size: 16, color: colorError),
          SizedBox(width: 8),
          Expanded(
            child: Text(
              'Sin conexión. Podés escribir notas: se envían solas cuando vuelva.',
              style: TextStyle(color: colorError, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }
}
