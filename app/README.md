# NeuroDesk AI — app movil (Flutter)

La app con la que el equipo **captura** conocimiento (notas, fotos, PDF, links) y despues le **pregunta en castellano**, recibiendo una respuesta **que cita la fuente**.

- **Stack:** Flutter 3.41.6 · `StatefulWidget` + `StreamBuilder` + `setState` (SIN gestor de estado) · Firebase Auth + Cloud Firestore.
- **Sin Firebase Storage y sin Cloud Functions:** los dos piden tarjeta de credito. El archivo **no se guarda en ningun lado**: viaja al backend, se le extrae el texto y se descarta.
- Autores: Valentino (backend/Firebase/APIs) y Martin (app/panel/QA).

---

## 1. Que hace cada archivo

| Archivo | Para que |
|---|---|
| `lib/main.dart` | Arranque **blindado** (las 3 capas anti-pantalla-roja) y **la Puerta**: el unico lugar donde se decide login / sin-workspace / home. |
| `lib/tema.dart` | La paleta de la marca, los colores de los 4 estados, y los widgets chicos que se repiten (chip de estado, vacio, error, SnackBar). |
| `lib/servicios/auth_servicio.dart` | Entrar, registrarse, salir, el ID token, y **la vigilancia de `claimsActualizadoEn`** para refrescar el token cuando cambian los permisos. |
| `lib/servicios/api.dart` | El **unico** lugar que habla con el backend. Manda el `Authorization: Bearer <idToken>` y traduce la forma unica de error a castellano. |
| `lib/pantallas/login.dart` | Entrar / crear cuenta, con los errores de Firebase traducidos. |
| `lib/pantallas/home.dart` | El muro de items en tiempo real: 2 pestanas (3 si sos admin), chips de estado y badge de sin-conexion. |
| `lib/pantallas/captura.dart` | Cargar nota / foto / PDF / link. **Crea el item en Firestore y recien despues llama al backend.** |
| `lib/pantallas/chat.dart` | Preguntar y ver la respuesta con su progreso en vivo y sus fuentes citadas. |
| `lib/pantallas/sin_workspace.dart` | "Todavia no perteneces a ningun equipo, pedile a tu admin que te invite". |

---

## 2. Como correrlo (paso a paso)

### 2.1 Requisitos

```bash
flutter --version   # objetivo del proyecto: 3.41.6
flutter doctor      # todo en verde para Android
```

> El `pubspec.yaml` pide **Flutter 3.41 o mas nuevo**, no 3.44 exacto: la maquina de la escuela tiene la 3.41.6 y con un minimo de 3.44 ahi no correria ni `flutter pub get`. El codigo no usa nada posterior a 3.41, asi que compila igual en las dos.
> Las **dependencias si van con la version exacta, sin el `^`**: con el caret, dos computadoras se bajan paquetes distintos y a uno le compila y al otro no, con un error que no esta en nuestro codigo.

### 2.2 Generar las carpetas nativas (`android/`) — una sola vez

En el repositorio estan **solo** el `pubspec.yaml`, el `lib/` y este README: las carpetas `android/`, `ios/`, `build/` y compania las genera Flutter y **no se suben** (son miles de archivos que cambian solos en cada maquina y ensucian los commits).

```bash
cd fase2/app
flutter create --platforms=android --project-name neurodesk .
```

El comando **no pisa** lo que ya existe en `lib/`. Si de paso te crea `test/widget_test.dart`, **borralo**: es el test de ejemplo de Flutter, busca un widget `MyApp` que no existe en este proyecto y hace fallar el `flutter analyze`.

### 2.3 Generar la configuracion de Firebase (esto NO esta en el repo)

`lib/firebase_options.dart` y `android/app/google-services.json` **no se suben al repositorio a proposito**: los genera cada uno en su maquina y traen los ids del proyecto de Firebase.

```bash
dart pub global activate flutterfire_cli
cd fase2/app
flutterfire configure --project=<el-id-del-proyecto-firebase>
```

