# NeuroDesk AI — Modelo de datos (Firestore)

Este es el mapa de toda la base: qué colecciones existen, qué campos tiene cada una y —lo más importante— **quién escribe cada campo, si el CLIENTE o el BACKEND**.
Los clientes (la app Flutter y el panel web) hablan directo con Firestore para leer y para el tiempo real; al backend le pegan solo cuando hace falta una clave secreta o privilegios.
Si el modelo, las reglas y el contrato no dicen exactamente lo mismo, hay un bug: eso fue lo que rompió la versión 1.

---

## Árbol de colecciones

```
(raíz de Firestore)
│
├── usuarios/{uid}                      doc personal. Lo CREA el backend. El cliente
│                                       solo edita 'nombre' y 'workspaceActual'.
│
├── chunks/{chunkId}                    COLECCIÓN PLANA (top-level).
│                                       chunkId = itemId_idx  (idx desde 0)
│                                       CERRADA para todos los clientes: read/write false.
│
└── workspaces/{wsId}                   el equipo
    │
    ├── members/{uid}                   quién está en el equipo y con qué rol.
    │                                   El backend lo lee en CADA request.
    │
    ├── items/{itemId}                  el conocimiento: notas, pdf, links, fotos.
    │                                   LO CREA EL CLIENTE en estado 'pendiente'.
    │
    ├── respuestas/{respId}             preguntas a la IA + respuesta con citas.
    │                                   Sin campo workspaceId: el wsId va solo en el path.
    │
    ├── eventos/{eventoId}              feed de auditoría (append-only). Solo admin lee.
    │
    └── suscripcion/actual              doc ÚNICO, id fijo 'actual'. Solo admin lee.
```

---

## `usuarios/{uid}`

**Quién escribe:** lo **CREA el backend** (`POST /v1/auth/registro`), nunca el cliente (en las reglas: `allow create: if false`). El cliente solo puede **editar dos campos** de su propio doc: `nombre` y `workspaceActual`.
**Quién lee:** solo el propio uid (y el backend). Nadie lee el doc de otro, ni el admin: para ver gente está `members`.

| Campo | Tipo | Quién lo escribe | Para qué |
|---|---|---|---|
| `email` | string | **BACKEND** | Email de la cuenta. Sale del token verificado, nunca del body. Se muestra en listas y sirve para invitar. |
| `nombre` | string (**2 a 60** caracteres) | **BACKEND** lo crea / **CLIENTE** lo puede editar | Nombre visible del usuario. El rango 2–60 es idéntico en el modelo, en el contrato y en la regla (`size() >= 2 && size() <= 60`). |
| `workspaces` | map (wsId → `{rol, nombre}`) | **BACKEND** | Espejo local de a qué workspaces pertenece, para dibujar el selector sin queries. Es la FUENTE DE VERDAD desde la que el backend reconstruye el custom claim completo. |
| `workspaceActual` | string \| null | **CLIENTE** | wsId del workspace abierto, para que la app arranque donde quedó. Queda en null cuando lo sacan del último workspace. |
| `claimsActualizadoEn` | timestamp | **BACKEND** | Marca que el backend cambió los custom claims. El cliente escucha su propio doc y, cuando cambia, llama a `getIdToken(true)` para refrescar el token de 1 hora. |
| `creadoEn` | timestamp | **BACKEND** | Alta de la cuenta (serverTimestamp). Informativo y de orden. |

---

## `workspaces/{wsId}`

**Quién escribe:** solo el **BACKEND**. Crear un workspace toca cuatro lugares de una: el doc del workspace, `members/{owner}`, `usuarios/{uid}.workspaces` y el custom claim. El cliente tiene create, update y delete cerrados.
**Quién lee:** cualquier miembro del workspace (la regla pide que el token traiga el claim `ws[wsId]`). Alguien de otro workspace no lo lee ni lo lista.

| Campo | Tipo | Quién lo escribe | Para qué |
|---|---|---|---|
| `nombre` | string (2 a 40) | **BACKEND** | Nombre visible del equipo (ej: "Coordinación 6.º 2.ª"). En el MVP no se puede renombrar: ver limitaciones. |
| `ownerUid` | string (uid) | **BACKEND** | Quién lo creó. Es siempre admin, no se lo puede eliminar ni bajar de rol. |
| `plan` | string (`'free'` \| `'pro'`) | **BACKEND** | Define los límites: items, miembros, preguntas por día. |
| `planStatus` | string — **enum único de estado de plan**: `'sin_plan'` \| `'pendiente'` \| `'activa'` \| `'pausada'` \| `'cancelada'` | **BACKEND** | Estado del cobro. **Es EXACTAMENTE el mismo enum que usa `suscripcion/actual.estado`**. El backend deja procesar items nuevos con `'sin_plan'`, `'pendiente'` y `'activa'`; con `'pausada'` o `'cancelada'` los rechaza. Crear el doc del item no lo puede frenar: eso lo escribe el cliente directo contra Firestore. |
| `creadoEn` | timestamp | **BACKEND** | Fecha de creación (serverTimestamp). |
| `actualizadoEn` | timestamp | **BACKEND** | Última modificación. Para ordenar y para debug. |

