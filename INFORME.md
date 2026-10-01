# NeuroDesk AI — Informe de avance (Fase 2)

**Materia:** Programación II · 6º 1ª · **Equipo:** Mattio, Valentino — Ramírez, Martín
**Entrega parcial:** avance de desarrollo · actualizado al 1 de octubre de 2026

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
- ✅ **Backend completo** (`api/src/`): los 13 endpoints con un formato único de
  error, la búsqueda semántica, la respuesta de la IA citando las fuentes y la
  extracción de texto en tres niveles (PDF digital → OCR.space → OCR local). Los
  scripts que usan su misma conexión ya escribieron en la base real.
- ✅ **App Flutter** (`app/lib/`): login, feed en tiempo real, captura de nota, foto
  o PDF, chat con la IA y pantalla para quien todavía no tiene equipo.
  `flutter analyze` no marca ningún problema (Flutter 3.41.6).
- ✅ **Panel web del administrador** (`panel/`): tablas de items y miembros en
  tiempo real y un dashboard con gráficos.

---

## 5. APIs que usamos

| API | Para qué | Estado |
|---|---|---|
| **NVIDIA NIM** | Genera los *embeddings* que indexan cada documento y redacta la respuesta final citando las fuentes | Integrada en el código (`api/src/servicios/nvidia.js`); falta la clave para probarla |
| **OCR.space** | Saca el texto de PDFs escaneados y fotos (25.000 usos gratis por mes) | Integrada (`api/src/servicios/extraer.js`); falta la clave |
| **Firebase** (Auth + Firestore) | Usuarios, roles y la base en tiempo real que comparten la app y el panel | Funcionando |
| **Mercado Pago** | Suscripción mensual del workspace | Opcional — ver sección 7 |

Con NVIDIA y OCR.space ya cumplimos el mínimo de dos APIs externas. Elegimos
NVIDIA porque da acceso gratuito con una cuenta de desarrollador y su API es
compatible con la de OpenAI: cambian la URL y la clave, el código es el mismo. El
modelo que habíamos anotado en la Fase 1 (GLM-5.2) no está en su catálogo, así que
pasamos a `nemotron-3.5-lightning` para el chat y a `nemotron-3-embed-1b` para los
embeddings.

Los nombres de los modelos viven en la configuración (`.env`) y no en el código: si
NVIDIA da uno de baja, se cambia una línea. Además, un script
(`api/scripts/chequear-modelos.js`) avisa si alguno dejó de existir.

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

1. **Claves de NVIDIA y OCR.space.** El flujo de IA está escrito pero todavía no
   corrió contra los servicios reales. Es lo próximo.
2. **Conectar la app y el panel al proyecto.** Falta correr `flutterfire configure`,
   que genera la configuración de Android, y registrar la app web del panel. Para
   entrar con Google desde Android hay que cargar además la huella SHA-1 de cada
   compu.
3. **Desplegar el backend en Render** (gratis), para que el celular le pueda pegar
   desde fuera de la red del colegio.
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
