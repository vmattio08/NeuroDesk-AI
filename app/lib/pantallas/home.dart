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
// ============================================================================

import 'dart:async';

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';

import '../servicios/api.dart';
import '../servicios/auth_servicio.dart';
import '../tema.dart';
import 'captura.dart';
import 'chat.dart';

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

  @override
  State<HomePantalla> createState() => _HomePantallaState();
}

class _HomePantallaState extends State<HomePantalla>
    with SingleTickerProviderStateMixin {
  // ---- LOS STREAMS SE CREAN UNA SOLA VEZ, ACA -------------------------------
  // Si se armaran adentro de build(), cada setState (por ejemplo el del badge
  // de conexion) crearia streams NUEVOS: la lista parpadearia y Firestore
  // cobraria las lecturas de nuevo cada vez.
  late final Stream<QuerySnapshot<Map<String, dynamic>>> _itemsDelEquipo;
  late final Stream<QuerySnapshot<Map<String, dynamic>>> _misItems;
  late final Stream<QuerySnapshot<Map<String, dynamic>>>? _todosLosItems;

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

    final CollectionReference<Map<String, dynamic>> items = FirebaseFirestore
        .instance
        .collection('workspaces')
        .doc(widget.wsId)
        .collection('items');

    // includeMetadataChanges: true -> ademas de los cambios de datos, avisa
    // cuando el mismo dato pasa de venir del cache a venir del servidor. Sin
    // esto el badge de "sin conexion" se quedaria prendido aunque ya haya
    // vuelto internet, porque no habria un evento nuevo que lo apague.
    _itemsDelEquipo = items
        .where('visibilidad', isEqualTo: 'equipo')
        .orderBy('creadoEn', descending: true)
        .limit(50)
        .snapshots(includeMetadataChanges: true);

    _misItems = items
        .where('creadoPor', isEqualTo: widget.miUid)
        .orderBy('creadoEn', descending: true)
        .limit(50)
        .snapshots(includeMetadataChanges: true);

    // La tercera vista es SOLO para el admin: es la diferencia de rol que se
    // muestra en la demo. Un miembro no puede hacer esta query (le fallaria
    // entera por los items privados ajenos), asi que ni la creamos.
    _todosLosItems = _esAdmin
        ? items
            .orderBy('creadoEn', descending: true)
            .limit(50)
            .snapshots(includeMetadataChanges: true)
        : null;

    _pestanas = TabController(length: _esAdmin ? 3 : 2, vsync: this);

    _vigilarConexion();
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
    // (Firebase Storage necesita tarjeta y esta descartado). Si un PDF o una
    // foto fallaron ANTES de que se le sacara el texto, no hay nada que
    // reprocesar: hay que volver a elegir el archivo. Se lo decimos en
    // castellano en vez de mandar un pedido que el backend va a rechazar con
    // ESTADO_INVALIDO.
    if ((tipo == 'pdf' || tipo == 'foto') && textoExtraido.isEmpty) {
      mostrarAviso(
        context,
        'El archivo no se guarda en el servidor. Volvé a subirlo desde el boton Agregar.',
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
        mostrarAviso(context, 'No pudimos reintentar. Proba de nuevo.', esError: true);
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
              '"$titulo" se borra junto con todo lo que la IA aprendio de el. '
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
        mostrarAviso(context, 'No pudimos borrarlo. Proba de nuevo.', esError: true);
      }
    } finally {
      if (mounted) setState(() => _ocupados.remove(itemId));
    }
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
      mostrarAviso(context, 'No pudimos cambiar de equipo. Proba de nuevo.', esError: true);
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
                    Text('Cerrar sesion', style: TextStyle(color: grisClaro)),
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
            child: TabBarView(
              controller: _pestanas,
              children: <Widget>[
                _ListaDeItems(
                  stream: _itemsDelEquipo,
                  vacioTitulo: 'Todavia no hay nada compartido',
                  vacioDetalle:
                      'Lo que suban tus companeros como "Todo el equipo" aparece aca.',
                  constructorDeFila: _fila,
                ),
                _ListaDeItems(
                  stream: _misItems,
                  vacioTitulo: 'Todavia no subiste nada',
                  vacioDetalle:
                      'Tocá Agregar para guardar tu primera nota, foto o PDF.',
                  constructorDeFila: _fila,
                ),
                if (_esAdmin)
                  _ListaDeItems(
                    stream: _todosLosItems!,
                    vacioTitulo: 'El equipo todavia no cargo nada',
                    vacioDetalle:
                        'Como administrador ves todo, incluso lo privado de cada uno.',
                    constructorDeFila: _fila,
                  ),
              ],
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
  /// tres se vean exactamente igual.
  Widget _fila(QueryDocumentSnapshot<Map<String, dynamic>> doc) {
    final Map<String, dynamic> d = doc.data();

    // Todo se lee con default. Un item cargado a mano desde la consola de
    // Firebase, o escrito por una version vieja de la app, puede tener campos
    // faltantes: eso NO puede romper la lista de todo el equipo.
    final String titulo = (d['titulo'] ?? '(sin titulo)').toString();
    final String tipo = (d['tipo'] ?? 'nota').toString();
    final String estado = (d['estado'] ?? 'pendiente').toString();
    final String visibilidad = (d['visibilidad'] ?? 'privado').toString();
    final String errorMsg = (d['errorMsg'] ?? '').toString();
    final int cantChunks = (d['cantChunks'] is int) ? d['cantChunks'] as int : 0;
    final bool esMio = (d['creadoPor'] ?? '') == widget.miUid;
    final bool ocupado = _ocupados.contains(doc.id);

    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: superficie,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: colorDeEstado(estado).withValues(alpha: 0.35)),
      ),
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
                        Text(
                          fechaCorta(d['creadoEn']),
                          style: const TextStyle(color: grisApagado, fontSize: 12),
                        ),
                        Icon(
                          visibilidad == 'privado' ? Icons.lock : Icons.groups,
                          size: 14,
                          color: grisApagado,
                        ),
                        if (estado == 'listo' && cantChunks > 0)
                          Text(
                            '$cantChunks fragmentos indexados',
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
                    if (opcion == 'borrar') _borrar(doc.id, titulo);
                  },
                  itemBuilder: (BuildContext ctx) => <PopupMenuEntry<String>>[
                    const PopupMenuItem<String>(
                      value: 'reintentar',
                      child: Text('Reintentar / volver a indexar',
                          style: TextStyle(color: grisClaro)),
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
                      ? 'Nunca se proceso: tocá para procesarlo'
                      : 'Reintentar',
                ),
                style: TextButton.styleFrom(foregroundColor: cianElectrico),
              ),
            ),
          ],
        ],
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
  });

  final Stream<QuerySnapshot<Map<String, dynamic>>> stream;
  final String vacioTitulo;
  final String vacioDetalle;
  final Widget Function(QueryDocumentSnapshot<Map<String, dynamic>>) constructorDeFila;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<QuerySnapshot<Map<String, dynamic>>>(
      stream: stream,
      builder: (
        BuildContext context,
        AsyncSnapshot<QuerySnapshot<Map<String, dynamic>>> snapshot,
      ) {
        // 1) El error PRIMERO. El sintoma tipico de olvidarse esta rama es
        //    "la lista aparece vacia" cuando en realidad hubo un
        //    permission-denied (token viejo o falta un .where()).
        if (snapshot.hasError) {
          return ErrorMensaje(error: snapshot.error!);
        }
        // 2) Primer frame, sin datos todavia.
        if (!snapshot.hasData) {
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
              'Estas viendo lo ultimo guardado en el telefono. Puede faltar algo nuevo.',
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
              'Sin conexion. Podes escribir notas: se envian solas cuando vuelva.',
              style: TextStyle(color: colorError, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }
}
