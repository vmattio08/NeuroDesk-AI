// ============================================================================
//  api.dart — el UNICO lugar de la app que habla con nuestro backend
//
//  Regla del contrato: "una funcion pedir() envuelve todos los llamados".
//  Ninguna pantalla arma una URL, ni pone el header Authorization, ni parsea
//  un JSON. Todas llaman a Api.algo() y reciben SIEMPRE un RespuestaApi, que
//  nunca es null y nunca tira una excepcion.
//
//  POR QUE NUNCA TIRA EXCEPCION: si cada pantalla tuviera que atrapar
//  SocketException, TimeoutException, FormatException y ClientException por
//  separado, alguna se iba a olvidar de una y eso es la pantalla roja de
//  Flutter en el medio de la defensa. Aca las atrapamos todas y las
//  convertimos a la MISMA forma de error del contrato:
//      { ok:false, codigo:'ALGO', mensaje:'texto en castellano', detalle:null }
//  Los codigos que inventa el cliente (no vienen del backend) son
//  SIN_CONEXION, SIGUE_PROCESANDO y RESPUESTA_RARA, y FALTA_TOKEN cuando no
//  hay sesion (o el token no se puede renovar por algo que NO es la red:
//  sin red es SIN_CONEXION).
// ============================================================================

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
// MediaType es el tipo que pide http.MultipartFile para decir que es cada
// archivo. Viene del paquete http_parser, que ya bajaba 'http' por su cuenta:
// figura en el pubspec solo para poder importarlo (ver el comentario ahi).
import 'package:http_parser/http_parser.dart' show MediaType;

import 'auth_servicio.dart';

/// Un archivo listo para mandar al backend: su nombre, sus BYTES y su tipo.
///
/// POR QUE BYTES Y NO UN File: File es de dart:io, que en el navegador no
/// existe (la app tambien compila para la web). Con los bytes en la mano el
/// mismo codigo sirve en Android y en la web: image_picker los da con
/// XFile.readAsBytes() y file_picker con PlatformFile.bytes.
class ArchivoParaSubir {
  const ArchivoParaSubir({
    required this.nombre,
    required this.bytes,
    required this.tipoMime,
  });

  /// El nombre con su extension ("cronograma.pdf"). El backend lo usa para
  /// la etiqueta de la parte (PDF «cronograma.pdf») en un item 'mixto'.
  final String nombre;
  final Uint8List bytes;

  /// "application/pdf", "image/jpeg"... (ver Api.tipoMimeDe).
  final String tipoMime;

  int get tamano => bytes.length;
}

/// Lo que devuelve CUALQUIER llamado al backend.
///
/// Es la forma unica del contrato metida en una clase: `ok` para saber si
/// salio bien, `codigo` para decidir por codigo (NUNCA por el texto del
/// mensaje: el texto puede cambiar y el codigo no) y `mensaje` para mostrarle
/// a la persona tal cual, sin tocarlo.
class RespuestaApi {
  const RespuestaApi({
    required this.ok,
    required this.codigoHttp,
    this.datos = const <String, dynamic>{},
    this.codigo = '',
    this.mensaje = '',
    this.detalle,
    this.esperarSegundos,
  });

  /// true si el backend respondio { "ok": true }.
  final bool ok;

  /// El codigo HTTP (200, 403, 500...). 0 cuando ni siquiera hubo respuesta.
  final int codigoHttp;

  /// El cuerpo completo ya parseado, para leer datos del exito
  /// (por ejemplo datos['item']['cantChunks']).
  final Map<String, dynamic> datos;

  /// Codigo del catalogo cerrado: NO_ES_MIEMBRO, ESTADO_INVALIDO, etc.
  final String codigo;

  /// Texto en castellano, ya listo para el SnackBar.
  final String mensaje;

  /// Info tecnica opcional. Va al log, NO a la pantalla.
  final String? detalle;

  /// Segundos del header Retry-After cuando el backend nos frena (429).
  final int? esperarSegundos;

