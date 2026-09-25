# NeuroDesk — HOJA PARA LA CLASE

> Esto es lo que hay que copiar a mano la primera hora. Version de trabajo: puede haber ajustes menores, pero la estructura es esta.

## 1. Arbol de colecciones

```
usuarios/{uid}
workspaces/{wsId}
workspaces/{wsId}/members/{uid}
workspaces/{wsId}/items/{itemId}
chunks/{chunkId}   (COLECCION PLANA top-level; chunkId = itemId_idx)
workspaces/{wsId}/respuestas/{respId}
workspaces/{wsId}/eventos/{eventoId}
workspaces/{wsId}/suscripcion/actual   (documento unico, id fijo 'actual')
```

## 2. Campos por coleccion

> La columna **Quien** es la mas importante: evita el bug de que el cliente intente escribir campos del backend.

### usuarios/{uid}

Escribe: Lo CREA el backend (POST /v1/auth/registro), nunca el cliente: en las reglas figura allow create: if false. El CLIENTE solo puede EDITAR dos campos de su propio documento: 'nombre' y 'workspaceActual'. Todo lo demas es del backend.  ·  Lee: Solo el propio uid (y el backend). Nadie lee el doc de otro, ni siquiera el admin: para ver gente esta la subcoleccion members.

| Campo | Tipo | Quien | Para que |
|---|---|---|---|
| `email` | string | backend | Email de la cuenta. Sale del token verificado, nunca del body. Se muestra en listas y sirve para invitar. |
| `nombre` | string (2 a 80) | backend lo crea / cliente lo puede editar | Nombre visible del usuario. Es uno de los dos unicos campos que el cliente puede tocar. |
| `workspaces` | map (wsId -> map {rol: string, nombre: string}) | backend | Espejo local de a que workspaces pertenece, para dibujar el selector sin queries. ES LA FUENTE DE VERDAD desde la que el backend reconstruye el custom claim completo. |
| `workspaceActual` | string | null | cliente | wsId del workspace abierto, para que la app arranque donde quedo. Puede quedar en null cuando lo sacan del ultimo workspace. |
| `claimsActualizadoEn` | timestamp | backend | Marca que el backend cambio los custom claims. El cliente escucha su propio doc y, cuando este campo cambia, llama a getIdToken(true) para refrescar el token de 1 hora. |
| `creadoEn` | timestamp | backend | Alta de la cuenta (serverTimestamp). Solo informativo y de orden. |

### workspaces/{wsId}

Escribe: Solo el backend. Crear un workspace toca cuatro lugares de una: el doc del workspace, members/{owner}, usuarios/{uid}.workspaces y el custom claim. El cliente tiene create, update y delete cerrados.  ·  Lee: Cualquier miembro del workspace: la regla pide que el token traiga el claim ws[wsId]. Un usuario de otro workspace no lo lee ni lo lista.

| Campo | Tipo | Quien | Para que |
|---|---|---|---|
| `nombre` | string (2 a 40) | backend | Nombre visible del equipo (ej: 'Coordinacion 6to Ano'). En el MVP no se puede renombrar: ver limitaciones. |
| `ownerUid` | string (uid) | backend | Quien lo creo. Es siempre admin y no se lo puede eliminar ni bajar de rol. |
| `plan` | string ('free' | 'pro') | backend | Define los limites (items, miembros, preguntas por dia). |
| `planStatus` | string ('activo' | 'prueba' | 'vencido' | 'cancelado') | backend | Estado de cobro. Si no es activo o prueba, el backend rechaza PROCESAR items nuevos (crear el doc no lo puede frenar: eso lo hace el cliente contra Firestore). |
| `creadoEn` | timestamp | backend | Fecha de creacion (serverTimestamp). |
| `actualizadoEn` | timestamp | backend | Ultima modificacion del workspace. Util para ordenar y para debug. |

### workspaces/{wsId}/members/{uid}

Escribe: Solo el backend (POST, DELETE y PATCH de miembros). El alta, la baja y el cambio de rol los pide un admin, pero el que escribe es el backend, porque tambien tiene que tocar los claims y usuarios/{uid}.  ·  Lee: Cualquier miembro del workspace, para mostrar 'quien subio esto'. ADEMAS es el documento que el BACKEND lee en CADA request para saber si la persona todavia esta en el equipo: el claim del token puede estar hasta 1 hora atrasado, este doc nunca.

| Campo | Tipo | Quien | Para que |
|---|---|---|---|
| `uid` | string | backend | Repetido como campo aunque este en el path, para usarlo en queries sin parsear rutas. |
| `email` | string | backend | Email del miembro, denormalizado para la lista del panel sin leer usuarios/{uid}. |
| `nombre` | string | backend | Nombre visible en la lista de miembros y en los items. |
| `rol` | string ('admin' | 'miembro') | backend | Rol en ESTE workspace. Es el rol que manda para el BACKEND (el claim manda para las reglas de Firestore). Si los dos no coinciden, gana este. |
| `agregadoPor` | string (uid) | backend | Quien lo invito. Rastro para el feed de auditoria. |
| `agregadoEn` | timestamp | backend | Cuando entro al equipo (serverTimestamp). |

### workspaces/{wsId}/items/{itemId}

Escribe: LA COLUMNA 'quien' DE ESTA TABLA ES LA MAS IMPORTANTE DEL PROYECTO: es la que se contradijo con las reglas en la v1 y rompio la creacion de items. El CLIENTE crea el documento con estado 'pendiente' y SOLO con los campos marcados 'cliente'. El BACKEND nunca crea el item: solo lo actualiza (pendiente -> procesando -> listo | error) y escribe todos los campos derivados. Borrar: NI el cliente NI el admin desde la app; solo el endpoint DELETE, que tambien borra los chunks.  ·  Lee: visibilidad 'equipo': cualquier miembro del workspace. visibilidad 'privado': SOLO creadoPor y el admin. La app lista SIEMPRE con query filtrada, en dos pestanas separadas (una con where visibilidad == 'equipo' y otra con where creadoPor == miUid), porque las reglas no filtran: rechazan la query entera.