---

## `workspaces/{wsId}/members/{uid}`

**Quién escribe:** solo el **BACKEND** (POST, DELETE y PATCH de miembros). El alta, la baja y el cambio de rol los pide un admin, pero el que escribe es el backend, porque también tiene que tocar los claims y `usuarios/{uid}`.
**Quién lee:** cualquier miembro del workspace, para mostrar "quién subió esto". Además **es el documento que el BACKEND lee en CADA request** para saber si la persona todavía está en el equipo: el claim del token puede estar hasta 1 hora atrasado, este doc nunca.

| Campo | Tipo | Quién lo escribe | Para qué |
|---|---|---|---|
| `uid` | string | **BACKEND** | Repetido como campo aunque esté en el path, para usarlo en queries sin parsear rutas. |
| `email` | string | **BACKEND** | Email del miembro, desnormalizado para la lista del panel sin leer `usuarios/{uid}`. |
| `nombre` | string (2 a 60) | **BACKEND** | Nombre visible en la lista de miembros y en los items. Copia de `usuarios/{uid}.nombre`, mismo rango. |
| `rol` | string (`'admin'` \| `'miembro'`) | **BACKEND** | Rol en ESTE workspace. Es el rol que manda **para el backend** (el claim manda para las reglas de Firestore). Si no coinciden, para el backend gana este. |
| `agregadoPor` | string (uid) | **BACKEND** | Quién lo invitó. Rastro para el feed de auditoría. |
| `agregadoEn` | timestamp | **BACKEND** | Cuándo entró al equipo (serverTimestamp). |

---

## `workspaces/{wsId}/items/{itemId}`

> **Esta tabla es la más importante del documento.** La columna "Quién lo escribe" es la que se contradijo con las reglas en la v1 y dejó la creación de items rota: el modelo decía que el cliente mandaba `texto` y `cantChunks`, y la regla los prohibía, así que **no se podía crear ni un item**.

**Quién escribe:** el **CLIENTE** crea el documento con estado `'pendiente'` y **solo** con los campos marcados CLIENTE (uno de más y `hasOnly()` rechaza la escritura entera). El **BACKEND nunca crea el item**: solo lo actualiza (`pendiente → procesando → listo | error`) y escribe todos los campos derivados.
**Borrar:** ni el cliente ni el admin desde la app (`allow delete: if false`). Solo el endpoint DELETE, que también borra los chunks.
**Quién lee:** `visibilidad: 'equipo'` → cualquier miembro. `visibilidad: 'privado'` → solo `creadoPor` y el admin. La app lista **siempre con query filtrada, en dos pestañas separadas** (`where visibilidad == 'equipo'` / `where creadoPor == miUid`), porque las reglas no filtran: rechazan la query entera.

| Campo | Tipo | Quién lo escribe | Para qué |
|---|---|---|---|
| `titulo` | string (1 a 140) | **CLIENTE** | Título que ve el usuario y que aparece en la cita de la respuesta. El autor o el admin lo pueden editar después. |
| `tipo` | string (`'nota'` \| `'pdf'` \| `'link'` \| `'foto'`) | **CLIENTE** | De dónde salió el contenido. Define qué pipeline usa el backend y qué otros campos son obligatorios. No se puede cambiar después. |
| `visibilidad` | string (`'equipo'` \| `'privado'`) | **CLIENTE** | Quién lo puede leer. Es el campo que hace la diferencia de rol del requisito 2. El autor o el admin lo pueden cambiar después. |
| `workspaceId` | string | **CLIENTE** | Mismo wsId que el del path; la regla exige que coincidan. Se guarda como campo para que el backend valide pertenencia sin parsear rutas. |
| `creadoPor` | string (uid) | **CLIENTE** | Autor. La regla exige que sea igual a `request.auth.uid`: nadie firma un item con el uid de otro. Lo usa la regla de 'privado' y el feed de eventos. |
| `creadoEn` | timestamp (obligatoriamente `FieldValue.serverTimestamp()`) | **CLIENTE** | Alta del item. La regla exige `request.time`, así que el reloj del celular no sirve. Orden por defecto de la lista: `creadoEn desc`. |
| `estado` | string (`'pendiente'` \| `'procesando'` \| `'listo'` \| `'error'`) | **CLIENTE solo al crear** (siempre `'pendiente'`) → después **BACKEND** | Ciclo de vida del procesamiento. Es lo que pinta el chip de color. El cliente nunca lo vuelve a tocar: `edicionDeItemValida()` no lo incluye. |
| `url` | string (≤ 2000) — solo si `tipo == 'link'` | **CLIENTE** | La dirección original del link. **Se llama `url` en las tres piezas** (en la v1 las reglas lo llamaban `fuenteUrl` y no se podía crear ni un link). El backend la valida contra SSRF antes de hacer fetch y la vuelve a leer del doc en cada reproceso. |
| `nombreArchivo` | string (≤ 200) \| ausente | **CLIENTE** | Nombre del archivo subido (pdf o foto), para que el usuario reconozca de dónde vino. El archivo NO se guarda en ningún lado: Storage está descartado. |
| `textoOriginal` | string (1 a 50.000) — solo si `tipo == 'nota'` | **CLIENTE** | **El contenido que escribió la persona.** Es el campo que hace que el tipo 'nota' exista. El autor lo puede editar y después tocar Reprocesar. |
| `texto` | string (≤ 300.000) | **BACKEND** | El texto **extraído** y normalizado: lo que se trocea en chunks y lo que se le manda a la IA. Para una nota sale de `textoOriginal`; para pdf/foto del OCR; para link del fetch. El cliente NUNCA lo escribe: si pudiera, plantaría fuentes falsas en el índice. |
| `cantChunks` | number | **BACKEND** | Cuántos chunks generó. 0 mientras no está listo. Permite verificar que el indexado no quedó a medias. |
| `paginas` | number \| null | **BACKEND** | Cantidad de páginas del PDF. null para nota, link y foto. |
| `origen` | string (`'nota'` \| `'pdf-texto'` \| `'ocr-space'` \| `'link'`) | **BACKEND** | Cómo se extrajo el texto. El panel muestra "extraído por OCR" y ayuda a explicar respuestas malas. Se guarda en el item Y en cada chunk. |
| `caracteres` | number | **BACKEND** | Largo REAL del texto extraído, antes de cualquier recorte. Sirve para explicar por qué un PDF escaneado dio 40 caracteres de basura. |
| `recortado` | boolean | **BACKEND** | true si el texto superaba los 300.000 caracteres y hubo que recortarlo para no chocar con el límite de 1 MiB por documento. El panel avisa "documento muy largo, se indexó la primera parte". |
| `errorMsg` | string \| null | **BACKEND** | Mensaje legible del fallo cuando `estado == 'error'` (ej: "El PDF está protegido con clave"). Es el MISMO texto que devolvió el HTTP, escrito a mano por nosotros: nunca un `err.message` crudo. |
| `actualizadoEn` | timestamp | **BACKEND** en cada cambio de estado / **CLIENTE** al editar (serverTimestamp obligatorio) | Último cambio. Es lo que usa el barrido para detectar items colgados en 'procesando' hace más de 5 minutos. Como la regla exige `request.time`, el cliente solo puede escribir AHORA, nunca una hora vieja. |

