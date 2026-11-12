// ============================================================================
//  tipos.js  —  el TIPO y el ORIGEN de un item, en castellano y con su icono,
//  para todas las pantallas que los muestran (Contenido, En vivo y Lo que
//  falta). Panel web de NeuroDesk AI.
//
//  POR QUE UN ARCHIVO APARTE: antes la lista vivia adentro de
//  pantallas/items.js. Con el item 'mixto' («Varios») el tipo aparece en tres
//  pantallas, y tres copias de la misma lista son tres lugares donde
//  olvidarse del tipo nuevo la proxima vez.
//
//  EL ITEM 'mixto' («Varios»): junta en UN solo item texto, varios links y
//  varios archivos (fotos, PDF, Word). El backend le escribe
//      origen: 'mixto'
//      partes: [{ etiqueta, tipo, origen, paginas, caracteres, error }]
//  y cada parte se lee por su lado: una puede fallar (una foto que no se
//  lee) y las otras quedar bien. Por eso el panel cuenta las partes y avisa
//  cuales tuvieron error, en vez de mostrar un solo "Listo" que esconda eso.
//
//  No importa Firebase ni toca el DOM: se prueba con node, desde AFUERA de
//  panel/ (ver el README: todo lo .js de aca se publica).
//
//  SEGURIDAD: todo lo que devuelve HTML (etiquetaDeTipo) pasa el texto por
//  esc(). La etiqueta y el error de cada parte los escribe el backend, pero la
//  etiqueta sale del nombre de un archivo o de un link que eligio otra
//  persona: se trata como hostil, igual que el titulo.
// ============================================================================

import { esc, plural } from './util.js';
import { icono } from './iconos.js';


// 'documento' NO aparece a proposito: en la app es solo el boton que acepta
// PDF y Word, y el item se guarda como 'pdf' o como 'word'.
const TEXTO_DE_TIPO = {
  nota:  'Nota',
  pdf:   'PDF',
  word:  'Word',
  link:  'Link',
  foto:  'Foto',
  mixto: 'Varios'
};

// El dibujo de cada tipo (los nombres son de iconos.js). PDF y Word comparten
// la hoja: el texto de al lado ya dice cual es.
const ICONO_DE_TIPO = {
  nota:  'nota',
  pdf:   'documento',
  word:  'documento',
  link:  'link',
  foto:  'foto',
  mixto: 'clip'
};

// 'origen' es el enum CERRADO del modelo que escribe el backend: de donde
// salio el texto que lee la IA. El valor crudo queda en el title de la celda.
// 'mixto' casi no se muestra: en su lugar va "3 partes" (ver resumenDePartes).
const TEXTO_DE_ORIGEN = {
  'nota':      'Texto de la nota',
  'pdf-texto': 'Texto del PDF',
  'docx':      'Texto del Word',
  'ocr-space': 'Leído con OCR',
  'link':      'Texto de la página',
  'mixto':     'Varias partes'
};


// Object.hasOwn y no TEXTO_DE_TIPO[tipo] a secas: con un tipo cargado a mano
// como 'constructor' o 'toString', el objeto devolveria una funcion heredada.
// Un tipo que no esta en la lista se devuelve crudo (el que lo dibuja lo pasa
// por esc()), igual que chipDeEstado() en items.js: no se rompe la fila.
export function textoDeTipo(tipo) {
  return Object.hasOwn(TEXTO_DE_TIPO, tipo) ? TEXTO_DE_TIPO[tipo] : (tipo ? String(tipo) : '—');
}

export function textoDeOrigen(origen) {
  return Object.hasOwn(TEXTO_DE_ORIGEN, origen) ? TEXTO_DE_ORIGEN[origen] : String(origen ?? '');
}

// El chip apagado del tipo, con su dibujo: "[clip] Varios". Para un tipo que
// no conocemos, el icono generico y el valor crudo ESCAPADO.
export function etiquetaDeTipo(tipo) {
  const dibujo = Object.hasOwn(ICONO_DE_TIPO, tipo) ? ICONO_DE_TIPO[tipo] : 'generico';
  return `<span class="etiqueta">${icono(dibujo)} ${esc(textoDeTipo(tipo))}</span>`;
}


