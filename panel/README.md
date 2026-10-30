# Panel web del admin — NeuroDesk AI

El panel de administración. JavaScript vanilla con **módulos ES nativos** y el
SDK de Firebase por CDN: **no hay `npm install`, no hay bundler, no hay React**.
Se sirve la carpeta y anda.

Quién lo usa: el **administrador** de un espacio de trabajo. Quien no es admin
de ningún espacio no puede entrar (y aunque se saltee el JS, Firestore no le
entrega nada: ver *"¿Es seguro?"* al final).

---

## 1. Configuración (ya está completa)

No hay nada que pegar antes de abrirlo.

| Archivo | Qué tiene |
|---|---|
| `js/firebase.js` | el objeto `configFirebase` del proyecto `neurodesk-6to` (sale de Consola de Firebase → ⚙ Configuración del proyecto → Tus apps → App web → **Config**) |
| `js/api.js` | `URL_API`, que **se elige sola** según desde dónde se abre el panel: desde `localhost` o `127.0.0.1`, el backend de la compu (`http://localhost:8080`); desde cualquier otro lado (el sitio publicado), el de Render (`https://neurodesk-api.onrender.com`). Así nunca se publica apuntando a `localhost`. |

Si algún día la config de Firebase queda vacía, el login lo avisa con un cartel
rojo en vez de tirar un error críptico en la consola.

---

## 2. Cómo abrirlo

> **NO funciona con doble clic en `index.html`.**
> Con `file://` el navegador bloquea los `import` de los módulos ES (política de
> CORS) y la pantalla queda en blanco con un error rojo en la consola. **Hay que
> servirlo por HTTP.** Es la pregunta número uno cuando "no anda nada".

### Opción A — Live Server de VS Code (la que usamos)

1. Instalar la extensión **Live Server** (Ritwick Dey).
2. Clic derecho sobre `panel/index.html` → **Open with Live Server**.
3. Se abre en `http://127.0.0.1:5500/fase2/panel/index.html`.

> ⚠️ Si el navegador te lleva a `127.0.0.1` y el backend espera `localhost`
> (o al revés), **son orígenes distintos para CORS**. Elegí uno y usá siempre
> el mismo. Nosotros usamos `http://localhost:5500`.

### Opción B — Python (viene instalado en casi todos lados)

```bash
cd fase2/panel
python -m http.server 5500
# después: http://localhost:5500
```

### Opción C — Node, sin instalar nada permanente

```bash
cd fase2/panel
npx serve -l 5500
```

### Opción D — Como queda publicado (landing + panel juntos)

Para ver el panel exactamente como lo va a servir Firebase Hosting, en
`/panel/` y al lado de la landing: ver **"Publicar el sitio"** en
`fase2/README.md`. Queda en `http://localhost:5002/panel/`. Ojo: desde el
puerto 5002, invitar o quitar miembros contra el backend local necesita sumar
ese origen a `CORS_ORIGENES` (ver la sección 6).

### Lo que además tiene que estar listo en Firebase

- **Reglas desplegadas**: `firebase deploy --only firestore:rules`
  (las de `fase2/firebase/firestore.rules`).
- **Índices desplegados**: `firebase deploy --only firestore:indexes`.
  Sin esto, filtrar por estado tira `failed-precondition`; el error que sale en
  la consola del navegador trae el link para crear el índice con un clic.
- **Dominio autorizado en Auth**: Authentication → Settings → *Authorized
  domains*. `localhost` ya viene autorizado. **Cuando publiques, hay que
  agregar el dominio nuevo a esa lista**, o el login falla con
  `auth/unauthorized-domain`.
- **CORS en el backend**: el backend solo acepta pedidos desde los orígenes de
  su lista (`CORS_ORIGENES`). En la compu, sin esa variable, acepta
  `localhost` y `127.0.0.1` en los puertos 5500 y 8080. En Render,
  `render.yaml` ya trae los dos dominios de Firebase Hosting
  (`neurodesk-6to.web.app` y `neurodesk-6to.firebaseapp.com`).

---

## 3. Cómo se publica

**Va junto con la landing, en Firebase Hosting, bajo `/panel/`:**
`https://neurodesk-6to.web.app/panel/`. El paso a paso (armar, probar y
publicar, siempre con el OK de los dos) está en **"Publicar el sitio"** en
`fase2/README.md`.

