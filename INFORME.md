# NeuroDesk AI — Informe de avance (Fase 2)

**Materia:** Programación II · 6º 1ª · **Equipo:** Mattio, Valentino — Ramírez, Martín
**Entrega parcial:** avance de desarrollo · actualizado al 29 de octubre de 2026

---

## 1. Qué es NeuroDesk (recordatorio de la Fase 1)

El "segundo cerebro" con IA de un equipo de trabajo. Los miembros capturan notas,
PDFs, links y fotos desde el celular; la IA los organiza e indexa; y después
cualquiera pregunta en lenguaje natural — *"¿dónde estaba el presupuesto de
agosto?"* — y recibe la respuesta **citando de qué documento salió**.

Son dos vistas sobre la misma base de datos: la **app móvil** para el miembro del
equipo, y el **panel web** para el administrador del espacio de trabajo.

---

## 2. El repositorio

| Carpeta | Qué hay |
|---|---|
| `api/` | Backend en Node.js + Express (20 archivos): verificación de sesión, roles, los 13 endpoints, la búsqueda con IA y la extracción de texto. En `api/scripts/` están los scripts que cargaron los datos de prueba. |
| `app/` | App móvil en Flutter (9 archivos): login, feed en tiempo real, captura y chat con la IA. |
| `panel/` | Panel web del administrador: HTML + JavaScript con el SDK de Firebase y Chart.js, sin compilación. |
| `firebase/` | Reglas de seguridad e índices de Firestore: los mismos que están publicados en el proyecto. |
| `MODELO-DATOS.md` y `CONTRATO.md` | El modelo de datos campo por campo (quién escribe cada uno) y el contrato de los 13 endpoints. |

Las claves (la cuenta de servicio de Firebase y las de las APIs) **no están en el
repositorio**: viven en un archivo `.env` local que Git ignora desde el primer commit.

---

## 3. La base de datos en Firebase

Creamos el proyecto **NeuroDesk AI** (`neurodesk-6to`) en el plan gratuito Spark.
La base es **Cloud Firestore** en modo nativo, en la región `southamerica-east1`
(San Pablo), la más cercana a Argentina. En **Authentication** habilitamos el
ingreso con correo y contraseña y con Google.

Para probar todo y mostrar la estructura, el script `api/scripts/seed.js` llena la
base con datos realistas de un curso usando NeuroDesk: 3 usuarios, un espacio de
trabajo y **86 documentos** en total. Todos los ids son fijos, así que se puede
volver a correr sin duplicar nada.

| Colección | Ruta | Qué guarda | Docs |
|---|---|---|---|
| **usuarios** | `usuarios/{uid}` | Perfil de cada persona y a qué espacios de trabajo pertenece | 3 |
| **workspaces** | `workspaces/{wsId}` | El espacio de trabajo del equipo: nombre, dueño y plan | 1 |
| **members** | `workspaces/{wsId}/members/{uid}` | Quién está en el equipo y con qué rol (admin o miembro) | 3 |
| **items** | `workspaces/{wsId}/items/{itemId}` | Cada cosa capturada (nota, PDF, link o foto) con su texto y su estado | 15 |
| **respuestas** | `workspaces/{wsId}/respuestas/{id}` | Las preguntas hechas a la IA y la respuesta con sus fuentes | 3 |
| **eventos** | `workspaces/{wsId}/eventos/{id}` | Registro de actividad para el panel del admin (auditoría) | 20 |
| **suscripcion** | `workspaces/{wsId}/suscripcion/actual` | Estado del plan pago (Mercado Pago) | 1 |
| **chunks** | `chunks/{itemId_idx}` | Fragmentos de texto de cada item con su *embedding*, para la búsqueda de la IA | 40 |

Casi todo cuelga del espacio de trabajo, así las reglas deciden con una sola
condición si alguien es parte del equipo. La excepción es `chunks`, que va aparte
porque solo la usa el backend para buscar: las reglas le niegan el acceso a
cualquier cliente, incluso al administrador.

Las capturas de la consola de Firebase van en el documento de la entrega.

---

## 4. Qué funciona hoy

- ✅ **Firebase andando:** la base está creada con sus 8 colecciones y datos, las
  reglas y los índices están publicados (la consola los compiló sin errores) y
  Authentication tiene 3 cuentas de prueba.
