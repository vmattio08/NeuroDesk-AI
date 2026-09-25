// ============================================================================
//  NeuroDesk AI — api/src/errores.js
//  LA FORMA UNICA DE ERROR + el catalogo cerrado de codigos.
//
//  POR QUE ESTE ARCHIVO EXISTE (esto va en la defensa oral):
//  En la v1 cada endpoint inventaba su propio error: uno devolvia
//  { error: "..." }, otro un string suelto, y cuando algo explotaba de verdad
//  Express respondia una pagina HTML con el stack trace adentro. Martin tenia
//  que escribir un if distinto por pantalla y, peor, el stack le mostraba al
//  cliente la ruta del servidor y pedazos de configuracion.
//
//  Ahora hay UNA sola forma, siempre igual, para los 26 codigos:
//      { ok: false, codigo: 'ALGO', mensaje: 'texto en castellano', detalle: null }
//  Martin escribe UNA sola funcion en Flutter: si (!body.ok) mostrar
//  body.mensaje, y ramificar por body.codigo (NUNCA por el texto del mensaje,
//  porque el texto lo podemos cambiar y el codigo no).
//
//  REGLA DURA DE LA V2 SOBRE 'detalle':
//  'detalle' se rellena SOLO cuando el texto lo escribimos nosotros a mano y
//  sabemos que es seguro ("el PDF pesa 14.2 MB", "la direccion apunta a una IP
//  privada"). En ERROR_INTERNO va HARDCODEADO en null: un error de
//  firebase-admin o de un fetch trae rutas del disco del servidor, hostnames
//  internos y a veces la propia configuracion. El err.stack completo va a
//  console.error (que en Render queda en el log) y NO viaja nunca al cliente.
// ============================================================================

// ----------------------------------------------------------------------------
// EL CATALOGO. Es CERRADO: si un codigo no esta aca, no existe.
// Cada entrada tiene el HTTP que le corresponde y el mensaje EXACTO que ve la
// persona. El mensaje esta escrito una sola vez, aca, para que la app, el panel
// y el backend digan literalmente lo mismo.
// ----------------------------------------------------------------------------
export const CATALOGO_DE_ERRORES = {
  // --- autenticacion ---
  FALTA_TOKEN: {
    http: 401,
    mensaje: 'Tenés que iniciar sesión para hacer esto.',
  },
  TOKEN_INVALIDO: {
    http: 401,
    mensaje: 'Tu sesión venció. Volvé a entrar.',
  },

  // --- permisos ---
  NO_ES_MIEMBRO: {
    http: 403,
    mensaje: 'No pertenecés a este espacio de trabajo.',
  },
  NO_ES_ADMIN: {
    http: 403,
    mensaje: 'Solo el administrador del espacio puede hacer esto.',
  },
  // Este codigo NO esta en la lista del contrato pero SI en el modelo de datos
  // (ciclo de vida del item) y es obligatorio: sin el, cualquier miembro
  // adjunta su archivo al item de otro y le pisa el contenido.
  NO_SOS_EL_AUTOR: {
    http: 403,
    mensaje: 'Solo el autor o un administrador pueden hacer esto.',
  },
  LIMITE_PLAN: {
    http: 403,
    mensaje: 'Llegaste al límite del plan gratuito. Pasá al plan Equipo para seguir.',
  },

  // --- datos que manda el cliente ---
  DATOS_INVALIDOS: {
    http: 400,
    mensaje: 'Faltan datos o están mal cargados. Revisá el formulario.',
  },
  URL_NO_PERMITIDA: {
    http: 400,
    mensaje: 'Esa dirección no se puede leer. Probá con un enlace público que empiece con https://',
  },
  ARCHIVO_FALTANTE: {
    http: 400,
    mensaje: 'No llegó el archivo. Elegilo de nuevo.',
  },
  ARCHIVO_MUY_GRANDE: {
    http: 413,
    mensaje: 'El archivo no puede pesar más de 10 MB.',
  },
  TIPO_NO_SOPORTADO: {
    http: 415,
    mensaje: 'Solo aceptamos PDF, JPG, PNG o WEBP.',
  },

  // --- no encontrado ---
  RUTA_NO_ENCONTRADA: {
    http: 404,
    mensaje: 'No pudimos completar la acción. Probá de nuevo en un rato.',
  },
  WORKSPACE_NO_ENCONTRADO: {
    http: 404,
    mensaje: 'Ese espacio de trabajo ya no existe.',
  },
  ITEM_NO_ENCONTRADO: {
    http: 404,
    mensaje: 'No encontramos ese contenido. Puede que lo hayan borrado.',
  },
  RESPUESTA_NO_ENCONTRADA: {
    http: 404,
    mensaje: 'Se perdió la consulta. Volvé a preguntar.',
  },
  USUARIO_NO_REGISTRADO: {
    http: 404,
    mensaje: 'Esa persona todavía no tiene cuenta en NeuroDesk. Pedile que se registre y volvé a invitarla.',
  },
  MIEMBRO_NO_ENCONTRADO: {
    http: 404,
    mensaje: 'Esa persona ya no está en el equipo.',
  },

  // --- conflictos de estado / reglas de negocio ---
  MIEMBRO_DUPLICADO: {
    http: 409,
    mensaje: 'Esa persona ya forma parte del equipo.',
  },
  ACCION_NO_PERMITIDA: {
    http: 409,
    mensaje: 'No se puede hacer eso con el dueño del espacio.',
  },
  ESTADO_INVALIDO: {
    http: 409,
    mensaje: 'Ese contenido no está listo para esta acción. Volvé a subir el archivo.',
  },
  // Igual que NO_SOS_EL_AUTOR: viene del modelo de datos (invariante 9), no de
  // la lista del contrato. Es el doble tap, y va a ser el error mas comun de la
  // demo. Tiene codigo PROPIO justamente para que el cliente lo distinga de un
  // ESTADO_INVALIDO de verdad y no le diga a la persona "volvé a subir el
  // archivo" cuando en realidad solo tiene que esperar tres segundos.
  PROCESO_EN_CURSO: {
    http: 409,
    mensaje: 'Ya lo estamos procesando, esperá unos segundos.',
  },

  // --- servicios de afuera ---
  NO_SE_PUDO_EXTRAER_TEXTO: {
    http: 422,
    mensaje: 'No pudimos leer el texto de ese archivo. Probá con una foto más nítida o un PDF con texto.',
  },
  SIN_CREDITOS_IA: {
    http: 402,
    mensaje: 'Se acabaron los créditos de la IA por este mes. Avisale al administrador.',
  },
  IA_NO_RESPONDE: {
    http: 503,
    mensaje: 'El servicio de IA no está respondiendo. Probá de nuevo en un minuto.',
  },
  DEMASIADOS_PEDIDOS: {
    http: 429,
    mensaje: 'Estás yendo muy rápido. Esperá unos segundos y probá de nuevo.',
  },

  // --- pagos (stretch goal) ---
  PAGOS_NO_DISPONIBLE: {
    http: 501,
    mensaje: 'Los pagos todavía no están disponibles.',
  },
  FIRMA_INVALIDA: {
    http: 401,
    mensaje: 'No pudimos validar la notificación de pago.',
  },

  // --- el ultimo recurso ---
  ERROR_INTERNO: {
    http: 500,
    mensaje: 'Algo salió mal de nuestro lado. Ya lo estamos viendo, probá de nuevo.',
  },
};