---

## `chunks/{chunkId}` — colección PLANA (top-level), `chunkId = itemId_idx`

**Quién escribe:** solo el **BACKEND** con Admin SDK. En las reglas: `allow read, write: if false`, cerrada para todos los clientes sin excepción.
**Quién lee:** solo el backend. NADIE la lee desde el cliente: ni el admin, ni el autor. Es plana y no anidada para poder hacer una sola query por `workspaceId` sin recorrer subcolecciones.

| Campo | Tipo | Quién lo escribe | Para qué |
|---|---|---|---|
| `workspaceId` | string | **BACKEND** | Filtro obligatorio de TODA búsqueda. Es lo que impide que un workspace vea el conocimiento de otro. |
| `itemId` | string | **BACKEND** | Item del que salió. Sirve para borrar en lote, para armar la cita y, sobre todo, para el filtro de privacidad: solo pasan los chunks cuyo `itemId` esté en el conjunto de items visibles para el que pregunta. |
| `visibilidad` | string (`'equipo'` \| `'privado'`) | **BACKEND** | **COPIA de la visibilidad del item al momento de indexar.** Es la SEGUNDA cerradura del RAG (defensa en profundidad), nunca la principal: **puede quedar vieja hasta el próximo reproceso**. Como se aplica con AND junto al conjunto leído en vivo, una copia vieja solo puede esconder de más, nunca mostrar de más. |
| `creadoPor` | string (uid) | **BACKEND** | **COPIA del autor del item**, misma lógica que `visibilidad`: defensa en profundidad, puede quedar vieja hasta el próximo reproceso. Permite descartar un chunk sin ir a buscar el item, y deja el filtro escrito también en el dato, no solo en un `if`. |
| `titulo` | string | **BACKEND** | Título del item, desnormalizado, para citar la fuente sin leer el item. |
| `idx` | number (0..n-1) | **BACKEND** | Posición del trozo dentro del item. Junto al `itemId` forma el id del documento, y por eso reindexar pisa los mismos docs. |
| `pagina` | number \| null | **BACKEND** | Página del PDF de la que salió, para citar "pág. 3". null en notas y links. |
| `origen` | string (`'nota'` \| `'pdf-texto'` \| `'ocr-space'` \| `'link'`) | **BACKEND** | Cómo se extrajo ese trozo. Ayuda a explicar respuestas malas (el OCR ensucia). |
| `texto` | string (~1500 caracteres) | **BACKEND** | El trozo que se le manda a la IA como contexto y del que sale el fragmento citado. |
| `embedding` | array de 1024 number (floats) | **BACKEND** | Vector del trozo. Se compara por similitud coseno contra el vector de la pregunta. Tiene `fieldOverride` con `indexes: []` o cada chunk generaría 1024 entradas de índice. |
| `creadoEn` | timestamp | **BACKEND** | Cuándo se indexó. Sirve para limpiar huérfanos viejos si alguna vez quedan. |

---