- ✅ **Roles en el token:** cada cuenta tiene su rol guardado como *custom claim*;
  Martín, por ejemplo, figura como miembro del workspace. Las reglas leen el rol de
  ahí, sin gastar una lectura de la base.
- ✅ **Backend probado contra la base real** (`api/src/`): los 11 endpoints del
  contrato que no son de pagos. `npm run probar:api` levanta el servidor, entra
  con las tres cuentas de prueba y recorre 24 casos (autenticación, autoría,
  procesar/reprocesar/borrar, limpieza masiva, preguntar, roles): **24 de 24 OK**,
  también después del cambio a Gemini (29/10).
- ✅ **La IA responde citando la fuente**: a "¿Cuándo es la reunión de padres?"
  contesta *"La reunión de padres de sexto año es el jueves 17 de octubre a las 18
  horas [1]. Se realiza en el aula 4 [1]."* en unos 5 segundos, con confianza alta
  (0.76).
- ✅ **Privacidad demostrada** (el test obligatorio del contrato): Martín pregunta
  por la contraseña que Camila guardó en una nota privada y recibe "No encontré
  esto en la base del equipo"; el admin hace la misma pregunta y sí la ve.
- ✅ **App Flutter conectada** (`app/`): paquete `com.neurodeskai.neurodesk`, login
  con email y con Google, feed en tiempo real, captura de nota, foto o PDF, chat
  con la IA. `flutter analyze` sin problemas y 13 tests OK (Flutter 3.41.6).
- ✅ **Panel web del administrador conectado** (`panel/`): tablas de items y
  miembros en tiempo real y un dashboard con gráficos, contra la base real.
- ✅ **Tests automáticos de las reglas de Firestore**: `npm.cmd run test:rules` las
  prueba contra el emulador de Firebase (con el JDK que trae Android Studio):
  **57 de 57 OK**.
- ✅ **La app con la marca**: el logo oficial ya está en el login, en la pantalla
  de carga y como ícono del launcher, y corregimos los textos de pantalla (tildes,
  ñ y voseo).
- ✅ **Despliegue preparado**: `render.yaml` deja el backend listo para Render; solo
  pide cargar 4 secretos (`FIREBASE_SERVICE_ACCOUNT_B64`, `GEMINI_API_KEY`,
  `GEMINI_API_KEY_RESPALDO`, que es opcional, y `OCR_SPACE_API_KEY`).
- ✅ **Scripts de diagnóstico**: `npm run probar:ia` (Gemini y OCR con el código del
  backend), `npm run calibrar` (umbral de similitud con preguntas de respuesta
  conocida) y `npm run modelos:vivos` (que ningún modelo haya sido dado de baja).

---

## 5. APIs que usamos

| API | Para qué | Estado |
|---|---|---|
| **Google Gemini** (free tier de Google AI Studio) | Genera los *embeddings* que indexan cada documento y redacta la respuesta final citando las fuentes | Funcionando con clave real (`api/src/servicios/ia.js`) |
| **OCR.space** | Saca el texto de PDFs escaneados y fotos (25.000 usos gratis por mes) | Integrada (`api/src/servicios/extraer.js`); falta la clave. Mientras tanto, las **fotos** se leen con el OCR local de respaldo (tesseract.js); los **PDF escaneados** necesitan OCR.space |
| **Firebase** (Auth + Firestore) | Usuarios, roles y la base en tiempo real que comparten la app y el panel | Funcionando |
| **Mercado Pago** | Suscripción mensual del workspace | Opcional — ver sección 7 |

Con Gemini y OCR.space ya cumplimos el mínimo de dos APIs externas.

**Empezamos con NVIDIA NIM.** Lo elegimos porque da acceso gratuito con una cuenta
de desarrollador y su API es compatible con la de OpenAI: cambian la URL y la clave,
el código es el mismo. Para los embeddings usábamos `nemotron-3-embed-1b`, y el
modelo de chat lo elegimos midiendo: probamos ocho modelos gratuitos con la misma
pregunta; varios figuraban en el catálogo pero no estaban habilitados para nuestra
cuenta (404), y GLM y DeepSeek se pasaban del minuto. Quedó `openai/gpt-oss-20b`
como principal (1 a 6 s, en castellano y citando bien), con una cadena de respaldo
(`nemotron-3-super-120b`, `nemotron-3.5-lightning`).

