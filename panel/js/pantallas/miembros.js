// ============================================================================
//  pantallas/miembros.js  —  quien esta en el equipo: alta, baja y rol.
//  Panel web de NeuroDesk AI.
//
//  ES LA PANTALLA DEL PANEL QUE MAS LE ESCRIBE AL BACKEND. Vale la pena
//  entender bien por que, porque es media defensa oral:
//
//  La tabla se LEE directo de Firestore con onSnapshot (rapido, en vivo,
//  gratis en lecturas ya cacheadas). Pero el alta, la baja y el cambio de rol
//  NO se pueden hacer desde el navegador: las reglas tienen, textualmente,
//      match /members/{miembroId} { allow create, update, delete: if false; }
//  o sea que ni el admin puede escribir ahi.
//
//  ¿Por que cerrado? Porque agregar a alguien a un equipo (o cambiarle el rol)
//  no es escribir un documento: es escribir CUATRO cosas que tienen que
//  quedar coherentes.
//    1. workspaces/{wsId}/members/{uid}          (el corte real de acceso)
//    2. usuarios/{uid}.workspaces                (la fuente de verdad del rol)
//    3. el CUSTOM CLAIM del token de esa persona (lo que leen las reglas)
//    4. el evento de auditoria
//  El paso 3 solo lo puede hacer el Admin SDK con la service account, que
//  vive en el backend y NUNCA puede estar en el JS del panel: si la clave
//  privada del proyecto viaja al navegador, cualquiera se hace admin de todo.
//  Ademas hay que buscar al invitado por email con getUserByEmail(), que
//  tampoco existe del lado del cliente.
//
//  Entonces: leer = Firestore. Escribir = backend. Y despues de escribir NO
//  tocamos la tabla a mano: el onSnapshot la trae sola. Si la cambiaramos a
//  mano y el backend fallara a la mitad, la tabla mostraria algo que no paso.
// ============================================================================

import {
  db, collection, doc, query, orderBy, onSnapshot
} from '../firebase.js';

import { pedir } from '../api.js';
import { aFecha, diaCorto, esc, fechaCorta, plural, uidCorto } from '../util.js';


let cortarEscucha = null;
let cortarWorkspace = null;
let raiz = null;
let ctxPantalla = null;
let miembros = [];
let ownerUid = null;      // el dueño del workspace: no se lo puede sacar ni bajar
let wsCargado = false;    // ¿ya llego el doc del workspace? (sin el no sabemos quien es el dueño)
let planActual = 'free';  // el tope de 5 personas es solo del plan Gratis
let exMiembros = {};      // uid -> { nombre, salioEn }: los que se fueron
let trabajando = false;   // hay un pedido al backend en curso


// ----------------------------------------------------------------------------
// El plan, en castellano. En la base se guarda 'free' / 'pro' y el estado del
// cobro con el enum de Mercado Pago ('sin_plan', 'activa'...): eso es para el
// codigo, no para el dueño. Un valor que no conocemos se muestra crudo (y
// escapado), en vez de romper el encabezado.
// ----------------------------------------------------------------------------
const NOMBRE_DEL_PLAN = { free: 'Gratis', pro: 'Pro' };

// 'sin_plan' es lo normal del plan Gratis: no hay nada que decir.
// 'pausada' y 'cancelada' SI hay que decirlas: con esos dos el servidor deja
// de procesar contenido nuevo (ver planStatus en MODELO-DATOS.md).
const ESTADO_DEL_PLAN = {
  sin_plan:  '',
  pendiente: 'pago pendiente',
  activa:    'al día',
  pausada:   'pausado: no se procesa contenido nuevo',
  cancelada: 'cancelado: no se procesa contenido nuevo'
};

