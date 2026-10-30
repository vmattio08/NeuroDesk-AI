// ============================================================================
//  nombres.js  —  de uid a nombre, para TODAS las pantallas que muestran
//  quien hizo algo (la columna Autor, "quien pregunto", "Ahora mismo").
//  Panel web de NeuroDesk AI.
//
//  Lee dos cosas, UNA vez, con get (no con onSnapshot):
//    1) workspaces/{wsId}/members        -> los que estan hoy en el equipo
//    2) workspaces/{wsId}.exMiembros     -> el nombre de los que se fueron
//  Las dos las puede leer cualquier miembro (y el admin, claro): no hace falta
//  ninguna regla nueva.
//
//  POR QUE UNA SOLA LECTURA Y NO EN VIVO: el equipo cambia una vez por semana.
//  Un stream vivo por pantalla serian lecturas facturadas en cada cambio para
//  una columna que casi nunca se mueve. Si alguien entra o sale mientras se
//  mira una pantalla, el nombre se actualiza la proxima vez que se entra.
//  (Mismo intercambio consciente que ya explicaba items.js.)
//
//  La REGLA para armar el nombre vive en util.js (nombreDeAutor), y es la
//  misma en la app y en el servidor: members -> exMiembros -> "Ex integrante".
// ============================================================================

import { db, collection, doc, getDocs, getDoc } from './firebase.js';
import { nombreDeAutor } from './util.js';


export async function leerNombres(wsId) {
  // Object.create(null): un mapa sin nada heredado. Los uid son texto que no
  // controlamos del todo, y un objeto comun ya "tiene" claves como 'toString'.
  const nombrePorUid = Object.create(null);
  let exMiembros = Object.create(null);

  // Las dos lecturas en paralelo, y si una falla la otra sirve igual: los
  // nombres son un lujo, no pueden romper la pantalla entera.
  const [miembros, workspace] = await Promise.allSettled([
    getDocs(collection(db, 'workspaces', wsId, 'members')),
    getDoc(doc(db, 'workspaces', wsId))
  ]);

  if (miembros.status === 'fulfilled') {
    miembros.value.forEach((d) => {
      // SOLO el nombre, como pide la regla comun. Si un doc de members viniera
      // sin nombre (roto), nombreDeAutor sigue con exMiembros y "Ex integrante",
      // igual que en la app: mejor eso que dos piezas mostrando cosas distintas.
      const nombre = d.data().nombre;
      if (typeof nombre === 'string' && nombre.trim()) nombrePorUid[d.id] = nombre.trim();
    });
  } else {
    console.warn('[panel] no pude leer los miembros', miembros.reason);
  }

  if (workspace.status === 'fulfilled' && workspace.value.exists()) {
    // exMiembros lo escribe SOLO el servidor (uid -> { nombre, salioEn }).
    // Puede no existir: un espacio del que nunca se fue nadie no lo tiene.
    const ex = workspace.value.data().exMiembros;
    if (ex && typeof ex === 'object') exMiembros = ex;
  } else if (workspace.status === 'rejected') {
    console.warn('[panel] no pude leer el espacio (exMiembros)', workspace.reason);
  }

  return {
    nombrePorUid,
    exMiembros,
    nombreDe: (uid) => nombreDeAutor(uid, nombrePorUid, exMiembros)
  };
}