## `workspaces/{wsId}/respuestas/{respId}`

**Quién escribe:** el **CLIENTE** crea el documento con **exactamente cuatro campos**: `pregunta`, `autorUid`, `estado: 'buscando'` y `creadoEn`. Después hace `POST /preguntar` con ese `respId`. Todo lo demás lo escribe el **BACKEND**.
**Quién lee:** solo `autorUid` y el admin del workspace. Motivo: una respuesta puede citar fragmentos de items 'privado' del que preguntó, así que no se comparte con el equipo.
**Ojo:** esta colección **NO tiene campo `workspaceId`**. El wsId va únicamente en el path. Ver el invariante 4.

| Campo | Tipo | Quién lo escribe | Para qué |
|---|---|---|---|
| `pregunta` | string (3 a 500) | **CLIENTE** | La pregunta en lenguaje natural, tal cual la escribió el usuario. El backend usa SIEMPRE la del documento, no la del body. |
| `autorUid` | string (uid) | **CLIENTE** | Quién preguntó. Define los permisos de lectura y, sobre todo, limita la búsqueda a los items que ESE usuario puede ver. |
| `estado` | string (`'buscando'` \| `'redactando'` \| `'listo'` \| `'error'`) | **CLIENTE solo al crear** (`'buscando'`) → después **BACKEND** | Ciclo de vida de la respuesta. Es lo que hace que la pantalla muestre progreso en tiempo real. |
| `creadoEn` | timestamp (serverTimestamp obligatorio) | **CLIENTE** | Cuándo se preguntó. Orden del historial. |
| `respuesta` | string (aparece recién cuando el backend la escribe) | **BACKEND** | Texto final redactado por la IA, con marcas `[1] [2]` que apuntan a `fuentes[].n`. Mientras el campo no exista, la pantalla muestra el spinner. |
| `fuentes` | array de map `{n, itemId, titulo, pagina, fragmento, similitud}` | **BACKEND** | Las citas. Es el corazón del producto: cada afirmación se puede abrir y verificar en el item original. Solo entran items que el que preguntó puede ver. |
| `confianza` | string (`'alta'` \| `'media'` \| `'baja'`) | **BACKEND** | Qué tan parecido era el mejor chunk. Es STRING en las tres piezas. El número crudo vive en `fuentes[].similitud` (≥ 0.60 alta, ≥ 0.45 media). |
| `chunksMirados` | number \| null | **BACKEND** | Cuántos chunks tenía el workspace. **`null` cuando quien preguntó no es admin**: decirle a un miembro cuántos hay en total le revela cuánto contenido privado ajeno existe. |
| `chunksVisibles` | number | **BACKEND** | Cuántos de esos chunks quedaron después de filtrar por lo que ESE uid puede ver. Si el admin pregunta lo mismo, este número es más grande: eso es el requisito 2 mostrado con un número. |
| `errorMsg` | string \| null | **BACKEND** | Motivo del fallo cuando `estado == 'error'` (ej: "la IA no respondió a tiempo"). |
| `actualizadoEn` | timestamp | **BACKEND** | Último cambio de estado. Detecta respuestas colgadas. |

---

## `workspaces/{wsId}/eventos/{eventoId}`

**Quién escribe:** solo el **BACKEND**, y solo agrega (append-only): nadie edita ni borra un evento. Como el cliente escribe items directo contra Firestore, el feed cubre lo que pasa POR EL BACKEND (ver limitaciones).
**Quién lee:** SOLO el admin del workspace (la regla exige claim `ws[wsId] == 'admin'`). Un miembro común ni siquiera puede listar la subcolección.

| Campo | Tipo | Quién lo escribe | Para qué |
|---|---|---|---|
| `tipo` | string: `'workspace.creado'` \| `'item.listo'` \| `'item.error'` \| `'item.eliminado'` \| `'miembro.agregado'` \| `'miembro.eliminado'` \| `'rol.cambiado'` \| `'pregunta.hecha'` \| `'plan.cambiado'` \| `'items.purgados'` | **BACKEND** | Qué pasó. Define el ícono y el filtro del feed. TODOS con punto, y la lista es idéntica en el contrato. |
| `actorUid` | string (uid) | **BACKEND** | Quién lo hizo. Sale siempre del token verificado, nunca del body. |
| `resumen` | string | **BACKEND** | Frase corta ya armada para mostrar (ej: "Martín subió Cronograma de mesas de examen"). |
| `itemId` | string \| null | **BACKEND** | Item afectado, si aplica, para que el feed linkee al item. |
| `creadoEn` | timestamp | **BACKEND** | Cuándo pasó (serverTimestamp). El feed ordena por `creadoEn desc`. |

---

## `workspaces/{wsId}/suscripcion/actual` (documento único, id fijo `actual`)

**Quién escribe:** solo el **BACKEND**, desde el webhook de Mercado Pago. (Mercado Pago es OPCIONAL / stretch goal: si no llega a hacerse, el doc igual existe con `plan: 'free'` y `estado: 'sin_plan'`.)
**Quién lee:** SOLO el admin del workspace (claim `ws[wsId] == 'admin'`). Un miembro no ve datos de facturación: es la segunda diferencia de rol de la materia, además de eventos.