function textoDelPlan(plan, estado) {
  const p = plan ?? 'free';
  const nombre = Object.hasOwn(NOMBRE_DEL_PLAN, p) ? NOMBRE_DEL_PLAN[p] : String(p);
  const detalle = Object.hasOwn(ESTADO_DEL_PLAN, estado ?? '') ? ESTADO_DEL_PLAN[estado] : String(estado ?? '');
  return `Plan ${nombre}` + (detalle ? ` · ${detalle}` : '');
}


// ============================================================================
//  MOUNT
// ============================================================================
export async function mount(contenedor, ctx) {
  raiz = contenedor;
  ctxPantalla = ctx;

  raiz.innerHTML = plantilla();
  engancharFormulario();
  engancharTabla();

  escucharWorkspace();
  escuchar();
}


// ============================================================================
//  UNMOUNT  —  cortar los listeners. Ver el comentario largo en items.js.
// ============================================================================
export function unmount() {
  if (cortarEscucha) {
    cortarEscucha();
    cortarEscucha = null;
  }
  if (cortarWorkspace) {
    cortarWorkspace();
    cortarWorkspace = null;
  }
  miembros = [];
  ownerUid = null;
  wsCargado = false;
  planActual = 'free';
  exMiembros = {};
  trabajando = false;
  raiz = null;
  ctxPantalla = null;
}


// ============================================================================
//  EL DOC DEL WORKSPACE, EN VIVO
//
//  Antes se leia una sola vez. Ahora se escucha (es UN documento, cuesta una
//  lectura por cambio) porque de ahi salen tres cosas que cambian MIENTRAS el
//  admin mira esta pantalla:
//    - exMiembros: el admin saca a alguien y "Ya no están en el equipo" lo
//      muestra al instante (el servidor guarda el nombre antes de borrar la
//      ficha de members: la memoria que no se va);
//    - el plan y su estado;
//    - ownerUid, que no cambia nunca, pero viene en el mismo doc.
//  Cualquier miembro puede leer este doc (allow read: if esMiembro).
// ============================================================================
function escucharWorkspace() {
  cortarWorkspace = onSnapshot(
    doc(db, 'workspaces', ctxPantalla.wsId),
    (foto) => {
      if (!foto.exists()) return;
      const ws = foto.data();
      wsCargado = true;
      planActual = ws.plan ?? 'free';
      ownerUid = ws.ownerUid ?? null;
      exMiembros = ws.exMiembros && typeof ws.exMiembros === 'object' ? ws.exMiembros : {};

      const cajaPlan = raiz?.querySelector('#datoPlan');
      if (cajaPlan) cajaPlan.textContent = textoDelPlan(ws.plan, ws.planStatus);

      // ownerUid decide que botones lleva cada fila: hay que redibujar.
      dibujarTabla();
    },
    (e) => console.warn('[miembros] no pude leer el workspace', e)
  );
}


// ============================================================================
//  LA TABLA EN VIVO
// ============================================================================
function escuchar() {
  if (cortarEscucha) cortarEscucha();

  // orderBy sobre un solo campo NO necesita indice compuesto: Firestore crea
  // solo los indices de un campo. El de dos campos (rol + agregadoEn) esta en
  // firestore.indexes.json por si algun dia filtramos por rol.
  const consulta = query(
    collection(db, 'workspaces', ctxPantalla.wsId, 'members'),
    orderBy('agregadoEn', 'desc')
  );

  cortarEscucha = onSnapshot(
    consulta,
    (foto) => {
      miembros = foto.docs.map((d) => ({ id: d.id, ...d.data() }));
      dibujarTabla();
    },
    (e) => {
      console.error('[miembros] se corto la escucha', e);
      avisar('No pudimos cargar la lista de miembros. Probá recargar la página.', 'aviso-error');
    }
  );
}


