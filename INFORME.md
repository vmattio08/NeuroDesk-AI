# NeuroDesk AI — Informe de avance (Fase 2)

**Materia:** Programación II · 6º 1ª · **Equipo:** Mattio, Valentino — Ramírez, Martín
**Entrega parcial:** cierre de trimestre (fecha extendida)

---

## 1. Qué es NeuroDesk (recordatorio de la Fase 1)

El "segundo cerebro" con IA de un equipo de trabajo. Los miembros capturan notas,
PDFs, links y fotos desde el celular; la IA los organiza e indexa; y después
cualquiera pregunta en lenguaje natural — *"¿dónde estaba el presupuesto de
agosto?"* — y recibe la respuesta **citando de qué documento salió**.

Son dos vistas sobre la misma base de datos: la **app móvil** para el miembro del
equipo, y el **panel web** para el administrador del espacio de trabajo.

---

## 2. Qué APIs vamos a usar finalmente

Cambiamos dos de las tres que habíamos anotado en la Fase 1, por razones concretas:

| API | Para qué | Estado |
|---|---|---|
| **NVIDIA NIM** (`integrate.api.nvidia.com`) | El motor de IA: genera los *embeddings* que indexan cada documento, y redacta la respuesta final citando las fuentes | Integrada en el backend (`api/src/servicios/nvidia.js`) |
| **OCR.space** | Sacar el texto de PDFs escaneados y de fotos, para que se puedan buscar | Integrada (`api/src/servicios/extraer.js`), 25.000 usos gratis/mes |
| **Mercado Pago** | Suscripción mensual del espacio de trabajo | Opcional — ver sección 5 |

**Por qué cambiamos de proveedor de IA.** En la Fase 1 habíamos anotado la API de
Claude/OpenAI, pero son pagas y no tenemos tarjeta. Investigamos y encontramos que
**NVIDIA regala acceso** a un catálogo de modelos con una cuenta gratuita de
desarrollador. Como su API es *compatible con la de OpenAI*, el código es
prácticamente el mismo: cambia la URL y la clave.

**Un detalle que casi nos come el proyecto.** Al ir a usarla descubrimos que el
modelo que habíamos elegido (GLM-5.2) no está disponible en ese catálogo. Por eso
ahora los identificadores de los modelos **viven en la configuración (`.env`) y no
dentro del código**: si NVIDIA da de baja uno, cambiamos una línea. Además tenemos
un script (`api/scripts/chequear-modelos.js`) que corre todos los lunes y avisa si
alguno murió.

---

## 3. Decisiones de arquitectura

**El hallazgo más importante de estas semanas:** desde el 3 de febrero de 2026,
**Firebase Storage y Cloud Functions exigen tarjeta de crédito** (plan Blaze). Eso
nos obligó a rediseñar dos cosas antes de escribir código:

- Los archivos originales no se guardan: de cada PDF o foto **guardamos solo el
  texto extraído**, que además es lo único que la IA necesita para responder.
- Lo que normalmente haría una Cloud Function (asignar los roles a cada usuario)
  lo hace **nuestro propio backend** con el SDK de administrador.

**Una decisión que salva la demostración en vivo.** Cuando alguien sube algo desde
el celular, la app **escribe primero en la base de datos** y recién después manda
el archivo al backend. Así la fila aparece al instante en el panel del
administrador aunque el servidor esté dormido (usamos un hosting gratuito que se
suspende por inactividad). Si lo hubiéramos hecho al revés, el momento más
importante de la demostración dependería de que el servidor despierte a tiempo.

**Seguridad.** Las reglas de Firestore están **cerradas desde el primer día**:
todo denegado por defecto, y cada permiso se abre explícitamente. Los roles no se
leen de la base de datos sino del *token firmado* de la sesión, lo que evita cobrar
una lectura por cada verificación. El backend, además, verifica en cada pedido que
quien procesa un item sea su autor o un administrador — sin eso, cualquiera podría
adjuntar su archivo al item de otro.

---

## 4. Qué ya está hecho

