// ============================================================================
//  pantallas/dashboard.js  —  4 numeros grandes y un grafico.
//  Panel web de NeuroDesk AI.
//
//  REGLA DE ESTA PANTALLA: UN SOLO onSnapshot alimenta TODO.
//
//  La tentacion es hacer una query por KPI ("una para contar los listos, otra
//  para los que fallaron..."). Seria mas facil de leer y cuatro veces mas caro:
//  cada query es su propio stream y cada cambio de un item dispara los cuatro.
//  Como los items ya vienen enteros en una sola escucha, los cuatro numeros y
//  el grafico salen de recorrer ese array en memoria. Contar 200 objetos en JS
//  es instantaneo; 800 lecturas de Firestore por minuto, no.
//
//  Y la otra regla, la del grafico: new Chart() UNA sola vez. Despues,
//  chart.update(). Ver el comentario grande de dibujarGrafico().
// ============================================================================

import {
  db, collection, query, orderBy, limit, onSnapshot
} from '../firebase.js';

// Esta pantalla no interpola NADA que venga de Firestore adentro de innerHTML
// (solo numeros que contamos nosotros y textos nuestros), asi que es la unica
// que no necesita esc(). Si algun dia se muestra el titulo de un item aca,
// vuelve a hacer falta.
import { aFecha, diaCorto } from '../util.js';


let cortarEscucha = null;
let raiz = null;
let ctxPantalla = null;

// La instancia de Chart.js. Vive mientras la pantalla esta montada.
let grafico = null;

const TOPE_FILAS = 200;   // el mismo tope que la pantalla de items
const DIAS_GRAFICO = 7;


// ============================================================================
//  MOUNT
// ============================================================================
export async function mount(contenedor, ctx) {
  raiz = contenedor;
  ctxPantalla = ctx;

  raiz.innerHTML = plantilla();

  // Chart.js entra por CDN con un <script> normal en app.html, asi que llega
  // como variable global. Si no cargo (sin internet, o el CDN bloqueado por la
  // red de la escuela), los KPIs tienen que funcionar igual: son lo importante.
  if (typeof Chart === 'undefined') {
    raiz.querySelector('#cajaGrafico').innerHTML =
      `<div class="aviso aviso-info">
         No se pudo cargar Chart.js desde el CDN. Los números de arriba
         funcionan igual; el gráfico vuelve cuando haya internet.
       </div>`;
  }

  escuchar();
}


// ============================================================================
//  UNMOUNT
// ============================================================================
export function unmount() {
  if (cortarEscucha) {
    cortarEscucha();
    cortarEscucha = null;
  }

  // destroy() es OBLIGATORIO aca. Chart.js se guarda una referencia interna
  // por cada <canvas> que usa; si nos vamos de la pantalla sin destruir el
  // grafico, esa referencia queda viva apuntando a un canvas que ya no esta en
  // el documento (fuga de memoria), y al volver a entrar el canvas nuevo tiene
  // el mismo id: Chart.js tira "Canvas is already in use. Chart with ID '0'
  // must be destroyed before the canvas can be reused."
  if (grafico) {
    grafico.destroy();
    grafico = null;
  }

  raiz = null;
  ctxPantalla = null;
}


