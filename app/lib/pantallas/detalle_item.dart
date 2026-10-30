// ============================================================================
//  detalle_item.dart — "Lo que leyó NeuroDesk": el texto de un item tal cual
//  lo leyo la IA, con la parte citada resaltada
//
//  Se abre al tocar una FUENTE de una respuesta o una FILA del muro. Es lo que
//  hace verdad la promesa "citas que te llevan al ítem original": la persona
//  no tiene que creerle a la IA, puede ir a ver de donde salio el dato.
//
//  ===================== QUE MUESTRA =======================================
//   - Como se leyo el item (PDF con texto, PDF escaneado con OCR, foto con
//     OCR, Word, pagina web o nota) y de quien es (equipo.dart).
//   - El campo 'texto' del item: lo que extrajo el BACKEND, que es lo mismo
//     que se troceo y se le paso a la IA (no textoOriginal, que es lo que
//     escribio la persona).
//   - Si se abrio desde una fuente, el fragmento citado pintado en cian.
//
//  ===================== POR QUE TARJETAS Y NO UN Text =====================
//  'texto' puede tener hasta 300.000 caracteres (el tope del backend). Un
//  solo Text de ese tamano hay que medirlo y dibujarlo ENTERO aunque se vea
//  un pedacito: la pantalla se traba. Por eso el texto se corta en las marcas
//  <<<PAGINA:n>>> que dejo el backend (una tarjeta por pagina) y, si una
//  pagina es muy larga, en bloques de unos 1500 caracteres. Todo va adentro
//  de un ListView.builder, que arma solo los bloques que estan en pantalla.
//
//  LAS MARCAS: extraer.js pega las paginas de un PDF con "<<<PAGINA:n>>>" en
//  el medio, y el backend las deja en item.texto a proposito (las usa al
//  reprocesar para saber de que pagina sale cada fragmento). A la foto le
//  pone una sola marca (la toma como pagina 1), asi que se ve como "Página
//  1". Notas, links y Word no tienen paginas: se muestran sin cortes.
//
//  EL RESALTADO puede no encontrar el fragmento (el item se volvio a procesar
//  y el texto cambio, o hay espacios distintos): en ese caso se muestra el
//  texto sin resaltar y se avisa. Nunca se rompe la pantalla por eso.
// ============================================================================

import 'dart:math' as math;

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

import '../servicios/equipo.dart';
import '../tema.dart';

class DetalleItemPantalla extends StatefulWidget {
  const DetalleItemPantalla({
    super.key,
    required this.wsId,
    required this.itemId,
    required this.miUid,
    this.titulo = '',
    this.fragmento,
    this.pagina,
  });

  final String wsId;
  final String itemId;
  final String miUid;

  /// El titulo que ya se conoce (el de la fuente o el de la fila), para
  /// mostrar algo mientras llega el documento.
  final String titulo;

  /// El fragmento que cito la respuesta (fuentes[].fragmento). null si se
  /// abrio desde el muro: ahi no hay nada que resaltar.
  final String? fragmento;

  /// La pagina que dice la cita (fuentes[].pagina), si tiene.
  final int? pagina;

  @override
  State<DetalleItemPantalla> createState() => _DetalleItemPantallaState();
}

class _DetalleItemPantallaState extends State<DetalleItemPantalla> {
  /// El item EN VIVO: si lo reprocesan o le cambian el candado mientras se
  /// mira, la pantalla se actualiza sola. Se crea UNA vez (no es final porque
  /// "Reintentar" lo vuelve a crear: un listener que fallo no revive solo).
  late Stream<DocumentSnapshot<Map<String, dynamic>>> _item;

  final ScrollController _scroll = ScrollController();

  /// La marca del bloque con el resaltado, para poder llevar la lista hasta el.
  final GlobalKey _claveDelResaltado = GlobalKey();

  /// Memoria del ultimo texto armado: cortar 300.000 caracteres y buscar el
  /// fragmento no es gratis, y la pantalla se redibuja con cada cambio de los
  /// nombres del equipo o del documento.
  String? _textoYaArmado;
  TextoArmado? _armado;

  /// La lista baja sola hasta la cita UNA vez, al abrir. Despues manda la
  /// persona (y tiene el boton de arriba para volver a la cita).
  bool _yaBajoAlResaltado = false;
  int _saltos = 0;