**Diseño y documentación**
- ✅ **Reglas de seguridad completas** (`firebase/firestore.rules`) con dos roles
  diferenciados: un miembro no puede leer los items privados de otro, ni el feed
  de auditoría, ni la facturación, ni nada de otro espacio de trabajo. Pasaron una
  revisión cruzada contra el modelo y el contrato.
- ✅ **Modelo de datos cerrado** (`MODELO-DATOS.md`): 8 colecciones, y por cada
  campo está documentado **quién lo escribe** — si el cliente o el backend.
- ✅ **Contrato de endpoints** (`CONTRATO.md`): los 13 endpoints del backend con
  su formato único de error, lo que permite trabajar en paralelo sin bloquearnos.

**Código**
- ✅ **Backend Node/Express completo** (`api/src/`, 20 archivos): autenticación
  con verificación de token, roles por *custom claims*, endpoints de registro,
  espacios de trabajo, miembros, procesamiento de items, y el flujo completo de
  pregunta con IA (búsqueda semántica por similitud de coseno + redacción con
  citas verificadas). Incluye la cascada de extracción de texto en tres niveles
  (PDF digital → OCR.space → OCR local de respaldo). Todo compila.
- ✅ **App Flutter** (`app/lib/`, 9 archivos): login, feed en tiempo real, captura
  de nota/foto/PDF, chat con la IA y pantalla de "sin equipo". Con el arranque
  blindado contra las pantallas rojas de error. `flutter analyze` sin ningún
  problema (Flutter 3.41.6).
- ✅ **Panel web del administrador** (`panel/`): JS puro con el SDK de Firebase,
  tablas de items y miembros en tiempo real, dashboard con gráficos. Sin build:
  se abre el HTML y funciona.
- ✅ **Scripts de datos** (`api/scripts/`): el `seed.js` crea y llena las 8
  colecciones con datos realistas de un colegio para poder probar todo y sacar las
  capturas de Firebase; más `set-admin.js`, `borrar-seed.js` y el chequeo de
  modelos.

---

## 5. Dónde estamos trabados / qué falta

Somos honestos con el estado real:

1. **Falta crear el proyecto de Firebase.** Es el paso que desbloquea todo lo
   demás: correr el seed, publicar las reglas, conectar la app con
   `flutterfire configure` y sacar las capturas. Los pasos están detallados en
   `api/SEED.md`.
2. **Falta obtener las claves de NVIDIA y OCR.space** y probar el flujo de IA con
   datos reales. El código está, pero todavía no corrió contra los servicios.
3. **Falta desplegar el backend** en un hosting gratuito (Render) para que la app
   del celular le pueda pegar desde fuera de la red local.
4. **Mercado Pago pasó a ser opcional.** La consigna pide un mínimo de 2 APIs
   externas y con NVIDIA y OCR.space ya cumplimos. Como la suscripción recurrente
   es la parte más cara de construir, decidimos hacerla **solo si llegamos con
   tiempo**, en vez de arriesgar lo esencial.
5. **Una limitación conocida que sabemos explicar:** cuando el administrador saca
   a alguien del equipo, esa persona puede seguir leyendo hasta una hora, porque
   su token de sesión sigue siendo válido. Lo mitigamos revocando el token e
   incorporando una verificación adicional en el backend, pero la lectura directa
   a la base tarda en cortarse. Es una característica conocida de este modelo de
   permisos y preferimos documentarla antes que negarla.

---

## 6. Cómo trabajamos

Nos repartimos por área para no pisarnos: **Valentino** lleva el backend, Firebase,
las APIs y la seguridad; **Martín** lleva la app móvil, el panel web y las pruebas.
El tablero del proyecto está en GitHub Projects con las 89 tareas del semestre
cargadas y con responsable asignado.

Antes de escribir una línea de código hicimos una investigación técnica de cada
área (está en `FASE2-investigacion.md`) y revisamos el plan buscándole los agujeros.
Eso nos ahorró tres errores que habríamos descubierto recién en octubre — entre
ellos, una contradicción entre el modelo y las reglas que habría hecho fallar
**toda** creación de items desde la app el primer día de integración.

El profesor habilita el uso de IA para acelerar el código, y la usamos: pero cada
archivo está comentado en castellano explicando el *por qué* de cada decisión,
porque lo que se evalúa es que entendamos y podamos defender lo que construimos.