Lo que hay que saber de este panel publicado:

- **Se sirve tal cual está en esta carpeta**: `scripts/armar-sitio.mjs` lo
  copia a `sitio/panel/` (menos este README) y Hosting publica `sitio/`. No hay
  build ni nada que cambiar a mano: las rutas son relativas (`css/estilo.css`,
  `./js/...`, `app.html`) y `URL_API` pasa sola a Render.
- **Con `cleanUrls`**, Hosting saca el `.html` de las direcciones: `app.html`
  redirige a `/panel/app` y `index.html` a `/panel/`. Las páginas siguen
  enlazándose con `.html` a propósito, para que también anden con Live Server.
- **`/panel` sin la barra final redirige a `/panel/`** (regla en
  `firebase.json`). Sin la barra, el navegador resolvería `css/estilo.css` como
  `/css/estilo.css`, que es de la landing, y el panel cargaría roto.
- El dominio `neurodesk-6to.web.app` ya viene autorizado en Firebase Auth, y
  `render.yaml` ya lo tiene en `CORS_ORIGENES`: no hay que tocar nada más.

> **No correr `firebase init hosting`**: pisaría la configuración de hosting
> de `firebase.json` (que publica `sitio/`, no `panel/`).

Si alguna vez hiciera falta publicarlo en otro lado (GitHub Pages, Netlify
Drop), anda igual porque es estático, pero ese dominio nuevo hay que sumarlo a
`CORS_ORIGENES` en Render.

---

## 4. Mapa de la carpeta

```
panel/
├── index.html              login (la puerta)
├── app.html                el shell: barra lateral + router por hash + botón de tema
├── css/estilo.css          todo el CSS, con la paleta arriba de todo (tema oscuro y claro)
├── img/isotipo-oscuro.png  el logo OFICIAL, copiado byte a byte de marca/png/ (nunca se redibuja)
├── js/
│   ├── firebase.js         initializeApp + Firestore con caché persistente
│   │                       (acá está la config del proyecto)
│   ├── auth.js             entrar, salir y el guardia de admin
│   ├── api.js              pedir(): la única función que llama al backend
│   │                       (URL_API: local o Render, se elige sola)
│   ├── util.js             esc(), las fechas y nombreDeAutor() (funciones puras)
│   ├── nombres.js          de uid a nombre: members + exMiembros (lee una vez)
│   ├── iconos.js           los íconos del panel, en SVG hecho a mano
│   ├── radar-calculos.js   las cuentas del Radar, SIN Firebase (se prueban con node)
│   └── pantallas/
│       ├── items.js        Contenido: tabla en vivo + buscador + filtros + candado
│       ├── radar.js        Lo que falta: preguntas sin respuesta + "Cargar la respuesta"
│       ├── actividad.js    En vivo: eventos en tiempo real + franja "Ahora mismo"
│       ├── miembros.js     alta, baja y cambio de rol (llama al backend)
│       └── dashboard.js    Resumen: 4 KPIs + gráfico (Chart.js por CDN)
└── README.md               este archivo
```

**Contrato de una pantalla.** Cada archivo de `js/pantallas/` exporta exactamente
dos funciones:

```js
export async function mount(contenedor, ctx) { /* dibuja y engancha listeners */ }
export function unmount() { /* CORTA los listeners */ }
```

`unmount()` **no es opcional**: es el que llama a la función que devuelve
`onSnapshot`. Si una pantalla nueva se olvida de cortar su escucha, cada ida y
vuelta por el menú deja un listener vivo y las lecturas del plan gratuito
(50.000 por día) se van en un rato. El router de `app.html` llama a `unmount()`
antes de montar la pantalla siguiente, siempre.

---

## 5. Qué hace y qué NO hace este panel

**Hace:**

- **Contenido:** ver **todo** el contenido del espacio en tiempo real,
  incluidos los items marcados como *privados* (eso es exactamente lo que el
  admin puede y un miembro no). Buscar y filtrar por estado, tipo y
  visibilidad. El candado de cada item («Del equipo» / «Privado») se actualiza
  solo cuando lo cambian desde la app: compartirlo con el equipo lo puede hacer
  solo el autor, y pasarlo a privado, el autor o el admin. La columna Autor dice el nombre
  también de quien ya se fue: «Lucas (ya no está en el equipo)».
