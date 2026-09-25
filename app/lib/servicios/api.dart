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
//  SIN_CONEXION, SIGUE_PROCESANDO y RESPUESTA_RARA.
// ============================================================================

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;

import 'auth_servicio.dart';

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
  //   flutter run --dart-define=API_URL=https://neurodesk-api.onrender.com
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
  // 'archivo' va SOLO para tipo 'pdf' y 'foto'. Para 'nota' y 'link' el
  // backend lee el texto del propio documento (textoOriginal / url).
  // --------------------------------------------------------------------------
  static Future<RespuestaApi> procesarItem({
    required String wsId,
    required String itemId,
    File? archivo,
  }) async {
    final String ruta = '/v1/workspaces/$wsId/items/$itemId/procesar';

    // Sin archivo (nota o link): es un POST comun.
    if (archivo == null) {
      return _pedir(metodo: 'POST', ruta: ruta, timeout: _timeoutLargo);
    }

    // Con archivo: multipart. NO se escribe el header Content-Type a mano;
    // http.MultipartRequest le pone el boundary correcto solo. Si lo
    // escribimos nosotros, el backend no encuentra donde empieza cada parte.
    try {
      final String? token = await AuthServicio.tokenActual();
      if (token == null) return _errorLocal('FALTA_TOKEN', 'Tenes que iniciar sesion para hacer esto.');

      final http.MultipartRequest pedido =
          http.MultipartRequest('POST', Uri.parse('$urlBase$ruta'));
      pedido.headers['Authorization'] = 'Bearer $token';
      // El nombre de la parte es 'archivo', tal cual lo espera el contrato.
      pedido.files.add(await http.MultipartFile.fromPath('archivo', archivo.path));

      final http.StreamedResponse cruda = await pedido.send().timeout(_timeoutLargo);
      final http.Response respuesta = await http.Response.fromStream(cruda);
      return _interpretar(respuesta);
    } on TimeoutException {
      return _errorLocal(
        'SIGUE_PROCESANDO',
        'Esta tardando. El archivo sigue procesandose: mira el estado en la lista.',
      );
    } catch (e) {
      return _errorDeRed(e);
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
      //    esta por vencer (dura 1 hora).
      final String? token = await AuthServicio.tokenActual();
      if (token == null) {
        return _errorLocal('FALTA_TOKEN', 'Tenes que iniciar sesion para hacer esto.');
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
        'Esta tardando mas de lo normal. Segui en la lista: te avisa cuando termina.',
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
        'El servidor contesto algo que no entendemos. Proba de nuevo en un rato.',
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
              'Algo salio mal de nuestro lado. Proba de nuevo.')
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
      'No hay conexion con el servidor. Revisa tu internet y proba de nuevo.',
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