**El 22/10 nos pasamos a Google Gemini.** Preferimos trabajar con **una sola cuenta
y una sola clave de Google**, y el free tier de Gemini alcanza para el proyecto, no
pide tarjeta y está disponible en Argentina. Lo que hay que saber explicar: en el
free tier Google puede usar lo que le mandamos para mejorar sus productos, y por eso
la app tiene **solo datos de prueba**. El servicio quedó en `api/src/servicios/ia.js`
(`nvidia.js` se borró): el chat va por el endpoint de Gemini compatible con OpenAI,
y los embeddings por la API nativa (`batchEmbedContents`), que deja marcar si el
texto es un documento o una pregunta (`RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`) y
pedir vectores de 1024 dimensiones.

**El modelo de chat lo volvimos a elegir midiendo** (29/10, misma pregunta, dos
intentos cada uno):

| Modelo | 1º intento / 2º intento | Quedó como |
|---|---|---|
| `gemini-3.6-flash` | 2,5 s / 3,4 s | Principal |
| `gemini-3.1-flash-lite` | 3,0 s / 8,0 s | Primer respaldo |
| `gemini-3.5-flash-lite` | 6,2 s / 8,4 s | Segundo respaldo |
| `gemini-3.8-flash` | no contestó en 60 s | Afuera |

`gemini-3.8-flash` es el "más inteligente" según Google, pero respondía 503 *high
demand*, y un modelo que no contesta no sirve para la demo. Para los embeddings
usamos `gemini-embedding-001`. Si el principal se cae o lo dan de baja, el backend
pasa solo al siguiente de la cadena; y como los límites del free tier son **por
modelo**, el respaldo también sirve cuando uno se queda sin cupo.

Para arrancar alcanza con `GEMINI_API_KEY` en el `.env`. Opcionalmente,
`GEMINI_API_KEY_RESPALDO` es una clave de **otro proyecto** de Google, porque los
límites también son por proyecto. Los modelos tienen un valor por defecto en el
código y se pueden pisar desde el `.env` sin tocarlo: `GEMINI_MODELO_CHAT`,
`GEMINI_MODELOS_CHAT_RESPALDO` (separados por comas; `ninguno` apaga el respaldo),
`GEMINI_MODELO_EMBED` y `GEMINI_RAZONAMIENTO` (por defecto `low`). Las variables
`NVIDIA_*` ya no existen. `npm run modelos:vivos` avisa si algún modelo dejó de
existir.

---

## 6. Decisiones de arquitectura

- **Sin Storage ni Cloud Functions.** Desde febrero de 2026 los dos exigen tarjeta
  de crédito (plan Blaze). Por eso de cada PDF o foto guardamos solo el texto
  extraído —que es lo único que la IA necesita— y los roles los asigna nuestro
  propio backend con el SDK de administrador.
- **Primero la base, después el archivo.** La app crea el item en Firestore con
  estado `pendiente` y recién después le manda el archivo al backend, que solo lo
  actualiza. Así el item aparece al instante en el panel aunque el servidor
  gratuito esté dormido.
- **Seguridad cerrada por defecto.** Todo está denegado y cada permiso se abre a
  mano. El backend además verifica que quien procesa un item sea su autor y
  bloquea los links que apuntan a direcciones internas.

---

## 7. Dónde estamos trabados / qué falta

1. **Probar la app en un celular real.** En el emulador de Android Studio ya
   compila y anda (Pixel 8, API 36), con el logo oficial y el login. Falta verla
   en un teléfono de verdad, con el login de Google incluido. Cada compu que
   compile tiene que registrar su SHA-1 (ver `app/README.md`, sección 2.4).
2. **Desplegar el backend en Render** (gratis), para que el celular le pueda pegar
   desde fuera de la red del colegio. Hoy corre en la compu. El `render.yaml` ya
   está: falta desplegarlo y cargarle los 4 secretos.
3. **La clave de OCR.space.** Sin ella, las fotos se leen con el OCR local de
   respaldo (tesseract.js), que anda pero es más lento. Los PDF escaneados, en
   cambio, no tienen respaldo: sin OCR.space dan `NO_SE_PUDO_EXTRAER_TEXTO`.
4. **Mercado Pago pasó a ser opcional.** Con dos APIs ya cumplimos la consigna, y la
   suscripción recurrente es lo más caro de construir: la hacemos solo si llegamos
   con tiempo.