| Campo | Tipo | Quién lo escribe | Para qué |
|---|---|---|---|
| `plan` | string (`'free'` \| `'pro'`) | **BACKEND** | Plan contratado. Tiene que coincidir con `workspaces/{wsId}.plan`. |
| `estado` | string — **mismo enum único**: `'sin_plan'` \| `'pendiente'` \| `'activa'` \| `'pausada'` \| `'cancelada'` | **BACKEND** | Estado de la suscripción en Mercado Pago. Es EXACTAMENTE el mismo enum que `workspaces/{wsId}.planStatus`, y los dos valores siempre coinciden. |
| `preapprovalId` | string \| null | **BACKEND** | Id de la suscripción en Mercado Pago. Es la llave para consultarla o cancelarla. **Se llama `preapprovalId`, NO `mpPreapprovalId`**, en el modelo y en el contrato. |
| `montoMensual` | number (ARS) | **BACKEND** | Cuánto se cobra por mes. Se muestra en el panel. |
| `vence` | timestamp \| null | **BACKEND** | Hasta cuándo está paga. Si venció, el backend pasa `planStatus` a `'pausada'` o `'cancelada'` según lo que diga MP. **Se llama `vence`, NO `venceEn`**, en el modelo y en el contrato. |
| `eventosProcesados` | array de string (ids de notificación de MP) | **BACKEND** | Idempotencia: Mercado Pago reenvía el mismo webhook varias veces; si el id ya está en el array, se ignora. |
| `actualizadoEn` | timestamp | **BACKEND** | Último webhook aplicado. |

---

# INVARIANTES

Reglas que siempre se cumplen. Si alguna se rompe, no es un detalle: es un bug.

1. **QUIÉN ESCRIBE QUÉ (la invariante madre).** El CLIENTE escribe `titulo`, `tipo`, `visibilidad`, `workspaceId`, `creadoPor`, `creadoEn`, `estado: 'pendiente'`, `url` (links), `nombreArchivo` (pdf/foto) y `textoOriginal` (notas). TODO lo demás —`texto`, `cantChunks`, `paginas`, `origen`, `caracteres`, `recortado`, `errorMsg` y los estados que siguen a 'pendiente'— lo escribe el BACKEND. Si el modelo y las reglas no dicen exactamente esto, hay un bug.

2. **`textoOriginal` y `texto` son DOS CAMPOS DISTINTOS a propósito y nunca se mezclan.** `textoOriginal` lo escribe la persona y solo existe en las notas; `texto` lo escribe el backend en los cuatro tipos y es lo único que se trocea en chunks. Para una nota, `texto` sale de normalizar `textoOriginal`.

3. **El campo del link se llama `url`** en las reglas, en el modelo, en el ejemplo y en el contrato. No existe `fuenteUrl` en ningún lado.

4. **`workspaceId` está en el path Y como campo SOLO en `items` y en `chunks`, y ahí los dos SIEMPRE coinciden.**
   **En `workspaces/{wsId}/respuestas` el wsId va ÚNICAMENTE en el path: esa colección NO tiene campo `workspaceId` y no hay que agregárselo.**
   Si en un item o en un chunk el path y el campo no coinciden, es un bug de seguridad.

5. **El id de un chunk es SIEMPRE `itemId_idx`** (idx desde 0, sin huecos). Aun así, reindexar SIEMPRE borra primero todos los chunks de ese `itemId` y después escribe: si el intento anterior generó 9 chunks y el nuevo genera 7, no pueden sobrevivir el 8 y el 9 con texto viejo.

6. **Un item `'listo'` cumple `cantChunks >= 1`** y existen exactamente esa cantidad de chunks con ese `itemId`. **Un item `'error'` cumple `errorMsg` no vacío y `cantChunks == 0`.**

7. **El backend NUNCA crea un item ni una respuesta.** Si el id que llega en el POST no existe en Firestore, responde 404. Crear es siempre del cliente; actualizar es siempre del backend.

8. **Cuando el backend pone `estado: 'procesando'` escribe `actualizadoEn` EN LA MISMA transacción.** Sin esa marca de tiempo, el barrido de items colgados no los encuentra y quedan muertos para siempre.

9. **La transición `pendiente → procesando` se hace SIEMPRE adentro de una `db.runTransaction()`:** leer, chequear el estado y escribir 'procesando' es un solo paso atómico. Si entran dos taps seguidos, el segundo se va con **`PROCESO_EN_CURSO` (HTTP 409)** — "Ya lo estamos procesando, esperá unos segundos" — y no se gastan dos veces los créditos de IA.

