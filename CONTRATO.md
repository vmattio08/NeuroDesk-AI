# CONTRATO HTTP — NeuroDesk AI (v3)

Este documento es el acuerdo entre el backend (Valentino) y los dos clientes: la app Flutter (Martín) y el panel web de administración. Dice **exactamente** qué se manda, qué vuelve y qué pasa cuando algo falla, en las 14 rutas que existen.

Sirve para tres cosas:

1. **Desbloquear a Martín.** Con este documento se pueden escribir todas las pantallas *antes* de que el backend esté implementado: los JSON de acá son los mismos que devuelven los mocks de la semana 2.
2. **Ser la única fuente de verdad cuando algo no coincide.** Si el modelo de datos, las reglas de Firestore y este contrato dicen cosas distintas, se corrige lo que no coincide con este documento (así se rompió la v1: las reglas llamaban `fuenteUrl` a un campo que el contrato llamaba `url`, y no se podía crear ni un link).
3. **Poder defenderlo oralmente.** Cada decisión rara tiene escrito *por qué* está así, en castellano, para poder contestarla en la mesa.

## Lo mínimo que hay que tener en la cabeza antes de leer

- **Los clientes hablan directo con Firestore** para leer y para el tiempo real. Al backend se le pega **solo** cuando hace falta una clave secreta (IA, OCR, Mercado Pago) o privilegios que las reglas no dan (borrar chunks, tocar claims).
- **El backend nunca crea items ni respuestas: solo los actualiza.** El documento lo crea el cliente en Firestore y recién después manda el POST con ese id.
- **La fuente de verdad de la UI es Firestore, no la respuesta HTTP.** El POST es una confirmación; la pantalla se dibuja con `StreamBuilder` / `onSnapshot`.
- **Base URL.** Producción: `https://neurodesk-api.onrender.com`. Desarrollo: `http://10.0.2.2:8080` desde el emulador de Android (`localhost` no funciona ahí) y `http://localhost:8080` desde el panel. Va en **una** constante (`--dart-define=API_URL` en Flutter, `config.js` en el panel), nunca escrita a mano en cada pantalla.
- **Todas las rutas cuelgan de `/v1/`, sin excepciones**, incluida `GET /v1/salud`.

---

## Forma única de error

Todos los endpoints, sin excepción, devuelven JSON con la clave `ok`. Cuando algo falla, el cuerpo es **siempre exactamente esta forma** — nunca un HTML de error de Express, nunca un string suelto, nunca un stack trace:

```json
{
  "ok": false,
  "codigo": "NO_ES_MIEMBRO",
  "mensaje": "No pertenecés a este espacio de trabajo.",
  "detalle": null
}
```

**Por qué una sola forma:** Martín escribe **una** función `pedir()` en Flutter y **una** en el panel. Si `!body.ok`, muestra `body.mensaje` en un SnackBar y, si hace falta, ramifica con un `switch (body.codigo)`. No hay que leer este documento entero para manejar errores: alcanza con esas cuatro claves.

Reglas de la forma de error:

- **`ok`**: siempre `false` en los errores y siempre `true` en las respuestas exitosas. El código HTTP y el campo `ok` **siempre concuerdan**: nunca un 200 con un error adentro, nunca un 500 con `"ok": true`.
- **`codigo`**: string en `MAYUSCULAS_CON_GUION_BAJO`, del catálogo cerrado de abajo. Es **lo único** que el código del cliente puede mirar para decidir. Nunca comparar el texto del mensaje.
- **`mensaje`**: castellano, listo para mostrarle a la persona. No dice "500", no dice "undefined", no nombra a Firestore, a NVIDIA ni a Mercado Pago.
- **`detalle`**: string o `null`. **Regla dura:** `detalle` se rellena **únicamente** donde el texto lo escribimos nosotros a mano y sabemos que es seguro y genérico (por ejemplo `"el PDF pesa 14.2 MB"`). En `ERROR_INTERNO` va **hardcodeado `null`**, jamás `err.message`: un error de `firebase-admin` o de un `fetch` trae rutas del servidor, hostnames internos y a veces pedazos de configuración. El `err.stack` completo va a `console.error` de Render y **no viaja al cliente**.
- Nada de oráculos. `URL_NO_PERMITIDA` devuelve siempre el mismo `detalle` genérico (`"la dirección no es pública"`), sin decir si el DNS no resolvió, si cayó en `10.0.0.0/8` o si el Content-Type era otro. El motivo exacto va **solo** al log de Render. Si no, cualquier miembro usa nuestro backend como escáner de la red interna de Render leyendo los mensajes de error.
- El backend **jamás** deja escapar un error sin envolverlo: hay un middleware final `app.use((err, req, res, next) => ...)` que atrapa cualquier excepción y responde `ERROR_INTERNO` 500 con esta misma forma.
- El 404 de ruta inexistente también responde así, con `RUTA_NO_ENCONTRADA`.
- Si la respuesta no es JSON o directamente no llega, **el cliente inventa un error con esta misma forma**: `{ok:false, codigo:'SIN_CONEXION', mensaje:'No hay conexión. Revisá tu internet.', detalle:null}`. Así el manejo sigue siendo uno solo.

---

## Catálogo de códigos de error

