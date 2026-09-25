// ============================================================================
//  pantallas/items.js  —  la tabla EN VIVO de todo el conocimiento del equipo.
//  Panel web de NeuroDesk AI.
//
//  Es la pantalla que se muestra en la demo: alguien sube una foto desde el
//  celular y la fila aparece sola en el proyector, en gris "Pendiente", pasa a
//  amarillo "Procesando" y termina en verde "Listo". Nadie toca F5.
//
//  COMO FUNCIONA, EN UNA FRASE: un onSnapshot sobre
//  workspaces/{wsId}/items deja SIEMPRE actualizado el array `itemsCrudos`, y
//  cada vez que ese array cambia (o cambia un filtro) se vuelve a dibujar el
//  <tbody>. Firestore es la fuente de verdad; el panel solo la dibuja.
//
//  Toda pantalla del panel exporta lo mismo:
//     mount(contenedor, ctx)  -> dibuja y engancha los listeners
//     unmount()               -> CORTA los listeners
//  El unmount NO es opcional: si el admin va y vuelve diez veces entre
//  pantallas, quedan diez onSnapshot vivos escuchando la misma coleccion y
//  cada cambio se cobra diez veces. En el plan gratuito de Firestore (50.000
//  lecturas por dia) eso se nota el mismo dia.
// ============================================================================

import {
  db, collection, query, where, orderBy, limit, onSnapshot, getDocs
} from '../firebase.js';

import { esc, fechaCorta, haceCuanto, normalizar, uidCorto } from '../util.js';


// ----------------------------------------------------------------------------
// Estado del modulo. Son variables de archivo, no globales del navegador:
// nadie de afuera las ve, y unmount() las limpia.
// ----------------------------------------------------------------------------
let cortarEscucha = null;   // la funcion que devuelve onSnapshot para darse de baja
let raiz = null;            // el <div> donde dibujamos
let ctxPantalla = null;     // { wsId, uid, ... } que nos pasa el shell
let itemsCrudos = [];       // lo ultimo que llego de Firestore, SIN filtrar
let nombrePorUid = {};      // uid -> nombre, para no mostrar uids pelados
let desdeCache = false;     // ultimo valor de metadata.fromCache

// Filtros. El de estado se aplica EN EL SERVIDOR (es un where de la query);
// los otros tres, en memoria. El porque esta en el comentario de escuchar().
let filtroEstado      = 'todos';
let filtroTipo        = 'todos';
let filtroVisibilidad = 'todas';
let textoBuscado      = '';

// Cuantas filas pedimos. 200 es el tope del plan free por workspace, asi que
// en la practica se ven todas. Si algun dia hay mas, la tabla avisa abajo que
// esta mostrando las 200 mas nuevas. El .limit() NO es opcional: sin el, un
// workspace grande se baja entero en cada carga y son lecturas facturadas.
const TOPE_FILAS = 200;


// ============================================================================
//  MOUNT
// ============================================================================
export async function mount(contenedor, ctx) {
  raiz = contenedor;
  ctxPantalla = ctx;

  raiz.innerHTML = plantilla();
  engancharFiltros();

  // Los nombres de los miembros se leen UNA VEZ, con getDocs, y NO con un
  // onSnapshot. Por que: la lista de miembros de un workspace cambia una vez
  // por semana, y un segundo stream vivo son mas lecturas por cada cambio,
  // para actualizar una columna que casi nunca se mueve. Si alguien entra al
  // equipo mientras miramos la tabla, su nombre aparece la proxima vez que
  // entremos a esta pantalla. Es un intercambio consciente, no un olvido.
  await cargarNombres();

  escuchar();
}


// ============================================================================
//  UNMOUNT  —  cortar TODO lo que quedo escuchando.
// ============================================================================
export function unmount() {
  if (cortarEscucha) {
    cortarEscucha();      // esta llamada es la que deja de gastar lecturas
    cortarEscucha = null;
  }
  itemsCrudos = [];
  nombrePorUid = {};
  raiz = null;
  ctxPantalla = null;
}