10. **PRIVACIDAD DEL RAG: dos cerraduras con AND, pero UNA SOLA manda.**
    **(a) La que manda —y la única que da la garantía—:** el conjunto de `itemIds` visibles para ese uid se calcula **en cada pedido**, leyendo los items en vivo con dos queries con `.select()` (`visibilidad == 'equipo'` y `creadoPor == uid`; si es admin, todos). **No existe ninguna caché de ese conjunto entre pedidos**: si la hubiera, un cambio de visibilidad quedaría sin efecto hasta que la caché venciera y el fail-closed dejaría de ser cierto. Dentro de un mismo request sí se puede reusar el conjunto ya calculado; fuera de ese request no sobrevive nada.
    **El fail-closed vale para (a):** si el item no aparece en esa lectura en vivo o no se pudo leer, el chunk se descarta. Nunca al revés.
    **(b) Defensa en profundidad, no garantía:** la copia de `visibilidad` y `creadoPor` que vive en cada chunk es una **foto del item al momento de indexar y PUEDE QUEDAR VIEJA** —si alguien cambia la visibilidad de un item ya indexado, los chunks siguen con el valor anterior **hasta el próximo reproceso**—. Como las dos condiciones se aplican con AND y la que manda es (a), una copia vieja **solo puede esconder de más, nunca mostrar de más**.

11. **Un item sin chunks no puede ser citado, y un chunk sin item no puede ser citado.** Las dos direcciones se cumplen: el DELETE borra primero los chunks y después el item, y el filtro del RAG descarta todo chunk cuyo item no aparezca en la lectura en vivo.

12. **Los tres lugares donde vive el rol dicen siempre lo mismo:** el custom claim `ws[wsId]`, `workspaces/{wsId}/members/{uid}.rol` y `usuarios/{uid}.workspaces[wsId].rol`. Los tres los escribe el mismo endpoint del backend. Si dos no coinciden: para el **BACKEND** manda `members/{uid}`, para las **REGLAS** manda el claim (que puede estar hasta 1 hora atrasado).

13. **El custom claim se RECONSTRUYE ENTERO** desde `usuarios/{uid}.workspaces` adentro de una transacción; nunca se mergea a ciegas contra el claim viejo.

14. **Cada vez que el backend llama a `setCustomUserClaims` también escribe `claimsActualizadoEn`** en `usuarios/{uid}`. Sin eso, el usuario sigue con el rol viejo hasta una hora.

15. **`ownerUid` es admin siempre** y no se lo puede eliminar ni bajar de rol: un workspace nunca queda sin ningún admin.

16. **Nadie lee `chunks` desde el cliente.** Ni el admin, ni el owner, ni para debuggear. Si hace falta mirarlos, se miran desde la consola de Firebase o con un script del backend.

17. **Todos los timestamps los pone el servidor** (`FieldValue.serverTimestamp()`), nunca `Date.now()` ni la hora del celular. La regla lo obliga comparando contra `request.time`.

18. **Las reglas de seguridad NUNCA usan `get(<ruta>)` de documento.** Todo lo que necesitan sale del custom claim. El `resource.data.get('campo','default')` que sí usamos es el método de un mapa: no lee nada y no se factura.

19. **Ningún endpoint confía en un `wsId`, `uid` ni rol que venga en el body:** el uid sale de `verifyIdToken()` y la membresía se confirma leyendo `members/{uid}` en cada request.

20. **Todo lo que devuelve un POST está también en el documento de Firestore**, que es la fuente de verdad de la UI. Las únicas excepciones son `tardoMs` y `chunksBorrados`, que son datos del pedido y no del documento.

21. **Hay UN SOLO enum de estado de plan:** `'sin_plan' | 'pendiente' | 'activa' | 'pausada' | 'cancelada'`, usado igual por `workspaces.planStatus` y por `suscripcion.estado`. Y los nombres de los campos de pago son `vence` (no `venceEn`) y `preapprovalId` (no `mpPreapprovalId`), idénticos en el modelo y en el contrato.

22. **`usuarios.nombre` mide de 2 a 60 caracteres**, ese rango exacto, en el modelo, en el contrato y en la regla (`size() >= 2 && size() <= 60`).

---

# CICLO DE VIDA

## Del ITEM — campo `estado` en `workspaces/{wsId}/items/{itemId}`

| # | Transición | Quién la hace | Qué ve el usuario |
|---|---|---|---|
| 1 | (no existe) → `pendiente` | **CLIENTE** (Flutter), escribiendo directo en Firestore | La fila ya aparece en su lista y en el panel del admin, al instante, con chip gris **"Pendiente"**. Funciona aunque el backend de Render esté dormido. |
| 2 | `pendiente` → `procesando` | **BACKEND**, apenas recibe el POST, adentro de una transacción | Chip amarillo **"Procesando"** con spinner, en tiempo real. |
| 3a | `procesando` → `listo` | **BACKEND**, recién después de borrar los chunks viejos y escribir todos los nuevos | Chip verde **"Listo"**. El item ya puede ser citado en una respuesta. |
| 3b | `procesando` → `error` | **BACKEND**, si falla la extracción, el OCR, el fetch del link o los embeddings | Chip rojo **"Error"** con el motivo abajo y el botón **"Reintentar"**. |
| 3c | `procesando` colgado → `error` | **EL BARRIDO DEL BACKEND** | Igual que 3b, con el mensaje "Se cortó el procesamiento. Tocá Reintentar." |
| 3d | se queda en `pendiente` | nadie (el POST nunca llegó) | El item sigue visible en **"Pendiente"** con el botón "Reintentar". El dato ya está guardado y no costó nada. |
| 4 | `listo` → `procesando` | **BACKEND**, solo por un reproceso EXPLÍCITO | Vuelve al chip amarillo. Nadie más vuelve de 'listo'. |