| Código | HTTP | Cuándo pasa | Mensaje que ve la persona |
|---|---|---|---|
| `FALTA_TOKEN` | 401 | No vino el header `Authorization`, o no arranca con `Bearer `. | Tenés que iniciar sesión para hacer esto. |
| `TOKEN_INVALIDO` | 401 | `verifyIdToken()` falla: token vencido (dura 1 hora), firmado por otro proyecto, mal formado, o emitido antes de un `revokeRefreshTokens()` (por eso va con `checkRevoked: true`). | Tu sesión venció. Volvé a entrar. |
| `NO_ES_MIEMBRO` | 403 | El token es válido pero (a) el claim `ws` no tiene el `wsId` de la ruta, o (b) no existe `workspaces/{wsId}/members/{uid}`. El caso (b) es el que corta **al instante** a alguien recién echado, aunque su token todavía diga que es miembro. También cuando el item o la respuesta pedidos pertenecen a otro workspace, y cuando el `wsId` de la ruta no existe. | No pertenecés a este espacio de trabajo. |
| `NO_ES_ADMIN` | 403 | Es miembro, pero `members/{uid}.rol` dice `'miembro'` y el endpoint exige `'admin'` (invitar, quitar, cambiar rol, limpieza masiva, pagos). El rol que manda para el backend es el del documento `members`, no el del claim. | Solo el administrador del espacio puede hacer esto. |
| `NO_SOS_EL_AUTOR` | 403 | **Código nuevo de la v3.** Quien llama no es `item.creadoPor` ni admin del workspace, y la acción es sobre ese item: procesar, reprocesar o borrar. | Solo el autor o un administrador pueden hacer esto. |
| `DATOS_INVALIDOS` | 400 | Falta un campo obligatorio del body o del query, viene vacío, con el tipo equivocado o fuera de rango (nombre de usuario fuera de 2 a 60, email mal escrito, rol distinto de `admin`/`miembro`, pregunta de más de 500 caracteres, `antesDe` que no es una fecha ISO válida o no está en el pasado). | Faltan datos o están mal cargados. Revisá el formulario. |
| `URL_NO_PERMITIDA` | 400 | El item es tipo `link` y su `url` no pasa la validación anti-SSRF (ver el bloque de `/procesar`). El `detalle` es siempre genérico: `"la dirección no es pública"`. | Esa dirección no se puede leer. Probá con un enlace público que empiece con https:// |
| `RUTA_NO_ENCONTRADA` | 404 | La URL no corresponde a ningún endpoint de este contrato (típico error de tipeo mientras se desarrolla). | No pudimos completar la acción. Probá de nuevo en un rato. |
| `ITEM_NO_ENCONTRADO` | 404 | `workspaces/{wsId}/items/{itemId}` no existe. Pasa si el cliente mandó el POST antes de que termine de escribirse el doc (con persistencia offline puede tardar), o si alguien lo borró. | No encontramos ese contenido. Puede que lo hayan borrado. |
| `RESPUESTA_NO_ENCONTRADA` | 404 | El `respId` mandado a `/preguntar` no existe. **También** cuando existe pero su `autorUid` es otro: a propósito no confirmamos que exista una consulta ajena. | Se perdió la consulta. Volvé a preguntar. |
| `USUARIO_NO_REGISTRADO` | 404 | Se invita por email a alguien que todavía no tiene cuenta en Firebase Auth (`getUserByEmail` tira `auth/user-not-found`). | Esa persona todavía no tiene cuenta en NeuroDesk. Pedile que se registre y volvé a invitarla. |
| `MIEMBRO_NO_ENCONTRADO` | 404 | El `uid` que se quiere quitar o al que se le quiere cambiar el rol no figura en `workspaces/{wsId}/members`. | Esa persona ya no está en el equipo. |
| `MIEMBRO_DUPLICADO` | 409 | El email invitado ya figura en `members` del mismo workspace. | Esa persona ya forma parte del equipo. |
| `ACCION_NO_PERMITIDA` | 409 | La acción es imposible por regla de negocio: quitar al dueño del workspace, quitarse a uno mismo siendo el único admin, bajarle el rol al owner, o cancelar una suscripción que ya está en `free`. | No se puede hacer eso con el dueño del espacio. |
| `PROCESO_EN_CURSO` | 409 | **Código nuevo de la v3.** Se pidió procesar o reprocesar un item que está en `'procesando'` hace menos de 5 minutos. Es el **doble tap**, que va a ser el 90% de los errores de la demo. | Ya lo estamos procesando, esperá unos segundos. |
| `ESTADO_INVALIDO` | 409 | **Un solo caso, nada más:** se pidió `/reprocesar` sobre un item `pdf` o `foto` que no tiene texto guardado en el campo `texto`. El archivo no se guarda en ningún lado (Storage está descartado), así que no hay de dónde sacarlo: hay que volver a elegir el archivo y llamar a `/procesar`. | Ese contenido no está listo para esta acción. Volvé a subir el archivo. |
| `ARCHIVO_FALTANTE` | 400 | El item es tipo `pdf` o `foto` pero el multipart no trae la parte `archivo`. | No llegó el archivo. Elegilo de nuevo. |
| `ARCHIVO_MUY_GRANDE` | 413 | El archivo supera 10 MB (tope de multer). El cliente además valida el tamaño **antes** de subir, para no gastar los datos del celular. | El archivo no puede pesar más de 10 MB. |
| `TIPO_NO_SOPORTADO` | 415 | El mimetype no es `application/pdf`, `image/jpeg`, `image/png` ni `image/webp`. | Solo aceptamos PDF, JPG, PNG o WEBP. |
| `NO_SE_PUDO_EXTRAER_TEXTO` | 422 | La cascada `unpdf` → OCR.space terminó sin texto útil: PDF escaneado ilegible, foto borrosa, PDF con contraseña, imagen sin letras, o un link que devolvió una página sin texto. | No pudimos leer el texto de ese archivo. Probá con una foto más nítida o un PDF con texto. |
| `SIN_CREDITOS_IA` | 402 | NVIDIA NIM (o OCR.space) devuelve 402 / quota exceeded: se agotaron los créditos o el cupo mensual gratuito. | Se acabaron los créditos de la IA por este mes. Avisale al administrador. |
| `DEMASIADOS_PEDIDOS` | 429 | Se superó el límite del backend (30 pedidos por minuto por uid, 10 por minuto en `/preguntar`), o NVIDIA devolvió 429 después de los 3 reintentos con backoff. Va con el header `Retry-After` en segundos. | Estás yendo muy rápido. Esperá unos segundos y probá de nuevo. |
| `IA_NO_RESPONDE` | 503 | NVIDIA NIM tarda más de 30 s, corta la conexión o devuelve 5xx. También cuando OCR.space no responde. Se reusa cuando Mercado Pago no contesta. | El servicio de IA no está respondiendo. Probá de nuevo en un minuto. |
| `LIMITE_PLAN` | 403 | El plan free llegó a su tope: 3 workspaces por usuario, 5 miembros por workspace o 200 items **procesados** por workspace. El tope de items se aplica en `/procesar`, no al crear el doc, porque crear no pasa por el backend. | Llegaste al límite del plan gratuito. Pasá al plan Equipo para seguir. |
| `PAGOS_NO_DISPONIBLE` | 501 | Se llamó a un endpoint de Mercado Pago y la integración todavía no está implementada (es stretch goal: hasta la semana 5, los tres endpoints responden esto). | Los pagos todavía no están disponibles. |
| `FIRMA_INVALIDA` | 401 | El webhook de Mercado Pago llegó con un `x-signature` que no valida contra el HMAC calculado con la clave secreta. Es el **único** caso en que el webhook no responde 200. | No pudimos validar la notificación de pago. |
| `ERROR_INTERNO` | 500 | Cualquier excepción no prevista, atrapada por el middleware final. El stack completo se loguea en Render y **nunca** viaja: este error responde siempre con `detalle` hardcodeado en `null`. | Algo salió mal de nuestro lado. Ya lo estamos viendo, probá de nuevo. |

**Código que existía en la v2 y ya no existe: `WORKSPACE_NO_ENCONTRADO`.** Era inalcanzable. Toda ruta con `:wsId` pasa primero por el middleware `exigirMiembro`, que lee `workspaces/{wsId}/members/{uid}`: si el workspace no existe, ese documento tampoco, así que la respuesta es `NO_ES_MIEMBRO` 403 y nunca se llega a un 404 de workspace. Martín **no** tiene que escribir una rama para ese código.

**Dos códigos que se parecen y no son lo mismo (esto lo puede preguntar el profesor):**

- `PROCESO_EN_CURSO` = *"ya está corriendo, esperá"*. Es temporal, se arregla solo, el cliente puede reintentar en unos segundos.
- `ESTADO_INVALIDO` = *"no hay de dónde sacar el texto"*. No se arregla esperando: hay que volver a subir el archivo.

---

## Rutina única de claims (la usan 4 endpoints)

La comparten `POST /v1/workspaces`, `POST /v1/workspaces/:wsId/miembros`, `DELETE /v1/workspaces/:wsId/miembros/:uid` y `PATCH /v1/workspaces/:wsId/miembros/:uid`. Está escrita una sola vez, acá, y los endpoints la referencian.

**Pasos, en orden:**

1. **Si `usuarios/{uid}` no existe, crearlo acá mismo, de forma idempotente** (`create` y, si tira `already-exists`, seguir de largo), con `email` y `nombre` sacados del registro de Firebase Auth (`admin.auth().getUser(uid)`), `workspaces: {}`, `workspaceActual: null` y `claimsActualizadoEn`. **Por qué:** si el registro falló a la mitad (Render dormido, el usuario cerró la app en el medio), el doc puede no existir; sin este paso, invitar a esa persona explotaba con un `ERROR_INTERNO` incomprensible y quedaba a medio hacer — con el miembro creado pero sin claim.
2. `db.runTransaction()` sobre `usuarios/{uid}`: leer el mapa `workspaces`, aplicarle **el alta, la baja o el cambio de rol**, y escribirlo junto con `claimsActualizadoEn: serverTimestamp()`.
3. Salir de la transacción y recién ahí llamar a `setCustomUserClaims(uid, { ws: mapaReconstruidoEntero })`.
4. Volver a leer el doc; si el mapa cambió mientras tanto, repetir **una** vez.

**Nunca se mergea a ciegas contra el claim viejo.** Si dos admins invitan a la misma persona en el mismo minuto, el segundo pisa lo que leyó antes del primero y esa persona pierde el acceso a un workspace en silencio. El claim es siempre el reflejo exacto del documento.

El invitado está escuchando su propio `usuarios/{uid}`: ve cambiar `claimsActualizadoEn` y refresca su token solo.

---

## Endpoints

### 1. `GET /v1/salud`

**Quién lo llama:** cualquiera. Es público (UptimeRobot, y la app y el panel al arrancar).

**Para qué:** health check y, sobre todo, **despertar a Render** — el plan free duerme a los 15 minutos y el primer pedido tarda entre 30 y 60 segundos. La app lo llama apenas abre, en segundo plano, así el primer POST de verdad ya encuentra el servidor despierto.

**Request:** sin headers, sin body.

```
GET https://neurodesk-api.onrender.com/v1/salud
```

**Respuesta OK — HTTP 200:**

```json
{
  "ok": true,
  "version": "3.0.0",
  "uptime": 842
}
```

Tres campos y **nada más**. `uptime` son segundos desde que arrancó el proceso. Un endpoint público no cuenta cuántos items se barrieron, ni si Firestore está caído, ni qué versión de qué librería usamos: eso es información sobre nuestra infraestructura y no le sirve a nadie que no sea nosotros. Lo que pasó en el barrido de items colgados se mira en el log de Render.

**Errores posibles:** ninguno. Si el proceso está vivo, responde 200; si no está vivo, no responde nada y el cliente muestra "Despertando el servidor...".

**Pasos del backend:** devolver el JSON. No toca Firestore.

**Semana:** 1.

---

### 2. `POST /v1/auth/registro`

**Quién lo llama:** la app Flutter y el panel, **una sola vez**, inmediatamente después de `createUserWithEmailAndPassword()` o del login con Google.