| Campo | Tipo | Quien | Para que |
|---|---|---|---|
| `titulo` | string (1 a 140) | cliente | Titulo que ve el usuario y que se muestra en la cita de la respuesta. El autor o el admin lo pueden editar despues. |
| `tipo` | string ('nota' | 'pdf' | 'link' | 'foto') | cliente | De donde salio el contenido. Define que pipeline usa el backend y que otros campos son obligatorios. No se puede cambiar despues. |
| `visibilidad` | string ('equipo' | 'privado') | cliente | Quien puede leerlo. Es el campo que hace la diferencia de rol del requisito 2. El autor o el admin lo pueden cambiar despues. |
| `workspaceId` | string | cliente | Mismo wsId que el del path; la regla exige que coincidan. Se guarda como campo para que el backend valide pertenencia sin parsear rutas. |
| `creadoPor` | string (uid) | cliente | Autor. La regla exige que sea igual a request.auth.uid: nadie puede firmar un item con el uid de otro. Lo usa la regla de 'privado' y el feed de eventos. |
| `creadoEn` | timestamp | cliente (obligatoriamente FieldValue.serverTimestamp()) | Alta del item. La regla exige request.time, asi que el reloj del celular no sirve. Orden por defecto de la lista: creadoEn desc. |
| `estado` | string ('pendiente' | 'procesando' | 'listo' | 'error') | cliente SOLO al crear (siempre 'pendiente') / despues backend | Ciclo de vida del procesamiento. Es lo que pinta el chip de color. El cliente nunca lo puede volver a tocar: edicionDeItemValida() no lo incluye. |
| `url` | string (<= 2000) — solo si tipo == 'link' | cliente | La direccion original del link. SE LLAMA 'url' EN LAS TRES PIEZAS (en la v1 las reglas lo llamaban 'fuenteUrl' y no se podia crear ni un link). El backend la valida contra SSRF antes de hacer fetch, y la vuelve a leer del doc en cada reproceso. |
| `nombreArchivo` | string (<= 200) | ausente | cliente | Nombre del archivo subido (pdf o foto), para que el usuario reconozca de donde vino. El archivo NO se guarda en ningun lado: Storage esta descartado. |
| `textoOriginal` | string (1 a 50.000) — solo si tipo == 'nota' | cliente | EL CONTENIDO QUE ESCRIBIO LA PERSONA. Es el campo que hace que el tipo 'nota' exista: en la v1 el cliente no podia escribir texto y el multipart no tenia por donde mandarlo, asi que las notas estaban muertas. El autor lo puede editar y despues tocar Reprocesar. |
| `texto` | string (<= 300.000) | backend | El texto EXTRAIDO y normalizado: lo que se trocea en chunks y lo que se le manda a la IA. Para una nota sale de textoOriginal; para pdf/foto del OCR; para link del fetch. El cliente NUNCA lo escribe: si pudiera, plantaria fuentes falsas en el indice. |
| `cantChunks` | number | backend | Cuantos chunks genero. 0 mientras no esta listo. Permite verificar que el indexado no quedo a medias. |
| `paginas` | number | null | backend | Cantidad de paginas del PDF. null para nota, link y foto. |
| `origen` | string ('nota' | 'pdf-texto' | 'ocr-space' | 'link') | backend | Como se extrajo el texto. El panel muestra 'extraido por OCR' y ayuda a explicar respuestas malas. Se guarda en el item Y en cada chunk. |
| `caracteres` | number | backend | Largo REAL del texto extraido, antes de cualquier recorte. Sirve para explicar por que un PDF escaneado dio 40 caracteres de basura. |
| `recortado` | boolean | backend | true si el texto extraido superaba los 300.000 caracteres y hubo que recortarlo para no chocar con el limite de 1 MiB por documento de Firestore. El panel avisa 'documento muy largo, se indexo la primera parte'. |
| `errorMsg` | string | null | backend | Mensaje legible del fallo cuando estado == 'error' (ej: 'El PDF esta protegido con clave'). Es el MISMO texto que devolvio el HTTP, escrito a mano por nosotros: nunca un err.message crudo. |
| `actualizadoEn` | timestamp | backend en cada cambio de estado / cliente al editar (serverTimestamp obligatorio) | Ultimo cambio. Es lo que usa el barrido para detectar items colgados en 'procesando' hace mas de 5 minutos. Como la regla exige request.time, el cliente solo puede escribir AHORA, nunca una hora vieja. |

### chunks/{chunkId}   (COLECCION PLANA top-level; chunkId = itemId_idx)

Escribe: Solo el backend con Admin SDK. En las reglas: allow read, write: if false, cerrada para todos los clientes sin excepcion.  ·  Lee: Solo el backend. NADIE la lee desde el cliente, ni el admin, ni el autor. Es plana y no anidada para poder hacer una sola query por workspaceId sin recorrer subcolecciones.

| Campo | Tipo | Quien | Para que |
|---|---|---|---|
| `workspaceId` | string | backend | Filtro obligatorio de TODA busqueda. Es lo que impide que un workspace vea el conocimiento de otro. |
| `itemId` | string | backend | Item del que salio. Sirve para borrar en lote, para armar la cita y, sobre todo, para el filtro de privacidad: solo pasan los chunks cuyo itemId este en el conjunto de items visibles para el que pregunta. |
| `visibilidad` | string ('equipo' | 'privado') | backend | COPIA de la visibilidad del item al momento de indexar. Es la SEGUNDA cerradura del RAG (defensa en profundidad): el chunk pasa solo si ademas su itemId esta en el conjunto visible. Las dos condiciones van con AND, asi que si esta copia quedo vieja solo puede esconder de mas, nunca mostrar de mas. |
| `creadoPor` | string (uid) | backend | COPIA del autor del item. Junto con visibilidad permite descartar un chunk sin ir a buscar el item, y deja el filtro escrito tambien en el dato, no solo en un if. |
| `titulo` | string | backend | Titulo del item, denormalizado, para citar la fuente sin leer el item. |
| `idx` | number (0..n-1) | backend | Posicion del trozo dentro del item. Junto al itemId forma el id del documento, y por eso reindexar pisa los mismos docs. |
| `pagina` | number | null | backend | Pagina del PDF de la que salio, para citar 'pag. 3'. null en notas y links. |
| `origen` | string ('nota' | 'pdf-texto' | 'ocr-space' | 'link') | backend | Como se extrajo ese trozo. Ayuda a explicar respuestas malas (el OCR ensucia). |
| `texto` | string (~1500 caracteres) | backend | El trozo que se le manda a la IA como contexto y del que sale el fragmento citado. |
| `embedding` | array de 1024 number (floats) | backend | Vector del trozo. Se compara por similitud coseno contra el vector de la pregunta. Tiene fieldOverride con indexes: [] o cada chunk generaria 1024 entradas de indice. |
| `creadoEn` | timestamp | backend | Cuando se indexo. Sirve para limpiar huerfanos viejos si alguna vez quedan. |

### workspaces/{wsId}/respuestas/{respId}

Escribe: El CLIENTE crea el documento con EXACTAMENTE cuatro campos: pregunta, autorUid, estado 'buscando' y creadoEn. No manda 'respuesta' (en la v1 el modelo decia que mandaba respuesta: '' y la regla lo rechazaba). Despues hace POST /preguntar con ese respId. Todo lo demas lo escribe el BACKEND.  ·  Lee: Solo autorUid y el admin del workspace. Motivo: una respuesta puede citar fragmentos de items 'privado' del que pregunto, asi que no se comparte con el equipo.