  @override
  void initState() {
    super.initState();
    _item = _escuchar();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  /// includeMetadataChanges: true por el caso sin red (ver el paso 2 de
  /// build): si el telefono no tiene copia del item, Firestore primero avisa
  /// "no existe" DESDE EL CACHE. Si el servidor despues confirma que de
  /// verdad no existe, los datos son los mismos y solo cambia el metadato:
  /// sin esto ese aviso no llegaria y la pantalla se quedaria en "sin
  /// conexion" aunque ya haya vuelto la red.
  Stream<DocumentSnapshot<Map<String, dynamic>>> _escuchar() {
    return FirebaseFirestore.instance
        .collection('workspaces')
        .doc(widget.wsId)
        .collection('items')
        .doc(widget.itemId)
        .snapshots(includeMetadataChanges: true);
  }

  TextoArmado _armar(String texto) {
    final TextoArmado? anterior = _armado;
    if (anterior != null && texto == _textoYaArmado) return anterior;
    final TextoArmado nuevo = TextoDelItem.armar(
      texto,
      fragmento: widget.fragmento,
      paginaCitada: widget.pagina,
    );
    _textoYaArmado = texto;
    _armado = nuevo;
    return nuevo;
  }

  /// Lleva la lista hasta el bloque resaltado.
  ///
  /// POR QUE ASI: el ListView.builder solo arma los bloques que estan cerca
  /// de la pantalla, asi que el bloque de la cita puede no existir todavia y
  /// no hay a donde "saltar". Se baja de a una pantalla por cuadro hasta que
  /// el bloque se arma, y ahi se lleva a la vista LA PARTE EN CIAN (ver
  /// _buscarElResaltado), no el bloque entero.
  void _irAlResaltado() {
    _saltos = 0;
    if (_claveDelResaltado.currentContext == null && _scroll.hasClients) {
      // Puede estar MAS ARRIBA de donde esta la persona: se arranca de cero.
      _scroll.jumpTo(0);
    }
    WidgetsBinding.instance.addPostFrameCallback((_) => _buscarElResaltado());
  }

  void _buscarElResaltado() {
    if (!mounted || !_scroll.hasClients) return;
    final BuildContext? bloque = _claveDelResaltado.currentContext;
    if (bloque != null) {
      // Se lleva a la vista EL TRAMO EN CIAN y no el bloque entero: un bloque
      // de 1500 caracteres es mas alto que la pantalla de un celular chico, y
      // con el bloque entero la cita podia quedar abajo, sin verse (el
      // ensureVisible deja afuera el 80% de lo que el bloque tiene de mas).
      final TextoArmado? armado = _armado;
      final int? indice = armado?.bloqueResaltado;
      final RenderObject? caja = bloque.findRenderObject();
      final Rect? cita = (armado == null || indice == null)
          ? null
          : rectDelResaltado(caja, armado.bloques[indice]);
      if (caja != null && cita != null) {
        final ScrollPosition posicion = _scroll.position;
        final double destino = RenderAbstractViewport.of(caja)
            .getOffsetToReveal(caja, 0.2, rect: cita)
            .offset
            .clamp(posicion.minScrollExtent, posicion.maxScrollExtent);
        _scroll.animateTo(
          destino,
          duration: const Duration(milliseconds: 350),
          curve: Curves.easeOut,
        );
        return;
      }
      // Si no se pudo medir (no deberia pasar), como antes: el bloque entero.
      Scrollable.ensureVisible(
        bloque,
        alignment: 0.2,
        duration: const Duration(milliseconds: 350),
        curve: Curves.easeOut,
      );
      return;
    }
    final ScrollPosition posicion = _scroll.position;
    // Tope por las dudas: nunca un bucle infinito de cuadros.
    if (_saltos > 400 || posicion.pixels >= posicion.maxScrollExtent) return;
    _saltos++;
    _scroll.jumpTo(
      math.min(posicion.pixels + posicion.viewportDimension * 0.8, posicion.maxScrollExtent),
    );
    WidgetsBinding.instance.addPostFrameCallback((_) => _buscarElResaltado());
  }

  @override
  Widget build(BuildContext context) {
    final bool hayCita = (_armado?.bloqueResaltado) != null;
    return Scaffold(
      appBar: AppBar(
        backgroundColor: azulNoche,
        foregroundColor: grisClaro,
        title: const Text('Lo que leyó NeuroDesk'),
        actions: <Widget>[
          if (hayCita)
            IconButton(
              tooltip: 'Ir a lo que citó la respuesta',
              icon: const Icon(Icons.format_quote, color: cianElectrico),
              onPressed: _irAlResaltado,
            ),
        ],
      ),
      body: SafeArea(
        child: EquipoEnVivo(
          wsId: widget.wsId,
          builder: (BuildContext context, NombresDelEquipo nombres) {
            return StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
              stream: _item,
              builder: (
                BuildContext context,
                AsyncSnapshot<DocumentSnapshot<Map<String, dynamic>>> snapshot,
              ) {
                // 1) El error primero. permission-denied = las reglas dicen
                //    que esta persona ya no lo puede leer (lo pasaron a
                //    privado). Otro error (sin red y sin copia): reintentar.
                if (snapshot.hasError) {
                  final Object error = snapshot.error!;
                  if (error is FirebaseException && error.code == 'permission-denied') {
                    return const SinAccesoALaFuente();
                  }
                  return ErrorMensaje(
                    error: error,
                    titulo: 'No pudimos abrir esta fuente',
                    alReintentar: () => setState(() => _item = _escuchar()),
                  );
                }
                if (!snapshot.hasData) {
                  // Mientras llega el documento: el titulo que ya se conocia
                  // (el de la fuente o el de la fila) arriba de la ruedita,
                  // asi se sabe que se esta abriendo.
                  return Center(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: <Widget>[
                          if (widget.titulo.trim().isNotEmpty) ...<Widget>[
                            Text(
                              widget.titulo.trim(),
                              textAlign: TextAlign.center,
                              style: const TextStyle(
                                color: grisClaro,
                                fontSize: 16,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 16),
                          ],
                          const CircularProgressIndicator(color: cianElectrico),
                        ],
                      ),
                    ),
                  );
                }
                final DocumentSnapshot<Map<String, dynamic>> doc = snapshot.data!;
                final Map<String, dynamic>? datos = doc.data();
                if (!doc.exists || datos == null) {
                  // 2) Sin red y sin copia en el telefono: el "no existe"
                  //    viene del cache (isFromCache) y todavia no hablo con
                  //    el servidor. NO es "sin acceso": no se sabe. La
                  //    escucha sigue viva y la fuente aparece sola cuando
                  //    vuelve la conexion.
                  if (doc.metadata.isFromCache) {
                    return const VacioMensaje(
                      icono: Icons.cloud_off,
                      titulo: 'Sin conexión',
                      detalle: 'Esta fuente no está guardada en el teléfono. '
                          'Se abre sola cuando vuelva internet.',
                    );
                  }
                  // 3) El servidor dice que no existe: lo borraron.
                  return const SinAccesoALaFuente();
                }

                final String texto = TextoDelItem.textoParaMostrar(datos);
                final TextoArmado? armado = texto.isEmpty ? null : _armar(texto);

                // La primera vez que hay cita, bajamos solos hasta ella. Va
                // despues del cuadro: recien ahi existe la lista.
                if (!_yaBajoAlResaltado && armado?.bloqueResaltado != null) {
                  _yaBajoAlResaltado = true;
                  WidgetsBinding.instance.addPostFrameCallback((_) {
                    if (!mounted) return;
                    setState(() {}); // aparece el boton de la cita arriba
                    _irAlResaltado();
                  });
                }

                return CuerpoDelDetalle(
                  datos: datos,
                  armado: armado,
                  dueno: etiquetaDelDueno(item: datos, miUid: widget.miUid, nombres: nombres),
                  fragmentoCitado: widget.fragmento,
                  paginaCitada: widget.pagina,
                  controlador: _scroll,
                  claveDelResaltado: _claveDelResaltado,
                );
              },
            );
          },
        ),
      ),
    );
  }
}