// ============================================================================
//  LA UNICA ESCUCHA
// ============================================================================
function escuchar() {
  const consulta = query(
    collection(db, 'workspaces', ctxPantalla.wsId, 'items'),
    orderBy('creadoEn', 'desc'),
    limit(TOPE_FILAS)
  );

  cortarEscucha = onSnapshot(
    consulta,
    (foto) => {
      const items = foto.docs.map((d) => d.data());
      dibujarKpis(items);
      dibujarGrafico(items);
    },
    (e) => {
      console.error('[dashboard] se corto la escucha', e);
      raiz.querySelector('#avisoDash').innerHTML =
        `<div class="aviso aviso-error">
           No pudimos leer los datos del espacio. Probá cerrar sesión y volver
           a entrar: casi siempre es el token viejo.
         </div>`;
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
        <h1>Resumen del espacio</h1>
        <p class="apagado chico">
          Sobre los ${TOPE_FILAS} items más nuevos, en tiempo real.
        </p>
      </div>
    </div>

    <div id="avisoDash"></div>

    <div class="grilla-kpis">
      <div class="tarjeta kpi">
        <div class="etiqueta-kpi">Items</div>
        <div class="valor" id="kpiTotal">—</div>
        <div class="pie-kpi">cargados en el espacio</div>
      </div>

      <div class="tarjeta kpi kpi-listo">
        <div class="etiqueta-kpi">Listos</div>
        <div class="valor" id="kpiListos">—</div>
        <div class="pie-kpi" id="kpiTrozos">la IA ya los puede citar</div>
      </div>

      <div class="tarjeta kpi kpi-encola">
        <div class="etiqueta-kpi">En cola</div>
        <div class="valor" id="kpiEnCola">—</div>
        <div class="pie-kpi">pendientes o procesándose</div>
      </div>

      <div class="tarjeta kpi kpi-error">
        <div class="etiqueta-kpi">Con error</div>
        <div class="valor" id="kpiErrores">—</div>
        <div class="pie-kpi">hay que reintentarlos desde la app</div>
      </div>
    </div>

    <div class="tarjeta">
      <h2>Actividad de los últimos ${DIAS_GRAFICO} días</h2>
      <p class="apagado chico">Cuántos items se cargaron cada día.</p>
      <div class="caja-grafico" id="cajaGrafico">
        <canvas id="lienzoGrafico"></canvas>
      </div>
    </div>
  `;
}


// ----------------------------------------------------------------------------
// Los cuatro numeros. Un solo recorrido del array.
// ----------------------------------------------------------------------------
function dibujarKpis(items) {
  let listos = 0, enCola = 0, errores = 0, trozos = 0;

  for (const item of items) {
    if (item.estado === 'listo') {
      listos++;
      trozos += item.cantChunks ?? 0;
    } else if (item.estado === 'pendiente' || item.estado === 'procesando') {
      enCola++;
    } else if (item.estado === 'error') {
      errores++;
    }
  }

  const poner = (id, valor) => {
    const nodo = raiz?.querySelector('#' + id);
    if (nodo) nodo.textContent = valor;
  };

  poner('kpiTotal',   items.length);
  poner('kpiListos',  listos);
  poner('kpiEnCola',  enCola);
  poner('kpiErrores', errores);

  // El total de trozos indexados es el numero que mejor explica en la demo
  // que "la IA leyo el material": son los pedacitos con embedding que estan
  // en la coleccion /chunks y que se comparan contra cada pregunta.
  const pie = raiz?.querySelector('#kpiTrozos');
  if (pie) pie.textContent = `${trozos} trozos indexados para la IA`;
}


// ----------------------------------------------------------------------------
// El grafico de barras.
//
// ACA ESTA LA TRAMPA DE CHART.JS, la que hace perder media hora:
//
//   Chart.js se guarda un registro global por cada <canvas> que usa. Si en
//   cada onSnapshot hicieramos `new Chart(lienzo, ...)` —que es lo que sale
//   naturalmente, porque "redibujar" suena a "crear de nuevo"— el segundo
//   snapshot explota con:
//       "Canvas is already in use. Chart with ID '0' must be destroyed
//        before the canvas can be reused."
//   Y como los snapshots llegan solos cuando alguien sube algo, el error
//   aparece justo en la demo y no cuando uno esta probando.
//
//   La forma correcta: crear el grafico UNA vez, y despues pisarle los datos
//   y llamar a update(). Ademas es mucho mas barato y anima la transicion en
//   vez de parpadear.
//
//   El destroy() del final vive en unmount(), que es el otro momento en que
//   el canvas cambia (al salir de la pantalla).
// ----------------------------------------------------------------------------
function dibujarGrafico(items) {
  if (typeof Chart === 'undefined') return;   // el CDN no cargo: KPIs y nada mas

  const lienzo = raiz?.querySelector('#lienzoGrafico');
  if (!lienzo) return;

  const { etiquetas, valores } = contarPorDia(items);

  // --- SEGUNDA VUELTA EN ADELANTE: actualizar ---
  if (grafico) {
    grafico.data.labels = etiquetas;
    grafico.data.datasets[0].data = valores;
    grafico.update();
    return;
  }

  // --- PRIMERA VUELTA: crear ---
  grafico = new Chart(lienzo, {
    type: 'bar',
    data: {
      labels: etiquetas,
      datasets: [{
        label: 'Items cargados',
        data: valores,
        // El violeta de la marca. Esta repetido a mano porque Chart.js dibuja
        // en un canvas y no lee variables CSS.
        backgroundColor: '#5b58e8',
        borderRadius: 5,
        maxBarThickness: 48
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,   // manda la altura del contenedor (.caja-grafico)
      plugins: {
        legend: { display: false }  // un solo dataset: la leyenda no dice nada
      },
      scales: {
        y: {
          beginAtZero: true,
          // Son items: no existe "2,5 items". Sin esto, con pocos datos el eje
          // se llena de decimales.
          ticks: { precision: 0 },
          grid: { color: '#e2e4ee' }
        },
        x: {
          grid: { display: false }
        }
      }
    }
  });
}


// ----------------------------------------------------------------------------
// contarPorDia()  —  arma los ultimos 7 dias (aunque no haya items ninguno de
// esos dias) y cuenta cuantos items se crearon en cada uno.
//
// Se arma la lista de dias PRIMERO y despues se cuenta encima. Si contaramos
// solo los dias que aparecen en los datos, un dia sin actividad simplemente no
// existiria y el grafico mentiria: se veria una barra al lado de la otra como
// si hubieran sido dias seguidos.
// ----------------------------------------------------------------------------
function contarPorDia(items) {
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  const etiquetas = [];
  const claves = [];
  const conteo = {};

  for (let i = DIAS_GRAFICO - 1; i >= 0; i--) {
    const dia = new Date(hoy);
    dia.setDate(hoy.getDate() - i);
    const clave = claveDeDia(dia);
    claves.push(clave);
    etiquetas.push(diaCorto(dia));
    conteo[clave] = 0;
  }

  for (const item of items) {
    // creadoEn puede ser null por un instante (serverTimestamp todavia sin
    // confirmar): ese item se cuenta en el proximo snapshot, no rompe nada.
    const fecha = aFecha(item.creadoEn);
    if (!fecha) continue;
    const clave = claveDeDia(fecha);
    if (clave in conteo) conteo[clave]++;   // los mas viejos que 7 dias se ignoran
  }

  return { etiquetas, valores: claves.map((c) => conteo[c]) };
}

// "2026-09-14". Se usa como clave del objeto: dos fechas del mismo dia dan la
// misma cadena, sin importar la hora.
function claveDeDia(fecha) {
  const dosDigitos = (n) => String(n).padStart(2, '0');
  return `${fecha.getFullYear()}-${dosDigitos(fecha.getMonth() + 1)}-${dosDigitos(fecha.getDate())}`;
}