**Detalles de cada paso**

- **(1)** El cliente escribe SOLO sus campos: `titulo`, `tipo`, `visibilidad`, `workspaceId`, `creadoPor`, `creadoEn`, `estado`, y según el tipo `url` (link), `nombreArchivo` (pdf/foto) o `textoOriginal` (nota). Es lo primero que pasa, antes de hablar con el backend.
- **(2)** El backend lee el item, chequea que el estado sea procesable y escribe `procesando` + `actualizadoEn` **en el mismo paso atómico**. Si entran dos taps a la vez, el segundo lee un 'procesando' reciente y se va con **`PROCESO_EN_CURSO` 409** ("Ya lo estamos procesando, esperá unos segundos"): no se procesa dos veces ni se gastan dos veces los créditos de IA.
- **(3a)** En el mismo update setea `texto`, `cantChunks`, `paginas`, `origen`, `caracteres`, `recortado` y `actualizadoEn`.
- **(3b)** Escribe `errorMsg` legible (el mismo texto que devolvió por HTTP, escrito a mano por nosotros) y deja `cantChunks` en 0.
- **(3c)** Render se reinicia o se corta la conexión a mitad del procesamiento y el item queda en 'procesando' para siempre. Al arrancar el servidor y después **cada 10 minutos**, el backend hace `collectionGroup('items').where('estado','==','procesando').where('actualizadoEn','<', ahora - 5 min)` y los pasa a 'error'. Además `/procesar` y `/reprocesar` aceptan como procesable un item en 'procesando' con más de 5 minutos de quietud, así el botón Reintentar funciona incluso antes del barrido.
- **(4)** Por ejemplo, después de editar el `textoOriginal` de una nota. La app avisa: "editaste la nota: tocá Reprocesar para que la IA la vuelva a leer".

**BORRADO.** El item no se borra desde la app: el cliente tiene `allow delete: if false`.
- Uno por uno: `DELETE /v1/workspaces/:wsId/items/:itemId`, que borra **primero los chunks** en lote y **después el item**, y deja el evento `item.eliminado`. Ese orden importa: si se corta en el medio, nunca quedan chunks sin item.
- Limpieza masiva del admin: `DELETE /v1/workspaces/:wsId/items?estado=pendiente&antesDe=<ISO>`. Borra en lotes de 400 con Admin SDK y escribe **un solo evento agregado** (no uno por item).

**Qué estados acepta cada endpoint**
- `/procesar`: `'pendiente'`, `'error'`, o `'procesando'` con más de 5 minutos. También acepta `'listo'`: volver a subir el archivo de un item ya procesado es legítimo y lo reindexa (los chunks se pisan solos porque su id es determinístico `itemId_idx`).
- `/reprocesar`: `'pendiente'`, `'error'`, `'listo'`, o `'procesando'` con más de 5 minutos, **y además** necesita una fuente de texto en el documento: `textoOriginal` si es nota, `url` si es link, `texto` ya extraído si es pdf o foto. Un pdf/foto sin texto extraíble no se puede reprocesar porque el archivo no se guarda en ningún lado: hay que volver a elegirlo y llamar a `/procesar`. **Ese, y solo ese, es el caso de `ESTADO_INVALIDO`**; el doble tap ya tiene su propio código (`PROCESO_EN_CURSO`).
- Si el que pide no es el autor ni admin: **`NO_SOS_EL_AUTOR` (HTTP 403)** — "Solo el autor o un administrador pueden hacer esto."

## De la RESPUESTA — campo `estado` en `workspaces/{wsId}/respuestas/{respId}`

| # | Transición | Quién la hace | Qué ve el usuario |
|---|---|---|---|
| 1 | (no existe) → `buscando` | **CLIENTE**, creando el doc con exactamente cuatro campos (`pregunta`, `autorUid`, `estado`, `creadoEn`) y recién después haciendo `POST /preguntar` con ese `respId` | La pregunta ya aparece en el hilo con **"Buscando en el conocimiento del equipo..."** |
| 2 | `buscando` → `redactando` | **BACKEND**, cuando ya armó el conjunto de items visibles para ese uid (dos queries con `.select()`, en vivo), descartó todos los chunks que no están en ese conjunto, calculó el embedding de la pregunta y se quedó con los 6 mejores | **"Redactando la respuesta..."** |
| 3a | `redactando` → `listo` | **BACKEND**, escribiendo en un solo update `respuesta`, `fuentes[]`, `confianza`, `chunksMirados` y `chunksVisibles` | La respuesta con las marcas `[1] [2]` clickeables. Si `confianza` es 'baja', `fuentes` puede venir vacío y arriba aparece **"No lo encontré en la base del equipo"**. |
| 3b | `buscando` o `redactando` → `error` | **BACKEND**, si la IA falla o se corta el tiempo. Escribe `errorMsg` | El motivo y un botón **"Volver a preguntar"**, que crea una respuesta NUEVA (no reusa la vieja). |