**Para qué:** crear `usuarios/{uid}`. Es la **única** forma de crearlo, porque las reglas tienen `allow create: if false` en `usuarios`. Antes competían el cliente y el backend, y si ganaba el cliente el doc quedaba sin `claimsActualizadoEn` y el listener que refresca el token no se disparaba nunca. El `uid` y el `email` salen del **token verificado**, nunca del body.

**Request:**

```
Headers:
  Authorization: Bearer <idToken>
  Content-Type: application/json

Body:
{
  "nombre": "Martín Ramírez"
}
```

`nombre`: **2 a 60 caracteres** (el mismo rango, idéntico, en el modelo, en las reglas y acá). Si el login fue con Google y no mandan nombre, el backend usa el `displayName` del token.

**Respuesta OK — HTTP 201 si lo creó, HTTP 200 si ya existía:**

```json
{
  "ok": true,
  "creado": true,
  "usuario": {
    "uid": "kJ8s0PqR2mVb1",
    "email": "martin@ejemplo.com",
    "nombre": "Martín Ramírez",
    "workspaces": {},
    "workspaceActual": null
  }
}
```

**Errores posibles:** `FALTA_TOKEN`, `TOKEN_INVALIDO`, `DATOS_INVALIDOS`, `DEMASIADOS_PEDIDOS`, `ERROR_INTERNO`.

**Pasos del backend:**

1. `verifyIdToken(token, true)`.
2. Validar `nombre` (2 a 60). Si falla, `DATOS_INVALIDOS`.
3. Escribir `usuarios/{uid}` de forma **idempotente**: si ya existe, no pisa nada y devuelve `creado: false` con el doc que ya estaba.
4. Deja `workspaces: {}`, `workspaceActual: null`, `creadoEn` y `claimsActualizadoEn`.

**Para Martín:** como el cliente ya no puede crear el doc, si esta llamada falla hay que **reintentarla** antes de dejar entrar a la app; mientras tanto se muestra "Preparando tu cuenta...". Puede tardar 60 s la primera vez si Render estaba dormido.

**Semana:** 2.

---

### 3. `POST /v1/workspaces`

**Quién lo llama:** app o panel, cualquier usuario ya registrado.

**Para qué:** crear el espacio de trabajo y dejar admin a quien lo crea.

**Request:**

```
Headers:
  Authorization: Bearer <idToken>
  Content-Type: application/json

Body:
{
  "nombre": "Kiosco Central"
}
```

`nombre` del workspace: 2 a 40 caracteres.

**Respuesta OK — HTTP 201:**

```json
{
  "ok": true,
  "workspace": {
    "wsId": "ws_7Kd2mQ9xLb",
    "nombre": "Kiosco Central",
    "ownerUid": "kJ8s0PqR2mVb1",
    "plan": "free",
    "planStatus": "sin_plan",
    "rol": "admin",
    "creadoEn": "2026-09-10T13:20:44.010Z"
  },
  "debeRefrescarToken": true
}
```

`planStatus` arranca en **`sin_plan`**, que es el valor normal de un workspace gratuito: todavía no hay ninguna suscripción de por medio. Los cinco valores posibles son `sin_plan | pendiente | activa | pausada | cancelada`, y son **los mismos** que usa `suscripcion/actual.estado`.

**Errores posibles:** `FALTA_TOKEN`, `TOKEN_INVALIDO`, `DATOS_INVALIDOS`, `LIMITE_PLAN`, `DEMASIADOS_PEDIDOS`, `ERROR_INTERNO`.

**Pasos del backend:**

1. `verifyIdToken`.
2. Contar los workspaces del usuario. Si ya tiene 3, `LIMITE_PLAN`.
3. Generar el `wsId` con nanoid de 12 (lo genera el backend, no el cliente).
4. Crear `workspaces/{wsId}` con `ownerUid`, `nombre`, `plan: 'free'`, `planStatus: 'sin_plan'`, `creadoEn`, `actualizadoEn`.
5. Crear `workspaces/{wsId}/members/{uid}` con `rol: 'admin'`.
6. Correr la **rutina única de claims** (incluido el paso 1, que crea `usuarios/{uid}` si no existe).
7. Escribir el evento `workspace.creado`.

**Para Martín:** si `debeRefrescarToken` es `true`, el cliente **tiene** que hacer `await user.getIdToken(true)` **antes** de navegar a la pantalla del workspace. Si no, Firestore le tira `permission-denied` con el token viejo, que todavía no tiene el claim.

**Semana:** 2.

---

### 4. `POST /v1/workspaces/:wsId/miembros`

**Quién lo llama:** panel web, **solo admin**.

**Para qué:** invitar a alguien por email. En el MVP no hay invitaciones pendientes: primero la persona se registra, después la invitan.

**Request:**

```
Headers:
  Authorization: Bearer <idToken del admin>
  Content-Type: application/json

Body:
{
  "email": "martin@ejemplo.com",
  "rol": "miembro"
}
```

`email` se normaliza a minúsculas y sin espacios. `rol`: `'admin'` o `'miembro'`; si no viene, `'miembro'`.

**Respuesta OK — HTTP 201:**

```json
{
  "ok": true,
  "miembro": {
    "uid": "p3Lm9QrT4vXz2",
    "email": "martin@ejemplo.com",
    "nombre": "Martín Ramírez",
    "rol": "miembro",
    "agregadoPor": "kJ8s0PqR2mVb1",
    "agregadoEn": "2026-09-17T14:05:02.774Z"
  }
}
```

El panel **no** agrega la fila a mano: ya está escuchando `members` con `onSnapshot` y aparece sola.

**Errores posibles:** `FALTA_TOKEN`, `TOKEN_INVALIDO`, `NO_ES_MIEMBRO`, `NO_ES_ADMIN`, `DATOS_INVALIDOS`, `USUARIO_NO_REGISTRADO`, `MIEMBRO_DUPLICADO`, `LIMITE_PLAN`, `DEMASIADOS_PEDIDOS`, `ERROR_INTERNO`.

**Pasos del backend:**

1. `verifyIdToken` + `exigirMiembro` (lee `members/{uid}` del que llama) + exigir `rol === 'admin'` en **ese** documento.
2. Validar email y rol. Si falla, `DATOS_INVALIDOS`.
3. `admin.auth().getUserByEmail()`. Si no existe, `USUARIO_NO_REGISTRADO`.
4. Si ya está en `members`, `MIEMBRO_DUPLICADO`. Si el workspace ya tiene 5 miembros y el plan es free, `LIMITE_PLAN`.
5. Crear `workspaces/{wsId}/members/{uidInvitado}`.
6. Correr la **rutina única de claims** sobre el doc del **invitado** — incluido el paso que crea `usuarios/{uidInvitado}` si no existe, que es justo el caso de alguien que se registró en Auth pero cuyo `POST /v1/auth/registro` falló.
7. Evento `miembro.agregado`.

**Semana:** 3.

---

### 5. `DELETE /v1/workspaces/:wsId/miembros/:uid`

**Quién lo llama:** panel web, **solo admin**.

**Para qué:** sacar a alguien del equipo.

**Request:**

```
Headers:
  Authorization: Bearer <idToken del admin>

Sin body.

DELETE /v1/workspaces/ws_7Kd2mQ9xLb/miembros/p3Lm9QrT4vXz2
```

**Respuesta OK — HTTP 200:**

```json
{
  "ok": true,
  "quitado": {
    "uid": "p3Lm9QrT4vXz2",
    "email": "martin@ejemplo.com",
    "itemsQueQuedan": 12
  },
  "corteDeAcceso": {
    "backend": "inmediato",
    "lecturaDirectaFirestore": "hasta 60 minutos (vence el ID token)",
    "tokensRevocados": true
  }
}
```

**Errores posibles:** `FALTA_TOKEN`, `TOKEN_INVALIDO`, `NO_ES_MIEMBRO`, `NO_ES_ADMIN`, `MIEMBRO_NO_ENCONTRADO`, `ACCION_NO_PERMITIDA`, `DEMASIADOS_PEDIDOS`, `ERROR_INTERNO`.

**Pasos del backend:**

1. `verifyIdToken` + `exigirMiembro` + exigir admin.
2. Si el `uid` es el `ownerUid`, o es uno mismo siendo el único admin, `ACCION_NO_PERMITIDA`.
3. Borrar `workspaces/{wsId}/members/{uid}`. **Este es el corte real**, porque todos los endpoints leen ese documento en cada pedido.
4. Correr la **rutina única de claims** sacando la entrada de `usuarios/{uid}.workspaces`.
5. `admin.auth().revokeRefreshTokens(uid)`, así no puede sacar un token nuevo con el claim viejo.
6. Evento `miembro.eliminado`.

Los items que esa persona había cargado **no** se borran: quedan en el workspace.