| Campo | Tipo | Quien | Para que |
|---|---|---|---|
| `pregunta` | string (3 a 500) | cliente | La pregunta en lenguaje natural, tal cual la escribio el usuario. El backend usa SIEMPRE la del documento, no la del body. |
| `autorUid` | string (uid) | cliente | Quien pregunto. Define los permisos de lectura y, sobre todo, limita la busqueda a los items que ESE usuario puede ver. |
| `estado` | string ('buscando' | 'redactando' | 'listo' | 'error') | cliente solo al crear ('buscando') / despues backend | Ciclo de vida de la respuesta. Es lo que hace que la pantalla muestre progreso en tiempo real. |
| `creadoEn` | timestamp | cliente (serverTimestamp obligatorio) | Cuando se pregunto. Orden del historial. |
| `respuesta` | string (aparece recien cuando el backend la escribe) | backend | Texto final redactado por la IA, con marcas [1] [2] que apuntan a fuentes[].n. Mientras el campo no exista, la pantalla muestra el spinner. |
| `fuentes` | array de map {n, itemId, titulo, pagina, fragmento, similitud} | backend | Las citas. Es el corazon del producto: cada afirmacion se puede abrir y verificar en el item original. Solo entran items que el que pregunto puede ver. |
| `confianza` | string ('alta' | 'media' | 'baja') | backend | Que tan parecido era el mejor chunk. Es STRING en las tres piezas (en la v1 el contrato devolvia un string y el modelo declaraba un number 0..1). El numero crudo vive en fuentes[].similitud. |
| `chunksMirados` | number | backend | Cuantos chunks tenia el workspace. Junto con chunksVisibles hace VISIBLE el filtro de privacidad en la demo. |
| `chunksVisibles` | number | backend | Cuantos de esos chunks quedaron despues de filtrar por lo que ESE uid puede ver. Si el admin pregunta lo mismo, este numero es mas grande: eso es el requisito 2 mostrado con un numero. |
| `errorMsg` | string | null | backend | Motivo del fallo cuando estado == 'error' (ej: 'la IA no respondio a tiempo'). |
| `actualizadoEn` | timestamp | backend | Ultimo cambio de estado. Detecta respuestas colgadas. |

### workspaces/{wsId}/eventos/{eventoId}

Escribe: Solo el backend, y solo agrega (append-only): nadie edita ni borra un evento. Como el cliente escribe items directo contra Firestore, el feed cubre lo que pasa POR EL BACKEND (ver limitaciones).  ·  Lee: SOLO admin del workspace: la regla exige claim ws[wsId] == 'admin'. Un miembro comun ni siquiera puede listar la subcoleccion.

| Campo | Tipo | Quien | Para que |
|---|---|---|---|
| `tipo` | string ('workspace.creado' | 'item.listo' | 'item.error' | 'item.eliminado' | 'miembro.agregado' | 'miembro.eliminado' | 'rol.cambiado' | 'pregunta.hecha' | 'plan.cambiado') | backend | Que paso. Define el icono y el filtro del feed. TODOS con punto, y la lista es identica en el contrato (en la v1 el contrato usaba guion bajo y el modelo puntos, asi que el filtro del panel no encontraba nada). |
| `actorUid` | string (uid) | backend | Quien lo hizo. Sale siempre del token verificado, nunca del body. |
| `resumen` | string | backend | Frase corta ya armada para mostrar (ej: 'Martin subio Cronograma de mesas de examen'). |
| `itemId` | string | null | backend | Item afectado, si aplica, para que el feed linkee al item. |
| `creadoEn` | timestamp | backend | Cuando paso (serverTimestamp). El feed ordena por creadoEn desc. |

### workspaces/{wsId}/suscripcion/actual   (documento unico, id fijo 'actual')

Escribe: Solo el backend, desde el webhook de Mercado Pago. (Mercado Pago es OPCIONAL / stretch goal: si no llega a hacerse, el doc igual existe con plan 'free'.)  ·  Lee: SOLO admin del workspace (claim ws[wsId] == 'admin'). Un miembro no ve datos de facturacion: es la segunda diferencia de rol de la materia, ademas de eventos.

| Campo | Tipo | Quien | Para que |
|---|---|---|---|
| `plan` | string ('free' | 'pro') | backend | Plan contratado. Tiene que coincidir con workspaces/{wsId}.plan. |
| `estado` | string ('activa' | 'pendiente' | 'pausada' | 'cancelada') | backend | Estado de la suscripcion en Mercado Pago. |
| `mpPreapprovalId` | string | null | backend | Id de la suscripcion en Mercado Pago. Es la llave para consultar o cancelar. |
| `montoMensual` | number (ARS) | backend | Cuanto se cobra por mes. Se muestra en el panel. |
| `vence` | timestamp | null | backend | Hasta cuando esta paga. Si vencio, el backend pasa planStatus a 'vencido'. |
| `eventosProcesados` | array de string (ids de notificacion de MP) | backend | Idempotencia: Mercado Pago reenvia el mismo webhook varias veces; si el id ya esta en el array, se ignora. |
| `actualizadoEn` | timestamp | backend | Ultimo webhook aplicado. |

## 3. Invariantes (no romper)

- QUIEN ESCRIBE QUE, LA INVARIANTE MADRE: el cliente escribe titulo, tipo, visibilidad, workspaceId, creadoPor, creadoEn, estado 'pendiente', url (links), nombreArchivo y textoOriginal (notas). TODO lo demas (texto, cantChunks, paginas, origen, caracteres, recortado, errorMsg y los estados que siguen) lo escribe el backend. Si el modelo y las reglas no dicen exactamente esto, hay un bug: es el error que rompio la version 1.
- textoOriginal y texto son DOS CAMPOS DISTINTOS y nunca se mezclan. textoOriginal lo escribe la persona y solo existe en las notas; texto lo escribe el backend en los cuatro tipos y es lo unico que se trocea en chunks. Para una nota, texto sale de normalizar textoOriginal.
- El campo del link se llama 'url' en las reglas, en el modelo, en el ejemplo y en el contrato. No existe 'fuenteUrl' en ningun lado.
- El id de un chunk es SIEMPRE `itemId_idx` (idx desde 0, sin huecos). Aun asi, reindexar SIEMPRE borra primero todos los chunks de ese itemId y despues escribe: si el intento anterior genero 9 chunks y el nuevo genera 7, no pueden sobrevivir el 8 y el 9 con texto viejo.
- Un item 'listo' cumple cantChunks >= 1 y existen exactamente esa cantidad de chunks con ese itemId. Un item 'error' cumple errorMsg no vacio y cantChunks == 0.
- workspaceId esta en el path Y como campo (items, chunks, respuestas) y los dos SIEMPRE coinciden. Si alguna vez no coinciden, es un bug de seguridad, no un detalle.
- El backend NUNCA crea un item ni una respuesta: si el id que llega en el POST no existe en Firestore, responde 404. Crear es siempre del cliente; actualizar es siempre del backend.
- Cuando el backend pone estado 'procesando' escribe actualizadoEn EN LA MISMA transaccion. Sin esa marca de tiempo, el barrido de items colgados no los encuentra y quedan muertos para siempre.
- La transicion pendiente -> procesando se hace SIEMPRE adentro de una db.runTransaction(): leer, chequear el estado y escribir 'procesando' es un solo paso atomico. Dos taps seguidos no pueden procesar el mismo item dos veces.
- PRIVACIDAD DEL RAG, DOS CERRADURAS CON AND: un chunk entra al ranking solo si (a) su itemId esta en el conjunto de items visibles para ese uid, calculado leyendo los items ANTES de rankear, y (b) su copia de visibilidad/creadoPor tambien lo permite. FAIL-CLOSED: si el item no existe o no se pudo leer, el chunk se descarta. Nunca al reves.
- Un item sin chunks no puede ser citado, y un chunk sin item no puede ser citado. Las dos direcciones se cumplen: el DELETE borra primero los chunks y despues el item, y el filtro del RAG descarta todo chunk cuyo item no aparezca.
- Los tres lugares donde vive el rol dicen siempre lo mismo: el custom claim ws[wsId], workspaces/{wsId}/members/{uid}.rol y usuarios/{uid}.workspaces[wsId].rol. Los tres los escribe el mismo endpoint del backend. Si dos no coinciden, para el BACKEND manda members/{uid} y para las REGLAS manda el claim (que puede estar hasta 1 hora atrasado).
- El custom claim se RECONSTRUYE ENTERO desde usuarios/{uid}.workspaces adentro de una transaccion; nunca se mergea a ciegas contra el claim viejo. Asi dos invitaciones simultaneas no se pisan y nadie pierde el acceso en silencio.
- Cada vez que el backend llama a setCustomUserClaims tambien escribe claimsActualizadoEn en usuarios/{uid}. Sin eso, el usuario sigue con el rol viejo hasta una hora.
- ownerUid es admin siempre y no se lo puede eliminar ni bajar de rol: un workspace nunca queda sin ningun admin.
- Nadie lee chunks desde el cliente. Ni el admin, ni el owner, ni para debuggear. Si hace falta mirarlos, se miran desde la consola de Firebase o con un script del backend.
- Todos los timestamps los pone el servidor (FieldValue.serverTimestamp), nunca Date.now() ni la hora del celular. La regla lo obliga comparando contra request.time, asi que el cliente ni siquiera puede escribir una hora vieja.
- Las reglas de seguridad NUNCA usan get(<ruta>) de documento. Todo lo que necesitan sale del custom claim. El resource.data.get('campo','default') que si usamos es el metodo de un mapa: no lee nada y no se factura.
- Ningun endpoint confia en un wsId, uid ni rol que venga en el body: el uid sale de verifyIdToken() y la membresia se confirma leyendo members/{uid}.
- Todo lo que devuelve un POST esta tambien en el documento de Firestore, que es la fuente de verdad de la UI. Las unicas excepciones son tardoMs y chunksBorrados, que son datos del pedido y no del documento.