/// Donde quedo lo pintado en cian adentro de un bloque ya dibujado, en
/// coordenadas del bloque, o null si no se puede medir. Es publica para
/// probarla en la compu (test/detalle_item_test.dart).
///
/// El texto del bloque es el ULTIMO parrafo adentro de la tarjeta (el primero
/// puede ser el "Página n"), y el tramo en cian son las mismas posiciones que
/// usa _bloque para partir el TextSpan.
Rect? rectDelResaltado(RenderObject? bloque, BloqueDelTexto b) {
  final int? desde = b.resaltadoDesde;
  final int? hasta = b.resaltadoHasta == null
      ? null
      : math.min(b.resaltadoHasta!, b.texto.trimRight().length);
  if (bloque == null || desde == null || hasta == null || desde >= hasta) return null;

  RenderParagraph? ultimo;
  void buscar(RenderObject r) {
    if (r is RenderParagraph) ultimo = r;
    r.visitChildren(buscar);
  }

  bloque.visitChildren(buscar);
  final RenderParagraph? parrafo = ultimo;
  if (parrafo == null || !parrafo.hasSize) return null;

  final List<TextBox> cajas = parrafo.getBoxesForSelection(
    TextSelection(baseOffset: desde, extentOffset: hasta),
  );
  if (cajas.isEmpty) return null;
  Rect tramo = cajas.first.toRect();
  for (final TextBox c in cajas.skip(1)) {
    tramo = tramo.expandToInclude(c.toRect());
  }
  return MatrixUtils.transformRect(parrafo.getTransformTo(bloque), tramo);
}

