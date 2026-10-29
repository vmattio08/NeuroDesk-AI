// ============================================================================
//  NeuroDesk AI — api/test/rules.test.js
//  Tests AUTOMATICOS de firebase/firestore.rules contra el emulador de Firestore.
//  (meta del 30/10, "QA cruzado")
//
//  QUE PRUEBA: lo que hay que poder defender en el oral (requisito de roles y
//  privacidad). Cada caso coincide con lo que ESTA ESCRITO en las reglas v3 y
//  en MODELO-DATOS.md (tabla "quien escribe" + INVARIANTES):
//    - items:      privado / equipo / admin ve todo, creacion SOLO con campos
//                  CLIENTE, estado 'pendiente' y un tipo de la lista cerrada
//                  (nota, pdf, word, link, foto), edicion acotada, borrado cerrado
//    - aislamiento entre workspaces (incluida la query collectionGroup)
//    - respuestas: create con EXACTAMENTE 4 campos, la leen el autor o el admin
//    - seguimientos (conversaciones): los 4 de siempre + conversacionId y
//                  anteriorRespId, los dos o ninguno; preguntaBuscada es solo
//                  del backend; la query con la que la app lista una
//                  conversacion (autorUid + conversacionId + orderBy creadoEn);
//                  lectura y borrado iguales que cualquier respuesta; y un doc
//                  ajeno con mi conversacionId no rompe mi conversacion
//    - eventos y suscripcion: solo admin
//    - chunks: cerrada para todos, incluso el admin
//    - usuarios / members: el cliente no los crea ni se sube el rol
//
//  EL ROL NO SALE DE LA BASE: sale del custom claim del token
//  { ws: { [wsId]: 'admin' | 'miembro' } }. Aca lo simulamos con
//  authenticatedContext(uid, { ws: {...} }), que arma un token de prueba con
//  ese claim adentro, igual al que firma el backend con setCustomUserClaims.
//
// ----------------------------------------------------------------------------
//  COMO SE CORRE (Windows, PowerShell, parado en fase2\api):
//
//    $env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
//    $env:Path = "$env:JAVA_HOME\bin;$env:Path"
//    npm.cmd run test:rules
//
//  - Las dos lineas de $env cambian JAVA_HOME y PATH SOLO en esa ventana de
//    PowerShell: no tocan las variables del sistema (donde sigue el Java 8).
//    El emulador de Firestore es un .jar y con Java 8 no arranca; el JDK 21
//    que viene adentro de Android Studio ('jbr') alcanza y sobra.
//  - npm.cmd (y no npm) porque PowerShell bloquea los scripts .ps1 (npm.ps1).
//    Adentro del script, npm usa cmd.exe, asi que 'npx' anda sin el .cmd.
//  - El script baja el CLI con 'npx firebase-tools@15.34.1' (version fija: asi el test da lo mismo el dia de la defensa) (no hace falta
//    instalarlo global). La primera vez tambien baja el .jar del emulador a
//    %USERPROFILE%\.cache\firebase\emulators: tarda un rato, despues no.
//  - PUERTO: el emulador escucha en 127.0.0.1:8181 y NO en el 8080 de
//    fase2/firebase.json, porque el backend local (npm run dev) ya usa el 8080
//    y chocan. Por eso el script le pasa
//      --config ../firebase/firebase.emulador-tests.json
//    (un firebase.json SOLO para los tests, que carga el MISMO firestore.rules)
//    y el firebase.json del proyecto queda intacto. Esta en fase2/firebase/ y
//    no en api/test/ porque el CLI no acepta un archivo de reglas que este
//    fuera de la carpeta del config ("is outside of project directory").
//  - PROYECTO 'demo-neurodesk': el prefijo demo- hace que el CLI NO hable con
//    el proyecto real (neurodesk-6to) ni pida login. Nada de esto toca la base
//    de verdad ni publica reglas.
//  - Si el emulador ya esta levantado a mano, alcanza con
//      $env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8181'; node --test test/rules.test.js
// ============================================================================

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc,
  collection,
  collectionGroup,
  query,
  where,
  orderBy,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  Timestamp,
  setLogLevel,
} from 'firebase/firestore';

// Leemos SIEMPRE el archivo real de reglas: si alguien lo cambia, estos tests
// prueban la version nueva sin tocar nada aca.
const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RUTA_REGLAS = path.resolve(AQUI, '../../firebase/firestore.rules');

const PROYECTO = 'demo-neurodesk';
const WS = 'ws_equipo_a';
const WS_OTRO = 'ws_equipo_b';

const UID = {
  admin: 'uid_admin_a',
  ana: 'uid_ana', //  miembro de WS
  beto: 'uid_beto', // miembro de WS
  ajeno: 'uid_zoe', // ADMIN, pero de OTRO workspace
  sinClaim: 'uid_sin_claim', // logueado, sin ningun workspace en el token
};

/** @type {import('@firebase/rules-unit-testing').RulesTestEnvironment} */
let entorno;