**La verdad sobre el corte** (hay que saber decirla en la defensa, la v1 del contrato mentía): el acceso al **backend** se corta al instante. El acceso **directo a Firestore** no: las reglas leen el custom claim que viaja dentro del ID token ya emitido, y ese token vale hasta 1 hora. `revokeRefreshTokens` impide sacar uno nuevo, pero no invalida el que la persona ya tiene en la mano.

**Semana:** 3.

---

### 6. `PATCH /v1/workspaces/:wsId/miembros/:uid`

**Quién lo llama:** panel web, **solo admin**.

**Para qué:** cambiar el rol de un miembro (ascender a admin o bajar a miembro). Es el endpoint que hace visible la diferencia de roles en la demo: se cambia el rol y en el celular de la otra persona la pantalla de eventos aparece o desaparece sola.

**Request:**

```
Headers:
  Authorization: Bearer <idToken del admin>
  Content-Type: application/json

Body:
{
  "rol": "admin"
}
```

**Respuesta OK — HTTP 200:**

```json
{
  "ok": true,
  "miembro": {
    "uid": "p3Lm9QrT4vXz2",
    "email": "martin@ejemplo.com",
    "rol": "admin"
  },
  "corteDeAcceso": {
    "backend": "inmediato",
    "reglasDeFirestore": "hasta 60 minutos si fue una baja de rol"
  }
}
```

**Errores posibles:** `FALTA_TOKEN`, `TOKEN_INVALIDO`, `NO_ES_MIEMBRO`, `NO_ES_ADMIN`, `DATOS_INVALIDOS`, `MIEMBRO_NO_ENCONTRADO`, `ACCION_NO_PERMITIDA`, `DEMASIADOS_PEDIDOS`, `ERROR_INTERNO`.

**Pasos del backend:**

1. `verifyIdToken` + `exigirMiembro` + exigir admin.
2. Validar que `rol` sea `'admin'` o `'miembro'`. Si no, `DATOS_INVALIDOS`.
3. Si el `uid` es el `ownerUid` y se lo quiere bajar, `ACCION_NO_PERMITIDA`.
4. Actualizar `members/{uid}.rol`.
5. Correr la **rutina única de claims**.
6. Si fue una **baja** de admin a miembro, `revokeRefreshTokens(uid)`.
7. Evento `rol.cambiado`.

Mismo aviso de honestidad que arriba: el backend aplica el rol nuevo al instante (lo lee de `members`), pero las reglas de Firestore siguen viendo el rol viejo hasta que venza el token.

**Semana:** 4.

---

### 7. `POST /v1/workspaces/:wsId/items/:itemId/procesar`

**Quién lo llama:** app Flutter (y el panel, si alguna vez sube archivos). El **autor del item** o un **admin**.

**Para qué:** el endpoint central. **El item ya existe**: el cliente lo creó directo en Firestore con estado `'pendiente'` y ya se ve en el panel del admin. Este endpoint solo lo **actualiza**. **El backend nunca crea el item.**

**Request:**

```
Headers:
  Authorization: Bearer <idToken>
  Content-Type: multipart/form-data   (lo pone http.MultipartRequest solo, NO escribirlo a mano)

Partes del multipart:
  archivo : el binario. ÚNICA parte del multipart.
            Obligatorio si el item es tipo 'pdf' o 'foto'.
            No se manda para 'nota' ni para 'link'.

POST /v1/workspaces/ws_7Kd2mQ9xLb/items/it_9Fh3Kd/procesar
```

No se manda `url`, ni el texto de la nota, ni el `uid`, ni el `wsId`. El backend **lee todo del documento** del item (`tipo`, `url`, `textoOriginal`, `visibilidad`); el `uid` sale del token y el `wsId` de la ruta.

**Respuesta OK — HTTP 200 (cuando terminó de indexar):**

```json
{
  "ok": true,
  "item": {
    "itemId": "it_9Fh3Kd",
    "estado": "listo",
    "cantChunks": 14,
    "origen": "pdf-texto",
    "paginas": 6,
    "caracteres": 18422,
    "recortado": false
  },
  "chunksBorrados": 0,
  "tardoMs": 12480
}
```

Todos los campos de `item` existen también como campos del documento en Firestore, que es la fuente de verdad de la UI. Solo `chunksBorrados` y `tardoMs` son datos del pedido y no del documento.

**Errores posibles:** `FALTA_TOKEN`, `TOKEN_INVALIDO`, `NO_ES_MIEMBRO`, `NO_SOS_EL_AUTOR`, `ITEM_NO_ENCONTRADO`, `PROCESO_EN_CURSO`, `ARCHIVO_FALTANTE`, `ARCHIVO_MUY_GRANDE`, `TIPO_NO_SOPORTADO`, `URL_NO_PERMITIDA`, `NO_SE_PUDO_EXTRAER_TEXTO`, `SIN_CREDITOS_IA`, `IA_NO_RESPONDE`, `DEMASIADOS_PEDIDOS`, `LIMITE_PLAN`, `ERROR_INTERNO`.

**Pasos del backend:**

1. `verifyIdToken(checkRevoked: true)`.
2. Middleware `exigirMiembro`: leer `workspaces/{wsId}/members/{uid}`. Si no existe, `NO_ES_MIEMBRO`. Es 1 lectura y es lo único que corta al instante a alguien recién echado. De ese mismo documento sale el `rol`, que se usa en el paso 3.
3. **Transacción** (`db.runTransaction()`), y **adentro de ella, en este orden**:
   1. Leer el item. Si no existe, `ITEM_NO_ENCONTRADO`.
   2. Si `item.workspaceId !== wsId`, `NO_ES_MIEMBRO`.
   3. **Chequeo de autoría (crítico):** si `uid !== item.creadoPor` **y** el rol del paso 2 no es `'admin'`, cortar con **`NO_SOS_EL_AUTOR` 403**. Va **antes** de mirar el estado, así nadie averigua en qué estado está el item de otro.
   4. Si el estado es `'procesando'` y `actualizadoEn` tiene **menos** de 5 minutos, `PROCESO_EN_CURSO` 409 (doble tap).
   5. Si llegó hasta acá, escribir `estado: 'procesando'`, `actualizadoEn` y `errorMsg: null` **en la misma transacción**.

   Estados que acepta: `'pendiente'`, `'error'`, `'listo'` (volver a subir el archivo de un item ya procesado es legítimo: se reindexa) y `'procesando'` con más de 5 minutos de quietud, que es un item colgado por un reinicio de Render.

   **Recién cuando la transacción termina se empieza a gastar plata en IA.**
4. **Extraer el texto según el tipo**, leyendo el documento (no el body): `nota` → el campo `textoOriginal`; `link` → el campo `url`, con la validación anti-SSRF de abajo; `pdf` → `unpdf` y, si viene vacío, OCR.space; `foto` → OCR.space. Si no sale nada útil, `NO_SE_PUDO_EXTRAER_TEXTO`.
5. **`indexar(itemId)`** — la misma función que usa `/reprocesar`: **primero** borra en lote todos los chunks `where('itemId','==',itemId)`, y **después** trocea en ~1500 caracteres con 200 de solapado, pide embeddings a NVIDIA con `input_type: 'passage'` en lotes de 32, recorta a 1024 dimensiones, renormaliza L2 y escribe `chunks/{itemId_idx}` con Admin SDK. Cada chunk lleva además la **copia** de `visibilidad` y `creadoPor` del item (la segunda cerradura del filtro de privacidad). Borrar primero es obligatorio: si el intento anterior escribió 9 chunks y este escribe 7, sin el borrado sobrevivirían el 8 y el 9 con texto viejo.
6. Actualizar el item a `'listo'` con `texto`, `cantChunks`, `paginas`, `origen`, `caracteres`, `recortado` y `actualizadoEn`. Evento `item.listo`.

Si algo falla **en cualquier paso**, el backend deja el item en `'error'` con `errorMsg` = el mismo mensaje que devuelve por HTTP (texto escrito por nosotros, nunca un `err.message`), escribe el evento `item.error` y recién ahí responde el error.

**Por qué el chequeo de autoría es crítico (esto se pregunta seguro).** Sin él, cualquier miembro podía mandar **su** archivo al `itemId` de **otra** persona. El backend escribía ese texto en el item de la víctima e indexaba los chunks con la **autoría y la visibilidad de la víctima**: quedaba plantada una fuente falsa dentro del índice de la IA, firmada por alguien que nunca la subió, y visible para el equipo si el item de la víctima era `'equipo'`. La lectura del item ya se hacía; lo único que faltaba era comparar dos strings antes de escribir.