// ----------------------------------------------------------------------------
// ErrorApi: el unico error que las rutas tiran a proposito.
//
// Extiende Error (y no un objeto suelto) por dos motivos concretos:
//  1) se puede tirar con `throw` desde cualquier profundidad y Express 5 lo
//     lleva solo hasta el middleware de error, incluso adentro de un async;
//  2) conserva el stack para el log de Render.
// El 'mensaje' del catalogo se copia al .message del Error para que el log
// diga algo util, pero lo que viaja al cliente sale SIEMPRE del catalogo.
// ----------------------------------------------------------------------------
export class ErrorApi extends Error {
  constructor(codigo, detalle = null) {
    const entrada = CATALOGO_DE_ERRORES[codigo];
    // Si alguien escribe mal un codigo, preferimos que reviente ACA (en
    // desarrollo, con un mensaje claro) y no que el cliente reciba un
    // { codigo: undefined } que su switch no sabe manejar.
    if (!entrada) {
      throw new Error(
        `Codigo de error inexistente: "${codigo}". Agregalo al CATALOGO_DE_ERRORES de errores.js.`
      );
    }
    super(entrada.mensaje);
    this.name = 'ErrorApi';
    this.codigo = codigo;
    this.http = entrada.http;
    this.mensajeParaLaPersona = entrada.mensaje;
    // 'detalle' es opcional y SIEMPRE lo escribimos nosotros a mano.
    // Si viene undefined lo normalizamos a null: en el JSON, null es un valor
    // y undefined desaparece de la clave, y no queremos que la forma del error
    // cambie segun el caso.
    this.detalle = detalle ?? null;
  }
}

// Atajo para no escribir `throw new ErrorApi(...)` cincuenta veces.
// Se usa asi:  if (!snap.exists) fallar('ITEM_NO_ENCONTRADO');
export function fallar(codigo, detalle = null) {
  throw new ErrorApi(codigo, detalle);
}

// Arma el cuerpo JSON. Es UNA sola funcion para que la forma no se pueda
// desincronizar entre el middleware final, el 404 de ruta y /salud.
export function cuerpoDeError(codigo, detalle = null) {
  const entrada = CATALOGO_DE_ERRORES[codigo] ?? CATALOGO_DE_ERRORES.ERROR_INTERNO;
  return {
    ok: false,
    codigo: CATALOGO_DE_ERRORES[codigo] ? codigo : 'ERROR_INTERNO',
    mensaje: entrada.mensaje,
    detalle: detalle ?? null,
  };
}

// Responde el error ya armado. El status HTTP y el campo ok SIEMPRE concuerdan:
// nunca un 200 con un error adentro, nunca un 500 con ok:true.
export function responderError(res, codigo, detalle = null) {
  const entrada = CATALOGO_DE_ERRORES[codigo] ?? CATALOGO_DE_ERRORES.ERROR_INTERNO;
  return res.status(entrada.http).json(cuerpoDeError(codigo, detalle));
}

// Para el middleware final: distingue "error nuestro, ya clasificado" de
// "excepcion inesperada". Chequeamos la propiedad y no `instanceof`, porque si
// alguna vez el archivo se carga dos veces (dos copias del modulo en memoria)
// el instanceof da false y perderiamos la clasificacion.
export function esErrorApi(err) {
  return Boolean(err && err.codigo && CATALOGO_DE_ERRORES[err.codigo]);
}