// ============================================================================
//  DIBUJO
// ============================================================================
function plantilla() {
  return `
    <div class="encabezado">
      <div>
        <h1>Miembros del espacio</h1>
        <p class="apagado chico" id="datoPlan">&nbsp;</p>
      </div>
    </div>

    <div id="avisoMiembros" aria-live="polite"></div>

    <div class="tarjeta" style="margin-bottom:18px">
      <h2>Invitar a alguien</h2>
      <p class="apagado chico">
        Escribí su email. Si todavía no tiene cuenta en NeuroDesk, el servidor
        se la crea y te muestra <b>una sola vez</b> una contraseña temporal
        para que se la pases.
      </p>

      <form id="formInvitar" class="form-invitar" novalidate>
        <div class="campo campo-email">
          <label for="emailInvitado">Email</label>
          <input type="email" id="emailInvitado" placeholder="persona@ejemplo.com"
                 autocomplete="off" required>
        </div>

        <div class="campo">
          <label for="rolInvitado">Rol</label>
          <select id="rolInvitado">
            <option value="miembro">Miembro</option>
            <option value="admin">Administrador</option>
          </select>
        </div>

        <button type="submit" id="botonInvitar" class="boton-principal">Invitar</button>
      </form>
    </div>

    <div class="caja-tabla">
      <table>
        <thead>
          <tr>
            <th>Nombre</th>
            <th>Email</th>
            <th>Rol</th>
            <th>Desde</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="cuerpoMiembros"></tbody>
      </table>
    </div>

    <p class="resumen-filtro" id="resumenMiembros"></p>
    <p class="resumen-filtro" id="exMiembros"></p>
  `;
}


function dibujarTabla() {
  const cuerpo = raiz?.querySelector('#cuerpoMiembros');
  if (!cuerpo) return;

  if (miembros.length === 0) {
    cuerpo.innerHTML = `<tr><td colspan="5" class="vacio">
      Todavía no hay nadie más en este espacio.
    </td></tr>`;
  } else {
    cuerpo.innerHTML = miembros.map(fila).join('');
  }

  const resumen = raiz.querySelector('#resumenMiembros');
  const admins = miembros.filter((m) => m.rol === 'admin').length;
  resumen.textContent =
    `${plural(miembros.length, 'persona', 'personas')} · ` +
    `${plural(admins, 'administrador', 'administradores')}.` +
    (planActual === 'free' ? ' El plan Gratis permite hasta 5 personas por espacio.' : '');

  dibujarExMiembros();
}


// "Ya no están en el equipo: Lucas (salió el 05/11)". Sus items siguen en el
// espacio y la IA los sigue citando con su nombre: se dice aca, donde el
// admin lo acaba de sacar. Si alguien vuelve a entrar, el servidor borra su
// clave de exMiembros y desaparece de esta linea solo.
function dibujarExMiembros() {
  const caja = raiz?.querySelector('#exMiembros');
  if (!caja) return;

  const idsActuales = new Set(miembros.map((m) => m.id));
  const idos = Object.entries(exMiembros)
    .filter(([uid, ex]) => !idsActuales.has(uid) && ex && typeof ex.nombre === 'string' && ex.nombre.trim());

  if (idos.length === 0) {
    caja.innerHTML = '';
    return;
  }

  const lista = idos
    .map(([, ex]) => {
      const salio = aFecha(ex.salioEn);
      return esc(ex.nombre.trim()) +
        (salio ? ` <span class="apagado">(salió el ${esc(diaCorto(salio))})</span>` : '');
    })
    .join(', ');

  caja.innerHTML =
    `<b>Ya no están en el equipo:</b> ${lista}. ` +
    `Lo que cargaron se queda en el espacio y la IA lo sigue usando, con su nombre.`;
}