**Validación anti-SSRF de los links** (obligatoria antes de cualquier `fetch`): solo esquemas `http` y `https`; resolver el hostname con `dns.lookup` y **rechazar** `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `0.0.0.0/8`, `::1` y `fc00::/7`; seguir como máximo 2 redirects **revalidando cada destino** con la misma función; timeout de 10 s; cortar la descarga a los 2 MB; aceptar solo `Content-Type` `text/html` o `text/plain`. Si algo de eso falla, `URL_NO_PERMITIDA` con `detalle: "la dirección no es pública"` — **siempre el mismo texto**, sin importar cuál de los checks falló. El motivo exacto (qué IP resolvió, qué Content-Type vino, en qué redirect se cayó) va **únicamente** a `console.error` de Render. Si el mensaje dijera cuál falló, el backend sería un escáner de la red interna de Render que cualquier miembro puede manejar desde el celular.

**Para Martín:** no bloquees la pantalla esperando esta respuesta. La fuente de verdad es el `StreamBuilder` sobre el doc del item (`pendiente → procesando → listo`). Si el POST tarda más de 90 s y corta por timeout, **no muestres error**: el item puede seguir procesándose. Mostrá "sigue procesando" y dejá que el listener avise.

**Semana:** 3.

---

### 8. `POST /v1/workspaces/:wsId/items/:itemId/reprocesar`

**Quién lo llama:** app y panel — botón "Reintentar" en los items en `'error'` o `'pendiente'`, y botón "Volver a indexar" después de editar una nota. El **autor del item** o un **admin**.

**Para qué:** reintentar **sin volver a subir el archivo**, usando lo que ya está guardado en el documento. Usa exactamente la misma transacción de estado, el mismo chequeo de autoría y la misma función `indexar(itemId)` que `/procesar`. La única diferencia es de dónde saca el texto.

De dónde saca el texto, según el tipo:

- `nota` → `textoOriginal` (por eso funciona editar la nota y volver a indexar).
- `link` → `url`, con la validación anti-SSRF completa otra vez, porque la página pudo cambiar.
- `pdf` y `foto` → el campo `texto` ya extraído. **Si no hay texto guardado, no se puede reprocesar** y responde `ESTADO_INVALIDO`: el archivo no se guarda en ningún lado (Storage está descartado), así que el cliente manda al usuario a elegir el archivo de nuevo y llamar a `/procesar`.

**Request:**

```
Headers:
  Authorization: Bearer <idToken>
  Content-Type: application/json

Body: {}   (vacío, o sin body)

POST /v1/workspaces/ws_7Kd2mQ9xLb/items/it_9Fh3Kd/reprocesar
```

**Respuesta OK — HTTP 200:**

```json
{
  "ok": true,
  "item": {
    "itemId": "it_9Fh3Kd",
    "estado": "listo",
    "cantChunks": 14,
    "origen": "nota",
    "paginas": null,
    "caracteres": 18422,
    "recortado": false
  },
  "chunksBorrados": 9,
  "tardoMs": 5210
}
```

**Errores posibles:** `FALTA_TOKEN`, `TOKEN_INVALIDO`, `NO_ES_MIEMBRO`, `NO_SOS_EL_AUTOR`, `ITEM_NO_ENCONTRADO`, `PROCESO_EN_CURSO`, `ESTADO_INVALIDO`, `URL_NO_PERMITIDA`, `NO_SE_PUDO_EXTRAER_TEXTO`, `SIN_CREDITOS_IA`, `IA_NO_RESPONDE`, `DEMASIADOS_PEDIDOS`, `ERROR_INTERNO`.

**Pasos del backend:**

1. `verifyIdToken(checkRevoked: true)`.
2. `exigirMiembro` leyendo `members/{uid}`; de ahí sale el `rol`.
3. **Transacción**, en este orden:
   1. Leer el item. Si no existe, `ITEM_NO_ENCONTRADO`.
   2. Si `item.workspaceId !== wsId`, `NO_ES_MIEMBRO`.
   3. **Chequeo de autoría:** si `uid !== item.creadoPor` y el rol no es `'admin'`, `NO_SOS_EL_AUTOR` 403. Antes de mirar el estado y **antes** de escribir `'procesando'`.
   4. Si está en `'procesando'` hace menos de 5 minutos, `PROCESO_EN_CURSO` 409.
   5. Si es `pdf` o `foto` y no tiene `texto` guardado, `ESTADO_INVALIDO` 409.
   6. Escribir `estado: 'procesando'`, `actualizadoEn`, `errorMsg: null`.

   Estados que acepta: `'pendiente'`, `'error'`, `'listo'` y `'procesando'` con más de 5 minutos de quietud. Acepta `'listo'` **a propósito**: es el caso de "edité la nota y quiero que la IA la vuelva a leer".
4. Sacar el texto según el tipo (arriba).
5. `indexar(itemId)`: borrar los chunks viejos, trocear, embeber, escribir.
6. Actualizar el item a `'listo'`. Evento `item.listo`.

**Semana:** 4.

---

### 9. `DELETE /v1/workspaces/:wsId/items/:itemId`

**Quién lo llama:** app y panel: el **autor del item** o cualquier **admin** del workspace.

**Para qué:** borrar de verdad un item, **con sus chunks**. Antes el cliente borraba el item directo contra Firestore y los chunks quedaban vivos en la colección plana `/chunks`: el texto de una nota privada seguía en la base, sin ningún item al cual preguntarle los permisos, y la IA lo podía seguir citando. La persona creía que lo había borrado y no lo había borrado. Ahora las reglas tienen `allow delete: if false` y el único camino es este.

**Request:**

```
Headers:
  Authorization: Bearer <idToken>

Sin body.

DELETE /v1/workspaces/ws_7Kd2mQ9xLb/items/it_9Fh3Kd
```

**Respuesta OK — HTTP 200:**

```json
{
  "ok": true,
  "borrado": {
    "itemId": "it_9Fh3Kd",
    "titulo": "Lista de precios agosto",
    "chunksBorrados": 14
  }
}
```

El cliente no saca la fila a mano: el `onSnapshot` de la lista la hace desaparecer sola.

**Errores posibles:** `FALTA_TOKEN`, `TOKEN_INVALIDO`, `NO_ES_MIEMBRO`, `NO_SOS_EL_AUTOR`, `ITEM_NO_ENCONTRADO`, `DEMASIADOS_PEDIDOS`, `ERROR_INTERNO`.

**Pasos del backend:**

1. `verifyIdToken` + `exigirMiembro` (de ahí sale el `rol`).
2. Leer el item. Si no existe, `ITEM_NO_ENCONTRADO`.
3. Si `uid !== item.creadoPor` y el rol no es `'admin'`, **`NO_SOS_EL_AUTOR` 403**. (En la v2 esto devolvía un código cuyo mensaje hablaba del *dueño del workspace*, que no tiene nada que ver con quién subió el archivo: la persona leía "no se puede hacer eso con el dueño del espacio" y no entendía nada.)
4. Borrar en lotes de 400 todos los chunks `where('itemId','==',itemId)`.
5. Borrar el item.
6. Evento `item.eliminado`.

**El orden importa: primero los chunks, después el item.** Si el proceso se corta en el medio, quedan chunks de un item que todavía existe (inofensivo: se limpia reintentando) y nunca chunks huérfanos de un item que ya no está. Además, como el filtro del RAG es fail-closed, un chunk cuyo item no aparece se descarta igual.

**Semana:** 4.

---

### 10. `DELETE /v1/workspaces/:wsId/items?estado=pendiente&antesDe=<ISO>`

**Quién lo llama:** panel web, **solo admin**.

**Para qué:** limpieza masiva. Después de una demo o de una clase quedan decenas de items en `'pendiente'` que nunca se procesaron (se cerró la app, se cayó la conexión, Render estaba dormido). Borrarlos de a uno son decenas de clicks y decenas de eventos en el feed de auditoría. Este endpoint los borra en lote y deja **un solo** evento agregado.

**Request:**

```
Headers:
  Authorization: Bearer <idToken del admin>

Sin body. Los dos parámetros van en el query string y los DOS son obligatorios:
  estado  : único valor aceptado, 'pendiente'
  antesDe : fecha ISO 8601, tiene que estar en el pasado