// ============================================================================
//  LA QUERY EN VIVO
// ============================================================================
function escuchar() {
  // Si ya habia una escucha (porque cambiaron el filtro de estado), se corta
  // antes de abrir la nueva. Sin esta linea se van acumulando.
  if (cortarEscucha) cortarEscucha();

  const coleccionItems = collection(db, 'workspaces', ctxPantalla.wsId, 'items');

  // --------------------------------------------------------------------
  // DONDE SE FILTRA CADA COSA, Y POR QUE (pregunta segura en la defensa)
  //
  // EN EL SERVIDOR (where): el ESTADO.
  //   Es un campo cerrado (cuatro valores), tiene indice compuesto en
  //   firebase/firestore.indexes.json —(estado ASC, creadoEn DESC)— y
  //   filtrar alla significa que Firestore nos manda 12 documentos en vez de
  //   200. Menos lecturas facturadas y menos datos por la red.
  //
  // EN MEMORIA (JavaScript): el BUSCADOR, el TIPO y la VISIBILIDAD.
  //   El buscador NO puede ir al servidor: Firestore no tiene "contiene
  //   texto", solo igualdad y rangos. Se haria con un servicio de busqueda
  //   aparte, que no esta en el alcance del proyecto.
  //   Tipo y visibilidad SI podrian ir al servidor, pero cada combinacion
  //   nueva pide su propio indice compuesto y, sobre todo, cada cambio de
  //   filtro seria una query nueva = 200 lecturas mas. Como ya tenemos las
  //   filas en memoria, filtrarlas ahi es gratis e instantaneo.
  //
  // POR QUE EL ADMIN PUEDE LISTAR SIN NINGUN where:
  //   Las reglas NO filtran: evaluan la regla contra CADA documento que la
  //   query devolveria y, si uno solo no pasa, cae la query ENTERA con
  //   permission-denied. Para un miembro comun eso obliga a dos queries
  //   separadas (where visibilidad == 'equipo' y where creadoPor == miUid),
  //   que es lo que hace la app Flutter. Para un ADMIN, en cambio,
  //   puedeLeerItem() da true en el primer termino (esAdmin) sin mirar el
  //   documento, asi que puede pedir la coleccion completa. ESA es la
  //   diferencia de rol que se muestra en la demo, y por eso este panel
  //   existe.
  // --------------------------------------------------------------------
  const condiciones = [];

  if (filtroEstado !== 'todos') {
    condiciones.push(where('estado', '==', filtroEstado));
  }

  const consulta = query(
    coleccionItems,
    ...condiciones,
    orderBy('creadoEn', 'desc'),   // lo mas nuevo arriba
    limit(TOPE_FILAS)
  );

  mostrarError(null);

  cortarEscucha = onSnapshot(
    consulta,

    // includeMetadataChanges: true  ->  SIN ESTO EL BADGE NO ANDA.
    // Por defecto, onSnapshot solo avisa cuando cambian los DATOS. Cuando el
    // navegador se queda sin internet, los datos siguen siendo los mismos:
    // lo unico que cambia es metadata.fromCache, y esa notificacion no llega.
    // Con esta opcion, tambien nos avisa de los cambios de metadata y el
    // badge "En vivo" / "Sin conexion" reacciona de verdad.
    { includeMetadataChanges: true },

    (foto) => {
      desdeCache = foto.metadata.fromCache;

      itemsCrudos = foto.docs.map((d) => ({ id: d.id, ...d.data() }));

      dibujarBadge();
      dibujarTabla();
    },

    (e) => {
      // Los onSnapshot TAMBIEN fallan, y si no le pasamos este tercer
      // argumento el error se pierde en la consola y la tabla queda vacia
      // para siempre sin decir por que.
      console.error('[items] se corto la escucha', e);
      mostrarError(explicarErrorFirestore(e));
    }
  );
}


// ----------------------------------------------------------------------------
// Los nombres de los miembros, de una sola lectura.
// ----------------------------------------------------------------------------
async function cargarNombres() {
  try {
    const foto = await getDocs(
      collection(db, 'workspaces', ctxPantalla.wsId, 'members')
    );
    nombrePorUid = {};
    foto.forEach((d) => { nombrePorUid[d.id] = d.data().nombre || d.data().email; });
  } catch (e) {
    // Si falla, la columna Autor muestra uids cortados. Feo, pero la tabla
    // sigue funcionando: los nombres no valen romper la pantalla entera.
    console.warn('[items] no pude leer los miembros', e);
  }
}


// ============================================================================
//  DIBUJO
// ============================================================================