## 4. Ciclo de vida

CICLO DE VIDA DEL ITEM (campo estado en workspaces/{wsId}/items/{itemId})

1) (no existe) -> "pendiente" — LO HACE EL CLIENTE (Flutter), escribiendo directo en Firestore, con SOLO sus campos: titulo, tipo, visibilidad, workspaceId, creadoPor, creadoEn, estado, y segun el tipo url (link), nombreArchivo (pdf/foto) o textoOriginal (nota). Es lo primero que pasa, antes de hablar con el backend. QUE VE EL USUARIO: la fila ya aparece en su lista y en el panel del admin, al instante, con un chip gris "Pendiente". Funciona aunque el backend de Render este dormido.

2) "pendiente" -> "procesando" — LO HACE EL BACKEND, apenas recibe el POST, ADENTRO DE UNA TRANSACCION: lee el item, chequea que el estado sea procesable y escribe 'procesando' + actualizadoEn en el mismo paso atomico. Si dos taps entran a la vez, el segundo lee 'procesando' reciente y se va con ESTADO_INVALIDO 409: no se procesa dos veces ni se gastan dos veces los creditos de IA. QUE VE EL USUARIO: chip amarillo "Procesando" con spinner, en tiempo real.

3a) "procesando" -> "listo" — LO HACE EL BACKEND, recien despues de haber borrado los chunks viejos y escrito TODOS los nuevos. En el mismo update setea texto, cantChunks, paginas, origen, caracteres, recortado y actualizadoEn. QUE VE EL USUARIO: chip verde "Listo"; el item ya puede ser citado en una respuesta.

3b) "procesando" -> "error" — LO HACE EL BACKEND si falla la extraccion, el OCR, el fetch del link o los embeddings. Escribe errorMsg legible (el mismo texto que devolvio por HTTP, escrito a mano por nosotros) y deja cantChunks en 0. QUE VE EL USUARIO: chip rojo "Error" con el motivo abajo y el boton "Reintentar".

3c) "procesando" COLGADO -> "error" — LO HACE EL BARRIDO DEL BACKEND. Render se reinicia o se corta la conexion a mitad del procesamiento y el item queda en 'procesando' para siempre: el cliente no puede tocar 'estado' y antes ningun endpoint lo aceptaba. Ahora, al arrancar el servidor y despues cada 10 minutos, el backend hace collectionGroup('items').where('estado','==','procesando').where('actualizadoEn','<', ahora - 5 min) y los pasa a 'error' con errorMsg 'Se corto el procesamiento. Toca Reintentar.'. Ademas /procesar y /reprocesar aceptan como procesable un item en 'procesando' con mas de 5 minutos de quietud, asi que el boton Reintentar funciona incluso antes del barrido.

3d) SE QUEDA EN "pendiente" — si el POST nunca llego (sin senal, backend caido, Render dormido). Nadie cambia el estado y no cuesta nada: el dato ya esta guardado. QUE VE EL USUARIO: el item sigue visible en "Pendiente" con el boton "Reintentar".

4) "listo" -> "procesando" — solo por un reproceso EXPLICITO (POST /reprocesar), por ejemplo despues de editar el textoOriginal de una nota. Nadie mas vuelve de 'listo'.

5) BORRADO — el item no se borra desde la app: el cliente tiene allow delete: if false. Lo borra DELETE /v1/workspaces/:wsId/items/:itemId, que borra PRIMERO los chunks en lote y DESPUES el item, y deja el evento 'item.eliminado'. Ese orden importa: si se corta en el medio, nunca quedan chunks sin item.

QUE ESTADOS ACEPTA CADA ENDPOINT
- /procesar: 'pendiente', 'error', o 'procesando' con mas de 5 minutos. NO acepta 'listo' (para reindexar algo que ya esta listo, se usa /reprocesar).
- /reprocesar: 'pendiente', 'error', 'listo', o 'procesando' con mas de 5 minutos, Y ademas necesita una fuente de texto en el documento: textoOriginal si es nota, url si es link, texto ya extraido si es pdf o foto. Un pdf/foto sin texto no se puede reprocesar porque el archivo no se guarda en ningun lado: hay que volver a elegirlo y llamar a /procesar.

CICLO DE VIDA DE LA RESPUESTA (campo estado en workspaces/{wsId}/respuestas/{respId})

1) (no existe) -> "buscando" — LO HACE EL CLIENTE, creando el doc con exactamente cuatro campos (pregunta, autorUid, estado, creadoEn) y recien despues haciendo POST /preguntar con ese respId. QUE VE EL USUARIO: la pregunta ya aparece en el hilo con "Buscando en el conocimiento del equipo...".

2) "buscando" -> "redactando" — LO HACE EL BACKEND, cuando ya armo el conjunto de items visibles para ese uid, descarto todos los chunks que no estan en ese conjunto, calculo el embedding de la pregunta y se quedo con los 6 mejores. QUE VE EL USUARIO: "Redactando la respuesta...".

