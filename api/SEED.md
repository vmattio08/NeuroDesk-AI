# SEED — cómo crear la base de NeuroDesk AI y sacar las capturas de la entrega

Esta guía es para hacerla **de cero, sin haberlo hecho nunca**. Son 8 pasos.
La primera vez lleva unos 25 minutos; a partir de la segunda, 10 segundos (`npm run seed`).

Al final está la lista exacta de **qué capturas de pantalla sacar** para el punto 2 de la
entrega del 18/9 ("se tiene que ver que ya crearon la base de datos y que ya estructuraron
las colecciones principales"). Esa parte es la que se entrega: no la saltees.

---

## Qué deja armado el seed

Una base realista de un curso, con todo lo que el modelo de datos declara:

| Colección | Cuántos | Qué hay adentro |
|---|---|---|
| `usuarios/{uid}` | 3 | Valentino (admin), Martín y Camila (miembros) |
| `workspaces/{wsId}` | 1 | `6to 1ra - Programación II` |
| `workspaces/{wsId}/members/{uid}` | 3 | los tres, con su rol |
| `workspaces/{wsId}/items/{itemId}` | 15 | notas, PDF, links y fotos, en los **4 estados** y con las **2 visibilidades** |
| `chunks/{itemId_idx}` | 40 | con embedding de **1024 números** normalizados |
| `workspaces/{wsId}/respuestas/{respId}` | 3 | con sus fuentes citadas `[1] [2]` |
| `workspaces/{wsId}/eventos/{eventoId}` | 20 | feed de auditoría (solo lo ve el admin) |
| `workspaces/{wsId}/suscripcion/actual` | 1 | plan `free`, estado `sin_plan` |
| **Total** | **86 documentos** | |

Además crea las 3 cuentas **de verdad** en Firebase Authentication, con su rol cargado en
el custom claim, así se puede entrar desde la app y desde el panel el día de la demo.

**Es idempotente**: correrlo dos, diez o cien veces deja exactamente la misma base.
No duplica nada. Si te equivocaste en algo, corregilo y volvé a correrlo.

---

## PASO 1 — Crear el proyecto en Firebase

1. Entrá a **https://console.firebase.google.com** con tu cuenta de Google.
2. Botón **Crear un proyecto** (o *Agregar proyecto*).
3. Nombre: `neurodesk-ai` (Firebase le va a agregar unas letras al final para que el id sea
   único, por ejemplo `neurodesk-ai-4f2a1`. **Anotá ese id completo**: ese es el
   `FIREBASE_PROJECT_ID`).
4. Google Analytics: **desactivalo**. No lo usamos y agrega pasos.
5. **Crear proyecto** y esperá el cartel de listo.

> El plan **Spark** (gratis) alcanza y sobra. No hace falta cargar tarjeta.
> Por eso el proyecto no usa Firebase Storage ni Cloud Functions: los dos la piden.

---

## PASO 2 — Prender Firestore

1. Menú de la izquierda → **Compilación → Firestore Database**.
2. Botón **Crear base de datos**.
3. **Ubicación**: elegí `southamerica-east1 (San Pablo)`.
   ⚠️ **La ubicación NO se puede cambiar después.** Si te equivocás hay que borrar el
   proyecto entero y empezar de nuevo.
4. **Modo**: elegí **modo de producción** (empieza con todo denegado). No elijas modo de
   prueba: deja la base abierta para cualquiera durante 30 días.
5. **Crear**.

Te va a quedar la base vacía con el cartel "Tu colección de inicio". Está bien: en el paso 7
la llenamos.

---

## PASO 3 — Prender Authentication (email y contraseña)

1. Menú de la izquierda → **Compilación → Authentication**.
2. Botón **Comenzar**.
3. Pestaña **Sign-in method** → **Correo electrónico/contraseña** → **Habilitar** (la
   primera palanca, no la de "vínculo por correo") → **Guardar**.

Si te salteás este paso, el seed falla al crear las cuentas con un error de
`auth/operation-not-allowed`.

---

## PASO 4 — Bajar la clave de la cuenta de servicio

La *service account* es la credencial que le permite al backend (y a estos scripts) escribir
en Firestore **salteándose las reglas de seguridad**. Es la llave maestra del proyecto.

1. Rueda dentada arriba a la izquierda (al lado de *Descripción general del proyecto*) →
   **Configuración del proyecto**.
2. Pestaña **Cuentas de servicio**.
3. Botón **Generar nueva clave privada** → **Generar clave**.
4. Se descarga un `.json` con un nombre largo. **Renombralo a `serviceAccountKey.json`** y
   guardalo en `fase2/api/`.

> 🔴 **Ese archivo NO se sube nunca a GitHub.** Cualquiera que lo tenga puede leer, escribir
> y borrar TODA la base, sin pasar por ninguna regla. El `fase2/.gitignore` ya lo cubre
> (`serviceAccountKey.json`, `firebase-adminsdk-*.json` y `.env`), pero si le cambiás el
> nombre al archivo, fijate de agregarlo ahí. Si alguna vez se te escapa a un repo público,
> hay que **revocar la clave** desde esa misma pantalla y generar otra.

---

## PASO 5 — Armar el archivo `.env`

1. Copiá `fase2/.env.example` a `fase2/api/.env`.

   ```powershell
   Copy-Item C:\Users\6to\Desktop\NeuroDesk-AI\fase2\.env.example C:\Users\6to\Desktop\NeuroDesk-AI\fase2\api\.env
   ```

2. Convertí la service account a **base64 en una sola línea**. Va en base64 para esquivar el
   problema de los saltos de línea (`\n`) del campo `private_key`, que pegado crudo dentro de
   un `.env` no funciona nunca.

   En **PowerShell**, parado en `fase2/api`:

   ```powershell
   cd C:\Users\6to\Desktop\NeuroDesk-AI\fase2\api
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("serviceAccountKey.json")) | Set-Clipboard
   ```

   Eso te deja el texto en el portapapeles.

3. Abrí `fase2/api/.env` y completá **solo estas dos líneas** (lo demás no hace falta para el
   seed):

   ```
   FIREBASE_SERVICE_ACCOUNT_B64=<pegá acá lo que copiaste, todo en UNA línea, sin comillas>
   FIREBASE_PROJECT_ID=neurodesk-ai-4f2a1
   ```

   - **Sin comillas**, **sin espacios** y **sin saltos de línea**. Es una línea larguísima y
     está bien que lo sea.
   - El `FIREBASE_PROJECT_ID` es el que anotaste en el paso 1. Si no te acordás, está en
     *Configuración del proyecto → General → ID del proyecto*.

   El script chequea que los dos coincidan: si la clave es de otro proyecto, te lo dice y no
   escribe nada.

---

## PASO 6 — Instalar las dependencias

```powershell
cd C:\Users\6to\Desktop\NeuroDesk-AI\fase2\api
npm install
```

Necesitás **Node 22 o más nuevo** (nosotros usamos 24). Comprobalo con `node --version`.
La versión importa porque los scripts usan `--env-file`, que en Node viejo no existe.

---

## PASO 7 — Correr el seed

```powershell
cd C:\Users\6to\Desktop\NeuroDesk-AI\fase2\api
chcp 65001
npm run seed
```

> `chcp 65001` pone la consola de Windows en UTF-8. No es obligatorio, pero sin eso los
> acentos de los títulos salen rotos en la terminal y la captura queda fea.

Tiene que terminar con algo así:

```
============================================================
  RESUMEN — documentos escritos en Firestore
============================================================
  usuarios..............   3 docs
  workspaces............   1 doc
    members.............   3 docs
    items...............  15 docs
    respuestas..........   3 docs
    eventos.............  20 docs
    suscripcion.........   1 doc
  chunks................  40 docs
  --------------------------------
  TOTAL.................  86 docs

  Cuentas de Firebase Auth:
    creadas ahora ... valentino.demo@neurodesk.test, martin.demo@neurodesk.test, camila.demo@neurodesk.test
    contrasena de todas: NeuroDesk2026!
```

**Las tres cuentas de demo** (sirven para entrar desde la app y el panel):

| Email | Rol | Para qué sirve en la demo |
|---|---|---|
| `valentino.demo@neurodesk.test` | **admin** | ve los 15 items, los eventos y la suscripción |
| `martin.demo@neurodesk.test` | miembro | ve los del equipo **+ sus 2 privados** |
| `camila.demo@neurodesk.test` | miembro | ve solo los del equipo y **su** privado |

Contraseña de las tres: `NeuroDesk2026!` (se puede cambiar con la variable `SEED_PASSWORD`).
Son cuentas descartables de un trabajo escolar; antes de usar esto en serio se borran con
`npm run seed:borrar -- --si --tambien-auth`.

---

## PASO 8 — Publicar las reglas y los índices (recomendado)

El seed usa el Admin SDK, que **se saltea las reglas**, así que la base se llena igual sin
este paso. Pero las reglas son la mitad de la nota de la fase 1, y además el profesor las va
a querer ver publicadas. Hay dos formas:

**A) A mano, desde la consola web (sin instalar nada):**

