// ============================================================================
//  pantallas/miembros.js  —  quien esta en el equipo: alta y baja.
//  Panel web de NeuroDesk AI.
//
//  ES LA UNICA PANTALLA DEL PANEL QUE LE ESCRIBE AL BACKEND. Vale la pena
//  entender bien por que, porque es media defensa oral:
//
//  La tabla se LEE directo de Firestore con onSnapshot (rapido, en vivo,
//  gratis en lecturas ya cacheadas). Pero el alta y la baja NO se pueden
//  hacer desde el navegador: las reglas tienen, textualmente,
//      match /members/{miembroId} { allow create, update, delete: if false; }
//  o sea que ni el admin puede escribir ahi.
//
//  ¿Por que cerrado? Porque agregar a alguien a un equipo no es escribir un
//  documento: es escribir CUATRO cosas que tienen que quedar coherentes.
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
//  agregamos la fila a mano: el onSnapshot la trae solo. Si la agregaramos a
//  mano y el backend fallara a la mitad, la tabla mostraria un miembro que no
//  existe.
// ============================================================================

import {
  db, collection, doc, query, orderBy, onSnapshot, getDoc
} from '../firebase.js';

import { pedir } from '../api.js';
import { esc, fechaCorta, uidCorto } from '../util.js';


let cortarEscucha = null;
let raiz = null;
let ctxPantalla = null;
let miembros = [];
let ownerUid = null;      // el dueño del workspace: no se lo puede sacar
let trabajando = false;   // hay un pedido al backend en curso


// ============================================================================
//  MOUNT
// ============================================================================
export async function mount(contenedor, ctx) {
  raiz = contenedor;
  ctxPantalla = ctx;

  raiz.innerHTML = plantilla();
  engancharFormulario();
  engancharTabla();

  // El doc del workspace, una sola lectura: de ahi sale el ownerUid.
  // Cualquier miembro lo puede leer (allow read: if esMiembro(wsId)).
  try {
    const ws = await getDoc(doc(db, 'workspaces', ctxPantalla.wsId));
    if (ws.exists()) {
      ownerUid = ws.data().ownerUid ?? null;
      const cajaPlan = raiz.querySelector('#datoPlan');
      if (cajaPlan) {
        cajaPlan.textContent =
          `Plan ${ws.data().plan ?? 'free'} · ${ws.data().planStatus ?? 'sin_plan'}`;
      }
    }
  } catch (e) {
    console.warn('[miembros] no pude leer el workspace', e);
  }

  escuchar();
}


// ============================================================================
//  UNMOUNT  —  cortar el listener. Ver el comentario largo en items.js.
// ============================================================================
export function unmount() {
  if (cortarEscucha) {
    cortarEscucha();
    cortarEscucha = null;
  }
  miembros = [];
  ownerUid = null;
  trabajando = false;
  raiz = null;
  ctxPantalla = null;
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

    <div id="avisoMiembros"></div>

    <div class="tarjeta" style="margin-bottom:18px">
      <h2>Invitar a alguien</h2>
      <p class="apagado chico">
        La persona tiene que tener cuenta en NeuroDesk (se registra desde la
        app). Si todavía no se registró, el backend te avisa con
        <b>USUARIO_NO_REGISTRADO</b> y no pasa nada más.
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
    `${miembros.length} persona(s) · ${admins} administrador(es). ` +
    `El plan gratuito permite hasta 5 miembros por espacio.`;
}


function fila(m) {
  const esDueno = m.id === ownerUid;
  const soyYo   = m.id === ctxPantalla.uid;

  // Quien NO se puede sacar desde aca:
  //  - el dueño del workspace: el backend contesta ACCION_NO_PERMITIDA
  //    ("un workspace nunca queda sin ningun admin"), asi que ni ofrecemos
  //    el boton;
  //  - uno mismo: irse del espacio desde el panel que estas usando te deja la
  //    pantalla rota a mitad de camino. Que te saque otro admin.
  // El boton deshabilitado NO es la seguridad: el backend vuelve a chequear
  // las dos cosas. Es para no ofrecer algo que va a fallar.
  let acciones = '';
  if (esDueno) {
    acciones = `<span class="apagado chico">Dueño del espacio</span>`;
  } else if (soyYo) {
    acciones = `<span class="apagado chico">Sos vos</span>`;
  } else {
    acciones = `<button class="boton-peligro chico" data-quitar="${esc(m.id)}">Quitar</button>`;
  }

  const claseRol = m.rol === 'admin' ? 'rol-admin' : 'rol-miembro';

  return `
    <tr>
      <td class="celda-titulo">${esc(m.nombre || uidCorto(m.id))}</td>
      <td>${esc(m.email)}</td>
      <td class="${claseRol}">${m.rol === 'admin' ? 'Administrador' : 'Miembro'}</td>
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
      avisar(`Listo: ${rta.miembro.nombre || rta.miembro.email} ya está en el equipo.`, 'aviso-ok');
      raiz.querySelector('#emailInvitado').value = '';

    } catch (e) {
      // pedir() ya nos dio el mensaje en castellano del contrato. Para dos
      // codigos agregamos el "y ahora que hago", que el backend no sabe.
      let extra = '';
      if (e.codigo === 'USUARIO_NO_REGISTRADO') {
        extra = ' Pedile que se registre en la app y volvé a invitarla.';
      } else if (e.codigo === 'LIMITE_PLAN') {
        extra = ' El plan gratuito permite hasta 5 miembros por espacio.';
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
//  BAJA  —  DELETE /v1/workspaces/:wsId/miembros/:uid
// ============================================================================
function engancharTabla() {
  // UN SOLO listener en el <tbody>, no uno por boton.
  // Se llama delegacion de eventos: como el tbody se vuelve a dibujar entero
  // en cada onSnapshot, los listeners puestos en cada boton se perderian (y
  // volver a engancharlos en cada dibujo es como se acumulan sin que nadie se
  // de cuenta). El tbody, en cambio, no se reemplaza nunca.
  const cuerpo = raiz.querySelector('#cuerpoMiembros');

  cuerpo.addEventListener('click', async (evento) => {
    const boton = evento.target.closest('[data-quitar]');
    if (!boton || trabajando) return;

    const uid = boton.dataset.quitar;
    const quien = miembros.find((m) => m.id === uid);
    const nombre = quien?.nombre || quien?.email || uid;

    // confirm() es feo, pero es una accion destructiva y no vale la pena
    // escribir un modal propio para esto. Que el texto diga el nombre.
    const seguro = confirm(
      `¿Sacar a ${nombre} del espacio?\n\n` +
      `Sus items NO se borran: quedan en el espacio de trabajo.\n` +
      `Pierde el acceso al backend al instante, y a la lectura directa de ` +
      `Firestore cuando le venza el token (hasta 1 hora).`
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
      avisar(
        `${nombre} ya no está en el equipo. Le quedan ${rta.quitado.itemsQueQuedan} items cargados. ` +
        `Acceso al backend: ${rta.corteDeAcceso.backend}. ` +
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
  });
}


// ----------------------------------------------------------------------------
// avisar(texto, tipo)  —  el cartelito de arriba. Con null, lo esconde.
// ----------------------------------------------------------------------------
function avisar(texto, tipo = 'aviso-info') {
  const caja = raiz?.querySelector('#avisoMiembros');
  if (!caja) return;
  caja.innerHTML = texto ? `<div class="aviso ${tipo}">${esc(texto)}</div>` : '';
}