- **Lo que falta (el Radar):** junta, en vivo, las preguntas del equipo que la
  IA no pudo contestar (respuestas `listo` con `fuentes` vacío), las agrupa por
  texto y las cuenta («3 veces esta semana»), **sin nombres** salvo que se
  pidan. Arriba: el % de preguntas de la semana respondidas con fuente y los 5
  documentos que más preguntas respondieron. El botón **«Cargar la respuesta
  para el equipo»** crea una nota del equipo (con EXACTAMENTE los campos que
  deja la regla) y la manda a procesar; cuando alguien vuelve a preguntar lo
  mismo y esta vez hay fuente, la fila pasa a **«Resuelta»**.
- **En vivo:** los últimos 50 eventos del servidor, con un ícono por tipo
  (los tipos que no conoce salen con uno genérico), un filtro, una animación
  corta en las filas nuevas, la opción de esconder el texto de las preguntas
  para proyectar, y la franja **«Ahora mismo»** con lo que se está procesando
  o preguntando (solo lo de los últimos minutos: un pendiente olvidado hace
  dos meses no es «ahora»).
- **Miembros:** invitar por email (si la persona no tiene cuenta, el servidor
  se la crea y el panel muestra **una sola vez** la contraseña temporal),
  **«Hacer admin» / «Pasar a miembro»** con confirmación, y quitar. Abajo,
  quiénes ya no están en el equipo (`exMiembros`).
- **Resumen:** los 4 números del espacio y lo que se cargó en la semana.
- **Tema claro (proyector):** un botón en la barra lateral pasa todo el panel
  a fondo claro con los mismos acentos cian y el mismo logo, por si en el aula
  el oscuro se ve lavado. Se recuerda en ese navegador.

**No hace (a propósito, está fuera del alcance de esta entrega):**

- **Subir archivos.** Eso es la app Flutter. Lo único que el panel escribe en
  `items` es la nota del Radar.
- **Borrar items ni reprocesarlos desde Contenido.** Los endpoints existen
  (`DELETE .../items/:itemId` y `POST .../items/:itemId/reprocesar`) y
  `pedir()` ya sabe llamarlos; falta el botón en la fila de `items.js`.
- **Pantalla de pagos.** Las reglas ya dejan que solo el admin lea
  `suscripcion/`; la pantalla todavía no está (Mercado Pago es «próximamente»).

**Cómo se prueba la lógica del Radar sin navegador:** `js/radar-calculos.js` y
`js/util.js` no importan nada (ni Firebase ni el DOM), así que un test de
`node --test` los puede importar directo: agrupar, contar, «Resuelta», el % de
la semana, los 5 más citados y que la nota tenga los mismos campos que
`camposQuePuedeCrearElCliente` de `firestore.rules`. **No pongan tests adentro
de `panel/`**: `scripts/armar-sitio.mjs` publica todo lo `.js`/`.mjs` de esta
carpeta en Hosting.

---

## 6. Cuando algo no anda