1. Firestore Database → pestaña **Reglas**.
2. Borrá lo que haya y pegá todo el contenido de `fase2/firebase/firestore.rules`.
3. **Publicar**.
4. Para los índices: Firestore Database → pestaña **Índices** → **Crear índice** y cargar a
   mano los de `fase2/firebase/firestore.indexes.json`. Son varios; se pueden ir agregando
   cuando la app los pida (Firestore te tira un link que lo crea solo).

**B) Con la CLI de Firebase (más rápido si vas a repetirlo):**

```powershell
npm install -g firebase-tools
firebase login
cd C:\Users\6to\Desktop\NeuroDesk-AI\fase2\firebase
firebase deploy --only firestore:rules,firestore:indexes --project <tu-project-id>
```

---

# 📸 LAS CAPTURAS PARA LA ENTREGA

Esto es lo que se entrega. Sacá **una captura por punto**, con el navegador en pantalla
completa y que se vea la barra de arriba con el nombre del proyecto.

> Consejo: numerá los archivos `01-vista-general.png`, `02-colecciones.png`, etc.
> Guardalas en `Downloads\Cosas CLAUDE\NeuroDesk-entrega-18-9\capturas\`.

### Base de datos y colecciones (el pedido textual del profesor)

**1 — El proyecto existe.**
`Descripción general del proyecto` (la casita del menú). Tiene que verse el nombre y el id.

**2 — Las 3 colecciones de primer nivel.**
`Compilación → Firestore Database → pestaña Datos`.
En la primera columna se tienen que ver **`chunks`, `usuarios` y `workspaces`**.
*Esta es LA captura del punto 2 de la entrega.*

**3 — El documento del workspace.**
Click en `workspaces` → click en `ws_seed_6to1ra`.
Se ven los campos `nombre`, `ownerUid`, `plan`, `planStatus`, `creadoEn`, `actualizadoEn`,
y abajo de todo **la lista de subcolecciones**: `members`, `items`, `respuestas`, `eventos`,
`suscripcion`. Que se vea esa lista, que es "las colecciones principales estructuradas".

**4 — Los miembros y sus roles.**
Subcolección `members` → se ven los 3 documentos. Abrí el de Valentino: `rol: "admin"`.
Abrí uno de los otros: `rol: "miembro"`. **Sacá las dos**, es la prueba de que hay roles.

### Los items (el corazón del modelo)

**5 — La lista de los 15 items.**
Subcolección `items`. Que se vea la columna entera con los 15 ids.

**6 — Un item `listo`, con todo lo que escribe el backend.**
Abrí `itm_seed_01`. Se ven juntos los campos del **cliente** (`titulo`, `tipo`,
`visibilidad`, `workspaceId`, `creadoPor`, `creadoEn`, `estado`) y los del **backend**
(`texto`, `cantChunks: 6`, `paginas: 3`, `origen`, `caracteres`, `recortado`, `errorMsg`,
`actualizadoEn`).

**7 — Un item `privado`.**
Abrí `itm_seed_05` (la nota de Martín) → `visibilidad: "privado"`.
Es la captura que acompaña al requisito de "cada rol ve solo lo suyo".

**8 — Un item en `error`, con su mensaje.**
Abrí `itm_seed_12` → `estado: "error"` y `errorMsg` en castellano
("Esa dirección no se puede leer..."). Notá que `cantChunks` es `0`.

**9 — Un item en `pendiente`.**
Abrí `itm_seed_15` → tiene **solo** los campos que escribe la app: ni `texto`, ni
`cantChunks`, ni `actualizadoEn`. Es la prueba de que respetamos la tabla de "quién escribe
qué". Si te preguntan por qué está así, la respuesta es: *el cliente crea el item en
`pendiente` y el backend nunca lo crea, solo lo actualiza.*

### El índice de la IA

**10 — La colección `chunks` y el id `itemId_idx`.**
Volvé a la raíz → `chunks`. Que se vean ids del estilo `itm_seed_01_0`, `itm_seed_01_1`, ...

**11 — Un chunk abierto, con el embedding.**
Abrí `itm_seed_01_0`. Desplegá el campo `embedding` y hacé click en **"Mostrar más"** hasta
que se vea que es un **array largo de números**. Que entren en la captura los campos
`workspaceId`, `itemId`, `idx`, `pagina`, `origen`, `visibilidad` y `creadoPor`.
Si te preguntan: son **1024 números** (el largo que devuelve el modelo de embeddings), y en
el seed están generados a propósito para no gastar créditos de la IA.

### Respuestas, auditoría y plan

**12 — Una respuesta con sus fuentes citadas.**
`workspaces/ws_seed_6to1ra/respuestas/resp_seed_01`. Desplegá el array `fuentes`: cada
entrada tiene `n`, `itemId`, `titulo`, `pagina`, `fragmento` y `similitud`. En el campo
`respuesta` se ven las marcas `[1]` y `[2]` que apuntan a esas fuentes.
Mostrá también `chunksMirados: 40` y `chunksVisibles: 38`.

**13 — El filtro de privacidad hecho número.**
Abrí `resp_seed_02` (la de Camila): `chunksVisibles: 35`.
Abrí `resp_seed_03` (la de Valentino, que es admin): `chunksVisibles: 40`.
**Sacá las dos, una al lado de la otra.** Misma base, tres personas, tres números distintos:
Camila ve 35, Martín 38 y el admin 40. Es la mejor captura de todo el trabajo.

**14 — El feed de eventos.**
Subcolección `eventos` → los 20 documentos. Abrí uno: `tipo`, `actorUid`, `resumen`,
`itemId`, `creadoEn`. Contá que **esta subcolección solo la puede leer el admin**.

**15 — La suscripción.**
`suscripcion/actual` → `plan: "free"`, `estado: "sin_plan"`, `preapprovalId: null`,
`montoMensual`, `vence`, `eventosProcesados`. Es la otra diferencia de rol: un miembro común
no ve los datos de facturación.

### Seguridad y cuentas

**16 — Las reglas publicadas.**
`Firestore Database → pestaña Reglas`. Que se vea el código y la fecha de publicación.

**17 — Los índices.**
`Firestore Database → pestaña Índices → Compuestos`. Solo si hiciste el paso 8.

**18 — Los usuarios reales.**
`Compilación → Authentication → pestaña Users`. Se ven los 3 emails con su UID.
Es la prueba de que las cuentas existen de verdad y no son documentos inventados.

**19 — La terminal.**
La ventana de PowerShell con el **RESUMEN** del seed (los 86 documentos). Demuestra que la
base se creó con un script versionado y no a mano.

---

## Los otros dos scripts

### `set-admin.js` — hacer admin a alguien

```powershell
npm run set-admin -- valentino.demo@neurodesk.test
npm run set-admin -- otro@ejemplo.com ws_otro_workspace   # con wsId explícito
```

Resuelve el problema del huevo y la gallina: para invitar gente hay que ser admin, pero al
**primer** admin no lo puede invitar nadie. También sirve si en la demo se bajó de rol al
único admin por error.

Toca los **tres** lugares donde vive el rol, que siempre tienen que decir lo mismo:
`members/{uid}.rol`, `usuarios/{uid}.workspaces[wsId].rol` y el custom claim del token.

⚠️ Después de correrlo, **la persona tiene que cerrar sesión y volver a entrar**. El rol
viaja adentro del ID token, y el token dura 1 hora. (La app lo resuelve sola: escucha su
propio documento `usuarios/{uid}` y, cuando ve cambiar `claimsActualizadoEn`, llama a
`getIdToken(true)`.)

### `borrar-seed.js` — limpiar los datos de prueba

```powershell
npm run seed:borrar                        # SIMULACRO: cuenta y muestra, no borra
npm run seed:borrar -- --si                # borra los datos, conserva las cuentas
npm run seed:borrar -- --si --tambien-auth # borra también las cuentas de Auth
```

**Sin `--si` no borra nada.** Primero te muestra cuántos documentos hay en cada colección.
Borra los chunks **antes** que los items, a propósito: si el proceso se corta a la mitad,
nunca quedan chunks huérfanos con el texto de una nota privada dando vueltas en la base.

---

## Si algo falla

| Lo que dice la terminal | Qué pasó y cómo se arregla |
|---|---|
| `Falta FIREBASE_PROJECT_ID en el .env` | Lo corriste sin `--env-file`. Usá `npm run seed`, no `node scripts/seed.js` a secas. |
| `FIREBASE_SERVICE_ACCOUNT_B64 no es un JSON valido en base64` | Al pegar el base64 se cortó en varias líneas, o le quedaron comillas. Tiene que ser **una sola línea sin comillas**. |
| `La service account es del proyecto "X" pero FIREBASE_PROJECT_ID dice "Y"` | Mezclaste dos proyectos de Firebase. Corregí el `.env`; el script no escribió nada. |
| `auth/operation-not-allowed` | Falta el **paso 3**: habilitar Correo/contraseña en Authentication. |
| `5 NOT_FOUND` o `The database (default) does not exist` | Falta el **paso 2**: crear la base de Firestore. |
| `7 PERMISSION_DENIED` | La service account es vieja o fue revocada. Generá una nueva (paso 4) y rehacé el base64. |
| `permission-denied` **desde la app** (no desde el seed) | Casi siempre el token viejo. Cerrá sesión y volvé a entrar. El orden de sospecha es: 1) token viejo, 2) falta un `.where()` en la query, 3) falta el `.limit()`, 4) recién ahí, la regla. |
| Los acentos se ven rotos en la terminal | Corré `chcp 65001` antes. No afecta a los datos: en Firestore están bien. |

---

## Dos detalles que conviene saber explicar en la defensa

**1. Los embeddings del seed son falsos, y está bien.**
Son 1024 números generados con un generador pseudo-azaroso **sembrado con el id del chunk**.
Eso hace dos cosas: que el vector de `itm_seed_01_3` sea siempre el mismo (si no, el seed no
sería idempotente) y que no gastemos créditos de NVIDIA para llenar la base. Están
normalizados a norma 1 porque el backend compara por **similitud coseno**, y con vectores
normalizados el coseno es simplemente el producto punto.
Consecuencia honesta: si preguntás algo contra esta base sin reprocesar los items, la IA va a
citar cualquier cosa. Los vectores de verdad los escribe el backend cuando procesa un item.

**2. El item en `procesando` va a pasar a `error` solo.**
`itm_seed_13` queda en `procesando` con una fecha vieja. Cuando levantes el backend, el
barrido de items colgados (que corre al arrancar y después cada 10 minutos) lo va a pasar a
`error` con el mensaje "Se cortó el procesamiento. Tocá Reintentar". **No es un bug**: es el
caso 3c del ciclo de vida, la red de contención para cuando Render se reinicia a mitad del
procesamiento. Si querés la captura con el chip amarillo de "Procesando", sacala **antes** de
levantar el backend.