3a) "redactando" -> "listo" — LO HACE EL BACKEND, escribiendo en un solo update respuesta, fuentes[], confianza, chunksMirados y chunksVisibles. QUE VE EL USUARIO: la respuesta con las marcas [1] [2] clickeables. Si confianza es 'baja', fuentes puede venir vacio y arriba aparece "No lo encontre en la base del equipo".

3b) "buscando" o "redactando" -> "error" — LO HACE EL BACKEND si la IA falla o se corta el tiempo. Escribe errorMsg. QUE VE EL USUARIO: el motivo y un boton "Volver a preguntar", que crea una respuesta NUEVA (no reusa la vieja).

En los dos ciclos vale la misma regla: el CLIENTE crea el documento en el primer estado y el BACKEND es el unico que lo mueve de ahi en adelante. Como los clientes escuchan Firestore en tiempo real, nadie hace polling al backend para saber en que estado va.

## 5. Endpoints (contrato con Martin)

| Metodo | Ruta | Quien llama | Para que | Semana |
|---|---|---|---|---|
| GET | `/salud` | publico (UptimeRobot, la app movil y el panel al arrancar) | Health check y, sobre todo, DESPERTAR a Render (el plan free duerme a los 15 minutos y la primera llamada tarda hasta 60 s). La app lo llama apenas abre, en segundo plano. Ademas informa cuantos items colgados barrio el proceso al arrancar, que sirve para explicar en la demo por que un item volvio de 'procesando' a 'error'. | S1 |
| POST | `/v1/auth/registro` | app movil Flutter y panel web, UNA sola vez, inmediatamente despues de createUserWithEmailAndPassword() o del login con Google | Crear el documento usuarios/{uid}. CAMBIO DE LA V2: es la UNICA forma de crearlo, porque las reglas ahora tienen allow create: if false en usuarios. Antes competian el cliente y el backend y, si ganaba el cliente, el doc quedaba sin claimsActualizadoEn y el listener que refresca el token no se disparaba nunca. El uid y el email salen del TOKEN VERIFICADO, nunca del body. Es idempotente: si ya existe, no pisa nada y devuelve creado:false. Deja el doc con workspaces {}, workspaceActual null y claimsActualizadoEn. IMPORTANTE PARA MARTIN: como el cliente ya no puede crear el doc, si esta llamada falla hay que reintentarla antes de dejar entrar a la app; mientras tanto se muestra "Preparando tu cuenta..." (puede tardar 60 s si Render estaba dormido). | S2 |
| POST | `/v1/workspaces` | app movil o panel web, cualquier usuario ya registrado | Crear el espacio de trabajo y dejar al que lo crea como ADMIN. El backend crea workspaces/{wsId} (ownerUid, plan 'free', planStatus 'activo'), crea workspaces/{wsId}/members/{uid} con rol 'admin' y despues sincroniza los claims con la RUTINA UNICA de la v2: adentro de una db.runTransaction() sobre usuarios/{uid} lee el mapa 'workspaces', le agrega la entrada nueva, lo escribe junto con claimsActualizadoEn, y RECIEN AHI llama a setCustomUserClaims({ ws: mapaReconstruidoEntero }). Nunca se mergea a ciegas contra el claim viejo: si dos admins invitan a la misma persona al mismo tiempo, el merge ciego borraba silenciosamente uno de los dos workspaces. Despues de escribir el claim vuelve a leer el doc y, si no coincide, repite una vez. Por ultimo deja un evento 'workspace.creado'. El wsId lo genera el backend (nanoid de 12). | S2 |
| POST | `/v1/workspaces/:wsId/miembros` | panel web, SOLO admin | Invitar a alguien por EMAIL. El backend busca el usuario con admin.auth().getUserByEmail(): si no existe devuelve USUARIO_NO_REGISTRADO (no hay invitaciones pendientes en el MVP: primero se registra, despues lo invitan). Si existe: crea workspaces/{wsId}/members/{uidInvitado} y corre la MISMA rutina transaccional de claims sobre el doc del INVITADO (reconstruir el mapa entero desde usuarios/{uid}.workspaces, escribir claimsActualizadoEn, setCustomUserClaims con el mapa completo). El invitado esta escuchando su propio doc, ve cambiar claimsActualizadoEn y refresca su token solo. Deja un evento 'miembro.agregado'. | S3 |
| DELETE | `/v1/workspaces/:wsId/miembros/:uid` | panel web, SOLO admin | Sacar a alguien del equipo. Hace cuatro cosas: (1) borra workspaces/{wsId}/members/{uid} — este es el corte REAL, porque todos los endpoints del backend leen ese documento en cada pedido; (2) corre la rutina transaccional de claims sacando la entrada de usuarios/{uid}.workspaces y reconstruyendo el claim completo; (3) llama a admin.auth().revokeRefreshTokens(uid), asi la persona no puede sacar un token nuevo con el claim viejo; (4) deja un evento 'miembro.eliminado'. Los items que esa persona habia cargado NO se borran: quedan en el workspace. No se puede quitar al ownerUid ni quitarse uno mismo siendo el unico admin.

LA VERDAD SOBRE EL CORTE (esto hay que saber decirlo en la defensa, la version 1 del contrato mentia): el acceso al BACKEND se corta AL INSTANTE, porque members/{uid} ya no existe. El acceso DIRECTO A FIRESTORE desde un cliente NO se corta al instante: las reglas leen el custom claim que viaja dentro del ID token ya emitido, y ese token vale hasta 1 hora. revokeRefreshTokens impide sacar uno nuevo, pero no invalida el que la persona ya tiene en la mano. O sea que un ex-miembro puede seguir leyendo los items 'equipo' hasta 60 minutos con un cliente hecho a mano. Es una limitacion conocida del modelo de custom claims y esta escrita en limitaciones_conocidas. | S3 |
| PATCH | `/v1/workspaces/:wsId/miembros/:uid` | panel web, SOLO admin | Cambiar el rol de un miembro (ascender a admin o bajar a miembro). Actualiza members/{uid}.rol y despues corre la misma rutina transaccional de claims (mapa reconstruido entero + claimsActualizadoEn + setCustomUserClaims). Cuando el cambio es una BAJA de admin a miembro, llama tambien a revokeRefreshTokens(uid), por el mismo motivo que el DELETE. Deja un evento 'rol.cambiado'. Es el endpoint que hace visible la diferencia de roles en la demo: se cambia el rol y en el celular de la otra persona la pantalla de eventos aparece o desaparece sola. Mismo aviso de honestidad: el backend aplica el rol nuevo al instante (lo lee de members), pero las reglas de Firestore siguen viendo el rol viejo hasta que venza el token. | S4 |
| POST | `/v1/workspaces/:wsId/items/:itemId/procesar` | app movil Flutter (y el panel web si algun dia sube archivos) | EL ENDPOINT CENTRAL. El item YA EXISTE: el cliente lo creo directo en Firestore con estado 'pendiente' y ya se ve en el panel del admin. Este endpoint solo lo ACTUALIZA; EL BACKEND NUNCA CREA EL ITEM.