Ese comando crea los dos archivos. En **Android** alcanza con `google-services.json`, y por eso `main.dart` llama a `Firebase.initializeApp()` sin pasarle opciones.
Para correr en **web o iOS** hay que descomentar en `main.dart` las dos lineas marcadas con `[1]`:

```dart
import 'firebase_options.dart';
// ...
await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
```

En la consola de Firebase hay que tener habilitado **Authentication → Email/Password**.

### 2.4 Instalar las dependencias

```bash
cd fase2/app
flutter pub get
```

### 2.5 Correr

La URL del backend **no esta hardcodeada**: entra por `--dart-define`.

```bash
# Contra el backend local, desde el emulador de Android.
# 10.0.2.2 es como el emulador ve el "localhost" de la computadora:
# 'localhost' adentro del emulador es el emulador mismo.
flutter run --dart-define=API_URL=http://10.0.2.2:8080

# Contra el backend publicado en Render.
flutter run --dart-define=API_URL=https://neurodesk-api.onrender.com

# Compilar el APK para la entrega.
flutter build apk --release --dart-define=API_URL=https://neurodesk-api.onrender.com
```

### 2.6 Los dos permisos de Android que hay que agregar a mano

En `android/app/src/main/AndroidManifest.xml`, arriba de `<application>`:

```xml
<uses-permission android:name="android.permission.INTERNET"/>
```

Y **solo para desarrollo**, si se pega contra `http://10.0.2.2:8080` (sin la `s`), Android bloquea el trafico sin cifrar desde la API 28. En el `<application ...>` del manifest de **debug**:

```xml
android:usesCleartextTraffic="true"
```

> Esa linea **no va en la version release**: contra Render se usa `https://`.

Para iOS habria que agregar `NSCameraUsageDescription` y `NSPhotoLibraryUsageDescription` en el `Info.plist` (la entrega es Android, queda anotado).

---

## 3. Las tres cosas que hay que saber explicar en la defensa oral

### 3.1 El orden de la carga: primero Firestore, despues el backend

```
 [app] crea items/{itemId} con estado 'pendiente'   <-- se ve AL INSTANTE
   |                                                     en el celular y en
   |                                                     el panel del admin
   v
 [app] POST /v1/workspaces/:wsId/items/:itemId/procesar
   |
   v
 [backend] pendiente -> procesando -> listo | error   <-- llega solo por
                                                          .snapshots()
```

**El backend NUNCA crea el item.** Si el POST falla, se corta la luz o no hay senal, el item queda visible en **Pendiente** con su boton *Reintentar*: no se perdio nada y no costo un peso de IA.
Y las reglas usan `hasOnly()`: si la app manda **un campo de mas** (`texto`, `cantChunks`...), se rechaza la escritura **entera**. Por eso `captura.dart` escribe exactamente los campos permitidos, ni uno mas.

### 3.2 El muro son DOS pestanas, no una lista unida

Las reglas de Firestore **no filtran: rechazan**. Si una query puede devolver aunque sea un documento no permitido, falla **la query completa** con `permission-denied`. Un miembro puede ver los items `equipo` **mas** los suyos, asi que pide dos queries separadas:

| Pestana | Query |
|---|---|
| Del equipo | `.where('visibilidad', isEqualTo: 'equipo')` |
| Mis notas | `.where('creadoPor', isEqualTo: miUid)` |
| Todo (solo admin) | sin `where` — su claim ya le da acceso a todo |

Las tres con `.orderBy('creadoEn', descending: true).limit(50)`.

### 3.3 El token dura 1 hora y los permisos no viajan solos

El rol vive en un **custom claim firmado adentro del ID token**, que dura **1 hora**. Si un admin te invita, tu token viejo todavia no tiene ese permiso y Firestore te contesta `permission-denied` aunque ya seas miembro.
Solucion (en `auth_servicio.dart`): el backend escribe `claimsActualizadoEn` en `usuarios/{uid}`; la app **escucha su propio documento** y, cuando ese campo cambia, llama a `getIdToken(true)`.

> Si aparece un `permission-denied` raro, el orden de sospecha es: **1)** token viejo, **2)** falta un `.where()` en la query, **3)** falta el `.limit()`, **4)** recien ahi, la regla.