// ---------------------------------------------------------------------------
// Quien esta mirando. Cada funcion devuelve el Firestore "de cliente" de esa
// persona, con el token (y el claim ws) que tendria en la app.
// ---------------------------------------------------------------------------
const comoAdmin = () => entorno.authenticatedContext(UID.admin, { ws: { [WS]: 'admin' } }).firestore();
const comoAna = () => entorno.authenticatedContext(UID.ana, { ws: { [WS]: 'miembro' } }).firestore();
const comoBeto = () => entorno.authenticatedContext(UID.beto, { ws: { [WS]: 'miembro' } }).firestore();
const comoAjeno = () => entorno.authenticatedContext(UID.ajeno, { ws: { [WS_OTRO]: 'admin' } }).firestore();
const comoSinClaim = () => entorno.authenticatedContext(UID.sinClaim).firestore();
const comoAnonimo = () => entorno.unauthenticatedContext().firestore();

// Atajos de rutas.
const item = (fs, id, ws = WS) => doc(fs, 'workspaces', ws, 'items', id);
const items = (fs, ws = WS) => collection(fs, 'workspaces', ws, 'items');
const respuesta = (fs, id) => doc(fs, 'workspaces', WS, 'respuestas', id);
const respuestas = (fs) => collection(fs, 'workspaces', WS, 'respuestas');
const evento = (fs, id) => doc(fs, 'workspaces', WS, 'eventos', id);
const eventos = (fs) => collection(fs, 'workspaces', WS, 'eventos');

// Ids nuevos para cada create, asi un test no pisa el documento de otro.
let contador = 0;
const idNuevo = (prefijo) => `${prefijo}_${++contador}`;

/** Un item como lo deja el BACKEND despues de procesarlo (estado 'listo'). */
function itemProcesado({ visibilidad, creadoPor, workspaceId = WS, titulo = 'Item de prueba' }) {
  const ahora = Timestamp.now();
  return {
    titulo,
    tipo: 'nota',
    textoOriginal: 'Contenido escrito por la persona.',
    visibilidad,
    workspaceId,
    creadoPor,
    creadoEn: ahora,
    estado: 'listo',
    texto: 'Contenido escrito por la persona.',
    cantChunks: 1,
    paginas: null,
    origen: 'nota',
    caracteres: 33,
    recortado: false,
    errorMsg: null,
    actualizadoEn: ahora,
  };
}

/**
 * Lo que manda la app al crear una nota: SOLO campos CLIENTE (invariante 1),
 * estado 'pendiente' y creadoEn = serverTimestamp(). Es el ejemplo (1) de
 * MODELO-DATOS.md. Cada test le cambia o le agrega UNA cosa.
 */
function notaNueva(cambios = {}) {
  return {
    titulo: 'Pendientes del taller',
    tipo: 'nota',
    textoOriginal: 'Pedir presupuesto de 3 fuentes ATX al proveedor de Quilmes.',
    visibilidad: 'privado',
    workspaceId: WS,
    creadoPor: UID.ana,
    creadoEn: serverTimestamp(),
    estado: 'pendiente',
    ...cambios,
  };
}

/**
 * Lo que manda la app al subir un Word (.docx): los MISMOS campos CLIENTE que
 * un pdf, con nombreArchivo y sin textoOriginal ni url. Despues manda el
 * archivo al backend, que saca el texto y lo guarda en 'texto' con origen
 * 'docx'. OJO: 'docx' es el ORIGEN del texto; el TIPO del item es 'word'.
 */
function wordNuevo(cambios = {}) {
  return {
    titulo: 'Acta de la reunion de padres',
    tipo: 'word',
    nombreArchivo: 'acta-reunion-de-padres.docx',
    visibilidad: 'equipo',
    workspaceId: WS,
    creadoPor: UID.ana,
    creadoEn: serverTimestamp(),
    estado: 'pendiente',
    ...cambios,
  };
}

/** Lo que manda la app al preguntar: EXACTAMENTE estos cuatro campos. */
function preguntaNueva(cambios = {}) {
  return {
    pregunta: 'Cuando es la mesa de Matematica?',
    autorUid: UID.ana,
    estado: 'buscando',
    creadoEn: serverTimestamp(),
    ...cambios,
  };
}

/**
 * Lo que manda la app en una pregunta de SEGUIMIENTO: los mismos cuatro campos
 * de siempre + los dos de la cadena, que van SIEMPRE juntos. Por defecto es la
 * TERCERA pregunta de la conversacion sembrada de Ana:
 *   conversacionId = la raiz (resp_de_ana)
 *   anteriorRespId = la ultima pregunta que ya tiene (seg_de_ana_1)
 */
function seguimientoNuevo(cambios = {}) {
  return preguntaNueva({
    pregunta: 'Y para cuando lo necesitan?',
    conversacionId: 'resp_de_ana',
    anteriorRespId: 'seg_de_ana_1',
    ...cambios,
  });
}

/**
 * La query con la que la app lista una conversacion (la que usa el indice
 * compuesto autorUid + conversacionId + creadoEn). El emulador no exige
 * indices, asi que aca se prueba SOLO la regla; el indice se prueba al
 * publicarlo en el proyecto real.
 */
const consultaConversacion = (fs, autorUid, raiz) =>
  query(respuestas(fs), where('autorUid', '==', autorUid), where('conversacionId', '==', raiz), orderBy('creadoEn'));