/// Lo que se ve si el item ya no existe o las reglas no dejan leerlo.
class SinAccesoALaFuente extends StatelessWidget {
  const SinAccesoALaFuente({super.key});

  @override
  Widget build(BuildContext context) {
    return const VacioMensaje(
      icono: Icons.lock_outline,
      titulo: 'Ya no tenés acceso a esta fuente',
      detalle: 'Puede que la hayan borrado o que su autor la haya pasado a privada. '
          'Lo que ya te respondió la IA queda en tu historial.',
    );
  }
}

/// El contenido de la pantalla ya con el documento leido: el encabezado y
/// los bloques de texto. Es publico y no toca Firebase para poder probarlo
/// en la compu (test/detalle_item_test.dart).
class CuerpoDelDetalle extends StatelessWidget {
  const CuerpoDelDetalle({
    super.key,
    required this.datos,
    required this.armado,
    required this.dueno,
    this.fragmentoCitado,
    this.paginaCitada,
    this.controlador,
    this.claveDelResaltado,
  });

  /// Los datos del item.
  final Map<String, dynamic> datos;

  /// El texto ya cortado en bloques, o null si todavia no hay texto.
  final TextoArmado? armado;

  /// La linea "de quien, de cuando y con que candado" (etiquetaDelDueno).
  final String dueno;

  final String? fragmentoCitado;
  final int? paginaCitada;
  final ScrollController? controlador;
  final GlobalKey? claveDelResaltado;

  /// Como se ve la parte citada: fondo cian y letra blanca, para que se lea
  /// sobre el fondo oscuro.
  static final TextStyle estiloResaltado = TextStyle(
    backgroundColor: cian.withValues(alpha: 0.38),
    color: Colors.white,
    fontWeight: FontWeight.w600,
  );