**En los dos ciclos vale la misma regla: el CLIENTE crea el documento en el primer estado y el BACKEND es el único que lo mueve de ahí en adelante.** Como los clientes escuchan Firestore en tiempo real, nadie hace polling al backend para saber en qué estado va.

---

# EJEMPLO COMPLETO DE UN ITEM

```jsonc
// ============================================================
// (1) LO QUE ESCRIBE EL CLIENTE AL CREAR UNA NOTA
//     ruta: workspaces/ws_est5_berazategui/items/itm_7Bd1nQ
//     Estos son TODOS los campos permitidos: uno de mas y la
//     regla rechaza la escritura entera (hasOnly).
// ============================================================
{
  "titulo": "Pendientes del taller",
  "tipo": "nota",
  "textoOriginal": "Pedir presupuesto de 3 fuentes ATX al proveedor de Quilmes. Reclamar la factura de los cables UTP. El lunes viene el tecnico del torno.",
  "visibilidad": "privado",
  "workspaceId": "ws_est5_berazategui",
  "creadoPor": "uid_valentino_m",
  "creadoEn": "<FieldValue.serverTimestamp()>",
  "estado": "pendiente"
}
// Ojo: NO va 'texto', NO va 'cantChunks', NO va 'actualizadoEn'.
// Ese era exactamente el bug de la version 1.


// ============================================================
// (2) EL MISMO DOCUMENTO DESPUES DE QUE EL BACKEND LO PROCESO.
//     Los campos nuevos los escribio SOLO el backend.
// ============================================================
{
  "titulo": "Pendientes del taller",
  "tipo": "nota",
  "textoOriginal": "Pedir presupuesto de 3 fuentes ATX al proveedor de Quilmes. Reclamar la factura de los cables UTP. El lunes viene el tecnico del torno.",
  "visibilidad": "privado",
  "workspaceId": "ws_est5_berazategui",
  "creadoPor": "uid_valentino_m",
  "creadoEn": "2026-09-14T13:42:05.221Z",
  "estado": "listo",
  "texto": "Pedir presupuesto de 3 fuentes ATX al proveedor de Quilmes. Reclamar la factura de los cables UTP. El lunes viene el tecnico del torno.",
  "cantChunks": 1,
  "paginas": null,
  "origen": "nota",
  "caracteres": 139,
  "recortado": false,
  "errorMsg": null,
  "actualizadoEn": "2026-09-14T13:42:07.480Z"
}


// ============================================================
// (3) UN ITEM PDF DEL EQUIPO, YA LISTO
//     ruta: workspaces/ws_est5_berazategui/items/itm_9K2mQx7pLd
// ============================================================
{
  "titulo": "Cronograma de mesas de examen - Diciembre 2026",
  "tipo": "pdf",
  "nombreArchivo": "mesas-diciembre-2026.pdf",
  "visibilidad": "equipo",
  "workspaceId": "ws_est5_berazategui",
  "creadoPor": "uid_martin_sosa",
  "creadoEn": "2026-09-14T14:05:11.902Z",
  "estado": "listo",
  "texto": "E.E.S.T. N.º 5 \"Ing. Pedro Cerini\" - Berazategui. Mesas de examen - Turno diciembre 2026.\nMatematica (6.º 2.ª): lunes 14/12, 8:00 hs, aula 12. Tribunal: Prof. Gomez, Prof. Ledesma, Prof. Arce.\nSistemas Digitales (6.º 2.ª): miercoles 16/12, 10:00 hs, laboratorio 2. Tribunal: Prof. Bonelli, Prof. Ferreyra, Prof. Gomez.\nLos alumnos deben presentarse 15 minutos antes con DNI y libreta.",
  "cantChunks": 7,
  "paginas": 3,
  "origen": "pdf-texto",
  "caracteres": 18422,
  "recortado": false,
  "errorMsg": null,
  "actualizadoEn": "2026-09-14T14:05:26.804Z"
}
// Un item tipo 'link' es igual pero con "url": "https://...",
// sin nombreArchivo y con "origen": "link".


// ============================================================
// (4) UN CHUNK DE ESE ITEM -> chunks/itm_9K2mQx7pLd_2
//     'visibilidad' y 'creadoPor' son la COPIA que hace de
//     SEGUNDA cerradura del filtro de privacidad. Es una foto
//     del item al indexar: puede quedar vieja hasta el proximo
//     reproceso, y por eso NUNCA es la cerradura que manda.
// ============================================================
{
  "workspaceId": "ws_est5_berazategui",
  "itemId": "itm_9K2mQx7pLd",
  "visibilidad": "equipo",
  "creadoPor": "uid_martin_sosa",
  "titulo": "Cronograma de mesas de examen - Diciembre 2026",
  "idx": 2,
  "pagina": 1,
  "origen": "pdf-texto",
  "texto": "Sistemas Digitales (6.º 2.ª): miercoles 16/12, 10:00 hs, laboratorio 2. Tribunal: Prof. Bonelli, Prof. Ferreyra, Prof. Gomez.",
  "embedding": [0.0142, -0.0871, 0.0339, 0.1104, "... (1024 floats en total)"],
  "creadoEn": "2026-09-14T14:05:25.115Z"
}
```
