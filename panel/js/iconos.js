// ============================================================================
//  iconos.js  —  los iconos del panel, dibujados a mano en SVG.
//  Panel web de NeuroDesk AI.
//
//  POR QUE A MANO Y NO UNA LIBRERIA DE ICONOS: son 20 dibujitos de lineas. Una
//  libreria por CDN seria una descarga mas (y un CDN mas que la red de la
//  escuela puede bloquear) para usar el 1 % de lo que trae.
//
//  Todos son de 24x24, con trazo del color del texto (currentColor): el mismo
//  icono sirve en la barra oscura, en una fila roja o en un chip cian, sin
//  tocar nada. Van con aria-hidden porque al lado siempre hay un texto que
//  dice lo mismo: un lector de pantalla leeria dos veces "Del equipo".
//
//  SEGURIDAD: este archivo es lo UNICO que se pega en innerHTML sin esc(), y es
//  seguro porque son textos fijos nuestros. Ningun dato de Firestore entra
//  aca: icono() solo acepta nombres de esta lista (con cualquier otro devuelve
//  el generico).
// ============================================================================

const TRAZOS = {
  // --- menu ---
  contenido:   '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  radar:       '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="m12 12 6.4-6.4"/>',
  vivo:        '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  miembros:    '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  resumen:     '<path d="M4 20h16"/><path d="M7 16v-5"/><path d="M12 16V6"/><path d="M17 16v-8"/>',

  // --- tipos de evento ---
  listo:       '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16 10"/>',
  alerta:      '<path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4.5"/><path d="M12 17.3v.2"/>',
  tacho:       '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 13h10l1-13"/>',
  limpieza:    '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  candado:     '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  personaMas:  '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M19 8v6M16 11h6"/>',
  personaMenos:'<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0"/><path d="M16 11h6"/>',
  escudo:      '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  pregunta:    '<path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L3.5 21l1.4-4.9A8.5 8.5 0 1 1 21 12z"/><path d="M9.7 9.6a2.4 2.4 0 0 1 4.6.9c0 1.6-2.3 2-2.3 3.4"/><path d="M12 16.6v.2"/>',
  plan:        '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M7 15h3"/>',
  chispa:      '<path d="M12 3v4M12 17v4M3 12h4M17 12h4"/><path d="m6.3 6.3 2.4 2.4M15.3 15.3l2.4 2.4M6.3 17.7l2.4-2.4M15.3 8.7l2.4-2.4"/>',
  generico:    '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',

  // --- sueltos ---
  equipo:      '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 14.2a6.5 6.5 0 0 1 3.5 5.8"/>',
  mas:         '<path d="M12 5v14M5 12h14"/>',
  sol:         '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  luna:        '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.8 6.8 0 0 0 10.5 10.5z"/>'
};


// icono('candado')  ->  '<svg ...>...</svg>'
// La clase extra sirve para el tamaño (ver .icono en estilo.css).
export function icono(nombre, clase = '') {
  const trazo = Object.hasOwn(TRAZOS, nombre) ? TRAZOS[nombre] : TRAZOS.generico;
  return `<svg class="icono ${clase}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
         `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ` +
         `focusable="false">${trazo}</svg>`;
}
