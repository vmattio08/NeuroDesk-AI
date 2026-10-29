// ============================================================================
//  video.js  —  la seccion "Mirá cómo funciona".
//
//  CONTRATO: la seccion queda OCULTA mientras su atributo data-video-url este
//  vacio. Cuando alguien pega ahi un link de YouTube, este archivo:
//    1. saca el id del video del link (acepta los formatos comunes);
//    2. arma el iframe con youtube-nocookie.com, el dominio de YouTube que no
//       guarda cookies de seguimiento hasta que la persona le da play;
//    3. muestra la seccion y el link "Mirá el video" del hero.
//
//  Si el link no es de YouTube, la seccion sigue oculta y avisa en la consola.
// ============================================================================

export function iniciarVideo() {
  const seccion = document.querySelector('[data-video-url]');
  if (!seccion) return;

  const link = (seccion.dataset.videoUrl || '').trim();
  if (!link) {
    seccion.hidden = true;        // el caso normal hasta que haya video
    return;
  }

  const video = leerLinkDeYouTube(link);
  if (!video) {
    console.warn('[landing] data-video-url no es un link de YouTube que entienda:', link);
    seccion.hidden = true;
    return;
  }

  const parametros = new URLSearchParams({ rel: '0' });   // al terminar, no recomienda videos de otros canales
  if (video.inicio > 0) parametros.set('start', String(video.inicio));

  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube-nocookie.com/embed/${video.id}?${parametros}`;
  iframe.title = 'Video: cómo funciona NeuroDesk AI';
  iframe.loading = 'lazy';        // no se baja nada hasta que la seccion se acerca a la pantalla
  iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.allowFullscreen = true;

  seccion.querySelector('.video__marco')?.replaceChildren(iframe);
  seccion.hidden = false;

  for (const enlace of document.querySelectorAll('[data-enlace-video]')) {
    enlace.hidden = false;
  }
}


// ----------------------------------------------------------------------------
// leerLinkDeYouTube(texto) -> { id, inicio } o null
//
// Formatos que acepta:
//   https://www.youtube.com/watch?v=ID        (el de la barra del navegador)
//   https://youtu.be/ID                       (el de "Compartir")
//   https://www.youtube.com/shorts/ID
//   https://www.youtube.com/embed/ID  y  https://www.youtube-nocookie.com/embed/ID
//   https://www.youtube.com/live/ID
// Con ?t=90 o ?t=1m30s arranca en ese segundo.
//
// El id de YouTube son siempre 11 caracteres (letras, numeros, - y _).
// Chequearlo es lo que impide que un link raro arme una URL rara.
// ----------------------------------------------------------------------------
function leerLinkDeYouTube(texto) {
  let url;
  try {
    url = new URL(texto);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^(www\.|m\.)/, '');
  let id = null;

  if (host === 'youtu.be') {
    id = url.pathname.slice(1).split('/')[0];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      const partes = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
      if (partes) id = partes[1];
    }
  }

  if (!/^[A-Za-z0-9_-]{11}$/.test(id || '')) return null;

  return { id, inicio: segundos(url.searchParams.get('t') || url.searchParams.get('start')) };
}


// "90" -> 90 · "1m30s" -> 90 · "1h2m" -> 3720 · cualquier otra cosa -> 0
function segundos(valor) {
  if (!valor) return 0;
  if (/^\d+$/.test(valor)) return Number(valor);
  const partes = valor.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!partes) return 0;
  const [, h = 0, m = 0, s = 0] = partes;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}