DELETE /v1/workspaces/ws_7Kd2mQ9xLb/items?estado=pendiente&antesDe=2026-10-01T00:00:00.000Z
```

Solo se acepta `estado=pendiente`. Cualquier otro valor devuelve `DATOS_INVALIDOS`. **Por qué tan cerrado:** un `estado=listo` borraría todo el conocimiento del equipo de un pedido, y un parámetro opcional que borra en masa es exactamente el tipo de cosa que alguien ejecuta sin querer el día de la entrega.

**Respuesta OK — HTTP 200:**

```json
{
  "ok": true,
  "filtro": {
    "estado": "pendiente",
    "antesDe": "2026-10-01T00:00:00.000Z"
  },
  "itemsBorrados": 37,
  "chunksBorrados": 0,
  "lotes": 1
}
```

Si no había nada que borrar, responde igual **200** con `itemsBorrados: 0`. Borrar cero cosas no es un error.

**Errores posibles:** `FALTA_TOKEN`, `TOKEN_INVALIDO`, `NO_ES_MIEMBRO`, `NO_ES_ADMIN`, `DATOS_INVALIDOS`, `DEMASIADOS_PEDIDOS`, `ERROR_INTERNO`.

**Pasos del backend:**

1. `verifyIdToken` + `exigirMiembro` + exigir `rol === 'admin'`.
2. Validar el query: `estado` tiene que ser exactamente `'pendiente'` y `antesDe` una fecha ISO válida y pasada. Si no, `DATOS_INVALIDOS`.
3. Query con Admin SDK: `workspaces/{wsId}/items` `where('estado','==','pendiente')` `where('creadoEn','<', antesDe)` con `.limit(400)`.
4. Por cada lote: **primero** borrar los chunks de esos `itemId` (consultando de a grupos de 10 ids), **después** borrar los items, todo con `batch.commit()`. Mismo invariante de orden que el DELETE de un item solo. (Un item en `'pendiente'` normalmente no tiene chunks, pero si un procesamiento se cortó a la mitad puede tenerlos.)
5. Repetir mientras el lote vuelva lleno.
6. Escribir **un único** evento `items.purgados` con el total (`resumen: "Se limpiaron 37 items pendientes anteriores al 01/10/2026"`), no uno por item: 37 eventos `item.eliminado` tapan el feed de auditoría y hacen inútil justo la pantalla que demuestra el rol de admin.

Usa Admin SDK, así que ignora las reglas y no le abre nada al cliente.

**Semana:** 5.

---

### 11. `POST /v1/workspaces/:wsId/preguntar`

**Quién lo llama:** app y panel, cualquier miembro.

**Para qué:** el RAG. Responder en lenguaje natural **citando la fuente**, y **solo con lo que esa persona puede ver**. Es el requisito 2 de la materia.

El **cliente crea primero** el doc `workspaces/{wsId}/respuestas/{respId}` con exactamente `pregunta`, `autorUid`, `estado: 'buscando'` y `creadoEn` — así la pantalla ya muestra la pregunta y el spinner aunque Render esté dormido — y recién después manda el POST con ese `respId`.

**Request:**

```
Headers:
  Authorization: Bearer <idToken>
  Content-Type: application/json

Body:
{
  "respId": "resp_4Tn8Qw",
  "pregunta": "¿Cuánto cobramos el service de la heladera?"
}
```

`pregunta`: 3 a 500 caracteres. El backend usa **siempre** la pregunta del documento; la del body es solo para validar que coincidan.

**Respuesta OK — HTTP 200:**

```json
{
  "ok": true,
  "respId": "resp_4Tn8Qw",
  "estado": "listo",
  "respuesta": "El service de heladera se cobra $12.000 más el repuesto [1]. Si es a domicilio se suma el viático de $3.500 [2].",
  "fuentes": [
    {
      "n": 1,
      "itemId": "it_9Fh3Kd",
      "titulo": "Lista de precios agosto",
      "pagina": 2,
      "fragmento": "Service de heladera: $12.000 + repuesto...",
      "similitud": 0.83
    }
  ],
  "confianza": "alta",
  "chunksVisibles": 190,
  "chunksMirados": 312,
  "tardoMs": 4310
}
```

- `confianza` es **string**: `"alta" | "media" | "baja"`, igual en el contrato y en el modelo. Se calcula con la similitud del mejor chunk: `>= 0.60` alta, `>= 0.45` media, si no baja. Los umbrales se calibran con datos reales antes de la entrega. El número crudo vive en `fuentes[].similitud`.
- `chunksVisibles` viaja **siempre**: es cuántos fragmentos podía ver quien preguntó.
- **`chunksMirados` viaja únicamente si quien pregunta es admin.** Para un miembro común, el campo **no aparece** en la respuesta y se escribe `null` en el documento. Es el total de chunks del workspace: decirle a un miembro "miré 312 y viste 190" le está contando que hay 122 fragmentos de contenido privado ajeno, o sea cuánto material hay que él no puede ver. El admin sí lo ve, y esa comparación es la que se muestra en vivo en la defensa: la misma pregunta hecha por el admin y por un miembro devuelve `chunksVisibles` distintos.

Si ningún chunk supera el umbral **no es un error**: responde 200 con `confianza: "baja"`, `fuentes: []` y el texto "No encontré esto en la base del equipo".

**Errores posibles:** `FALTA_TOKEN`, `TOKEN_INVALIDO`, `NO_ES_MIEMBRO`, `RESPUESTA_NO_ENCONTRADA`, `DATOS_INVALIDOS`, `SIN_CREDITOS_IA`, `IA_NO_RESPONDE`, `DEMASIADOS_PEDIDOS`, `ERROR_INTERNO`.

**Pasos del backend:**

1. `verifyIdToken` + `exigirMiembro` leyendo `members/{uid}`; de ahí sale el `rol`.
2. Leer `respuestas/{respId}`. Si no existe, `RESPUESTA_NO_ENCONTRADA`. Si existe pero su `autorUid` no es el `uid` del token, **también** `RESPUESTA_NO_ENCONTRADA`: a propósito no confirmamos que exista una consulta ajena.
3. **Armar el conjunto de `itemId` visibles para ESE uid. Esto va primero, antes de rankear nada.** Si el rol es `'admin'`, son todos los items del workspace. Si es miembro, se arma con **dos queries** sobre `workspaces/{wsId}/items`: `where('visibilidad','==','equipo')` y `where('creadoPor','==',uid)`, las dos con **`.select()`** para traer solo los ids y no el texto.
4. **Se calcula en cada pedido. No hay caché de este conjunto.** (La v2 lo cacheaba 60 segundos por `(wsId, uid)`. Escenario que lo rompía, y es justo el que el profesor prueba en la demo: alguien pasa una nota de `'equipo'` a `'privado'` desde la app — que es una escritura **directa** a Firestore, el backend ni se entera — y un compañero pregunta dentro de ese minuto: la IA le cita contenido que ya es privado. Las dos queries con `.select()` son baratas; el minuto de caché no valía el agujero.)
5. Traer los chunks del workspace (`where('workspaceId','==',wsId)`) y **descartar todo chunk cuyo `itemId` no esté en el conjunto del paso 3**. **Fail-closed, siempre:** si el item no existe, si fue borrado o si la lectura falló, el chunk **se descarta**. Nunca "no lo encontré, lo dejo pasar".
6. **Segunda cerradura** (defensa en profundidad): además, el chunk tiene que cumplir su propia copia de permisos → `esAdmin || chunk.visibilidad === 'equipo' || chunk.creadoPor === uid`. Las dos condiciones van con **AND**: si la copia del chunk quedó vieja, solo puede esconder de más, nunca mostrar de más.
7. **Recién ahora rankear**, sobre los chunks que sobrevivieron: embeber la pregunta con `input_type: 'query'` (asimétrico, obligatorio: el índice se armó con `'passage'`), ordenar por similitud coseno, quedarse con los 6 mejores. Pasar el doc a `'redactando'`.
8. Armar el prompt con los fragmentos numerados, pedirle al modelo que responda **solo** con eso y que cite `[1] [2]`, y guardar en el doc `respuesta`, `fuentes`, `confianza`, `chunksVisibles`, `chunksMirados` (o `null` si no es admin), `estado: 'listo'` y `actualizadoEn`. Evento `pregunta.hecha`.

**El orden es la seguridad.** Filtrar primero y rankear después no es una optimización: es lo que garantiza que un chunk que la persona no puede ver **nunca entra** en el ranking, ni siquiera para ser descartado más tarde por un `if` al final. En la v1 el filtro colgaba de un solo `if` después del ranking; con un `continue` mal puesto la nota privada salía citada.

Lo que sí se cachea en memoria es la **matriz de embeddings por `wsId`** (para no leer 2.800 documentos en cada pregunta), y se invalida cuando cambia algún item. Esa caché **no decide permisos**: quien decide es el conjunto de `itemId` del paso 3, que se recalcula siempre.

**Test obligatorio del emulador:** A sube una nota privada, B pregunta exactamente por su contenido, y `fuentes[]` tiene que venir **vacío**. Si ese test pasa, el requisito 2 está demostrado.

**Semana:** 4.

---

### 12. `POST /v1/workspaces/:wsId/pagos/suscribir`

**Quién lo llama:** panel web, **solo admin**. **Opcional (stretch goal).**

**Para qué:** arrancar la suscripción mensual en Mercado Pago. El backend crea el preapproval con el access token secreto y devuelve el `initPoint`; el panel abre ese link en una pestaña nueva. **El plan no cambia acá:** aunque Mercado Pago redirija a la `back_url` diciendo "aprobado", el backend lo ignora. La única fuente de verdad del plan es el webhook.

**Request:**

```
Headers:
  Authorization: Bearer <idToken del admin>
  Content-Type: application/json