  @override
  Widget build(BuildContext context) {
    final List<BloqueDelTexto> bloques = armado?.bloques ?? const <BloqueDelTexto>[];
    return ListView.builder(
      controller: controlador,
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 32),
      itemCount: 1 + bloques.length,
      itemBuilder: (BuildContext context, int i) {
        if (i == 0) return _encabezado();
        return _bloque(bloques[i - 1], i - 1);
      },
    );
  }

  Widget _encabezado() {
    final String titulo = (datos['titulo'] ?? '(sin título)').toString();
    final String tipo = (datos['tipo'] ?? 'nota').toString();
    final String estado = (datos['estado'] ?? 'pendiente').toString();
    final bool esPrivado = (datos['visibilidad'] ?? 'privado').toString() != 'equipo';
    final String errorMsg = (datos['errorMsg'] ?? '').toString();
    final String url = (datos['url'] ?? '').toString();
    final String nombreArchivo = (datos['nombreArchivo'] ?? '').toString();
    final Object? caracteres = datos['caracteres'];
    final bool recortado = datos['recortado'] == true;
    final bool tieneTextoLeido = (datos['texto'] ?? '').toString().trim().isNotEmpty;
    final String? fragmento =
        (fragmentoCitado ?? '').trim().isEmpty ? null : fragmentoCitado!.trim();
    final bool resaltado = armado?.bloqueResaltado != null;

    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: superficie,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: cian.withValues(alpha: 0.3)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Icon(iconoDeTipo(tipo), color: azulRoyal, size: 24),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  titulo,
                  style: const TextStyle(
                    color: grisClaro,
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          _renglon(Icons.auto_stories_outlined, TextoDelItem.comoSeLeyo(datos)),
          _renglon(esPrivado ? Icons.lock : Icons.groups, dueno),
          if (nombreArchivo.isNotEmpty) _renglon(Icons.attach_file, nombreArchivo),
          if (url.isNotEmpty) _renglon(Icons.link, url, seleccionable: true),
          if (caracteres is num && caracteres > 0)
            _renglon(Icons.notes, '${TextoDelItem.conPuntos(caracteres.toInt())} caracteres leídos'),
          if (recortado)
            _renglon(
              Icons.content_cut,
              'Era muy largo: la IA leyó solo la primera parte.',
              color: colorProcesando,
            ),

          // El estado: si todavia no lo leyo, o si fallo, se dice aca arriba.
          if (estado != 'listo') ...<Widget>[
            const SizedBox(height: 8),
            Align(alignment: Alignment.centerLeft, child: ChipDeEstado(estado: estado)),
            const SizedBox(height: 8),
            Text(
              estado == 'error'
                  ? (errorMsg.isNotEmpty ? errorMsg : 'No se pudo leer.')
                  : (tieneTextoLeido
                      ? 'Se está volviendo a leer: abajo está la lectura anterior.'
                      : 'Todavía no lo leyó la IA: cuando termine, el texto aparece acá solo.'),
              style: TextStyle(
                color: estado == 'error' ? colorError : grisApagado,
                fontSize: 13,
              ),
            ),
          ],

          // La cita: donde esta, o por que no se resalto.
          if (fragmento != null) ...<Widget>[
            const SizedBox(height: 12),
            if (resaltado)
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Container(
                    width: 14,
                    height: 14,
                    margin: const EdgeInsets.only(top: 2),
                    decoration: BoxDecoration(
                      color: cian.withValues(alpha: 0.6),
                      borderRadius: BorderRadius.circular(3),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      paginaCitada != null && !(armado?.tienePaginas ?? false)
                          ? 'En cian, lo que citó la respuesta (es de la pág. $paginaCitada).'
                          : 'En cian, lo que citó la respuesta.',
                      style: const TextStyle(color: cianElectrico, fontSize: 13),
                    ),
                  ),
                ],
              )
            else
              Text(
                'No encontramos la cita en el texto de hoy (puede que lo hayan '
                'vuelto a procesar). La respuesta citó: "$fragmento"',
                style: const TextStyle(
                  color: grisApagado,
                  fontSize: 13,
                  fontStyle: FontStyle.italic,
                ),
              ),
          ],
        ],
      ),
    );
  }

  Widget _renglon(IconData icono, String texto, {Color color = grisApagado, bool seleccionable = false}) {
    final TextStyle estilo = TextStyle(color: color, fontSize: 13);
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Icon(icono, size: 16, color: color),
          const SizedBox(width: 8),
          Expanded(
            child: seleccionable ? SelectableText(texto, style: estilo) : Text(texto, style: estilo),
          ),
        ],
      ),
    );
  }

  /// Un pedazo del texto. Los bloques de una misma pagina van pegados (sin
  /// espacio ni bordes redondeados en el medio), asi se ven como UNA tarjeta.
  Widget _bloque(BloqueDelTexto b, int indice) {
    final String visible = b.texto.trimRight();
    final int? desde = b.resaltadoDesde;
    final int? hasta = b.resaltadoHasta == null
        ? null
        : math.min(b.resaltadoHasta!, visible.length);

    final List<TextSpan> partes = <TextSpan>[];
    if (desde != null && hasta != null && desde < hasta) {
      partes
        ..add(TextSpan(text: visible.substring(0, desde)))
        ..add(TextSpan(text: visible.substring(desde, hasta), style: estiloResaltado))
        ..add(TextSpan(text: visible.substring(hasta)));
    } else {
      partes.add(TextSpan(text: visible));
    }

    const Radius redondeo = Radius.circular(14);
    return Container(
      key: indice == armado?.bloqueResaltado ? claveDelResaltado : null,
      margin: EdgeInsets.only(top: b.esPrimeroDeLaPagina ? 12 : 0),
      padding: EdgeInsets.fromLTRB(
        16,
        b.esPrimeroDeLaPagina ? 14 : 0,
        16,
        b.esUltimoDeLaPagina ? 16 : 0,
      ),
      decoration: BoxDecoration(
        color: superficie,
        borderRadius: BorderRadius.vertical(
          top: b.esPrimeroDeLaPagina ? redondeo : Radius.zero,
          bottom: b.esUltimoDeLaPagina ? redondeo : Radius.zero,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (b.esPrimeroDeLaPagina && b.numeroDePagina != null) ...<Widget>[
            Text(
              'Página ${b.numeroDePagina}',
              style: const TextStyle(
                color: cianElectrico,
                fontSize: 12.5,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.3,
              ),
            ),
            const SizedBox(height: 8),
          ],
          Text.rich(
            TextSpan(children: partes),
            style: const TextStyle(color: grisClaro, fontSize: 14.5, height: 1.5),
          ),
        ],
      ),
    );
  }
}