  /// La sesion se vencio: hay que cerrar sesion y mandar al login.
  bool get sesionVencida => codigo == 'TOKEN_INVALIDO' || codigo == 'FALTA_TOKEN';

  /// Lo sacaron del workspace (o el token todavia no tiene el claim).
  bool get noEsMiembro => codigo == 'NO_ES_MIEMBRO';

  /// Va demasiado rapido: el boton se deshabilita unos segundos.
  bool get vaMuyRapido => codigo == 'DEMASIADOS_PEDIDOS';

  /// El pedido tardo mas de la cuenta. NO es un error: el backend puede seguir
  /// trabajando y el StreamBuilder del documento nos va a avisar como termino.
  bool get sigueProcesando => codigo == 'SIGUE_PROCESANDO';
}

class Api {
  // --------------------------------------------------------------------------
  // La URL del backend viene de afuera, nunca hardcodeada en las pantallas:
  //   flutter run --dart-define=API_URL=https://neurodesk-api-u97j.onrender.com
  // El default es 10.0.2.2, que es como el emulador de Android ve el localhost
  // de la computadora ('localhost' adentro del emulador es el emulador mismo).
  // --------------------------------------------------------------------------
  static const String urlBase = String.fromEnvironment(
    'API_URL',
    defaultValue: 'http://10.0.2.2:8080',
  );

  // Timeouts. Render free DUERME a los 15 minutos y el primer pedido tarda
  // entre 30 y 60 segundos, asi que 10 segundos (el default) no alcanza.
  static const Duration _timeoutNormal = Duration(seconds: 30);
  static const Duration _timeoutLargo = Duration(seconds: 90); // procesar/preguntar

  // --------------------------------------------------------------------------
  // GET /salud — despertar a Render
  // Se llama apenas arranca la app, en segundo plano y sin await, para que
  // cuando la persona suba su primer item el servidor ya este despierto.
  // Si falla no pasa nada: es solo un empujon.
  // --------------------------------------------------------------------------
  static Future<void> despertarBackend() async {
    try {
      await http
          .get(Uri.parse('$urlBase/salud'))
          .timeout(const Duration(seconds: 75));
    } catch (_) {
      // A proposito vacio: que el servidor este dormido no es un error que la
      // persona tenga que ver.
    }
  }

  // --------------------------------------------------------------------------
  // POST /v1/auth/registro — crea usuarios/{uid}
  // Es la UNICA forma de crear ese documento (las reglas tienen
  // allow create: if false). Si esto falla, el usuario queda logueado pero sin
  // ficha, asi que la app lo reintenta antes de dejarlo entrar.
  // --------------------------------------------------------------------------
  static Future<RespuestaApi> registrarUsuario(String nombre) {
    return _pedir(
      metodo: 'POST',
      ruta: '/v1/auth/registro',
      cuerpo: <String, dynamic>{'nombre': nombre},
    );
  }