PASOS:
1. verifyIdToken(checkRevoked: true).
2. Middleware exigirMiembro: leer workspaces/{wsId}/members/{uid}. Si no existe -> NO_ES_MIEMBRO. Es 1 lectura y es lo unico que corta al instante a alguien recien echado.
3. TRANSACCION (arregla el doble tap, que va a ser el 90% de los errores de la demo): db.runTransaction() -> leer el item; si no existe, ITEM_NO_ENCONTRADO; si item.workspaceId != wsId, NO_ES_MIEMBRO; si el estado NO es procesable, ESTADO_INVALIDO; si lo es, escribir estado 'procesando' + actualizadoEn + errorMsg null EN LA MISMA TRANSACCION. Procesable = 'pendiente', 'error', o 'procesando' con actualizadoEn de mas de 5 minutos (item colgado por un reinicio de Render). Recien despues de que la transaccion termina se empieza a gastar plata en IA.
4. Extraer el texto SEGUN EL TIPO, leyendo el documento (no el body): 'nota' -> el campo textoOriginal del item; 'link' -> el campo url del item, con la validacion anti-SSRF de abajo; 'pdf' -> unpdf y si viene vacio OCR.space; 'foto' -> OCR.space. Si no sale nada util: NO_SE_PUDO_EXTRAER_TEXTO.
5. indexar(itemId) — LA MISMA FUNCION QUE USA /reprocesar: PRIMERO borra en lote todos los chunks where('itemId','==',itemId), y DESPUES trocea en ~1500 caracteres con 200 de solapado, pide embeddings a NVIDIA con input_type 'passage' en lotes de 32, recorta a 1024 dims, renormaliza L2 y escribe chunks/{itemId_idx} con Admin SDK. Cada chunk lleva ademas la COPIA de visibilidad y creadoPor del item (segunda cerradura del filtro de privacidad). Borrar primero es obligatorio: si el intento anterior escribio 9 chunks y este escribe 7, sin el borrado sobrevivirian el 8 y el 9 con texto viejo.
6. Actualizar el item a 'listo' con texto, cantChunks, paginas, origen, caracteres, recortado y actualizadoEn, y escribir el evento 'item.listo'.

Si algo falla EN CUALQUIER PASO, el backend deja el item en 'error' con errorMsg = el mismo mensaje que devuelve por HTTP (texto escrito por nosotros, nunca un err.message), escribe el evento 'item.error' y recien ahi responde el error.

VALIDACION ANTI-SSRF DE LOS LINKS (obligatoria antes de cualquier fetch): solo esquemas http y https; resolver el hostname con dns.lookup y RECHAZAR 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 0.0.0.0/8, ::1 y fc00::/7; seguir como maximo 2 redirects REVALIDANDO cada destino con la misma funcion; timeout de 10 s; cortar la descarga a los 2 MB; y aceptar solo Content-Type text/html o text/plain. Si algo de eso falla: URL_NO_PERMITIDA. Sin esto, cualquier miembro puede hacer que nuestro servidor lea la red interna de Render y guardarse la respuesta como si fuera conocimiento del equipo. | S3 |
| POST | `/v1/workspaces/:wsId/items/:itemId/reprocesar` | app movil y panel web (boton "Reintentar" en los items en 'error' o 'pendiente', y boton "Volver a indexar" despues de editar una nota) | Reintentar SIN volver a subir el archivo, usando lo que ya esta guardado en el documento. Usa exactamente la misma transaccion de estado y la misma funcion indexar(itemId) que /procesar: la unica diferencia es de donde saca el texto y que estados acepta.

De donde saca el texto, segun el tipo: 'nota' -> textoOriginal (por eso funciona editar la nota y volver a indexar); 'link' -> url, con la validacion anti-SSRF completa otra vez (la pagina pudo cambiar); 'pdf' y 'foto' -> el campo texto que ya se habia extraido. Si un pdf o una foto no tienen texto guardado, NO se puede reprocesar: el archivo no se guarda en ningun lado (Storage esta descartado), asi que responde ESTADO_INVALIDO y el cliente manda al usuario a elegir el archivo de nuevo y llamar a /procesar.

Estados que acepta: 'pendiente', 'error', 'listo' y 'procesando' con mas de 5 minutos sin cambios. Acepta 'listo' a proposito, porque es el caso de "edite la nota y quiero que la IA la vuelva a leer". | S4 |
| DELETE | `/v1/workspaces/:wsId/items/:itemId` | app movil y panel web: el AUTOR del item o cualquier admin del workspace | ENDPOINT NUEVO DE LA V2. Borrar de verdad un item, con sus chunks. Antes el cliente borraba el item directo contra Firestore y los chunks quedaban vivos en la coleccion plana /chunks: el texto de una nota privada seguia en la base, sin ningun item al cual preguntarle los permisos, y la IA lo podia seguir citando. La persona creia que lo habia borrado y no lo habia borrado. Ahora las reglas tienen allow delete: if false y el unico camino es este.

Pasos: verifyIdToken -> exigirMiembro leyendo members/{uid} -> leer el item (si no existe, ITEM_NO_ENCONTRADO) -> si el uid no es creadoPor y su rol en members no es 'admin', ACCION_NO_PERMITIDA -> borrar en lotes de 400 todos los chunks where('itemId','==',itemId) -> borrar el item -> escribir el evento 'item.eliminado'.

EL ORDEN IMPORTA: primero los chunks, despues el item. Si el proceso se corta en el medio, quedan chunks de un item que todavia existe (inofensivo, se limpia reintentando) y nunca chunks huerfanos de un item que ya no esta. Ademas, como el filtro del RAG es fail-closed, un chunk cuyo item no aparece se descarta igual. | S4 |
| POST | `/v1/workspaces/:wsId/preguntar` | app movil Flutter y panel web, cualquier miembro | El RAG: responder en lenguaje natural CITANDO LA FUENTE. El CLIENTE crea primero el doc workspaces/{wsId}/respuestas/{respId} con exactamente pregunta, autorUid, estado 'buscando' y creadoEn (asi la pantalla ya muestra la pregunta y el spinner aunque Render este dormido) y recien despues manda el POST con ese respId.