function fila(m) {
  const esDueno = m.id === ownerUid;
  const soyYo   = m.id === ctxPantalla.uid;
  const esAdmin = m.rol === 'admin';

  // Quien NO se puede tocar desde aca:
  //  - el dueño del workspace: el backend contesta ACCION_NO_PERMITIDA
  //    ("un workspace nunca queda sin ningun admin", y el dueño es admin
  //    siempre), asi que ni ofrecemos los botones;
  //  - uno mismo: irse del espacio (o bajarse de admin) desde el panel que
  //    estas usando te deja la pantalla rota a mitad de camino. Que lo haga
  //    otro admin.
  // El boton que no aparece NO es la seguridad: el backend vuelve a chequear
  // todo. Es para no ofrecer algo que va a fallar.
  let acciones = '';
  if (!wsCargado) {
    // Todavia no sabemos quien es el dueño: mejor ningun boton un instante
    // que ofrecerle "Quitar" al dueño y que el backend lo rechace.
    acciones = '';
  } else if (esDueno) {
    acciones = `<span class="apagado chico">Dueño del espacio</span>`;
  } else if (soyYo) {
    acciones = `<span class="apagado chico">Sos vos</span>`;
  } else {
    // data-rol lleva el rol NUEVO que se pide: el que no tiene hoy.
    const botonRol = esAdmin
      ? `<button class="boton-suave chico" data-rol="miembro" data-uid="${esc(m.id)}">Pasar a miembro</button>`
      : `<button class="boton-suave chico" data-rol="admin" data-uid="${esc(m.id)}">Hacer admin</button>`;
    acciones = `
      <div class="acciones-fila">
        ${botonRol}
        <button class="boton-peligro chico" data-quitar="${esc(m.id)}">Quitar</button>
      </div>`;
  }

  return `
    <tr>
      <td class="celda-titulo">${esc(m.nombre || uidCorto(m.id))}</td>
      <td>${esc(m.email)}</td>
      <td class="${esAdmin ? 'rol-admin' : 'rol-miembro'}">${esAdmin ? 'Administrador' : 'Miembro'}</td>
      <td>${esc(fechaCorta(m.agregadoEn))}</td>
      <td>${acciones}</td>
    </tr>
  `;
}


// ============================================================================
//  ALTA  —  POST /v1/workspaces/:wsId/miembros
// ============================================================================
function engancharFormulario() {
  const form = raiz.querySelector('#formInvitar');
  const boton = raiz.querySelector('#botonInvitar');

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    if (trabajando) return;

    const email = raiz.querySelector('#emailInvitado').value.trim().toLowerCase();
    const rol   = raiz.querySelector('#rolInvitado').value;

    // Validacion minima del lado del cliente. El backend valida TODO de nuevo
    // (DATOS_INVALIDOS): esto es solo para no gastar un pedido de red en algo
    // que ya sabemos que esta mal.
    if (!email.includes('@') || email.length < 5) {
      avisar('Escribí un email válido.', 'aviso-error');
      return;
    }

    trabajando = true;
    boton.disabled = true;
    boton.textContent = 'Invitando…';
    avisar(null);

    try {
      const rta = await pedir(
        'POST',
        `/v1/workspaces/${ctxPantalla.wsId}/miembros`,
        { email, rol },
        { segundos: 60 }   // Render dormido puede tardar hasta un minuto
      );

      // NO agregamos la fila a mano: el onSnapshot de arriba ya la trae.
      const quien = rta.miembro.nombre || rta.miembro.email;
      if (rta.cuentaCreada && rta.passwordTemporal) {
        // La persona NO tenia cuenta y el servidor se la creo. La contraseña
        // temporal viaja UNA sola vez, en esta respuesta (no se guarda en
        // ningun lado): si no se la mostramos aca, nadie la ve nunca y la
        // persona no puede entrar. Por eso el cartel no se va solo.
        avisarHtml(
          `Listo: ${esc(quien)} ya está en el equipo. Le creamos la cuenta: ` +
          `pasale esta contraseña temporal para que entre a la app ` +
          `<code class="clave-temporal">${esc(rta.passwordTemporal)}</code> ` +
          `(la vas a ver solo esta vez).`,
          'aviso-ok'
        );
      } else {
        avisar(`Listo: ${quien} ya está en el equipo.`, 'aviso-ok');
      }
      raiz.querySelector('#emailInvitado').value = '';

    } catch (e) {
      // pedir() ya nos dio el mensaje en castellano del contrato. Para dos
      // codigos agregamos el "y ahora que hago", que el backend no sabe.
      let extra = '';
      if (e.codigo === 'USUARIO_NO_REGISTRADO') {
        extra = ' Pedile que se registre en la app y volvé a invitarla.';
      } else if (e.codigo === 'LIMITE_PLAN') {
        extra = ' El plan Gratis permite hasta 5 personas por espacio.';
      }
      avisar(e.mensaje + extra, 'aviso-error');

    } finally {
      trabajando = false;
      boton.disabled = false;
      boton.textContent = 'Invitar';
    }
  });
}