| Lo que ves | Casi siempre es |
|---|---|
| Pantalla en blanco, en la consola `CORS policy: file://` | Lo abriste con doble clic. Servilo por HTTP (sección 2). |
| Cartel rojo *"Falta configurar Firebase"* | `js/firebase.js` sigue con los `PEGAR_...`. |
| 404 en los `import` de gstatic | Esa versión del SDK no existe. Cambiala en las **tres** líneas de import de `js/firebase.js`. |
| `permission-denied` al listar items | En este orden: **1)** token viejo (cerrá sesión y volvé a entrar), **2)** no sos admin de ese espacio, **3)** falta un `where`, **4)** recién ahí, la regla. |
| `failed-precondition` al filtrar | Falta el índice compuesto. El error de la consola trae el link para crearlo. |
| «Lo que falta» o «Ahora mismo» dicen que falta un índice | Son los de `(estado ASC, creadoEn DESC)` de `respuestas` y de `items`, que están en `firestore.indexes.json` y ya se publicaron. Si igual aparece (por ejemplo, en otro proyecto de Firebase), publicarlos con `firebase deploy --only firestore:indexes` y esperar unos minutos. |
| «En vivo» dice que solo el administrador puede | `eventos/` es SOLO del admin. Si recién te cambiaron el rol, el token todavía no se renovó: cerrá sesión y volvé a entrar. |
| «Cargar la respuesta»: *Firestore no dejó guardar la nota* | Token viejo (cerrá sesión y volvé a entrar). Si sigue, alguien cambió los campos de `datosDeLaNota()` en `js/radar-calculos.js`: tienen que ser EXACTAMENTE los de la regla. |
| «Cargar la respuesta»: *quedó guardada, pero no se pudo procesar* | El backend no contestó (dormido o apagado). La nota ya está en *Pendiente*: tocá **Reintentar** en la misma fila. |
| En el proyector el panel se ve lavado | Botón **Tema claro (proyector)** en la barra lateral. |
| `auth/unauthorized-domain` | Falta agregar el dominio en Authentication → Settings → Authorized domains. |
| El fetch al backend "no llega" pero el backend loguea el pedido | CORS: el origen del panel no está en la lista del backend. |
| Desde el emulador de Hosting (`localhost:5002`) se ve todo, pero invitar o quitar miembros da *"No hay conexión con el servidor"* | CORS otra vez: el backend local, sin `CORS_ORIGENES`, solo acepta los puertos 5500 y 8080. Agregá al `.env` de `api/` la línea `CORS_ORIGENES=http://localhost:5500,http://127.0.0.1:5500,http://localhost:8080,http://127.0.0.1:8080,http://localhost:5002,http://127.0.0.1:5002` (la variable **reemplaza** la lista por defecto: por eso van todos) y reiniciá el backend. |
| Recién publicado, el panel queda en «Cargando…» (en la consola: *does not provide an export named …*) o se sigue viendo lo viejo | La caché del navegador mezcló versiones. Ctrl+F5 (F5 solo no alcanza). Con los encabezados de `firebase.json` (HTML, CSS y JS con `no-cache`, que se revisan en cada visita) no debería pasar; solo una imagen puede verse vieja hasta 10 minutos. |
| Todo tarda 60 segundos la primera vez | Render free estaba dormido. Es normal, y por eso el panel llama a `/salud` al arrancar. |
| El badge dice *Sin conexión* un instante al cargar | Normal: la primera foto siempre sale de la caché. Si **queda** en *Sin conexión*, ahí sí no hay internet. |

---

## 7. ¿Es seguro que la config de Firebase esté en el JS?

Sí, y hay que saber contestarlo:

La configuración de una app web de Firebase (`apiKey`, `projectId`, `appId`)
**viaja siempre al navegador**: es pública por diseño y cualquiera la ve con
Ctrl+U en cualquier sitio que use Firebase. **No es una contraseña: es la
dirección del proyecto.**

Lo que protege los datos son otras dos cosas, y ninguna vive en esta carpeta:

1. **`firebase/firestore.rules`** — Firestore no le entrega un documento a
   quien no tiene el custom claim correcto, diga lo que diga el JavaScript del
   navegador. `chunks/` está cerrado para todos; `eventos/` y `suscripcion/`
   son solo del admin; `items` se filtra por visibilidad y por rol, y las
   `respuestas` de todo el equipo (lo que lee el Radar) también las puede
   listar solo el admin: un miembro que intenta las queries de «Lo que falta»
   o de «En vivo» recibe `permission-denied`.
2. **El backend** — verifica el ID token con `verifyIdToken()` **y además** lee
   `workspaces/{wsId}/members/{uid}` en cada pedido, que es lo único que corta
   al instante a alguien recién echado.

El guardia de `js/auth.js` **no es la seguridad**: es comodidad, para no
mostrarle pantallas rotas a quien no es admin. Cualquiera puede saltearlo desde
la consola del navegador, y lo único que consigue es ver tablas vacías con
errores rojos.

Los secretos de verdad — la *service account*, la clave de Gemini, la de
OCR.space y la de Mercado Pago — están en el `.env` del backend y **nunca**
tocan esta carpeta.

Una honestidad más, que también está en el contrato: cuando se saca a alguien
del equipo, el acceso al **backend** se corta al instante, pero la **lectura
directa de Firestore** sigue funcionando hasta que le venza el ID token (hasta
1 hora), porque las reglas leen el claim que ya viaja firmado adentro de ese
token. Es una limitación conocida del modelo de custom claims y está escrita
en las limitaciones del proyecto.