PASOS DEL BACKEND:
1. verifyIdToken + exigirMiembro leyendo members/{uid}.
2. Leer respuestas/{respId}. Si no existe -> RESPUESTA_NO_ENCONTRADA. Si existe pero su autorUid no es el uid del token -> tambien RESPUESTA_NO_ENCONTRADA (a proposito: no confirmamos que exista una consulta ajena).
3. FILTRO DE PRIVACIDAD, ANTES DE RANKEAR NADA (esto es el requisito 2 de la materia y en la v1 colgaba de un solo if): armar el CONJUNTO de itemIds que ESE uid puede ver. Si su rol en members es 'admin', son todos los items del workspace; si es miembro, se arma con dos queries sobre workspaces/{wsId}/items: where('visibilidad','==','equipo') y where('creadoPor','==',uid). Se usa .select() para traer solo los ids.
4. Traer los chunks del workspace (where workspaceId == wsId, cacheados en memoria por wsId) y DESCARTAR todo chunk cuyo itemId NO este en ese conjunto. FAIL-CLOSED, SIEMPRE: si el item no existe, si fue borrado o si la lectura fallo, el chunk se descarta. Nunca "no lo encontre, lo dejo pasar".
5. SEGUNDA CERRADURA (defensa en profundidad): ademas, el chunk tiene que cumplir su propia copia de permisos -> esAdmin // chunk.visibilidad == 'equipo' // chunk.creadoPor == uid. Las dos condiciones van con AND: si la copia quedo vieja solo puede esconder de mas, nunca mostrar de mas.
6. Embeber la pregunta con input_type 'query' (asimetrico, obligatorio), ordenar por similitud coseno, quedarse con los 6 mejores, pasar a estado 'redactando'.
7. Armar el prompt con los fragmentos numerados, pedirle al modelo que responda SOLO con eso y cite [1] [2], y guardar respuesta, fuentes, confianza, chunksMirados, chunksVisibles y estado 'listo'. Evento 'pregunta.hecha'.

Si ningun chunk supera el umbral, NO es un error: responde 200 con confianza 'baja', fuentes [] y el texto "No encontré esto en la base del equipo".

TEST OBLIGATORIO DEL EMULADOR: A sube una nota privada, B pregunta exactamente por su contenido, y fuentes[] tiene que venir vacio. Si ese test pasa, el requisito 2 esta demostrado. | S4 |
| POST | `/v1/workspaces/:wsId/pagos/suscribir` | panel web, SOLO admin — OPCIONAL (stretch goal) | Arrancar la suscripcion mensual en Mercado Pago. El backend crea el preapproval con el access token secreto y devuelve el init_point; el panel abre ese link en una pestaña nueva. EL PLAN NO CAMBIA ACA: aunque Mercado Pago redirija a la back_url diciendo "aprobado", el backend lo ignora; la unica fuente de verdad del plan es el webhook. Hasta la semana 5 responde 501 PAGOS_NO_DISPONIBLE y el panel muestra el boton "Pasar a Pro" deshabilitado con la leyenda "Próximamente". | S6 |
| POST | `/v1/pagos/webhook` | Mercado Pago (servidor a servidor) — OPCIONAL (stretch goal). NUNCA lo llama la app ni el panel. | Unica fuente de verdad del plan. REGLA DE ORO: responde 200 ANTES de procesar nada (res.status(200).json({ok:true,recibido:true}) y recien despues el await del procesamiento), porque si tarda mas de 22 s Mercado Pago lo da por fallido y reintenta hasta 8 veces. Y NO LE CREE AL BODY: del body solo toma data.id y type, y despues consulta la API de Mercado Pago con el access token secreto para saber el estado REAL del preapproval. Antes de eso valida el header x-signature con HMAC SHA256 (ts + id + la clave secreta): si no valida, responde 401 FIRMA_INVALIDA y no hace nada. Es idempotente: guarda cada data.id en suscripcion/actual.eventosProcesados y si ya lo vio, corta. Recien con el estado real actualiza workspaces/{wsId}.plan, planStatus y la subcoleccion suscripcion, y deja un evento 'plan.cambiado'. Si el procesamiento se cae, igual ya respondio 200: el error queda en el log de Render. | S6 |
| POST | `/v1/workspaces/:wsId/pagos/cancelar` | panel web, SOLO admin — OPCIONAL (stretch goal) | Cancelar la suscripcion mensual. El backend llama a la API de Mercado Pago para poner el preapproval en 'cancelled' y marca planStatus 'cancelado' con la fecha hasta la que el equipo conserva el plan pago (no se corta el acceso en el momento: vale hasta que termina el periodo ya pagado). El cambio definitivo a plan 'free' lo hace igual el webhook cuando llega la confirmacion. | S6 |

## 6. Forma unica de error

```json
TODOS los endpoints, sin excepcion, devuelven JSON con la clave "ok". Si algo falla, el cuerpo es SIEMPRE exactamente esta forma (nunca un HTML de error de Express, nunca un string suelto, nunca un stack trace):

{
  "ok": false,
  "codigo": "NO_ES_MIEMBRO",
  "mensaje": "No pertenecés a este espacio de trabajo.",
  "detalle": null
}

Reglas de la forma de error:
- "ok": siempre false en los errores y siempre true en las respuestas exitosas. Martin escribe UNA sola funcion en Flutter/JS: si (!body.ok) mostrar body.mensaje y ramificar por body.codigo.
- "codigo": string en MAYUSCULAS_CON_GUION_BAJO, del catalogo cerrado de abajo. Es lo unico que el codigo del cliente puede usar para decidir (nunca comparar el texto del mensaje).
- "mensaje": texto en castellano, ya listo para mostrarle a la persona en un SnackBar o un toast. No dice "500", no dice "undefined", no nombra a Firestore ni a NVIDIA.
- "detalle": string o null. Informacion tecnica opcional para el log del cliente. REGLA DURA DE LA V2: "detalle" se rellena UNICAMENTE en los errores donde el texto lo escribimos nosotros a mano y sabemos que es seguro (por ejemplo "el PDF pesa 14.2 MB", "la direccion apunta a una IP privada"). En el middleware final de ERROR_INTERNO va HARDCODEADO detalle: null, nunca err.message: un error de firebase-admin o de un fetch trae rutas del servidor, hostnames internos y a veces pedazos de configuracion. El err.stack completo va a console.error de Render y NO viaja al cliente. Y nunca lleva datos de otro usuario ni claves.
- El backend jamas devuelve un error sin envolverlo: hay un middleware final app.use((err, req, res, next) => ...) que atrapa cualquier excepcion y responde ERROR_INTERNO 500 con esta misma forma.
- El 404 de ruta inexistente tambien responde asi, con codigo "RUTA_NO_ENCONTRADA".
- Nunca se devuelve 200 con un error adentro, ni un 500 con "ok": true. El codigo HTTP y el campo ok siempre concuerdan.
```