// ----------------------------------------------------------------------------
// partesDe(item)  —  las partes de un 'mixto', limpias y siempre con la misma
// forma: [{ etiqueta, tipo, origen, paginas, caracteres, error }].
//
// Defensiva a proposito: mientras el item esta 'pendiente' el backend todavia
// no escribio 'partes' (devuelve []), y un doc tocado a mano desde la consola
// puede traer cualquier cosa. Lo que no es un objeto se saltea; una parte sin
// etiqueta se llama por su tipo ("Foto") o por su numero ("Parte 3").
// ----------------------------------------------------------------------------
export function partesDe(item) {
  const crudas = Array.isArray(item?.partes) ? item.partes : [];
  const partes = [];

  crudas.forEach((p, i) => {
    if (!p || typeof p !== 'object') return;
    const etiqueta = typeof p.etiqueta === 'string' && p.etiqueta.trim()
      ? p.etiqueta.trim()
      : (Object.hasOwn(TEXTO_DE_TIPO, p.tipo) ? TEXTO_DE_TIPO[p.tipo] : `Parte ${i + 1}`);
    partes.push({
      etiqueta,
      tipo: p.tipo ?? null,
      origen: p.origen ?? null,
      paginas: Number.isFinite(p.paginas) ? p.paginas : null,
      caracteres: Number.isFinite(p.caracteres) ? p.caracteres : null,
      // El error lo escribe el backend a mano y en castellano (como errorMsg).
      // Si viniera algo que no es texto (true, un objeto), igual cuenta como
      // error, con un mensaje generico: no se esconde.
      error: p.error
        ? (typeof p.error === 'string' && p.error.trim() ? p.error.trim() : 'No se pudo leer esta parte.')
        : null
    });
  });

  return partes;
}


// { texto: '3 partes', errores: '1 con error' | null }, o null si no hay
// partes (todavia). Van separados para que el error se pinte en rojo.
export function resumenDePartes(partes) {
  if (!partes.length) return null;
  const conError = partes.filter((p) => p.error).length;
  return {
    texto: plural(partes.length, 'parte', 'partes'),
    errores: conError ? `${conError} con error` : null
  };
}


// "Texto · Presupuesto.pdf · Pizarrón.jpg · y 2 más": la segunda linea del
// titulo de un 'mixto', donde los otros tipos muestran su archivo o su link.
// Hasta 'tope' nombres: con ocho archivos la celda se comeria la tabla.
// Es TEXTO plano: el que lo pone en innerHTML lo pasa por esc().
export function listaCorta(nombres, tope = 3) {
  const lista = nombres.slice(0, tope);
  if (nombres.length > tope) lista.push(`y ${nombres.length - tope} más`);
  return lista.join(' · ');
}

export function listaDePartes(partes, tope = 3) {
  return listaCorta(partes.map((p) => p.etiqueta), tope);
}


// linksDe(item)  —  los links que la persona puso en un 'mixto' (el campo
// 'links' que escribe la APP al crearlo: de 1 a 5 URLs). Sirven mientras el
// backend todavia no escribio 'partes' (un 'pendiente' recien subido): asi la
// fila ya dice algo de lo que trae. Solo strings: lo demas se ignora.
export function linksDe(item) {
  return Array.isArray(item?.links)
    ? item.links.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim())
    : [];
}


// Una parte en una linea, para el title de la celda:
// "Presupuesto.pdf: Texto del PDF, 3 págs." / "Pizarrón.jpg: con error (...)".
// Es TEXTO plano: el que lo pone en un atributo lo pasa por esc().
export function detalleDeParte(parte) {
  if (parte.error) return `${parte.etiqueta}: con error (${parte.error})`;
  const datos = [];
  if (parte.origen) datos.push(textoDeOrigen(parte.origen));
  else if (parte.tipo) datos.push(textoDeTipo(parte.tipo));
  if (parte.paginas) datos.push(plural(parte.paginas, 'pág.', 'págs.'));
  return datos.length ? `${parte.etiqueta}: ${datos.join(', ')}` : parte.etiqueta;
}