// ============================================================================
//  BAJA Y CAMBIO DE ROL  —  DELETE y PATCH /v1/workspaces/:wsId/miembros/:uid
// ============================================================================
function engancharTabla() {
  // UN SOLO listener en el <tbody>, no uno por boton.
  // Se llama delegacion de eventos: como el tbody se vuelve a dibujar entero
  // en cada onSnapshot, los listeners puestos en cada boton se perderian (y
  // volver a engancharlos en cada dibujo es como se acumulan sin que nadie se
  // de cuenta). El tbody, en cambio, no se reemplaza nunca.
  const cuerpo = raiz.querySelector('#cuerpoMiembros');

  cuerpo.addEventListener('click', (evento) => {
    if (trabajando) return;

    const quitar = evento.target.closest('[data-quitar]');
    if (quitar) {
      sacarDelEquipo(quitar);
      return;
    }

    const rol = evento.target.closest('[data-rol]');
    if (rol) cambiarRol(rol);
  });
}


async function sacarDelEquipo(boton) {
  const uid = boton.dataset.quitar;
  const quien = miembros.find((m) => m.id === uid);
  const nombre = quien?.nombre || quien?.email || uid;

  // confirm() es feo, pero es una accion destructiva y no vale la pena
  // escribir un modal propio para esto. Que el texto diga el nombre.
  const seguro = confirm(
    `¿Sacar a ${nombre} del espacio?\n\n` +
    `Lo que cargó NO se borra: queda en el espacio y la IA lo sigue usando, con su nombre.\n` +
    `Pierde el acceso al servidor al instante, y a la lectura directa de ` +
    `Firestore cuando le venza la sesión (hasta 1 hora).`
  );
  if (!seguro) return;

  trabajando = true;
  boton.disabled = true;
  boton.textContent = 'Quitando…';
  avisar(null);

  try {
    const rta = await pedir(
      'DELETE',
      `/v1/workspaces/${ctxPantalla.wsId}/miembros/${uid}`,
      null,
      { segundos: 60 }
    );

    // La fila desaparece sola por el onSnapshot. Lo que si mostramos es el
    // dato honesto del corte de acceso, que viene en la respuesta y es
    // justo lo que el contrato nos pide no esconder.
    const quedan = rta.quitado.itemsQueQuedan;
    avisar(
      `${nombre} ya no está en el equipo. ` +
      (quedan > 0
        ? `Le quedan ${plural(quedan, 'item cargado', 'items cargados')}: siguen en el espacio y la IA los sigue usando. `
        : 'No había cargado nada. ') +
      `Acceso al servidor: ${rta.corteDeAcceso.backend}. ` +
      `Lectura directa de Firestore: ${rta.corteDeAcceso.lecturaDirectaFirestore}.`,
      'aviso-ok'
    );

  } catch (e) {
    avisar(e.mensaje, 'aviso-error');
    boton.disabled = false;
    boton.textContent = 'Quitar';

  } finally {
    trabajando = false;
  }
}