// ---------------------------------------------------------------------------
// Arranque: reglas reales + datos sembrados con las reglas APAGADAS (como lo
// haria el backend con Admin SDK, que las ignora).
// ---------------------------------------------------------------------------
before(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      'No hay emulador (falta FIRESTORE_EMULATOR_HOST). Corré "npm.cmd run test:rules" ' +
        '(ver el comentario de arriba de este archivo).',
    );
  }

  // El SDK de cliente loguea un warning por cada permission-denied, y aca los
  // provocamos a proposito: sin esto la salida del test queda ilegible.
  setLogLevel('silent');

  entorno = await initializeTestEnvironment({
    projectId: PROYECTO,
    firestore: { rules: readFileSync(RUTA_REGLAS, 'utf8') },
  });
  await entorno.clearFirestore();

  await entorno.withSecurityRulesDisabled(async (ctx) => {
    const fs = ctx.firestore();
    const ahora = Timestamp.now();

    await setDoc(doc(fs, 'usuarios', UID.ana), {
      email: 'ana@demo.test',
      nombre: 'Ana',
      workspaces: { [WS]: { rol: 'miembro', nombre: 'Equipo A' } },
      workspaceActual: WS,
      claimsActualizadoEn: ahora,
      creadoEn: ahora,
    });
    await setDoc(doc(fs, 'usuarios', UID.beto), {
      email: 'beto@demo.test',
      nombre: 'Beto',
      workspaces: { [WS]: { rol: 'miembro', nombre: 'Equipo A' } },
      workspaceActual: WS,
      claimsActualizadoEn: ahora,
      creadoEn: ahora,
    });

    await setDoc(doc(fs, 'workspaces', WS), {
      nombre: 'Equipo A',
      ownerUid: UID.admin,
      plan: 'free',
      planStatus: 'sin_plan',
      creadoEn: ahora,
      actualizadoEn: ahora,
    });
    await setDoc(doc(fs, 'workspaces', WS, 'members', UID.ana), {
      uid: UID.ana,
      email: 'ana@demo.test',
      nombre: 'Ana',
      rol: 'miembro',
      agregadoPor: UID.admin,
      agregadoEn: ahora,
    });
    await setDoc(doc(fs, 'workspaces', WS, 'suscripcion', 'actual'), {
      plan: 'free',
      estado: 'sin_plan',
      preapprovalId: null,
      montoMensual: 0,
      vence: null,
      eventosProcesados: [],
      actualizadoEn: ahora,
    });

    await setDoc(item(fs, 'privado_de_ana'), itemProcesado({ visibilidad: 'privado', creadoPor: UID.ana }));
    await setDoc(item(fs, 'privado_de_beto'), itemProcesado({ visibilidad: 'privado', creadoPor: UID.beto }));
    await setDoc(item(fs, 'equipo_de_beto'), itemProcesado({ visibilidad: 'equipo', creadoPor: UID.beto }));
    await setDoc(item(fs, 'para_editar_de_ana'), itemProcesado({ visibilidad: 'equipo', creadoPor: UID.ana }));
    await setDoc(
      item(fs, 'equipo_del_ws_b', WS_OTRO),
      itemProcesado({ visibilidad: 'equipo', creadoPor: UID.ajeno, workspaceId: WS_OTRO }),
    );

    await setDoc(respuesta(fs, 'resp_de_ana'), {
      pregunta: 'Que dice mi nota privada?',
      autorUid: UID.ana,
      estado: 'listo',
      creadoEn: ahora,
      respuesta: 'Dice que hay que pedir presupuesto [1].',
      fuentes: [],
      confianza: 'alta',
      chunksMirados: null,
      chunksVisibles: 3,
      errorMsg: null,
      actualizadoEn: ahora,
    });
    // Conversacion de Ana: la raiz es resp_de_ana (sin campos nuevos) y esta
    // es su primera pregunta de seguimiento, ya respondida por el backend.
    // preguntaBuscada = como la entendio el backend despues de reformularla.
    await setDoc(respuesta(fs, 'seg_de_ana_1'), {
      pregunta: 'Y a que proveedor?',
      autorUid: UID.ana,
      estado: 'listo',
      creadoEn: ahora,
      conversacionId: 'resp_de_ana',
      anteriorRespId: 'resp_de_ana',
      preguntaBuscada: 'A que proveedor hay que pedirle el presupuesto segun mi nota?',
      respuesta: 'Al proveedor de Quilmes [1].',
      fuentes: [],
      confianza: 'alta',
      chunksMirados: null,
      chunksVisibles: 3,
      errorMsg: null,
      actualizadoEn: ahora,
    });
    await setDoc(respuesta(fs, 'resp_de_beto'), {
      pregunta: 'Cuando viene el tecnico?',
      autorUid: UID.beto,
      estado: 'buscando',
      creadoEn: ahora,
    });

    await setDoc(evento(fs, 'ev_1'), {
      tipo: 'item.listo',
      actorUid: UID.ana,
      resumen: 'Ana subio Nota privada',
      itemId: 'privado_de_ana',
      creadoEn: ahora,
    });

    await setDoc(doc(fs, 'chunks', 'privado_de_ana_0'), {
      workspaceId: WS,
      itemId: 'privado_de_ana',
      visibilidad: 'privado',
      creadoPor: UID.ana,
      titulo: 'Item de prueba',
      idx: 0,
      pagina: null,
      origen: 'nota',
      texto: 'Contenido escrito por la persona.',
      embedding: [0.1, 0.2, 0.3],
      creadoEn: ahora,
    });
  });
});