function plantilla() {
  return `
    <div class="encabezado">
      <div>
        <h1>Contenido del espacio</h1>
        <p class="apagado chico">
          Todo lo que cargó el equipo, en tiempo real. Como administrador ves
          también los items marcados como privados.
        </p>
      </div>
      <div id="badgeVivo"></div>
    </div>

    <div id="errorItems"></div>

    <div class="filtros">
      <div class="campo campo-buscador">
        <label for="buscador">Buscar por título, archivo o autor</label>
        <input type="search" id="buscador" placeholder="Ej: cronograma">
      </div>

      <div class="campo">
        <label for="filtroEstado">Estado <span class="apagado">(servidor)</span></label>
        <select id="filtroEstado">
          <option value="todos">Todos</option>
          <option value="pendiente">Pendiente</option>
          <option value="procesando">Procesando</option>
          <option value="listo">Listo</option>
          <option value="error">Error</option>
        </select>
      </div>

      <div class="campo">
        <label for="filtroTipo">Tipo</label>
        <select id="filtroTipo">
          <option value="todos">Todos</option>
          <option value="nota">Nota</option>
          <option value="pdf">PDF</option>
          <option value="link">Link</option>
          <option value="foto">Foto</option>
        </select>
      </div>

      <div class="campo">
        <label for="filtroVisibilidad">Visibilidad</label>
        <select id="filtroVisibilidad">
          <option value="todas">Todas</option>
          <option value="equipo">Del equipo</option>
          <option value="privado">Privado</option>
        </select>
      </div>
    </div>

    <div class="caja-tabla">
      <table>
        <thead>
          <tr>
            <th>Título</th>
            <th>Tipo</th>
            <th>Estado</th>
            <th>Visibilidad</th>
            <th>Autor</th>
            <th class="numero">Trozos</th>
            <th>Creado</th>
          </tr>
        </thead>
        <tbody id="cuerpoTabla"></tbody>
      </table>
    </div>

    <p class="resumen-filtro" id="resumen"></p>
  `;
}


function engancharFiltros() {
  const $ = (id) => raiz.querySelector('#' + id);

  // El buscador y los dos filtros de memoria solo redibujan: no tocan
  // Firestore, no cuestan nada, y por eso pueden reaccionar en cada tecla.
  $('buscador').addEventListener('input', (e) => {
    textoBuscado = e.target.value;
    dibujarTabla();
  });

  $('filtroTipo').addEventListener('change', (e) => {
    filtroTipo = e.target.value;
    dibujarTabla();
  });

  $('filtroVisibilidad').addEventListener('change', (e) => {
    filtroVisibilidad = e.target.value;
    dibujarTabla();
  });

  // El de estado, en cambio, cambia la QUERY: hay que rearmar la escucha.
  $('filtroEstado').addEventListener('change', (e) => {
    filtroEstado = e.target.value;
    escuchar();
  });
}


// ----------------------------------------------------------------------------
// El badge "En vivo" / "Sin conexion", leyendo metadata.fromCache.
//
// QUE SIGNIFICA fromCache EXACTAMENTE (y que NO significa):
//   true  -> estos datos salieron de la cache local (IndexedDB) y el SDK
//            todavia no confirmo con el servidor. Pasa al recargar la pagina
//            (la primera foto siempre es de cache, y es lo que hace que la
//            tabla aparezca instantanea) y pasa cuando se corta internet.
//   false -> el SDK esta conectado y esto es lo que hay en el servidor.
//
// O sea que fromCache: true por un instante al cargar es NORMAL, no es un
// error. Lo que importa es que quede en false enseguida; si se queda en true,
// ahi si no hay conexion con Firestore.
// ----------------------------------------------------------------------------
function dibujarBadge() {
  const caja = raiz?.querySelector('#badgeVivo');
  if (!caja) return;

  caja.innerHTML = desdeCache
    ? `<span class="badge-vivo cache" title="Estos datos salieron de la memoria del navegador. Puede que no haya internet.">
         <span class="punto"></span> Sin conexión
       </span>`
    : `<span class="badge-vivo vivo" title="Escuchando Firestore: los cambios aparecen solos.">
         <span class="punto"></span> En vivo
       </span>`;
}


function dibujarTabla() {
  const cuerpo = raiz?.querySelector('#cuerpoTabla');
  if (!cuerpo) return;

  const visibles = filtrarEnMemoria(itemsCrudos);

  if (visibles.length === 0) {
    cuerpo.innerHTML = `
      <tr><td colspan="7" class="vacio">
        ${itemsCrudos.length === 0
          ? 'Todavía no hay nada cargado en este espacio de trabajo.'
          : 'Ningún item coincide con lo que buscaste.'}
      </td></tr>`;
  } else {
    // .join('') y un solo innerHTML: tocar el DOM 200 veces es lento y se
    // nota. Asi se arma todo el HTML como texto y se pega de una.
    cuerpo.innerHTML = visibles.map(fila).join('');
  }

  const resumen = raiz.querySelector('#resumen');
  resumen.textContent =
    `Mostrando ${visibles.length} de ${itemsCrudos.length} items` +
    (itemsCrudos.length >= TOPE_FILAS
      ? ` (solo se traen los ${TOPE_FILAS} más nuevos)`
      : '');
}