5. **Una limitación que sabemos explicar:** si el admin saca a alguien del equipo,
   esa persona puede seguir leyendo hasta una hora, porque su token sigue siendo
   válido. El backend revoca la sesión y vuelve a chequear la membresía, pero la
   lectura directa a la base tarda en cortarse.

### Problemas que ya resolvimos

- **Las piezas del backend no encajaban.** Al levantar el servidor completo por
  primera vez (2/10) descubrimos que `items.js` y `preguntar.js` importaban de una
  carpeta `src/lib/` que no existe, usaban funciones con otros nombres y no
  estaban montadas en `server.js`: cada archivo pasaba `node --check` solo, pero
  juntos no arrancaban. Las reescribimos sobre los módulos reales, sumamos los dos
  endpoints que faltaban (cambio de rol y limpieza masiva) y armamos
  `npm run probar:api` para que no vuelva a pasar sin que nos enteremos.
- **La IA decía "no encontré" teniendo el dato.** El umbral de similitud estaba a
  ojo en 0.35, y con datos reales la respuesta correcta daba entre 0.26 y 0.69:
  4 de 11 preguntas se hubieran quedado sin respuesta. Con `npm run calibrar` lo
  bajamos a 0.20 y recalibramos la confianza (alta ≥ 0.45, media ≥ 0.30). Esos
  números eran del modelo de NVIDIA: al pasar a `gemini-embedding-001` volvimos a
  calibrar (29/10). Las 11 preguntas con respuesta en el seed dieron entre 0.67 y
  0.84 (mediana 0.72) y las 5 sin respuesta entre 0.51 y 0.61, así que los dos
  grupos quedan separados. **Hoy el umbral es 0.64** (confianza alta ≥ 0.72, media
  ≥ 0.66), y acierta el item correcto en 10 de 11 (la otra la contesta un fragmento
  distinto que también es válido).
- **El chat "pensaba en voz alta" en inglés.** Los modelos de razonamiento escribían
  su borrador antes de contestar. Lo apagamos según la familia de cada modelo y
  limpiamos en código lo que se cuele. Con Gemini el razonamiento no se puede apagar
  del todo: lo dejamos en el nivel más bajo (`low`) y la limpieza sigue.
- **La primera clave de Gemini no andaba.** Daba 403 *Your project has been denied
  access* en todos los modelos (lo único que funcionaba era listar los modelos). Se
  resolvió creando el proyecto desde la consola de Google Cloud y sacando claves
  nuevas.
- **Los tests de las reglas no corrían en las compus del colegio.** El emulador de
  Firebase necesita Java 11 o más y está instalado Java 8. Los corrimos con el JDK
  que trae Android Studio (`npm.cmd run test:rules`): 57 de 57 OK.
- **Otros bugs que salieron al probar:** el troceo cortaba sin solapar
  (`Number(undefined) ?? 200` da `NaN`), un error interno podía mandarle al
  cliente texto de la configuración del servidor, y un workspace inexistente
  respondía distinto que uno ajeno (dejaba averiguar qué ids existen).

- **El script de carga no arrancaba.** La versión 14 de `firebase-admin` eliminó la
  forma vieja de importarse y el seed fallaba con *Cannot read properties of
  undefined (reading 'cert')*. Lo migramos a la API modular.
- **Error 403 al publicar las reglas.** Con el proyecto recién creado, la API de
  Firestore tarda unos minutos en activarse. Reintentamos y se publicaron.
- **La CLI de Firebase en las compus del colegio.** PowerShell tiene bloqueada la
  ejecución de scripts, así que la corremos con `npx.cmd`.

---

## 8. Cómo trabajamos

Nos repartimos por área para no pisarnos: **Valentino** lleva el backend, Firebase,
las APIs y la seguridad; **Martín** lleva la app móvil, el panel web y las pruebas.
El tablero del proyecto está en GitHub Projects con las 89 tareas del semestre
cargadas y con responsable asignado.

Antes de escribir una línea de código hicimos una investigación técnica de cada
área y revisamos el plan buscándole los agujeros. Eso nos ahorró, entre otras
cosas, una contradicción entre el modelo y las reglas que habría hecho fallar
**toda** creación de items desde la app el primer día de integración.

El profesor habilita el uso de IA para acelerar el código, y la usamos: pero cada
archivo está comentado en castellano explicando el *por qué* de cada decisión,
porque lo que se evalúa es que entendamos y podamos defender lo que construimos.