after(async () => {
  await entorno?.cleanup();
});

// ===========================================================================
//  ITEMS — PRIVACIDAD DE LECTURA (requisito de roles)
// ===========================================================================
describe('items: privacidad de lectura', () => {
  test('miembro LEE su propio item privado', async () => {
    await assertSucceeds(getDoc(item(comoAna(), 'privado_de_ana')));
  });

  test('miembro NO lee el item privado de otro miembro', async () => {
    await assertFails(getDoc(item(comoAna(), 'privado_de_beto')));
  });

  test('miembro LEE un item "equipo" de otro miembro', async () => {
    await assertSucceeds(getDoc(item(comoAna(), 'equipo_de_beto')));
  });

  test('miembro LISTA la pestaña "Del equipo" (where visibilidad == equipo)', async () => {
    await assertSucceeds(getDocs(query(items(comoAna()), where('visibilidad', '==', 'equipo'))));
  });

  test('miembro LISTA la pestaña "Mis notas" (where creadoPor == su uid)', async () => {
    await assertSucceeds(getDocs(query(items(comoAna()), where('creadoPor', '==', UID.ana))));
  });

  test('miembro NO lista la colección entera sin filtro (las reglas no filtran)', async () => {
    await assertFails(getDocs(items(comoAna())));
  });

  test('miembro NO lista where creadoPor == otro uid (traería privados ajenos)', async () => {
    await assertFails(getDocs(query(items(comoAna()), where('creadoPor', '==', UID.beto))));
  });

  test('admin LEE el item privado de cualquier miembro', async () => {
    await assertSucceeds(getDoc(item(comoAdmin(), 'privado_de_beto')));
  });

  test('admin LISTA todos los items sin where', async () => {
    await assertSucceeds(getDocs(items(comoAdmin())));
  });
});

// ===========================================================================
//  AISLAMIENTO ENTRE WORKSPACES — nadie lee de otro workspace
// ===========================================================================
describe('aislamiento entre workspaces', () => {
  test('admin de OTRO workspace NO lee un item "equipo" de este', async () => {
    await assertFails(getDoc(item(comoAjeno(), 'equipo_de_beto')));
  });

  test('admin de OTRO workspace NO lista los items de este (ni filtrando equipo)', async () => {
    await assertFails(getDocs(query(items(comoAjeno()), where('visibilidad', '==', 'equipo'))));
  });

  test('admin de OTRO workspace NO lee la ficha del workspace ni sus members', async () => {
    const fs = comoAjeno();
    await assertFails(getDoc(doc(fs, 'workspaces', WS)));
    await assertFails(getDoc(doc(fs, 'workspaces', WS, 'members', UID.ana)));
  });

  test('miembro de ESTE workspace SÍ lee la ficha y los members (control)', async () => {
    const fs = comoAna();
    await assertSucceeds(getDoc(doc(fs, 'workspaces', WS)));
    await assertSucceeds(getDoc(doc(fs, 'workspaces', WS, 'members', UID.ana)));
  });

  test('miembro de este workspace NO lee items del workspace B', async () => {
    await assertFails(getDoc(item(comoAna(), 'equipo_del_ws_b', WS_OTRO)));
  });

  test('nadie hace collectionGroup("items") desde el cliente, ni el admin', async () => {
    await assertFails(getDocs(query(collectionGroup(comoAdmin(), 'items'), where('workspaceId', '==', WS))));
  });

  test('logueado SIN claim ws no lee nada del workspace', async () => {
    const fs = comoSinClaim();
    await assertFails(getDoc(item(fs, 'equipo_de_beto')));
    await assertFails(getDoc(doc(fs, 'workspaces', WS)));
  });

  test('sin login no se lee nada', async () => {
    const fs = comoAnonimo();
    await assertFails(getDoc(item(fs, 'equipo_de_beto')));
    await assertFails(getDoc(doc(fs, 'workspaces', WS)));
  });
});