| Codigo | HTTP | Cuando | Mensaje al usuario |
|---|---|---|---|
| `FALTA_TOKEN` | 401 | No vino el header Authorization, o no arranca con 'Bearer '. | Tenés que iniciar sesión para hacer esto. |
| `TOKEN_INVALIDO` | 401 | verifyIdToken() falla: token vencido (dura 1 hora), firmado por otro proyecto, mal formado, o emitido antes de un revokeRefreshTokens() (por eso verificamos con checkRevoked: true). | Tu sesión venció. Volvé a entrar. |
| `NO_ES_MIEMBRO` | 403 | El token es valido pero (a) el claim ws no tiene el wsId de la ruta, O (b) —chequeo nuevo de la v2— no existe el documento workspaces/{wsId}/members/{uid}. El segundo caso es el que corta AL INSTANTE a alguien recien echado, aunque su token todavia diga que es miembro. Tambien cuando el item o la respuesta pedidos pertenecen a otro workspace. | No pertenecés a este espacio de trabajo. |
| `NO_ES_ADMIN` | 403 | Es miembro del workspace pero members/{uid}.rol dice 'miembro' y el endpoint exige 'admin' (invitar, quitar, cambiar rol, pagos). El rol que manda para el backend es el del documento members, no el del claim. | Solo el administrador del espacio puede hacer esto. |
| `DATOS_INVALIDOS` | 400 | Falta un campo obligatorio del body, viene vacio, con el tipo equivocado o fuera de rango (nombre vacio, email mal escrito, rol distinto de admin/miembro, pregunta de mas de 500 caracteres, nota de mas de 50.000). | Faltan datos o están mal cargados. Revisá el formulario. |
| `URL_NO_PERMITIDA` | 400 | CODIGO NUEVO DE LA V2 (anti-SSRF). El item es tipo 'link' y su campo url no pasa la validacion: esquema distinto de http/https, hostname que resuelve a loopback o a una red privada (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 0.0.0.0/8, ::1, fc00::/7), mas de 2 redirects, un redirect que cae en una de esas direcciones, o un Content-Type que no es text/html ni text/plain. | Esa dirección no se puede leer. Probá con un enlace público que empiece con https:// |
| `RUTA_NO_ENCONTRADA` | 404 | La URL no corresponde a ningun endpoint del contrato (tipico error de tipeo en la ruta durante el desarrollo). | No pudimos completar la acción. Probá de nuevo en un rato. |
| `WORKSPACE_NO_ENCONTRADO` | 404 | El wsId de la ruta no existe en Firestore (o fue borrado mientras la app lo tenia cacheado). | Ese espacio de trabajo ya no existe. |
| `ITEM_NO_ENCONTRADO` | 404 | workspaces/{wsId}/items/{itemId} no existe. Pasa si el cliente mando el POST antes de que termine de escribirse el doc (con persistencia offline puede tardar), o si alguien lo borro. | No encontramos ese contenido. Puede que lo hayan borrado. |
| `RESPUESTA_NO_ENCONTRADA` | 404 | El respId mandado a /preguntar no existe en workspaces/{wsId}/respuestas. TAMBIEN se responde esto cuando el doc existe pero su autorUid es otro: a proposito no confirmamos que exista una consulta ajena. | Se perdió la consulta. Volvé a preguntar. |
| `USUARIO_NO_REGISTRADO` | 404 | Se invita por email a alguien que todavia no tiene cuenta en Firebase Auth (getUserByEmail tira auth/user-not-found). | Esa persona todavía no tiene cuenta en NeuroDesk. Pedile que se registre y volvé a invitarla. |
| `MIEMBRO_NO_ENCONTRADO` | 404 | El uid que se quiere quitar o al que se le quiere cambiar el rol no figura en workspaces/{wsId}/members. | Esa persona ya no está en el equipo. |
| `MIEMBRO_DUPLICADO` | 409 | El email invitado ya figura en members del mismo workspace. | Esa persona ya forma parte del equipo. |
| `ACCION_NO_PERMITIDA` | 409 | La accion es imposible por regla de negocio: quitar al dueño del workspace, quitarse a uno mismo siendo el unico admin, bajarle el rol al owner, o borrar un item del que no se es autor ni admin. | No se puede hacer eso con el dueño del espacio. |
| `ESTADO_INVALIDO` | 409 | El item no esta en un estado que admita la operacion. /procesar acepta 'pendiente', 'error' o 'procesando' con mas de 5 minutos sin cambios (item colgado); rechaza 'listo' y 'procesando' reciente (que es el doble tap, cortado ademas por la transaccion). /reprocesar acepta ademas 'listo', pero necesita una fuente de texto en el documento: textoOriginal si es nota, url si es link, texto ya extraido si es pdf o foto. Un pdf o una foto sin texto no se pueden reprocesar porque el archivo no se guarda en ningun lado. | Ese contenido no está listo para esta acción. Volvé a subir el archivo. |
| `ARCHIVO_FALTANTE` | 400 | El item es de tipo 'pdf' o 'foto' pero el multipart no trae la parte 'archivo'. | No llegó el archivo. Elegilo de nuevo. |
| `ARCHIVO_MUY_GRANDE` | 413 | El archivo supera 10 MB (tope de multer). El cliente ademas valida el tamaño ANTES de subir para no gastar datos del celular. | El archivo no puede pesar más de 10 MB. |
| `TIPO_NO_SOPORTADO` | 415 | El mimetype no es application/pdf, image/jpeg, image/png ni image/webp. | Solo aceptamos PDF, JPG, PNG o WEBP. |
| `NO_SE_PUDO_EXTRAER_TEXTO` | 422 | La cascada unpdf -> OCR.space termino sin texto util: PDF escaneado ilegible, foto borrosa, PDF con contraseña, imagen sin letras, o un link que devolvio una pagina sin texto. (Sacamos tesseract.js: en Render free, con 512 MB y CPU compartida, se come la memoria justo en la demo.) | No pudimos leer el texto de ese archivo. Probá con una foto más nítida o un PDF con texto. |
| `SIN_CREDITOS_IA` | 402 | NVIDIA NIM (o OCR.space) devuelve 402 / quota exceeded: se agotaron los creditos o el cupo mensual gratuito. | Se acabaron los créditos de la IA por este mes. Avisale al administrador. |
| `DEMASIADOS_PEDIDOS` | 429 | El usuario supero el limite del backend (30 pedidos por minuto por uid, 10 por minuto en /preguntar), o NVIDIA devolvio 429 despues de los 3 reintentos con backoff. | Estás yendo muy rápido. Esperá unos segundos y probá de nuevo. |
| `IA_NO_RESPONDE` | 503 | NVIDIA NIM tarda mas de 30 s, corta la conexion o devuelve 5xx. Tambien cuando OCR.space no responde. Se reusa cuando Mercado Pago no contesta. | El servicio de IA no está respondiendo. Probá de nuevo en un minuto. |
| `LIMITE_PLAN` | 403 | El plan free llego a su tope: 3 workspaces por usuario, 5 miembros por workspace o 200 items PROCESADOS por workspace. Ojo: el tope de items se aplica en /procesar, no al crear el doc, porque crear no pasa por el backend (ver limitaciones). | Llegaste al límite del plan gratuito. Pasá al plan Equipo para seguir. |
| `PAGOS_NO_DISPONIBLE` | 501 | Se llamo a un endpoint de Mercado Pago y la integracion todavia no esta implementada (es stretch goal: hasta la semana 5 los tres endpoints responden esto). | Los pagos todavía no están disponibles. |
| `FIRMA_INVALIDA` | 401 | El webhook de Mercado Pago llego con un header x-signature que no valida contra el HMAC calculado con la clave secreta. Es el UNICO caso en que el webhook no responde 200. | No pudimos validar la notificación de pago. |
| `ERROR_INTERNO` | 500 | Cualquier excepcion no prevista, atrapada por el middleware de error final. El stack completo se loguea en Render con console.error y NUNCA se manda al cliente: este error responde SIEMPRE con detalle hardcodeado en null. | Algo salió mal de nuestro lado. Ya lo estamos viendo, probá de nuevo. |
