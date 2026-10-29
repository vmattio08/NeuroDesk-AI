# NeuroDesk AI — Fase 2 (desarrollo)

> El segundo cerebro con IA de tu equipo. · Entrega: **16/10/2026**

## Reglas de trabajo (leer antes de tocar nada)

**1. Propiedad por carpeta.** Nadie edita la carpeta del otro sin avisar.

| Carpeta | Dueño | Qué es |
|---|---|---|
| `api/` | Valentino | Backend Node + Express |
| `firebase/` | Valentino | `firestore.rules`, índices, scripts |
| `app/` | Martín | App móvil Flutter |
| `panel/` | Martín | Panel web del admin |
| `CONTRATO.md` | **compartido** | Si se toca, se avisa en voz alta |

**2. `git pull` al empezar la clase, `git push` al terminar.** Siempre, aunque esté a
medio hacer (commit `wip`). Si no, el próximo conflicto se come una clase entera.

**3. Trabajamos directo en `main`.** Con dos personas y carpetas separadas, las
ramas agregan ceremonia sin beneficio.

**4. Versiones congeladas.** Flutter **3.41.6** — no correr `flutter upgrade` hasta
después del 16/10. `package-lock.json` y `pubspec.lock` van al repo.

## Regla de oro
Los secretos van en `.env` (copiado de `.env.example`) y **nunca** al repo.
El `.gitignore` es el primer commit del proyecto, antes que cualquier código.

## Documentos
- `MODELO-DATOS.md` — las colecciones, sus campos y las invariantes
- `CONTRATO.md` — los endpoints del backend y el formato único de error
- `firebase/firestore.rules` — las reglas de seguridad (desplegadas desde el día 1)

## Publicar el sitio (landing + panel)

Firebase Hosting publica **una sola carpeta: `sitio/`**. No se edita a mano ni
va al repo (está en el `.gitignore`): la arma `scripts/armar-sitio.mjs` con esto
y nada más.

| Sale de | Queda en | Se ve en |
|---|---|---|
| `landing/` | `sitio/` | `https://neurodesk-6to.web.app/` |
| `panel/` (menos su `README.md`) | `sitio/panel/` | `https://neurodesk-6to.web.app/panel/` |
| `app/build/app/outputs/flutter-apk/app-release.apk`, **si existe** | `sitio/descargas/neurodesk.apk` | `/descargas/neurodesk.apk` |

**Probarlo en la compu** (desde `fase2/`): queda en `http://localhost:5002` y
`http://localhost:5002/panel/`.

```bash
node scripts/armar-sitio.mjs
npx firebase-tools@15.34.1 emulators:start --only hosting --project neurodesk-6to
```

**Publicarlo: solo con el OK de los dos**, porque queda a la vista de cualquiera.

```bash
npx firebase-tools@15.34.1 deploy --only hosting --project neurodesk-6to
```

(La primera vez en cada compu pide `npx firebase-tools@15.34.1 login` con la
cuenta dueña del proyecto.)

- El deploy arma `sitio/` solo antes de subir (`predeploy` en `firebase.json`).
  Si falta la landing o aparece algo con cara de secreto (`.env`, la service
  account), corta y no publica nada. Leé el resumen: tiene que listar solo
  archivos de la landing, del panel y el APK.
- `--only hosting` no toca las reglas ni los índices de Firestore. Si algo sale
  mal, en la consola de Firebase → Hosting se vuelve a la versión anterior.
- Publicado, el panel le habla solo al backend de Render (`URL_API` se elige
  sola): leer anda siempre, invitar o quitar miembros necesita Render arriba.
- Caché: el HTML se revisa en cada visita; CSS, JS e imágenes se guardan 10
  minutos (sin build, los archivos no cambian de nombre y una caché larga
  mezclaría HTML nuevo con JS viejo). Recién publicado, Ctrl+F5.
- Las reglas de `firebase.json` usan `regex` y no globs (`**/*.css`) a
  propósito: el emulador en Windows ignora los globs sin avisar, y así lo que se
  prueba en la compu es lo mismo que pasa publicado.
- Cupo gratis de Hosting: 10 GB de transferencia por mes. Cada descarga del APK
  gasta su tamaño entero (el resumen del armado dice cuántas entran); si se
  pasa, Firebase deshabilita el sitio hasta el mes siguiente.