---

## 4. Reglas de codigo que se respetan en todos los archivos

1. **Nada de gestor de estado.** `StatefulWidget` + `StreamBuilder` + `setState`.
2. **El Stream se crea UNA vez, en `initState`. Nunca adentro de `build()`.** Si se creara en `build()`, cada `setState` armaria un stream nuevo: parpadea la lista y Firestore vuelve a cobrar las lecturas.
3. **Todo `StreamBuilder` y `FutureBuilder` maneja `snapshot.hasError` PRIMERO.** El sintoma de olvidarse esa rama es "la lista aparece vacia" cuando en realidad hubo un `permission-denied`.
4. **Todo `async` va en `try/catch/finally`** con SnackBar en castellano. El `finally` devuelve el boton a su estado normal: sin el, un error deja el boton deshabilitado para siempre.
5. **`context.mounted` (o `mounted`) despues de CADA `await`.** Y si la pantalla se va a cerrar, el `ScaffoldMessenger` y el `Navigator` se agarran **antes** del primer `await` (ver `mostrarAvisoEn` en `tema.dart`).
6. **Cada boton que dispara un pedido se deshabilita mientras dura.** El 90% de los errores `DEMASIADOS_PEDIDOS` de una demo son un doble tap.
7. **Comentarios en castellano y explicando el POR QUE**, no el que.

---

## 5. Limitaciones conocidas (decirlas, no esconderlas)

- **El archivo no se guarda.** Si un PDF o una foto fallan **antes** de que se les extraiga el texto, no se pueden reintentar: hay que volver a elegir el archivo. La app lo dice con esas palabras.
- **El texto de las fotos y de los PDF escaneados se procesa en OCR.space**, un servicio externo, **incluso en los items marcados como privados**. Esta avisado en el login y en la pantalla de captura.
- **Sacar a alguien del equipo corta el backend al instante, pero no la lectura directa a Firestore hasta que vence su token (1 hora).** Es una limitacion conocida del modelo de custom claims.
- **Render (plan gratis) se duerme a los 15 minutos** y el primer pedido tarda hasta 60 segundos. Por eso la app llama a `GET /salud` al arrancar, los timeouts de `/procesar` y `/preguntar` son de 90 s, y un timeout **no se muestra como error**: se muestra "sigue procesando" y el `StreamBuilder` avisa como termino.
- **Borrar un item solo se puede desde el backend** (`DELETE /v1/.../items/:itemId`): las reglas tienen `allow delete: if false` porque borrarlo desde el cliente dejaria vivos sus *chunks* con el texto adentro, y la IA los podria seguir citando.
- **No se crea el workspace desde la app.** Se invita desde el panel web; la app muestra `sin_workspace.dart` hasta que alguien te agregue.

---

## 6. Que probar antes de entregar (checklist de QA — Martin)

- [ ] Crear cuenta nueva → aparece **"Preparando tu cuenta..."** y despues **"Todavia no perteneces a ningun equipo"**.
- [ ] Que el admin invite a esa cuenta desde el panel → **la pantalla se abre sola**, sin cerrar y volver a abrir la app (esa es la vigilancia de claims funcionando).
- [ ] Subir una nota → aparece en **Pendiente** al instante y cambia solo a **Procesando** y a **Listo**.
- [ ] Apagar el backend, subir una nota → queda en **Pendiente** con *Reintentar*. Prender el backend, tocar *Reintentar* → pasa a **Listo**.
- [ ] Modo avion → banda roja de sin conexion y banda amarilla de "lo ultimo guardado en el telefono".
- [ ] Doble tap rapido en *Guardar* y en *Enviar* → **no** se crean dos items ni dos respuestas.
- [ ] Subir un PDF de mas de 10 MB → lo frena la app, sin subir nada.
- [ ] **La prueba del requisito de roles:** A sube una nota **privada**, B pregunta exactamente por su contenido → la respuesta viene **sin fuentes**. Si el admin hace la misma pregunta, el numero de "fragmentos que pude usar" es mas grande.