  // --------------------------------------------------------------------------
  // POST /v1/workspaces/:wsId/items/:itemId/procesar
  //
  // OJO CON EL ORDEN: cuando esto se llama, el item YA EXISTE en Firestore,
  // creado por la app en estado 'pendiente'. Este endpoint solo lo actualiza.
  // El backend nunca crea el item.
  //
  // Que viaja segun el tipo del item:
  //   'nota' y 'link'        -> nada: POST comun. El backend lee el texto del
  //                             propio documento (textoOriginal / url).
  //   'pdf', 'word', 'foto'  -> [archivo]: multipart con UNA parte 'archivo'.
  //   'mixto'                -> [archivos]: multipart con 0 a 8 partes
  //                             'archivos' y SIN la parte 'archivo'. Va
  //                             multipart aunque sea una lista vacia (texto y
  //                             links solos): asi lo pide el contrato. El
  //                             texto y los links los lee del documento.
  // --------------------------------------------------------------------------
  static Future<RespuestaApi> procesarItem({
    required String wsId,
    required String itemId,
    ArchivoParaSubir? archivo,
    List<ArchivoParaSubir>? archivos,
  }) async {
    final String ruta = '/v1/workspaces/$wsId/items/$itemId/procesar';

    // Sin archivos (nota o link): es un POST comun.
    if (archivo == null && archivos == null) {
      return _pedir(metodo: 'POST', ruta: ruta, timeout: _timeoutLargo);
    }

    try {
      // Sin red y con el token vencido, tokenParaElBackend tira el error de
      // red y el catch de abajo lo vuelve SIN_CONEXION (ver _pedir).
      final String? token = await AuthServicio.tokenParaElBackend();
      if (token == null) return _errorLocal('FALTA_TOKEN', 'Tenés que iniciar sesión para hacer esto.');

      final http.MultipartRequest pedido = armarMultipart(
        url: Uri.parse('$urlBase$ruta'),
        token: token,
        archivo: archivo,
        archivos: archivos,
      );

      final http.StreamedResponse cruda = await pedido.send().timeout(_timeoutLargo);
      final http.Response respuesta = await http.Response.fromStream(cruda);
      return _interpretar(respuesta);
    } on TimeoutException {
      return _errorLocal(
        'SIGUE_PROCESANDO',
        'Está tardando. El archivo sigue procesándose: mirá el estado en la lista.',
      );
    } catch (e) {
      return _errorDeRed(e);
    }
  }

  /// El pedido multipart de /procesar, armado pero SIN mandar. Aparte y
  /// publico para probar en la compu que partes lleva (test/carga_test.dart).
  ///
  /// NO se escribe el header Content-Type a mano: http.MultipartRequest le
  /// pone el boundary correcto solo. Si lo escribimos nosotros, el backend no
  /// encuentra donde empieza cada parte.
  ///
  /// Cada parte lleva el nombre del archivo y su tipo. El backend igual mira
  /// los primeros bytes para saber que es de verdad (no le cree al cliente),
  /// pero el nombre lo necesita para la etiqueta de la parte, y sin tipo un
  /// archivo armado con bytes viajaria como application/octet-stream.
  static http.MultipartRequest armarMultipart({
    required Uri url,
    required String token,
    ArchivoParaSubir? archivo,
    List<ArchivoParaSubir>? archivos,
  }) {
    final http.MultipartRequest pedido = http.MultipartRequest('POST', url);
    pedido.headers['Authorization'] = 'Bearer $token';
    http.MultipartFile parte(String campo, ArchivoParaSubir a) {
      return http.MultipartFile.fromBytes(
        campo,
        a.bytes,
        filename: a.nombre,
        contentType: MediaType.parse(a.tipoMime),
      );
    }

    // 'archivo' (uno solo) para pdf/word/foto; 'archivos' (0 a 8) para el
    // 'mixto'. Los nombres de las partes son los del contrato, tal cual.
    if (archivo != null) pedido.files.add(parte('archivo', archivo));
    for (final ArchivoParaSubir a in archivos ?? const <ArchivoParaSubir>[]) {
      pedido.files.add(parte('archivos', a));
    }
    return pedido;
  }

  /// El tipo MIME segun la extension del nombre. Lo que no conocemos va como
  /// application/octet-stream ("bytes sin tipo"): el backend decide igual.
  static String tipoMimeDe(String nombre) {
    final String n = nombre.trim().toLowerCase();
    final int punto = n.lastIndexOf('.');
    final String ext = punto < 0 ? '' : n.substring(punto + 1);
    switch (ext) {
      case 'pdf':
        return 'application/pdf';
      case 'docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'webp':
        return 'image/webp';
      case 'gif':
        return 'image/gif';
      case 'heic':
        return 'image/heic';
      default:
        return 'application/octet-stream';
    }
  }

  // --------------------------------------------------------------------------
  // POST /v1/workspaces/:wsId/items/:itemId/reprocesar
  // El boton "Reintentar" / "Volver a indexar". No manda el archivo: usa lo
  // que ya esta guardado en el documento (textoOriginal, url o texto).
  // --------------------------------------------------------------------------
  static Future<RespuestaApi> reprocesarItem({
    required String wsId,
    required String itemId,
  }) {
    return _pedir(
      metodo: 'POST',
      ruta: '/v1/workspaces/$wsId/items/$itemId/reprocesar',
      cuerpo: const <String, dynamic>{},
      timeout: _timeoutLargo,
    );
  }