// ----------------------------------------------------------------------------
// UNA FILA.
//
// ACA ES DONDE IMPORTA esc(). Absolutamente TODO lo que sale del documento de
// Firestore —titulo, nombreArchivo, url, errorMsg, el nombre del autor— lo
// escribio otra persona desde la app, y va adentro de un innerHTML. Sin esc(),
// un titulo con <img src=x onerror=...> ejecuta codigo en el navegador DEL
// ADMIN. No hay ni una interpolacion en esta funcion sin esc().
// ----------------------------------------------------------------------------
function fila(item) {
  const autor = nombrePorUid[item.creadoPor] || uidCorto(item.creadoPor);

  // Segunda linea del titulo: el nombre del archivo o el link de origen.
  let sub = '';
  if (item.nombreArchivo) sub = item.nombreArchivo;
  else if (item.url)      sub = item.url;

  // El mensaje de error lo escribe el BACKEND (nunca un err.message crudo),
  // asi que ya viene en castellano y se muestra tal cual.
  const lineaError = item.estado === 'error' && item.errorMsg
    ? `<div class="celda-error">${esc(item.errorMsg)}</div>`
    : '';

  // 'recortado' lo pone el backend cuando el texto pasaba los 300.000
  // caracteres: el item esta listo, pero indexado a medias, y el admin tiene
  // que saberlo antes de que la IA le conteste algo incompleto.
  const lineaRecorte = item.recortado
    ? `<div class="celda-error">Documento muy largo: se indexó solo la primera parte.</div>`
    : '';

  return `
    <tr>
      <td class="celda-titulo">
        ${esc(item.titulo)}
        ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
        ${lineaError}
        ${lineaRecorte}
      </td>
      <td><span class="etiqueta">${esc(item.tipo)}</span></td>
      <td>
        ${chipDeEstado(item.estado)}
        ${item.origen ? `<div class="sub chico apagado">${esc(item.origen)}</div>` : ''}
      </td>
      <td><span class="etiqueta">${item.visibilidad === 'privado' ? 'Privado' : 'Del equipo'}</span></td>
      <td>${esc(autor)}</td>
      <td class="numero">${esc(item.cantChunks ?? 0)}</td>
      <td title="${esc(haceCuanto(item.creadoEn))}">${esc(fechaCorta(item.creadoEn))}</td>
    </tr>
  `;
}


// El chip de color. El default existe a proposito: si algun dia aparece un
// item con un estado que no conocemos (cargado a mano desde la consola de
// Firebase, o de una version vieja), se muestra el valor crudo escapado en
// vez de romper la fila.
function chipDeEstado(estado) {
  const textos = {
    pendiente:  'Pendiente',
    procesando: 'Procesando',
    listo:      'Listo',
    error:      'Error'
  };
  const clase = textos[estado] ? `chip-${estado}` : 'chip-desconocido';
  return `<span class="chip ${clase}">${esc(textos[estado] || estado || '—')}</span>`;
}


// ----------------------------------------------------------------------------
// Los filtros que corren en memoria.
// ----------------------------------------------------------------------------
function filtrarEnMemoria(lista) {
  const buscado = normalizar(textoBuscado).trim();

  return lista.filter((item) => {
    if (filtroTipo !== 'todos' && item.tipo !== filtroTipo) return false;
    if (filtroVisibilidad !== 'todas' && item.visibilidad !== filtroVisibilidad) return false;
    if (!buscado) return true;

    // Se busca en lo que la persona ve o reconoce: titulo, archivo, link y
    // autor. NO se busca en 'texto' (el contenido extraido) a proposito:
    // seria buscar adentro de notas privadas de otros y, aunque el admin
    // tenga permiso, no es lo que este buscador promete que hace.
    const bolsa = normalizar([
      item.titulo,
      item.nombreArchivo,
      item.url,
      nombrePorUid[item.creadoPor]
    ].filter(Boolean).join(' '));

    return bolsa.includes(buscado);
  });
}


// ----------------------------------------------------------------------------
// Errores de Firestore, traducidos.
// ----------------------------------------------------------------------------
function mostrarError(texto) {
  const caja = raiz?.querySelector('#errorItems');
  if (!caja) return;
  caja.innerHTML = texto
    ? `<div class="aviso aviso-error">${esc(texto)}</div>`
    : '';
}

function explicarErrorFirestore(e) {
  if (e.code === 'permission-denied') {
    // El orden de sospecha que dice el contrato: 1) token viejo,
    // 2) falta un where, 3) falta el limit, 4) recien ahi la regla.
    return 'Firestore no te deja leer esta lista. Suele ser el token viejo: ' +
           'cerrá sesión y volvé a entrar. Si sigue, revisá que sigas siendo ' +
           'administrador de este espacio.';
  }
  if (e.code === 'failed-precondition') {
    // Firestore pide un indice compuesto y pone el link para crearlo con un
    // clic en el mensaje del error, que esta en la consola del navegador.
    return 'Falta un índice en Firestore para esta combinación de filtros. ' +
           'Miralo en la consola del navegador: el error trae el link para crearlo.';
  }
  if (e.code === 'unavailable') {
    return 'No hay conexión con Firestore. Se muestra lo último que quedó guardado.';
  }
  return 'No pudimos cargar la lista. Probá recargar la página.';
}