// ===========================================================================
//  ITEMS — CREACION (invariante 1: solo campos CLIENTE, nace 'pendiente')
// ===========================================================================
describe('items: creación desde el cliente', () => {
  test('miembro CREA una nota con SOLO campos CLIENTE y estado pendiente', async () => {
    await assertSucceeds(setDoc(item(comoAna(), idNuevo('nota')), notaNueva()));
  });

  test('miembro CREA un link con url (sin textoOriginal)', async () => {
    const { textoOriginal, ...sinTexto } = notaNueva({ tipo: 'link', url: 'https://example.com/apunte' });
    await assertSucceeds(setDoc(item(comoAna(), idNuevo('link')), sinTexto));
  });

  test('miembro CREA un Word (tipo "word") con nombreArchivo, igual que un pdf', async () => {
    await assertSucceeds(setDoc(item(comoAna(), idNuevo('word')), wordNuevo()));
  });

  test('RECHAZADO: tipo "docx" (eso es el ORIGEN del texto; el tipo es "word")', async () => {
    await assertFails(setDoc(item(comoAna(), idNuevo('word')), wordNuevo({ tipo: 'docx' })));
  });

  test('RECHAZADO: tipo inventado "excel" (la lista de tipos es cerrada)', async () => {
    await assertFails(setDoc(item(comoAna(), idNuevo('word')), wordNuevo({ tipo: 'excel' })));
  });

  test('RECHAZADO: un Word con textoOriginal (solo las notas lo llevan)', async () => {
    await assertFails(
      setDoc(item(comoAna(), idNuevo('word')), wordNuevo({ textoOriginal: 'Texto pegado a mano.' })),
    );
  });

  test('RECHAZADO: campo de más "texto" (lo escribe solo el backend)', async () => {
    await assertFails(setDoc(item(comoAna(), idNuevo('nota')), notaNueva({ texto: 'fuente falsa' })));
  });

  test('RECHAZADO: campo de más "cantChunks"', async () => {
    await assertFails(setDoc(item(comoAna(), idNuevo('nota')), notaNueva({ cantChunks: 5 })));
  });

  test('RECHAZADO: creadoPor distinto al uid del token', async () => {
    await assertFails(setDoc(item(comoAna(), idNuevo('nota')), notaNueva({ creadoPor: UID.beto })));
  });

  test('RECHAZADO: workspaceId distinto al del path', async () => {
    await assertFails(setDoc(item(comoAna(), idNuevo('nota')), notaNueva({ workspaceId: WS_OTRO })));
  });

  test('RECHAZADO: nace con estado "listo" en vez de "pendiente"', async () => {
    await assertFails(setDoc(item(comoAna(), idNuevo('nota')), notaNueva({ estado: 'listo' })));
  });

  test('RECHAZADO: creadoEn con la hora del celular (no serverTimestamp)', async () => {
    await assertFails(setDoc(item(comoAna(), idNuevo('nota')), notaNueva({ creadoEn: Timestamp.now() })));
  });

  test('RECHAZADO: alguien de otro workspace crea un item en este', async () => {
    await assertFails(
      setDoc(item(comoAjeno(), idNuevo('nota')), notaNueva({ creadoPor: UID.ajeno })),
    );
  });
});

// ===========================================================================
//  ITEMS — EDICION Y BORRADO
// ===========================================================================
describe('items: edición y borrado', () => {
  test('el autor EDITA titulo y visibilidad con actualizadoEn del servidor', async () => {
    await assertSucceeds(
      updateDoc(item(comoAna(), 'para_editar_de_ana'), {
        titulo: 'Titulo corregido',
        visibilidad: 'privado',
        actualizadoEn: serverTimestamp(),
      }),
    );
  });

  test('RECHAZADO: el autor cambia el estado (solo lo mueve el backend)', async () => {
    await assertFails(updateDoc(item(comoAna(), 'privado_de_ana'), { estado: 'pendiente' }));
  });

  test('RECHAZADO: un miembro que no es el autor edita un item "equipo"', async () => {
    await assertFails(updateDoc(item(comoAna(), 'equipo_de_beto'), { titulo: 'Lo cambio yo' }));
  });

  test('RECHAZADO: el autor borra su item desde el cliente', async () => {
    await assertFails(deleteDoc(item(comoAna(), 'privado_de_ana')));
  });

  test('RECHAZADO: el admin borra un item desde el cliente', async () => {
    await assertFails(deleteDoc(item(comoAdmin(), 'equipo_de_beto')));
  });
});

// ===========================================================================
//  RESPUESTAS — create con EXACTAMENTE 4 campos; las leen el autor o el admin
// ===========================================================================
describe('respuestas', () => {
  test('miembro CREA con EXACTAMENTE pregunta, autorUid, estado buscando y creadoEn', async () => {
    await assertSucceeds(setDoc(respuesta(comoAna(), idNuevo('resp')), preguntaNueva()));
  });

  test('RECHAZADO: campo de más workspaceId (D1: el wsId va solo en el path)', async () => {
    await assertFails(setDoc(respuesta(comoAna(), idNuevo('resp')), preguntaNueva({ workspaceId: WS })));
  });

  test('RECHAZADO: campo de más respuesta: "" (el bug de la v1)', async () => {
    await assertFails(setDoc(respuesta(comoAna(), idNuevo('resp')), preguntaNueva({ respuesta: '' })));
  });

  test('RECHAZADO: falta creadoEn', async () => {
    const { creadoEn, ...sinFecha } = preguntaNueva();
    await assertFails(setDoc(respuesta(comoAna(), idNuevo('resp')), sinFecha));
  });

  test('RECHAZADO: estado distinto de "buscando"', async () => {
    await assertFails(setDoc(respuesta(comoAna(), idNuevo('resp')), preguntaNueva({ estado: 'listo' })));
  });

  test('RECHAZADO: autorUid de otro', async () => {
    await assertFails(setDoc(respuesta(comoAna(), idNuevo('resp')), preguntaNueva({ autorUid: UID.beto })));
  });

  test('el autor LEE su respuesta', async () => {
    await assertSucceeds(getDoc(respuesta(comoAna(), 'resp_de_ana')));
  });

  test('otro miembro NO lee una respuesta ajena', async () => {
    await assertFails(getDoc(respuesta(comoBeto(), 'resp_de_ana')));
  });

  test('admin LEE la respuesta de cualquiera', async () => {
    await assertSucceeds(getDoc(respuesta(comoAdmin(), 'resp_de_ana')));
  });

  test('miembro LISTA su historial (where autorUid == su uid)', async () => {
    await assertSucceeds(getDocs(query(respuestas(comoAna()), where('autorUid', '==', UID.ana))));
  });

  test('miembro NO lista todas las respuestas sin filtro', async () => {
    await assertFails(getDocs(respuestas(comoAna())));
  });

  test('RECHAZADO: el cliente escribe la respuesta (update es del backend)', async () => {
    await assertFails(updateDoc(respuesta(comoAna(), 'resp_de_ana'), { respuesta: 'inventada' }));
  });
});