Body:
{
  "plan": "pro"
}
```

**Respuesta OK — HTTP 200:**

```json
{
  "ok": true,
  "initPoint": "https://www.mercadopago.com.ar/subscriptions/checkout?preapproval_id=2c93808...",
  "preapprovalId": "2c93808495b8e1e50195c1d2f3a40001",
  "plan": "pro",
  "planStatus": "pendiente",
  "montoMensual": 18000,
  "moneda": "ARS",
  "aviso": "El plan se activa recién cuando Mercado Pago nos confirma el pago."
}
```

El campo se llama **`preapprovalId`** — el mismo nombre en el contrato y en el modelo (`suscripcion/actual.preapprovalId`). Y `planStatus` queda en **`pendiente`**, del enum único de cinco valores.

**Errores posibles:** `PAGOS_NO_DISPONIBLE` (hasta la semana 5), `FALTA_TOKEN`, `TOKEN_INVALIDO`, `NO_ES_MIEMBRO`, `NO_ES_ADMIN`, `DATOS_INVALIDOS`, `IA_NO_RESPONDE` (se reusa cuando Mercado Pago no contesta), `DEMASIADOS_PEDIDOS`, `ERROR_INTERNO`.

**Pasos del backend:**

1. `verifyIdToken` + `exigirMiembro` + exigir admin.
2. Validar `plan === 'pro'`.
3. Crear el preapproval en Mercado Pago con el access token secreto (que nunca sale en ninguna respuesta).
4. Guardar `preapprovalId`, `montoMensual` y `estado: 'pendiente'` en `workspaces/{wsId}/suscripcion/actual`, y `planStatus: 'pendiente'` en el workspace.
5. Devolver el `initPoint`.

Hasta la semana 5 responde 501 `PAGOS_NO_DISPONIBLE` y el panel muestra el botón "Pasar a Pro" deshabilitado con la leyenda "Próximamente".

**Semana:** 6.

---

### 13. `POST /v1/pagos/webhook`

**Quién lo llama:** Mercado Pago, servidor a servidor. **Nunca** la app ni el panel. **Opcional (stretch goal).**

**Para qué:** única fuente de verdad del plan.

**Request:**

```
Headers (los pone Mercado Pago; NO hay Authorization ni idToken):
  x-signature: ts=1757520000,v1=8f3c...
  x-request-id: 9f8a7b6c-...
  Content-Type: application/json

Body (se usa SOLO para sacar type e id):
{
  "type": "subscription_preapproval",
  "action": "updated",
  "data": { "id": "2c93808495b8e1e50195c1d2f3a40001" }
}
```

**Respuesta OK — HTTP 200**, siempre, incluso si el evento es de un tipo que no nos interesa o si el procesamiento posterior falla:

```json
{
  "ok": true,
  "recibido": true
}
```

**Errores posibles:** `FIRMA_INVALIDA` (401), el único caso en que no devuelve 200. Cualquier otra falla se loguea en Render y se responde 200 igual, para que Mercado Pago no reintente para siempre.

**Pasos del backend:**

1. Validar `x-signature` con HMAC SHA256 (`ts` + `id` + la clave secreta). Si no valida, `FIRMA_INVALIDA` 401 y **no hace nada más**.
2. **Responder 200 antes de procesar** (`res.status(200).json({ok:true,recibido:true})` y recién después el `await` del procesamiento). Si tarda más de 22 s, Mercado Pago lo da por fallido y reintenta hasta 8 veces.
3. **No creerle al body:** del body solo se toman `type` y `data.id`; después se consulta la API de Mercado Pago con el access token secreto para saber el estado **real** del preapproval.
4. Idempotencia: si `data.id` ya está en `suscripcion/actual.eventosProcesados`, cortar.
5. Con el estado real, actualizar `workspaces/{wsId}.plan` y `.planStatus`, y la subcolección `suscripcion/actual` (`estado`, `preapprovalId`, `vence`, `eventosProcesados`, `actualizadoEn`). Evento `plan.cambiado`.

`planStatus` del workspace y `estado` de la suscripción usan **el mismo enum** y se escriben con **el mismo valor**: `sin_plan | pendiente | activa | pausada | cancelada`.

**Semana:** 6.

---

### 14. `POST /v1/workspaces/:wsId/pagos/cancelar`

**Quién lo llama:** panel web, **solo admin**. **Opcional (stretch goal).**

**Para qué:** cancelar la suscripción mensual. No se corta el acceso en el momento: el equipo conserva el plan pago hasta que termina el período ya pagado.

**Request:**

```
Headers:
  Authorization: Bearer <idToken del admin>
  Content-Type: application/json