// ----------------------------------------------------------------------------
// "Hacer admin" / "Pasar a miembro"  —  PATCH .../miembros/:uid  { rol }
//
// El backend hace todo (members, usuarios, el custom claim y el evento
// 'rol.cambiado'); aca solo se pide y se avisa. La tabla cambia sola por el
// onSnapshot de members.
//
// LO QUE HAY QUE SABER DECIR (y por eso lo dice el confirm):
//   - Subir a admin: el celular de esa persona se entera solo (escucha
//     claimsActualizadoEn y pide un token nuevo) y le aparece lo de admin.
//   - Bajar a miembro: el servidor le aplica el rol nuevo al instante, y
//     ademas le revoca la sesion (revokeRefreshTokens): la app no puede sacar
//     un token nuevo con el rol viejo, asi que tiene que volver a entrar. Las
//     reglas de Firestore igual pueden verla como admin hasta que venza el
//     token que ya tiene en la mano (hasta 1 hora).
// ----------------------------------------------------------------------------
async function cambiarRol(boton) {
  const uid = boton.dataset.uid;
  const rolNuevo = boton.dataset.rol === 'admin' ? 'admin' : 'miembro';
  const quien = miembros.find((m) => m.id === uid);
  const nombre = quien?.nombre || quien?.email || uid;

  const seguro = confirm(rolNuevo === 'admin'
    ? `¿Hacer administrador a ${nombre}?\n\n` +
      `Va a poder ver todo el contenido del espacio (también lo privado de cada uno), ` +
      `invitar y sacar gente, cambiar roles y entrar a este panel.`
    : `¿Pasar a ${nombre} a miembro?\n\n` +
      `Deja de ver lo privado de los demás y de entrar al panel. ` +
      `Por seguridad, el servidor le cierra la sesión: va a tener que volver a entrar en la app.`
  );
  if (!seguro) return;

  const textoOriginal = boton.textContent;
  trabajando = true;
  boton.disabled = true;
  boton.textContent = 'Cambiando…';
  avisar(null);

  try {
    await pedir(
      'PATCH',
      `/v1/workspaces/${ctxPantalla.wsId}/miembros/${uid}`,
      { rol: rolNuevo },
      { segundos: 60 }
    );

    avisar(rolNuevo === 'admin'
      ? `Listo: ${nombre} ahora es administrador del espacio.`
      : `Listo: ${nombre} ahora es miembro. Tiene que volver a entrar en la app.`,
      'aviso-ok');

  } catch (e) {
    // ACCION_NO_PERMITIDA trae en 'detalle' el motivo exacto, escrito a mano
    // por el servidor (por ejemplo, que el espacio se quedaria sin
    // administradores): se lo sumamos. SOLO en ese codigo: en un error de red
    // el 'detalle' es el texto crudo del navegador ("Failed to fetch"), y eso
    // no se le muestra a nadie.
    const detalle = e.codigo === 'ACCION_NO_PERMITIDA' && typeof e.detalle === 'string' && e.detalle
      ? ` ${e.detalle}`
      : '';
    avisar(e.mensaje + detalle, 'aviso-error');
    boton.disabled = false;
    boton.textContent = textoOriginal;

  } finally {
    trabajando = false;
  }
}


// ----------------------------------------------------------------------------
// avisar(texto, tipo)  —  el cartelito de arriba. Con null, lo esconde.
// avisarHtml() es la misma caja, para el UNICO caso que necesita marcado (la
// contraseña temporal en <code>): el que llama tiene que haber pasado por
// esc() todo lo que venga de afuera.
// ----------------------------------------------------------------------------
function avisar(texto, tipo = 'aviso-info') {
  avisarHtml(texto ? esc(texto) : null, tipo);
}

function avisarHtml(html, tipo = 'aviso-info') {
  const caja = raiz?.querySelector('#avisoMiembros');
  if (!caja) return;
  caja.innerHTML = html ? `<div class="aviso ${tipo}">${html}</div>` : '';
}