  // --------------------------------------------------------------------------
  // DELETE /v1/workspaces/:wsId/items/:itemId
  // El unico camino para borrar: las reglas tienen allow delete: if false,
  // porque borrar el item desde el cliente dejaria vivos sus chunks (con el
  // texto de la nota adentro) y la IA los podria seguir citando.
  // --------------------------------------------------------------------------
  static Future<RespuestaApi> borrarItem({
    required String wsId,
    required String itemId,
  }) {
    return _pedir(metodo: 'DELETE', ruta: '/v1/workspaces/$wsId/items/$itemId');
  }

  // --------------------------------------------------------------------------
  // PATCH /v1/workspaces/:wsId/items/:itemId/visibilidad   (candado en vivo)
  // body { visibilidad: 'equipo' | 'privado' } -> 200 { ok, visibilidad }
  //
  // POR QUE POR EL BACKEND si la regla deja que el autor cambie el campo:
  // cada fragmento (chunk) del item guarda una COPIA de la visibilidad, que el
  // buscador usa como segunda cerradura, y los chunks solo los toca el
  // backend. Si la app cambiara solo el item, al compartir una nota la IA se
  // la seguiria escondiendo al equipo. El backend cambia el item y todos sus
  // fragmentos en el orden seguro (para abrir: primero los fragmentos; para
  // cerrar: primero el item) y deja el evento 'item.visibilidad'.
  //
  // Solo el autor comparte con el equipo; el autor o un admin pasan a
  // privado. Si no: NO_SOS_EL_AUTOR. Procesandose: PROCESO_EN_CURSO.
  // --------------------------------------------------------------------------
  static Future<RespuestaApi> cambiarVisibilidad({
    required String wsId,
    required String itemId,
    required String visibilidad,
  }) {
    return _pedir(
      metodo: 'PATCH',
      ruta: '/v1/workspaces/$wsId/items/$itemId/visibilidad',
      cuerpo: <String, dynamic>{'visibilidad': visibilidad},
    );
  }

  // --------------------------------------------------------------------------
  // POST /v1/workspaces/:wsId/preguntar
  // Igual que con los items: el documento de la respuesta lo crea la app en
  // estado 'buscando' y este endpoint solo lo completa.
  // --------------------------------------------------------------------------
  static Future<RespuestaApi> preguntar({
    required String wsId,
    required String respId,
    required String pregunta,
  }) {
    return _pedir(
      metodo: 'POST',
      ruta: '/v1/workspaces/$wsId/preguntar',
      cuerpo: <String, dynamic>{'respId': respId, 'pregunta': pregunta},
      timeout: _timeoutLargo,
    );
  }