// ===========================================================================
//  RESPUESTAS — PREGUNTAS DE SEGUIMIENTO (una conversacion = una cadena)
//  La raiz es una pregunta comun (los 4 campos). Cada seguimiento suma
//  conversacionId (la raiz) y anteriorRespId (la pregunta anterior): los dos o
//  ninguno. Las reglas validan solo la FORMA; que la cadena cierre (existe, es
//  tuya, esta 'listo', es de la misma conversacion) lo valida el backend.
// ===========================================================================
describe('respuestas: preguntas de seguimiento', () => {
  test('miembro CREA un seguimiento: los 4 de siempre + conversacionId y anteriorRespId', async () => {
    await assertSucceeds(setDoc(respuesta(comoAna(), idNuevo('seg')), seguimientoNuevo()));
  });

  test('ids de 64 caracteres justos se aceptan (el tope de 1 a 64 es inclusivo)', async () => {
    await assertSucceeds(
      setDoc(
        respuesta(comoAna(), idNuevo('seg')),
        seguimientoNuevo({ conversacionId: 'c'.repeat(64), anteriorRespId: 'a'.repeat(64) }),
      ),
    );
  });

  test('RECHAZADO: solo conversacionId, sin anteriorRespId (van siempre juntos)', async () => {
    const { anteriorRespId, ...soloConversacion } = seguimientoNuevo();
    await assertFails(setDoc(respuesta(comoAna(), idNuevo('seg')), soloConversacion));
  });

  test('RECHAZADO: solo anteriorRespId, sin conversacionId', async () => {
    const { conversacionId, ...soloAnterior } = seguimientoNuevo();
    await assertFails(setDoc(respuesta(comoAna(), idNuevo('seg')), soloAnterior));
  });

  test('RECHAZADO: anteriorRespId igual al propio respId (no puede ser su propia anterior)', async () => {
    const id = idNuevo('seg');
    await assertFails(setDoc(respuesta(comoAna(), id), seguimientoNuevo({ anteriorRespId: id })));
  });

  test('RECHAZADO: conversacionId numérico', async () => {
    await assertFails(setDoc(respuesta(comoAna(), idNuevo('seg')), seguimientoNuevo({ conversacionId: 12345 })));
  });

  test('RECHAZADO: conversacionId vacío', async () => {
    await assertFails(setDoc(respuesta(comoAna(), idNuevo('seg')), seguimientoNuevo({ conversacionId: '' })));
  });

  test('RECHAZADO: conversacionId de 65 caracteres', async () => {
    await assertFails(
      setDoc(respuesta(comoAna(), idNuevo('seg')), seguimientoNuevo({ conversacionId: 'c'.repeat(65) })),
    );
  });

  test('RECHAZADO: anteriorRespId vacío (misma validación que conversacionId)', async () => {
    await assertFails(setDoc(respuesta(comoAna(), idNuevo('seg')), seguimientoNuevo({ anteriorRespId: '' })));
  });

  test('RECHAZADO: primera pregunta con los dos campos en null (se omiten, no se mandan en null)', async () => {
    await assertFails(
      setDoc(respuesta(comoAna(), idNuevo('resp')), preguntaNueva({ conversacionId: null, anteriorRespId: null })),
    );
  });

  test('RECHAZADO: el cliente manda preguntaBuscada al crear (la escribe solo el backend)', async () => {
    await assertFails(
      setDoc(
        respuesta(comoAna(), idNuevo('seg')),
        seguimientoNuevo({ preguntaBuscada: 'Para cuando necesitan el presupuesto?' }),
      ),
    );
  });

  test('RECHAZADO: primera pregunta con preguntaBuscada: null (ni en null: el campo es del backend)', async () => {
    // null es justo lo que el backend guarda en una raiz, por eso es la
    // tentacion mas probable de una app que "completa" el documento.
    await assertFails(setDoc(respuesta(comoAna(), idNuevo('resp')), preguntaNueva({ preguntaBuscada: null })));
  });

  test('RECHAZADO: el autor le escribe preguntaBuscada a su seguimiento ya creado (update cerrado)', async () => {
    await assertFails(
      updateDoc(respuesta(comoAna(), 'seg_de_ana_1'), { preguntaBuscada: 'Otra cosa que nunca pregunte' }),
    );
  });

  test('el autor LISTA su conversación (where autorUid + where conversacionId + orderBy creadoEn)', async () => {
    const foto = await assertSucceeds(getDocs(consultaConversacion(comoAna(), UID.ana, 'resp_de_ana')));
    const ids = foto.docs.map((d) => d.id);
    // Trae los seguimientos (el sembrado y los que crearon los tests de
    // arriba)...
    assert.ok(ids.includes('seg_de_ana_1'));
    // ...pero NO la raiz: la raiz no tiene conversacionId. Por eso la app
    // escucha el doc raiz por su id Y ADEMAS esta query.
    assert.ok(!ids.includes('resp_de_ana'));
  });

  test('RECHAZADO: un miembro hace esa query con el autorUid de OTRO', async () => {
    await assertFails(getDocs(consultaConversacion(comoBeto(), UID.ana, 'resp_de_ana')));
  });

  test('RECHAZADO: la query de la conversación SIN el where autorUid (las reglas no filtran)', async () => {
    await assertFails(
      getDocs(query(respuestas(comoAna()), where('conversacionId', '==', 'resp_de_ana'), orderBy('creadoEn'))),
    );
  });

  test('un seguimiento se lee como cualquier respuesta: el autor y el admin sí, otro miembro no', async () => {
    await assertSucceeds(getDoc(respuesta(comoAna(), 'seg_de_ana_1')));
    await assertSucceeds(getDoc(respuesta(comoAdmin(), 'seg_de_ana_1')));
    // El admin puede listar todo, asi que la misma query le anda con el uid
    // de cualquiera (la lectura de respuestas no cambio con esta funcion).
    await assertSucceeds(getDocs(consultaConversacion(comoAdmin(), UID.ana, 'resp_de_ana')));
    await assertFails(getDoc(respuesta(comoBeto(), 'seg_de_ana_1')));
  });

  test('RECHAZADO: otro miembro borra un seguimiento ajeno', async () => {
    await assertFails(deleteDoc(respuesta(comoBeto(), 'seg_de_ana_1')));
  });

  test('un seguimiento de OTRO que apunta a mi raíz no rompe ni ensucia mi conversación', async () => {
    // Las reglas validan solo la FORMA (no hay get() para mirar de quien es
    // la raiz), asi que Beto PUEDE crear un doc SUYO con conversacionId = la
    // raiz de Ana. No gana nada: el backend lo cierra en 'error' (el anterior
    // es de otra persona) y, como el doc es de Beto, solo lo leen Beto y el
    // admin. Por eso conversacionId no es un permiso: es solo una etiqueta.
    const plantado = idNuevo('seg');
    await assertSucceeds(
      setDoc(
        respuesta(comoBeto(), plantado),
        seguimientoNuevo({ autorUid: UID.beto, pregunta: 'Que mas dice la nota de Ana?' }),
      ),
    );
    // La query de Ana sigue andando: las reglas no revisan doc por doc, miran
    // que el where autorUid == Ana garantice que todo lo que pueda venir es de
    // ella. Y el doc de Beto no cumple ese where, asi que no viene.
    const foto = await assertSucceeds(getDocs(consultaConversacion(comoAna(), UID.ana, 'resp_de_ana')));
    assert.ok(!foto.docs.some((d) => d.id === plantado));
  });
});