// ============================================================================
//  EL TEXTO DEL ITEM: paginas, bloques y donde esta la cita
//  Todo sin Firebase y sin widgets, para probarlo con 'flutter test'.
// ============================================================================

/// Una pagina del texto. [numero] es null si el texto no tiene marcas de
/// pagina (nota, link, Word) o en lo que haya antes de la primera. La foto
/// trae una sola marca: es la pagina 1.
class PaginaDelTexto {
  const PaginaDelTexto({required this.numero, required this.texto});
  final int? numero;
  final String texto;
}

/// Un tramo [inicio, fin) adentro de un texto.
class Tramo {
  const Tramo(this.inicio, this.fin);
  final int inicio;
  final int fin;

  @override
  bool operator ==(Object other) => other is Tramo && other.inicio == inicio && other.fin == fin;

  @override
  int get hashCode => Object.hash(inicio, fin);

  @override
  String toString() => 'Tramo($inicio, $fin)';
}

/// Donde quedo la cita: en que pagina (indice de la lista) y en que tramo.
class UbicacionDeLaCita {
  const UbicacionDeLaCita({required this.pagina, required this.tramo});
  final int pagina;
  final Tramo tramo;
}

/// Un bloque para el ListView: un pedazo de UNA pagina.
class BloqueDelTexto {
  const BloqueDelTexto({
    required this.numeroDePagina,
    required this.texto,
    required this.esPrimeroDeLaPagina,
    required this.esUltimoDeLaPagina,
    this.resaltadoDesde,
    this.resaltadoHasta,
  });

  final int? numeroDePagina;
  final String texto;
  final bool esPrimeroDeLaPagina;
  final bool esUltimoDeLaPagina;

  /// La parte de ESTE bloque que va en cian (posiciones dentro de [texto]).
  /// Una cita que cae justo entre dos bloques se pinta en los dos.
  final int? resaltadoDesde;
  final int? resaltadoHasta;
}

/// El texto listo para dibujar.
class TextoArmado {
  const TextoArmado({
    required this.paginas,
    required this.bloques,
    this.cita,
    this.bloqueResaltado,
  });

  final List<PaginaDelTexto> paginas;
  final List<BloqueDelTexto> bloques;

  /// null si no habia cita o no se encontro.
  final UbicacionDeLaCita? cita;

  /// El indice del PRIMER bloque con parte en cian, o null.
  final int? bloqueResaltado;

  /// true si el texto vino con marcas de pagina.
  bool get tienePaginas => paginas.any((PaginaDelTexto p) => p.numero != null);
}

class TextoDelItem {
  TextoDelItem._();

  /// La marca que pone extraer.js entre pagina y pagina (texto.js del backend).
  static final RegExp marcaDePagina = RegExp(r'<<<PAGINA:(\d+)>>>');

  /// Cuanto texto entra en un bloque como mucho.
  static const int maximoPorBloque = 1500;

  /// El texto que se muestra: el que LEYO la IA ('texto', del backend). Si la
  /// nota todavia no se proceso, lo que escribio la persona, para no mostrar
  /// una pantalla vacia de algo que si tiene contenido.
  static String textoParaMostrar(Map<String, dynamic> datos) {
    final String leido = (datos['texto'] ?? '').toString();
    if (leido.trim().isNotEmpty) return leido;
    if ((datos['tipo'] ?? '') == 'nota') return (datos['textoOriginal'] ?? '').toString();
    return '';
  }

  /// Corta el texto en las marcas <<<PAGINA:n>>>. Igual que separarEnPaginas
  /// del backend (texto.js): lo que hay antes de la primera marca va sin
  /// numero, y las paginas vacias no cuentan. Cada pagina va sin los espacios
  /// de los bordes, que es como el backend arma sus fragmentos: asi la cita
  /// se encuentra tal cual.
  static List<PaginaDelTexto> cortarEnPaginas(String texto) {
    final List<PaginaDelTexto> paginas = <PaginaDelTexto>[];
    int? numero;
    int desde = 0;
    void agregar(String crudo) {
      final String limpio = crudo.trim();
      if (limpio.isNotEmpty) paginas.add(PaginaDelTexto(numero: numero, texto: limpio));
    }

    for (final RegExpMatch m in marcaDePagina.allMatches(texto)) {
      agregar(texto.substring(desde, m.start));
      numero = int.tryParse(m.group(1) ?? '');
      desde = m.end;
    }
    agregar(texto.substring(desde));
    return paginas;
  }

