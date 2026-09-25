# Panel web del admin — NeuroDesk AI

El panel de administración. JavaScript vanilla con **módulos ES nativos** y el
SDK de Firebase por CDN: **no hay `npm install`, no hay bundler, no hay React**.
Se sirve la carpeta y anda.

Quién lo usa: el **administrador** de un espacio de trabajo. Quien no es admin
de ningún espacio no puede entrar (y aunque se saltee el JS, Firestore no le
entrega nada: ver *"¿Es seguro?"* al final).

---

## 1. Qué hay que completar antes de abrirlo

Son dos archivos y dos minutos. Los dos lugares están marcados con un cartel
`>>>>> COMPLETAR <<<<<`.

| Archivo | Qué va | De dónde sale |
|---|---|---|
| `js/firebase.js` | el objeto `configFirebase` | Consola de Firebase → ⚙ Configuración del proyecto → Tus apps → App web → **Config** |
| `js/api.js` | la constante `URL_API` | `http://localhost:8080` mientras se desarrolla, `https://neurodesk-api.onrender.com` en producción |

Si te olvidás de la config de Firebase, el login te lo dice con un cartel rojo
en vez de tirar un error críptico en la consola.

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
- **CORS en el backend**: el backend solo acepta pedidos desde el origen del
  panel. En desarrollo, `http://localhost:5500`. Al publicar, agregar el
  dominio nuevo a la lista de orígenes permitidos del backend.

---

## 3. Cómo publicarlo gratis

Es HTML, CSS y JS estáticos: lo hostea cualquiera. Tres opciones, de más a
menos recomendada.

### A. Firebase Hosting (la mejor para este proyecto)

Ventaja concreta: el dominio que te da (`tu-proyecto.web.app`) **queda
autorizado solo** en Authentication, así que el login funciona sin tocar nada
más. Y es el mismo proyecto donde ya está Firestore.

```bash
# desde fase2/  (una sola vez)
firebase init hosting
#   ¿Public directory?          panel
#   ¿Single-page app?           N     <-- NO. Nuestro router es por hash.
#   ¿Sobrescribir index.html?   N     <-- NO, tenemos el nuestro.

firebase deploy --only hosting
```

Queda en `https://<tu-proyecto>.web.app`. Cada `deploy` publica la versión
nueva y se puede volver atrás desde la consola.

### B. GitHub Pages

Gratis y sale del repo que ya tenemos.

1. Repo → **Settings** → **Pages** → Source: `main`, carpeta `/root`.
2. Queda en `https://<usuario>.github.io/<repo>/fase2/panel/index.html`.
3. **Agregar `<usuario>.github.io` a los dominios autorizados de Firebase Auth.**

Ojo: el repo tiene que ser público (o pagar Pages en privado), y todo el código
del panel queda a la vista. **No es un problema**: la config de Firebase es
pública por diseño (ver abajo) y no hay ninguna clave secreta en esta carpeta.

### C. Netlify Drop

Lo más rápido de todo: entrar a `app.netlify.com/drop` y **arrastrar la carpeta
`panel`**. Da una URL al toque. Sirve para mostrarle algo a alguien en cinco
minutos; para la entrega usamos A o B.

En las tres: acordarse de **cambiar `URL_API`** a la URL de Render y de
**agregar el dominio nuevo a CORS en el backend y a Authorized domains en
Firebase Auth**.

---

## 4. Mapa de la carpeta

```
panel/
├── index.html              login (la puerta)
├── app.html                el shell: barra lateral + router por hash
├── css/estilo.css          todo el CSS, con la paleta arriba de todo
├── js/
│   ├── firebase.js         initializeApp + Firestore con caché persistente
│   │                       (>>> LA CONFIG SE COMPLETA ACÁ <<<)
│   ├── auth.js             entrar, salir y el guardia de admin
│   ├── api.js              pedir(): la única función que llama al backend
│   │                       (>>> LA URL DEL BACKEND SE COMPLETA ACÁ <<<)
│   ├── util.js             esc() y las fechas
│   └── pantallas/
│       ├── items.js        tabla en vivo + buscador + filtros + badge
│       ├── miembros.js     alta y baja de miembros (llama al backend)
│       └── dashboard.js    4 KPIs + gráfico (Chart.js por CDN)
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

- Ver **todo** el contenido del espacio en tiempo real, incluidos los items
  marcados como *privados* (eso es exactamente lo que el admin puede y un
  miembro no).
- Buscar y filtrar por estado, tipo y visibilidad.
- Invitar por email y quitar miembros (llamando al backend).
- Ver los 4 números del espacio y la actividad de la semana.

**No hace (a propósito, está fuera del alcance de esta entrega):**

- **Subir archivos.** Eso es la app Flutter. El panel es de lectura y de
  administración de personas.
- **Borrar items ni reprocesarlos.** Los endpoints existen
  (`DELETE .../items/:itemId` y `POST .../items/:itemId/reprocesar`) y
  `pedir()` ya sabe llamarlos; falta el botón en la fila de `items.js`.
- **Cambiar el rol de un miembro** (`PATCH .../miembros/:uid`). Mismo caso.
- **Feed de eventos y pantalla de pagos.** Las reglas ya dejan que solo el
  admin lea `eventos/` y `suscripcion/`; las pantallas todavía no están.

---

## 6. Cuando algo no anda

| Lo que ves | Casi siempre es |
|---|---|
| Pantalla en blanco, en la consola `CORS policy: file://` | Lo abriste con doble clic. Servilo por HTTP (sección 2). |
| Cartel rojo *"Falta configurar Firebase"* | `js/firebase.js` sigue con los `PEGAR_...`. |
| 404 en los `import` de gstatic | Esa versión del SDK no existe. Cambiala en las **tres** líneas de import de `js/firebase.js`. |
| `permission-denied` al listar items | En este orden: **1)** token viejo (cerrá sesión y volvé a entrar), **2)** no sos admin de ese espacio, **3)** falta un `where`, **4)** recién ahí, la regla. |
| `failed-precondition` al filtrar | Falta el índice compuesto. El error de la consola trae el link para crearlo. |
| `auth/unauthorized-domain` | Falta agregar el dominio en Authentication → Settings → Authorized domains. |
| El fetch al backend "no llega" pero el backend loguea el pedido | CORS: el origen del panel no está en la lista del backend. |
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
   navegador. `chunks/`, `eventos/` y `suscripcion/` están cerrados; `items` se
   filtra por visibilidad y por rol.
2. **El backend** — verifica el ID token con `verifyIdToken()` **y además** lee
   `workspaces/{wsId}/members/{uid}` en cada pedido, que es lo único que corta
   al instante a alguien recién echado.

El guardia de `js/auth.js` **no es la seguridad**: es comodidad, para no
mostrarle pantallas rotas a quien no es admin. Cualquiera puede saltearlo desde
la consola del navegador, y lo único que consigue es ver tablas vacías con
errores rojos.

Los secretos de verdad — la *service account*, la clave de NVIDIA, la de
OCR.space y la de Mercado Pago — están en el `.env` del backend y **nunca**
tocan esta carpeta.

Una honestidad más, que también está en el contrato: cuando se saca a alguien
del equipo, el acceso al **backend** se corta al instante, pero la **lectura
directa de Firestore** sigue funcionando hasta que le venza el ID token (hasta
1 hora), porque las reglas leen el claim que ya viaja firmado adentro de ese
token. Es una limitación conocida del modelo de custom claims y está escrita
en las limitaciones del proyecto.