// ===========================================================================
//  EVENTOS Y SUSCRIPCION — solo admin (las diferencias de rol de la materia)
// ===========================================================================
describe('eventos y suscripción: solo admin', () => {
  test('admin LEE y LISTA el feed de eventos', async () => {
    const fs = comoAdmin();
    await assertSucceeds(getDoc(evento(fs, 'ev_1')));
    await assertSucceeds(getDocs(eventos(fs)));
  });

  test('miembro NO lee un evento', async () => {
    await assertFails(getDoc(evento(comoAna(), 'ev_1')));
  });

  test('miembro NO lista eventos', async () => {
    await assertFails(getDocs(eventos(comoAna())));
  });

  test('RECHAZADO: ni el admin escribe eventos desde el cliente', async () => {
    await assertFails(
      setDoc(evento(comoAdmin(), idNuevo('ev')), {
        tipo: 'item.listo',
        actorUid: UID.admin,
        resumen: 'falso',
        itemId: null,
        creadoEn: serverTimestamp(),
      }),
    );
  });

  test('admin LEE suscripcion/actual; miembro NO', async () => {
    await assertSucceeds(getDoc(doc(comoAdmin(), 'workspaces', WS, 'suscripcion', 'actual')));
    await assertFails(getDoc(doc(comoAna(), 'workspaces', WS, 'suscripcion', 'actual')));
  });
});

// ===========================================================================
//  CHUNKS — cerrada para TODOS los clientes (invariante 16)
// ===========================================================================
describe('chunks: denegado para todos', () => {
  test('el autor del item NO lee su propio chunk', async () => {
    await assertFails(getDoc(doc(comoAna(), 'chunks', 'privado_de_ana_0')));
  });

  test('el admin NO lee un chunk', async () => {
    await assertFails(getDoc(doc(comoAdmin(), 'chunks', 'privado_de_ana_0')));
  });

  test('el admin NO lista los chunks de su workspace', async () => {
    await assertFails(getDocs(query(collection(comoAdmin(), 'chunks'), where('workspaceId', '==', WS))));
  });

  test('RECHAZADO: nadie escribe chunks desde el cliente', async () => {
    await assertFails(
      setDoc(doc(comoAdmin(), 'chunks', 'plantado_0'), {
        workspaceId: WS,
        itemId: 'plantado',
        texto: 'fuente falsa',
      }),
    );
  });
});