  /// Corta una pagina larga en tramos de hasta [maximo] caracteres, sin
  /// perder ni repetir nada (pegados dan el texto original). Busca cortar en
  /// un borde natural (fin de parrafo, de renglon, de oracion o un espacio)
  /// entre la mitad y el maximo, para no partir una palabra al medio.
  static List<Tramo> cortarEnBloques(String texto, {int maximo = maximoPorBloque}) {
    final int tope = math.max(maximo, 20);
    final List<Tramo> tramos = <Tramo>[];
    int desde = 0;
    while (desde < texto.length) {
      if (texto.length - desde <= tope) {
        tramos.add(Tramo(desde, texto.length));
        break;
      }
      final int hasta = _mejorCorte(texto, desde + tope ~/ 2, desde + tope);
      tramos.add(Tramo(desde, hasta));
      desde = hasta;
    }
    return tramos;
  }

  static int _mejorCorte(String texto, int minimo, int maximo) {
    final String ventana = texto.substring(minimo, maximo);
    for (final String borde in <String>['\n\n', '\n', '. ', ' ']) {
      final int pos = ventana.lastIndexOf(borde);
      if (pos >= 0) return minimo + pos + borde.length;
    }
    // Sin ningun espacio (un codigo larguisimo): corte a lo bruto, pero sin
    // partir un emoji en dos (las dos mitades se verian como un simbolo roto).
    final int unoAntes = texto.codeUnitAt(maximo - 1);
    final bool partiriaUnEmoji = unoAntes >= 0xD800 && unoAntes <= 0xDBFF;
    return partiriaUnEmoji ? maximo - 1 : maximo;
  }

  /// Donde esta [fragmento] adentro de [texto], o null.
  ///
  /// El backend guarda como cita los primeros 240 caracteres del fragmento y
  /// le agrega "…" si lo corto (recorteParaCitar en buscar.js): ese "…" no
  /// esta en el texto, asi que se saca antes de buscar. Primero se busca
  /// tal cual; si no aparece, se busca con las mismas palabras aunque cambien
  /// los espacios o los saltos de renglon entre ellas.
  static Tramo? buscarFragmento(String texto, String fragmento) {
    String limpio = fragmento.trim();
    while (limpio.endsWith('…') || limpio.endsWith('...')) {
      limpio = limpio.substring(0, limpio.length - (limpio.endsWith('…') ? 1 : 3)).trimRight();
    }
    if (limpio.isEmpty) return null;

    final int exacto = texto.indexOf(limpio);
    if (exacto >= 0) return Tramo(exacto, exacto + limpio.length);

    final List<String> palabras =
        limpio.split(RegExp(r'\s+')).where((String p) => p.isNotEmpty).toList();
    if (palabras.isEmpty) return null;
    final RegExpMatch? m = RegExp(
      palabras.map(RegExp.escape).join(r'\s+'),
      caseSensitive: false,
    ).firstMatch(texto);
    return m == null ? null : Tramo(m.start, m.end);
  }

  /// Busca la cita en las paginas: primero en la que dice la fuente (si el
  /// mismo renglon se repite en dos paginas, como un encabezado, se resalta
  /// el de la cita) y despues en las demas, en orden.
  static UbicacionDeLaCita? ubicarCita(
    List<PaginaDelTexto> paginas,
    String? fragmento, {
    int? paginaCitada,
  }) {
    if (fragmento == null || fragmento.trim().isEmpty) return null;
    final List<int> orden = <int>[
      for (int i = 0; i < paginas.length; i++)
        if (paginaCitada != null && paginas[i].numero == paginaCitada) i,
      for (int i = 0; i < paginas.length; i++)
        if (paginaCitada == null || paginas[i].numero != paginaCitada) i,
    ];
    for (final int i in orden) {
      final Tramo? tramo = buscarFragmento(paginas[i].texto, fragmento);
      if (tramo != null) return UbicacionDeLaCita(pagina: i, tramo: tramo);
    }
    return null;
  }