Body: {}   (vacío)
```

**Respuesta OK — HTTP 200:**

```json
{
  "ok": true,
  "plan": "pro",
  "planStatus": "cancelada",
  "vence": "2026-10-14T03:00:00.000Z",
  "aviso": "Vas a poder seguir usando el plan Pro hasta el 14/10/2026."
}
```

El campo de la fecha se llama **`vence`**, el mismo nombre que en el modelo (`suscripcion/actual.vence`). Y el estado es **`cancelada`**, del enum único.

**Errores posibles:** `PAGOS_NO_DISPONIBLE` (hasta la semana 5), `FALTA_TOKEN`, `TOKEN_INVALIDO`, `NO_ES_MIEMBRO`, `NO_ES_ADMIN`, `ACCION_NO_PERMITIDA` (si ya estaba en `free`), `IA_NO_RESPONDE` (Mercado Pago no contesta), `DEMASIADOS_PEDIDOS`, `ERROR_INTERNO`.

**Pasos del backend:**

1. `verifyIdToken` + `exigirMiembro` + exigir admin.
2. Si el plan ya es `'free'`, `ACCION_NO_PERMITIDA`.
3. Llamar a la API de Mercado Pago para poner el preapproval en `cancelled`.
4. Marcar `planStatus: 'cancelada'` y `suscripcion/actual.estado: 'cancelada'`, con `vence` = la fecha hasta la que conservan el plan pago.
5. El cambio definitivo a `plan: 'free'` **lo hace igual el webhook** cuando llega la confirmación.

**Semana:** 6.

---

## Notas transversales

### N1. Autenticación, igual en todos lados

Todo endpoint salvo `GET /v1/salud` y `POST /v1/pagos/webhook` exige `Authorization: Bearer <idToken>`. El backend hace `verifyIdToken(token, true)` —con `checkRevoked`— en **cada** pedido, y de ahí saca `uid` y `email`.

Todo endpoint con `:wsId` en la ruta pasa **además** por el middleware `exigirMiembro`, que **lee** `workspaces/{wsId}/members/{uid}`: si el documento no existe, `NO_ES_MIEMBRO`; y si el endpoint pide admin, el rol se toma de **ese documento**, no del claim. Cuesta 1 lectura por request y es lo único que corta al instante a alguien recién echado o recién bajado de rol.

**El `uid`, el `email` y el `rol` nunca se leen del body.** Si el body trae un `uid` o un `wsId` con el que se pretende autorizar algo, se ignora.

### N2. Quién puede tocar qué item

Tres niveles, y conviene tenerlos separados en la cabeza:

| Nivel | Lo chequea | Qué corta |
|---|---|---|
| ¿Está en el equipo? | `exigirMiembro` (doc `members`) | `NO_ES_MIEMBRO` 403 |
| ¿Es admin del equipo? | `members/{uid}.rol` | `NO_ES_ADMIN` 403 |
| ¿Es el autor de **este** item? | `item.creadoPor` vs `uid`, con admin como excepción | `NO_SOS_EL_AUTOR` 403 |

Los tres endpoints que tocan un item concreto — `/procesar`, `/reprocesar` y el `DELETE` — usan el tercer nivel. Ser miembro del equipo **no** alcanza para escribir arriba del contenido de otro.

### N3. El token dura 1 hora y los claims no viajan solos

Cada vez que el backend toca los claims de alguien (crear workspace, invitar, quitar, cambiar rol) responde con `debeRefrescarToken: true` y escribe `claimsActualizadoEn` en `usuarios/{uid}`. Regla para los dos clientes:

- Si la respuesta trae `debeRefrescarToken`, hacer `await user.getIdToken(true)` **antes** de navegar.
- Tener **siempre** un listener sobre el propio `usuarios/{uid}` y, cuando cambia `claimsActualizadoEn`, forzar `getIdToken(true)`.

Si aparece un `permission-denied` raro, el orden de sospecha es: 1) token viejo, 2) falta un `.where()` en la query del cliente, 3) falta el `.limit()`, 4) recién ahí, la regla.

Ojo también con el límite de **1000 bytes** del custom claim: el mapa `ws` no puede tener decenas de workspaces por usuario.

### N4. Límite de pedidos por minuto

`express-rate-limit` **por uid**, no por IP, porque en la escuela todos salen por la misma IP: 30 pedidos por minuto en general y 10 por minuto en `/preguntar`. Al pasarse devuelve `DEMASIADOS_PEDIDOS` 429 con el header `Retry-After` en segundos.

El cliente **deshabilita el botón** mientras hay un pedido en curso. El 90% de los 429 de la demo van a ser por doble tap; ese mismo doble tap, del lado de los datos, lo cortan la transacción y el `PROCESO_EN_CURSO` de `/procesar`.

### N5. Idempotencia: qué se puede repetir sin romper nada

- `POST /v1/auth/registro`: **idempotente**. Si el doc ya existe, no pisa nada y devuelve `creado: false` con 200. Se puede reintentar todas las veces que haga falta.
- `/procesar` y `/reprocesar`: **protegidos por transacción**. Dos pedidos simultáneos: el primero escribe `'procesando'` y el segundo se va con `PROCESO_EN_CURSO` 409. Y `indexar()` borra los chunks viejos antes de escribir los nuevos, así que reprocesar diez veces deja la misma cantidad de chunks, no diez veces más.
- `POST /v1/pagos/webhook`: **idempotente** por `eventosProcesados`. Mercado Pago reenvía el mismo webhook hasta 8 veces.
- `DELETE` de item y de miembros: repetirlos devuelve `ITEM_NO_ENCONTRADO` / `MIEMBRO_NO_ENCONTRADO`, que el cliente puede tratar como "ya estaba hecho".
- La rutina de claims: se puede correr de nuevo sin problema. Reconstruye el mapa entero desde el documento, no acumula.

### N6. Manejo de errores en el cliente, una sola vez

Una función `pedir()` envuelve **todos** los llamados: try/catch, timeout, parseo de JSON, y si `!body.ok` muestra `body.mensaje` en un SnackBar. Cinco códigos merecen tratamiento especial:

- `TOKEN_INVALIDO` y `FALTA_TOKEN` → cerrar sesión y mandar al login.
- `NO_ES_MIEMBRO` → volver a la selección de workspace y refrescar el token.
- `DEMASIADOS_PEDIDOS` → deshabilitar el botón los segundos que diga `Retry-After`.
- `PROCESO_EN_CURSO` → **no es un error para el usuario**: no hace falta ni un SnackBar rojo. Alcanza con dejar el botón deshabilitado y confiar en el listener del doc, que va a avisar cuando pase a `'listo'`.

Nunca mostrar **dos veces** el mismo error (uno por HTTP y otro por el campo `errorMsg` del doc): mostrar el del doc. Y nunca, bajo ningún concepto, una pantalla roja de Flutter.

### N7. Render free duerme

Después de 15 minutos sin tráfico, el primer pedido tarda entre 30 y 60 segundos. Por eso: (a) la app y el panel llaman a `GET /v1/salud` apenas arrancan, en segundo plano; (b) el timeout del cliente para `/procesar` y `/preguntar` es de **90 segundos**, no los 10 por defecto; (c) si el primer intento tarda, se muestra "Despertando el servidor..." en vez de un error.

Atención especial con `/v1/auth/registro`: como es la única forma de crear `usuarios/{uid}`, el registro puede tardar esos 60 s la primera vez.

### N8. Items colgados en `'procesando'`

Si Render se reinicia a mitad del procesamiento, el item queda en `'procesando'` y el cliente no puede tocar `estado`. Dos redes de contención:

1. Al arrancar el servidor, y después cada 10 minutos, un barrido con `collectionGroup('items').where('estado','==','procesando').where('actualizadoEn','<', ahora - 5 min)` los pasa a `'error'` con un mensaje claro. Necesita el índice de collection group `(estado, actualizadoEn)` que está en `firestore.indexes.json`, y usa Admin SDK, así que no le abre nada al cliente.
2. `/procesar` y `/reprocesar` aceptan como procesable un item en `'procesando'` con más de 5 minutos de quietud, así que el botón Reintentar funciona **incluso antes** del barrido.

El resultado del barrido se mira en el log de Render: `GET /v1/salud` **no** lo cuenta (ver N10).

### N9. Semana 2 = mocks

Valentino levanta las 14 rutas devolviendo exactamente estos JSON hardcodeados, con un delay artificial de 1200 ms y el header `X-Mock: 1`, así Martín escribe todas las pantallas sin esperar la lógica real. Para probar los caminos de error, el cliente manda `X-Simular-Error: SIN_CREDITOS_IA` y el mock responde ese código con su HTTP y su mensaje.

**Ese header se borra del código en la semana 5**, junto con los `console.log` de tokens. Queda como tarea explícita en el tablero.

### N10. Lo que el backend no cuenta (y por qué)

El backend no es un oráculo. Tres lugares donde se calla a propósito:

1. **`URL_NO_PERMITIDA`** dice siempre `"la dirección no es pública"`, sin decir cuál de los checks falló. Si dijera "resolvió a 10.0.0.5" o "el Content-Type era application/json", cualquier miembro podría mapear la red interna de Render probando URLs desde el celular. El motivo exacto va al log.
2. **`chunksMirados`** solo viaja si quien pregunta es admin (ver endpoint 11).
3. **`GET /v1/salud`** devuelve tres campos y nada más: `ok`, `version`, `uptime`. Ni el estado de Firestore, ni cuántos items se barrieron, ni cuánto hace que está despierto por dentro. Es un endpoint **público**: cualquiera con la URL lo puede pegar.

Y la regla que las une: `detalle` en `ERROR_INTERNO` va **hardcodeado en `null`**. El `err.message` solo a `console.error`.

### N11. Lo que este contrato NO garantiza (decirlo, no esconderlo)

- **Sacar a alguien del equipo no le corta la lectura directa a Firestore hasta por 1 hora.** El backend se corta al instante (el doc `members` ya no existe), pero las reglas leen el custom claim que ya viaja adentro del ID token de esa persona, y ese token vive hasta 60 minutos. `revokeRefreshTokens(uid)` impide sacar uno nuevo, pero no invalida el que ya tiene. Durante esa hora, un ex-miembro con un cliente hecho a mano y el `appId` (que viaja en el JS del panel) puede seguir leyendo los items `'equipo'`. Lo mismo vale para una baja de admin a miembro. La alternativa sería que las reglas hicieran `get()` del doc `members` en cada lectura, que cuesta una lectura facturada por documento y por regla. Elegimos la versión barata y la explicamos.
- **El feed de eventos cubre lo que pasa por el backend**, no todo. El cliente crea y edita items directo contra Firestore, así que "fulano subió un item" aparece recién cuando el item se procesa, y "fulano cambió una nota de equipo a privado" no aparece.
- **El texto de los PDFs escaneados y de las fotos se extrae en OCR.space**, que es un servicio externo, **incluso cuando el item está marcado como `'privado'`**. Hay que decirlo en la app y en el README: es exactamente el tipo de detalle que el profesor puede preguntar.
- **Los límites del plan free se aplican donde pasa el backend.** El tope de 200 items se chequea en `/procesar`, no al crear el documento, porque crear no pasa por acá. Alguien puede crear 500 items `'pendiente'`; ninguno se va a indexar.
- **El costo del RAG hay que medirlo antes de la entrega.** Leer todos los chunks del workspace en cada pregunta son unas 2.800 lecturas con 200 items indexados, o sea alrededor de 17 preguntas por día en el plan gratuito de Firestore. Por eso se cachea la matriz de embeddings por `wsId`. Hay que probarlo con el volumen real de la demo, no con tres items.

### N12. CORS y claves

El backend acepta pedidos solo desde el origen del panel (`localhost:5500` en desarrollo y el dominio publicado) más la app móvil, que no manda `Origin`. Nada de `cors()` abierto en producción.

Ninguna clave (NVIDIA, OCR.space, Mercado Pago, service account) sale **nunca** en una respuesta, en un mensaje de error ni en un log que se le mande al cliente.

### N13. Auditoría

Todo endpoint que cambia algo importante escribe un doc en `workspaces/{wsId}/eventos` (`tipo`, `actorUid`, `resumen`, `itemId`, `creadoEn`), que es el feed del panel y **solo lo puede leer el admin**. Los tipos son siempre con punto y la lista es esta, idéntica a la del modelo:

`workspace.creado` · `item.listo` · `item.error` · `item.eliminado` · `items.purgados` · `miembro.agregado` · `miembro.eliminado` · `rol.cambiado` · `pregunta.hecha` · `plan.cambiado`

Junto con los items `'privado'` y la subcolección `suscripcion`, es lo que demuestra el requisito de "cada rol ve solo lo suyo" sin depender de Mercado Pago.

**Nadie, en ningún caso, lee `chunks` desde el cliente.**