// ===========================================================================
//  USUARIOS Y MEMBERS — el alta y los roles los escribe solo el backend
// ===========================================================================
describe('usuarios y members', () => {
  test('RECHAZADO: el cliente crea su propio usuarios/{uid}', async () => {
    await assertFails(
      setDoc(doc(comoSinClaim(), 'usuarios', UID.sinClaim), {
        email: 'nuevo@demo.test',
        nombre: 'Nuevo',
        workspaces: {},
        workspaceActual: null,
        creadoEn: serverTimestamp(),
      }),
    );
  });

  test('cada uno LEE su propia ficha', async () => {
    await assertSucceeds(getDoc(doc(comoAna(), 'usuarios', UID.ana)));
  });

  test('nadie lee la ficha de otro, ni el admin', async () => {
    await assertFails(getDoc(doc(comoBeto(), 'usuarios', UID.ana)));
    await assertFails(getDoc(doc(comoAdmin(), 'usuarios', UID.ana)));
  });

  test('el usuario edita su nombre (2 a 60); con 1 caracter se rechaza (D2)', async () => {
    const fs = comoBeto();
    await assertSucceeds(updateDoc(doc(fs, 'usuarios', UID.beto), { nombre: 'Beto R.' }));
    await assertFails(updateDoc(doc(fs, 'usuarios', UID.beto), { nombre: 'B' }));
  });

  test('RECHAZADO: un miembro se pone rol admin en members (escalada de privilegios)', async () => {
    await assertFails(updateDoc(doc(comoAna(), 'workspaces', WS, 'members', UID.ana), { rol: 'admin' }));
  });
});

// ===========================================================================
//  CONTACTOS — el formulario de la landing (publico, solo crear)
// ===========================================================================
describe('contactos (formulario de la landing)', () => {
  const contacto = (cambios = {}) => ({
    nombre: 'Lucía Pérez',
    email: 'lucia@estudio.com',
    empresa: 'Estudio LP',
    plan: 'equipo',
    mensaje: 'Somos 8 en el estudio y queremos probarlo.',
    origen: 'landing',
    creadoEn: serverTimestamp(),
    ...cambios,
  });
  const nuevoContacto = (fs) => doc(fs, 'contactos', idNuevo('contacto'));

  test('alguien SIN login crea un pedido de contacto valido', async () => {
    await assertSucceeds(setDoc(nuevoContacto(comoAnonimo()), contacto()));
  });

  test('empresa y mensaje vacios se aceptan (son opcionales en el formulario)', async () => {
    await assertSucceeds(setDoc(nuevoContacto(comoAnonimo()), contacto({ empresa: '', mensaje: '', plan: 'no-se' })));
  });

  test('RECHAZADO: campo de mas (por ejemplo "leido")', async () => {
    await assertFails(setDoc(nuevoContacto(comoAnonimo()), contacto({ leido: true })));
  });

  test('RECHAZADO: falta un campo (empresa)', async () => {
    const sinEmpresa = contacto();
    delete sinEmpresa.empresa;
    await assertFails(setDoc(nuevoContacto(comoAnonimo()), sinEmpresa));
  });

  test('RECHAZADO: email sin @, nombre vacio o mensaje de 1001 caracteres', async () => {
    const fs = comoAnonimo();
    await assertFails(setDoc(nuevoContacto(fs), contacto({ email: 'lucia.estudio.com' })));
    await assertFails(setDoc(nuevoContacto(fs), contacto({ nombre: '' })));
    await assertFails(setDoc(nuevoContacto(fs), contacto({ mensaje: 'x'.repeat(1001) })));
  });

  test('RECHAZADO: plan inventado u origen distinto de "landing"', async () => {
    const fs = comoAnonimo();
    await assertFails(setDoc(nuevoContacto(fs), contacto({ plan: 'gratis-para-siempre' })));
    await assertFails(setDoc(nuevoContacto(fs), contacto({ origen: 'panel' })));
  });

  test('RECHAZADO: creadoEn con la hora del cliente', async () => {
    await assertFails(setDoc(nuevoContacto(comoAnonimo()), contacto({ creadoEn: Timestamp.fromDate(new Date()) })));
  });

  test('nadie LEE, edita ni borra los pedidos desde un cliente, ni un admin', async () => {
    const id = idNuevo('contacto');
    await assertSucceeds(setDoc(doc(comoAnonimo(), 'contactos', id), contacto()));
    await assertFails(getDoc(doc(comoAnonimo(), 'contactos', id)));
    await assertFails(getDoc(doc(comoAdmin(), 'contactos', id)));
    await assertFails(getDocs(collection(comoAdmin(), 'contactos')));
    await assertFails(updateDoc(doc(comoAdmin(), 'contactos', id), { mensaje: 'editado' }));
    await assertFails(deleteDoc(doc(comoAdmin(), 'contactos', id)));
  });
});