  /// Todo junto: paginas, bloques y la cita repartida en los bloques.
  static TextoArmado armar(
    String texto, {
    String? fragmento,
    int? paginaCitada,
    int maximo = maximoPorBloque,
  }) {
    final List<PaginaDelTexto> paginas = cortarEnPaginas(texto);
    final UbicacionDeLaCita? cita = ubicarCita(paginas, fragmento, paginaCitada: paginaCitada);

    final List<BloqueDelTexto> bloques = <BloqueDelTexto>[];
    int? bloqueResaltado;
    for (int p = 0; p < paginas.length; p++) {
      final PaginaDelTexto pagina = paginas[p];
      final List<Tramo> tramos = cortarEnBloques(pagina.texto, maximo: maximo);
      for (int b = 0; b < tramos.length; b++) {
        final Tramo tramo = tramos[b];
        int? desde;
        int? hasta;
        if (cita != null && cita.pagina == p) {
          // La parte de la cita que cae en ESTE bloque (puede ser ninguna).
          final int i = math.max(cita.tramo.inicio, tramo.inicio);
          final int f = math.min(cita.tramo.fin, tramo.fin);
          if (i < f) {
            desde = i - tramo.inicio;
            hasta = f - tramo.inicio;
            bloqueResaltado ??= bloques.length;
          }
        }
        bloques.add(
          BloqueDelTexto(
            numeroDePagina: pagina.numero,
            texto: pagina.texto.substring(tramo.inicio, tramo.fin),
            esPrimeroDeLaPagina: b == 0,
            esUltimoDeLaPagina: b == tramos.length - 1,
            resaltadoDesde: desde,
            resaltadoHasta: hasta,
          ),
        );
      }
    }
    return TextoArmado(
      paginas: paginas,
      bloques: bloques,
      cita: cita,
      bloqueResaltado: bloqueResaltado,
    );
  }

  /// "Como se leyo" el item, en castellano y para la persona. Sale del campo
  /// 'origen' que escribe el backend (y de 'tipo' si todavia no lo leyo).
  static String comoSeLeyo(Map<String, dynamic> datos) {
    final String tipo = (datos['tipo'] ?? '').toString();
    final String origen = (datos['origen'] ?? '').toString();
    final Object? campoPaginas = datos['paginas'];
    final int paginas = campoPaginas is num
        ? campoPaginas.toInt()
        : cortarEnPaginas((datos['texto'] ?? '').toString())
            .where((PaginaDelTexto p) => p.numero != null)
            .length;
    final String dePaginas = paginas == 1 ? 'de 1 página' : 'de $paginas páginas';

    switch (origen) {
      case 'nota':
        return 'Nota escrita en la app.';
      case 'pdf-texto':
        return paginas > 0 ? 'PDF $dePaginas, leído con su texto.' : 'PDF leído con su texto.';
      case 'ocr-space':
        // 'ocr-space' quiere decir "el texto salio de un OCR" (puede haber
        // sido el OCR local de respaldo): por eso puede tener letras cambiadas.
        if (tipo == 'foto') {
          return 'Foto: el texto se sacó con OCR (reconocimiento de letras) y puede tener errores.';
        }
        return paginas > 0
            ? 'PDF escaneado $dePaginas: el texto se sacó con OCR y puede tener errores.'
            : 'Documento escaneado: el texto se sacó con OCR y puede tener errores.';
      case 'docx':
        return 'Documento de Word (.docx).';
      case 'link':
        return 'Página web: se guardó el texto que tenía cuando se cargó.';
    }
    // Todavia no lo leyo (sin origen): se dice que es por el tipo.
    switch (tipo) {
      case 'pdf':
        return 'PDF.';
      case 'word':
        return 'Documento de Word.';
      case 'foto':
        return 'Foto.';
      case 'link':
        return 'Página web.';
      case 'nota':
        return 'Nota escrita en la app.';
      default:
        return 'Contenido del equipo.';
    }
  }

  /// 18422 -> "18.422", como se escriben los numeros en castellano.
  static String conPuntos(int n) {
    final String digitos = n.abs().toString();
    final StringBuffer salida = StringBuffer(n < 0 ? '-' : '');
    for (int i = 0; i < digitos.length; i++) {
      if (i > 0 && (digitos.length - i) % 3 == 0) salida.write('.');
      salida.write(digitos[i]);
    }
    return salida.toString();
  }
}
