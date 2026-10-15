# NeuroDesk AI — Informe de avance (Fase 2)

**Materia:** Programación II · 6º 1ª · **Equipo:** Mattio, Valentino — Ramírez, Martín
**Entrega parcial:** avance de desarrollo · actualizado al 2 de octubre de 2026

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
  procesar/reprocesar/borrar, limpieza masiva, preguntar, roles): **24 de 24 OK**.
- ✅ **La IA responde citando la fuente**: a "¿Cuándo es la reunión de padres?"
  contesta *"La reunión de padres es el jueves 17 de octubre a las 18 horas. [1]"*
  en unos 3 segundos.
- ✅ **Privacidad demostrada** (el test obligatorio del contrato): Martín pregunta
  por la contraseña que Camila guardó en una nota privada y recibe "No encontré
  esto en la base del equipo"; el admin hace la misma pregunta y sí la ve.
- ✅ **App Flutter conectada** (`app/`): paquete `com.neurodeskai.neurodesk`, login
  con email y con Google, feed en tiempo real, captura de nota, foto o PDF, chat
  con la IA. `flutter analyze` sin problemas y 13 tests OK (Flutter 3.41.6).
- ✅ **Panel web del administrador conectado** (`panel/`): tablas de items y
  miembros en tiempo real y un dashboard con gráficos, contra la base real.
- ✅ **Scripts de diagnóstico**: `npm run probar:ia` (NVIDIA y OCR con el código del
  backend), `npm run calibrar` (umbral de similitud con preguntas de respuesta
  conocida) y `npm run modelos:vivos` (que ningún modelo haya sido dado de baja).

---

## 5. APIs que usamos

| API | Para qué | Estado |
|---|---|---|
| **NVIDIA NIM** | Genera los *embeddings* que indexan cada documento y redacta la respuesta final citando las fuentes | Funcionando con clave real (`api/src/servicios/nvidia.js`) |
| **OCR.space** | Saca el texto de PDFs escaneados y fotos (25.000 usos gratis por mes) | Integrada (`api/src/servicios/extraer.js`); falta la clave. Mientras tanto anda el OCR local de respaldo (tesseract.js) |
| **Firebase** (Auth + Firestore) | Usuarios, roles y la base en tiempo real que comparten la app y el panel | Funcionando |
| **Mercado Pago** | Suscripción mensual del workspace | Opcional — ver sección 7 |

Con NVIDIA y OCR.space ya cumplimos el mínimo de dos APIs externas. Elegimos
NVIDIA porque da acceso gratuito con una cuenta de desarrollador y su API es
compatible con la de OpenAI: cambian la URL y la clave, el código es el mismo. Para los
embeddings usamos `nemotron-3-embed-1b`.

**El modelo de chat lo elegimos midiendo.** Probamos ocho modelos gratuitos con la
misma pregunta: varios figuran en el catálogo pero no están habilitados para
nuestra cuenta (404), y GLM y DeepSeek se pasaban del minuto. Quedó
`openai/gpt-oss-20b` como principal (1 a 6 s, en castellano y citando bien) y una
**cadena de respaldo** (`nemotron-3-super-120b`, `nemotron-3.5-lightning`): si el
principal se cae o lo dan de baja, el backend pasa solo al siguiente. Si se acaban
los créditos de la cuenta, cambiar de modelo no sirve (son por cuenta): para eso
está la clave de respaldo de otra cuenta.

Los nombres de los modelos viven en la configuración (`.env`: `NVIDIA_MODELO_CHAT`
y `NVIDIA_MODELOS_CHAT_RESPALDO`) y no en el código. `npm run modelos:vivos` avisa
si alguno dejó de existir.

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

1. **Probar la app en un celular.** En las compus del colegio no está el SDK de
   Android, así que la app todavía no se compiló: pasa el análisis y los tests,
   pero falta verla andar en un teléfono (login de Google incluido). Cada compu
   que compile tiene que registrar su SHA-1 (ver `app/README.md`, sección 2.4).
2. **Desplegar el backend en Render** (gratis), para que el celular le pueda pegar
   desde fuera de la red del colegio. Hoy corre en la compu.
3. **La clave de OCR.space.** Sin ella, fotos y PDF escaneados se leen con el OCR
   local de respaldo, que anda pero es más lento.
4. **Pruebas automáticas de las reglas.** El emulador de Firebase necesita Java 11
   o más y en las compus del colegio está instalado Java 8.
5. **Mercado Pago pasó a ser opcional.** Con dos APIs ya cumplimos la consigna, y la
   suscripción recurrente es lo más caro de construir: la hacemos solo si llegamos
   con tiempo.
6. **Una limitación que sabemos explicar:** si el admin saca a alguien del equipo,
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
  bajamos a 0.20 y recalibramos la confianza (alta ≥ 0.45, media ≥ 0.30).
- **El chat "pensaba en voz alta" en inglés.** Los modelos de razonamiento escribían
  su borrador antes de contestar. Lo apagamos según la familia de cada modelo y
  limpiamos en código lo que se cuele.
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