  // ==========================================================================
  // LA FUNCION UNICA. Todo lo de arriba pasa por aca.
  // ==========================================================================
  static Future<RespuestaApi> _pedir({
    required String metodo,
    required String ruta,
    Map<String, dynamic>? cuerpo,
    Duration timeout = _timeoutNormal,
  }) async {
    try {
      // 1) El ID token. Lo pide fresco a firebase_auth, que lo renueva solo si
      //    esta por vencer (dura 1 hora). Si hay que renovarlo y NO hay red,
      //    tokenParaElBackend tira el error de red y el catch de abajo lo
      //    vuelve SIN_CONEXION: un corte de senal no es una sesion vencida, y
      //    con FALTA_TOKEN la app cerraba la sesion. null = no hay sesion.
      final String? token = await AuthServicio.tokenParaElBackend();
      if (token == null) {
        return _errorLocal('FALTA_TOKEN', 'Tenés que iniciar sesión para hacer esto.');
      }

      final Uri url = Uri.parse('$urlBase$ruta');
      final Map<String, String> cabeceras = <String, String>{
        'Authorization': 'Bearer $token',
        if (cuerpo != null) 'Content-Type': 'application/json',
      };
      final String? cuerpoJson = cuerpo == null ? null : jsonEncode(cuerpo);

      // 2) El pedido, con timeout SIEMPRE (sin timeout, si Render no contesta
      //    la app se queda colgada para siempre con el spinner girando).
      final http.Response respuesta;
      if (metodo == 'POST') {
        respuesta = await http
            .post(url, headers: cabeceras, body: cuerpoJson)
            .timeout(timeout);
      } else if (metodo == 'PATCH') {
        // PATCH = "cambia UNA parte de algo que ya existe" (el candado de un
        // item). Lleva cuerpo JSON igual que el POST.
        respuesta = await http
            .patch(url, headers: cabeceras, body: cuerpoJson)
            .timeout(timeout);
      } else if (metodo == 'DELETE') {
        respuesta = await http.delete(url, headers: cabeceras).timeout(timeout);
      } else {
        respuesta = await http.get(url, headers: cabeceras).timeout(timeout);
      }

      return _interpretar(respuesta);
    } on TimeoutException {
      // El contrato lo dice con todas las letras: un timeout NO es un error.
      // El backend puede seguir trabajando; la fuente de verdad es el
      // documento de Firestore, que el StreamBuilder ya esta escuchando.
      return _errorLocal(
        'SIGUE_PROCESANDO',
        'Está tardando más de lo normal. Seguí en la lista: te avisa cuando termina.',
      );
    } catch (e) {
      return _errorDeRed(e);
    }
  }

  /// Convierte la respuesta HTTP cruda en un RespuestaApi.
  static RespuestaApi _interpretar(http.Response respuesta) {
    Map<String, dynamic> cuerpo;
    try {
      final Object? decodificado = jsonDecode(respuesta.body);
      // Si el backend devolvio un HTML de error de Express o un string suelto,
      // el jsonDecode puede andar pero no darnos un mapa.
      if (decodificado is! Map<String, dynamic>) throw const FormatException();
      cuerpo = decodificado;
    } catch (_) {
      return _errorLocal(
        'RESPUESTA_RARA',
        'El servidor contestó algo que no entendemos. Probá de nuevo en un rato.',
        codigoHttp: respuesta.statusCode,
      );
    }

    final bool ok = cuerpo['ok'] == true;
    if (ok) {
      return RespuestaApi(ok: true, codigoHttp: respuesta.statusCode, datos: cuerpo);
    }

    // Camino de error del contrato. El mensaje YA viene en castellano y listo
    // para mostrar: no lo reescribimos ni le agregamos el numero de HTTP.
    return RespuestaApi(
      ok: false,
      codigoHttp: respuesta.statusCode,
      datos: cuerpo,
      codigo: (cuerpo['codigo'] ?? 'ERROR_INTERNO').toString(),
      mensaje: (cuerpo['mensaje'] ??
              'Algo salió mal de nuestro lado. Probá de nuevo.')
          .toString(),
      detalle: cuerpo['detalle']?.toString(),
      esperarSegundos: int.tryParse(respuesta.headers['retry-after'] ?? ''),
    );
  }

  /// No hubo respuesta: no hay internet, DNS caido, Render apagado, etc.
  static RespuestaApi _errorDeRed(Object e) {
    // El detalle tecnico va al log de nosotros, nunca a la pantalla.
    return _errorLocal(
      'SIN_CONEXION',
      'No hay conexión con el servidor. Revisá tu internet y probá de nuevo.',
      detalle: e.toString(),
    );
  }

  /// Arma un error con la MISMA forma que los del backend, para que las
  /// pantallas no tengan que distinguir de donde vino.
  static RespuestaApi _errorLocal(
    String codigo,
    String mensaje, {
    int codigoHttp = 0,
    String? detalle,
  }) {
    return RespuestaApi(
      ok: false,
      codigoHttp: codigoHttp,
      codigo: codigo,
      mensaje: mensaje,
      detalle: detalle,
    );
  }
}
