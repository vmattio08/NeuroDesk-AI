# NeuroDesk AI — app movil (Flutter)

La app con la que el equipo **captura** conocimiento (un texto, fotos, PDF, Word y links, todo junto en una sola carga) y despues le **pregunta en castellano**, recibiendo una respuesta **que cita la fuente**.

- **Stack:** Flutter 3.41.6 · `StatefulWidget` + `StreamBuilder` + `setState` (SIN gestor de estado) · Firebase Auth (email/contrasena y Google) + Cloud Firestore.
- **Dos plataformas con el MISMO codigo:** Android (el APK) y **la web** (se publica en `https://neurodesk-6to.web.app/app/`, ver 2.8).
- **Sin Firebase Storage y sin Cloud Functions:** los dos piden tarjeta de credito. El archivo **no se guarda en ningun lado**: viaja al backend, se le extrae el texto y se descarta.
- Autores: Valentino (backend/Firebase/APIs) y Martin (app/panel/QA).

---

## 1. Que hace cada archivo

| Archivo | Para que |
|---|---|
| `lib/main.dart` | Arranque **blindado** (las 3 capas anti-pantalla-roja) y **la Puerta**: el unico lugar donde se decide login / sin-workspace / home. En la web inicializa Firebase con las opciones de `firebase_web.dart` y deja la persistencia offline apagada (ver 5). Despues del registro, si el servidor sumo a la persona al espacio de bienvenida, pide un token nuevo antes de abrir el muro. |
| `lib/firebase_web.dart` | La configuracion **publica** de la app web de Firebase (la misma de `panel/js/firebase.js`). Solo se usa con `kIsWeb`. No es un secreto (ver 2.3). |
| `lib/tema.dart` | La paleta de la marca, los colores de los 4 estados, el icono y el nombre de cada tipo (`mixto` = «Varios», con icono de capas), `MarcoDeLaApp` (la columna centrada de 720 px en una pantalla ancha) y los widgets chicos que se repiten (chip de estado, vacio, error, SnackBar). |
| `lib/servicios/auth_servicio.dart` | Entrar (email o Google: hoja nativa en Android, **popup** en la web), registrarse, salir, el ID token, la traduccion de errores a castellano y **la vigilancia de `claimsActualizadoEn`** para refrescar el token cuando cambian los permisos. |
| `lib/servicios/api.dart` | El **unico** lugar que habla con el backend. Manda el `Authorization: Bearer <idToken>` y traduce la forma unica de error a castellano. Los archivos viajan como **bytes** (`MultipartFile.fromBytes` con nombre y tipo), no como `File`: asi el mismo codigo anda en la web. |
| `lib/pantallas/login.dart` | Entrar / crear cuenta / **Continuar con Google**, con los errores traducidos. |
| `lib/pantallas/home.dart` | El muro de items en tiempo real: 2 pestanas (3 si sos admin), chips de estado y badge de sin-conexion. La fila de un «Varios» dice cuantas partes tiene. |
| `lib/pantallas/captura.dart` | **La carga universal:** titulo, un texto opcional y *Adjuntar* (camara o galeria, PDF o Word `.docx`, links), todo lo que quieras en una sola carga. La app decide el tipo (ver 3.5). **Crea el item en Firestore y recien despues llama al backend.** |
| `lib/pantallas/chat.dart` | Preguntar y ver la respuesta con su progreso en vivo y sus fuentes citadas (con su parte, si salio de un «Varios»: "PDF «x.pdf» · pág. 3"), con preguntas de seguimiento en la misma conversacion. |
| `lib/pantallas/detalle_item.dart` | "Lo que leyó NeuroDesk": se abre al tocar una fuente o una fila del muro. Muestra como se leyo el item, de quien es y el texto que extrajo el backend (cortado por pagina donde hay marcas `<<<PAGINA:n>>>` y, en un «Varios», separado por partes con las marcas `<<<PARTE:etiqueta>>>`), con la parte citada en cian **en su parte**. Una parte que fallo se avisa en su lugar. |
| `lib/servicios/equipo.dart` | De quien es cada cosa: el nombre de cada autor (members, despues exMiembros con "(ya no está en el equipo)", y si no "Ex integrante") y la linea "de quien, de cuando y con que candado" de cada fuente y de cada fila del muro. |
| `lib/pantallas/sin_workspace.dart` | "Todavia no perteneces a ningun equipo, pedile a tu admin que te invite". |
| `test/widget_test.dart` | Las pruebas de `flutter test`: que la app no muestre la pantalla roja si Firebase falla, la regla del nombre para `/v1/auth/registro`, la traduccion de errores, que sin red y con el token vencido no se cierre la sesion, y que el boton *Documento* distinga PDF de Word. |
| `test/conversacion_test.dart` | Las preguntas de seguimiento: los campos exactos del documento (4 en una primera pregunta, 6 en un seguimiento), de que vuelta se cuelga cada pregunta y cuando se habilita la caja de abajo. |
| `test/candado_y_rol_test.dart` | El candado en vivo (que opcion ofrece el menu de cada fila) y la key de la pantalla principal, que junta el espacio y el rol. |
| `test/detalle_item_test.dart` | "Lo que leyó NeuroDesk": el corte por pagina y en bloques, encontrar la cita, y que la parte en cian quede a la vista en un celular chico. |
| `test/dueno_test.dart` | "Cada dato con dueño": el nombre de cada autor, la linea de cada fuente, las fechas cortas y los textos de una respuesta (miembro, admin y sin fuentes). |
| `test/carga_test.dart` | La carga universal y los «Varios»: que tipo sale segun lo cargado, los topes, los campos exactos del documento, las partes del multipart, el texto separado por partes con la cita en su parte, la etiqueta de la fuente con su parte, la fila del muro, el registro con espacio de bienvenida, el popup de Google y el marco de la web. |
| `analysis_options.yaml` | Activa las reglas de `flutter_lints` para `flutter analyze`. La meta es **0 issues** siempre. |
| `android/` | El proyecto nativo de Android, **versionado a proposito** (ver 2.2): lleva el plugin de Google Services, el `google-services.json` y los permisos. |
| `web/` | La version web (la agrego `flutter create --platforms=web .`). `index.html` con el titulo «NeuroDesk AI» y el fondo azul noche desde el primer cuadro; `favicon.png` es el isotipo oficial **con los mismos bytes** de `marca/png/isotipo-oscuro.png`, y `icons/Icon-*.png` (los del `manifest.json`) son ese mismo PNG achicado a 192 y 512 px, igual que los iconos de Android. |

Los 6 archivos de `test/` suman 180 pruebas (al 12/11) y corren sin celular, sin Firebase y sin internet.

---

## 2. Como correrlo (paso a paso)

### 2.1 Requisitos

```bash
flutter --version   # objetivo del proyecto: 3.41.6
flutter doctor      # todo en verde para Android
```

> El `pubspec.yaml` pide **Flutter 3.41 o mas nuevo**, no 3.44 exacto: la maquina de la escuela tiene la 3.41.6 y con un minimo de 3.44 ahi no correria ni `flutter pub get`. El codigo no usa nada posterior a 3.41, asi que compila igual en las dos.
> Las **dependencias si van con la version exacta, sin el `^`**: con el caret, dos computadoras se bajan paquetes distintos y a uno le compila y al otro no, con un error que no esta en nuestro codigo.

**Para compilar el APK o probar en un celular hace falta el Android SDK** (viene con Android Studio). En una PC sin SDK, como la de la escuela, solo se puede correr `flutter analyze` y `flutter test`: sirven para revisar el codigo, pero "Continuar con Google" solo se puede probar en un celular o en un emulador.

> Si PowerShell tiene los scripts bloqueados (pasa en las PCs de la escuela), usar `flutter.bat`, `dart.bat` y `npx.cmd` en vez de `flutter`, `dart` y `npx`.

### 2.2 La carpeta `android/` YA esta en el repo

Antes la generaba cada uno con `flutter create`. Ahora **se versiona a proposito**, porque lleva cosas que `flutter create` no pone y sin las cuales Firebase no anda:

- el plugin de Gradle `com.google.gms.google-services` en `android/settings.gradle.kts` y `android/app/build.gradle.kts` (lo agrego `flutterfire configure`). Es el que lee el `google-services.json`: sin el, ese archivo no sirve para nada;
- el `android/app/google-services.json` (ver 2.3);
- el paquete `com.neurodeskai.neurodesk`, que es con el que esta registrada la app en Firebase. Si cambia, ni Firebase ni Google reconocen la app;
- los permisos del manifest (ver 2.7).

Lo que Flutter arma solo en cada maquina **sigue sin subirse** (lo ignora `android/.gitignore`): `local.properties` (la ruta del SDK de cada PC), `gradlew`, `gradlew.bat`, `gradle-wrapper.jar`, `.gradle/` y `build/`. Los vuelve a crear `flutter run` / `flutter build`.

**No hace falta correr `flutter create`.** Si alguien lo corre igual, no pisa lo que ya existe. Ojo: `test/widget_test.dart` ahora es **nuestro** (no el test del contador que trae Flutter). No lo borres: si falta, `flutter create` vuelve a poner el test de ejemplo, que busca un `MyApp` que no existe y rompe `flutter analyze`.

### 2.3 Firebase YA esta configurado

| Que | Valor |
|---|---|
| Proyecto | `neurodesk-6to` |
| App Android | paquete `com.neurodeskai.neurodesk` · appId `1:455226002826:android:1b6dec9213b32194d64c73` |
| Authentication → proveedores habilitados | **Email/Password** y **Google** |

`flutterfire configure` ya se corrio una vez y dejo estos archivos:

- **`android/app/google-services.json` → SI va al repo, a proposito.** No es un secreto: viaja adentro de cada APK (cualquiera lo puede sacar de ahi), igual que la config web del panel que ya esta en `panel/js/firebase.js`. Lo que protege los datos no es esconder este archivo, sino las reglas de Firestore, el backend que verifica el ID token en cada pedido y, para Google, la SHA-1 registrada de cada PC (ver 2.4). Subiendolo, el companero clona y compila sin correr `flutterfire configure`.
- **`lib/firebase_options.dart` → NO va al repo** (esta en el `.gitignore` de la raiz) **y no se usa**: en Android, `main.dart` llama a `Firebase.initializeApp()` sin opciones y Firebase lee el `google-services.json`. Solo haria falta para iOS.
- **`lib/firebase_web.dart` → SI va al repo.** En la **web** no hay ningun archivo que Firebase pueda leer solo, asi que `main.dart` (solo con `kIsWeb`) le pasa estas opciones a mano. Son las de la app web del proyecto, **las mismas del panel** (`panel/js/firebase.js`): un mismo proyecto, los mismos usuarios y las mismas reglas. Tampoco son un secreto: viajan adentro de cualquier pagina de Firebase.

- `firebase.json` (en `app/`): el registro de que proyecto y que app eligio `flutterfire`. No es secreto y se versiona.

**El client ID de Google no esta pegado en el codigo:** el paquete `google_sign_in` lo lee solo del `google-services.json` (el `oauth_client` con `client_type: 3`, o sea el "client ID web"). Si algun dia aparece el error `serverClientId must be provided on Android`, hay que volver a bajar el `google-services.json` desde la consola (Configuracion del proyecto → Tus apps → la app Android).

### 2.4 Registrar la SHA-1 de TU PC (obligatorio para "Continuar con Google")

Cada PC firma el APK de debug con **su propia** llave (`debug.keystore`), y Google solo deja entrar a una app si el par **paquete + SHA-1** esta registrado en Firebase. La SHA-1 (y la SHA-256) de la PC donde se corrio `flutterfire configure` ya estan cargadas; **cada PC nueva que compile tiene que cargar la suya, una sola vez**. El login con email anda igual sin esto: lo unico que falla es Google.

> **Sintoma de que falta:** elegis la cuenta de Google y "no pasa nada" (vuelve al login, sin cartel). En el log aparece `[NeuroDesk] Google cancelado: ...`. El paquete no puede distinguir una SHA-1 faltante de una cancelacion de verdad, por eso no mostramos error.

**1) Sacar la SHA-1.** El `debug.keystore` se crea solo la primera vez que compilas algo de Android en esa PC. Con el `keytool` que trae Android Studio (si no esta en el PATH: `C:\Program Files\Android\Android Studio\jbr\bin\keytool.exe`):

```bat
:: En cmd. En PowerShell, cambiar %USERPROFILE% por $env:USERPROFILE
keytool -list -v -keystore "%USERPROFILE%\.android\debug.keystore" -alias androiddebugkey -storepass android -keypass android
```

La contrasena `android` es la de fabrica de TODAS las llaves de debug, no es un secreto. Copia la linea `SHA1:` (y si queres tambien la `SHA256:`). Otra forma, con el SDK instalado y despues de haber compilado una vez: `cd android` y `.\gradlew.bat signingReport`.

**2) Cargarla en Firebase.** Por la consola: Configuracion del proyecto → General → Tus apps → la app Android `com.neurodeskai.neurodesk` → **Agregar huella digital**. O por terminal (con una cuenta que tenga acceso al proyecto):

```bat
npx.cmd firebase-tools@latest login
npx.cmd firebase-tools@latest apps:android:sha:create 1:455226002826:android:1b6dec9213b32194d64c73 <TU_SHA1> --project neurodesk-6to
```

**No hace falta volver a bajar el `google-services.json`** despues de agregar la huella: Google la valida del lado del servidor. Si algun dia se firma el release con otra llave (o se sube a Play Store con Play App Signing), tambien hay que registrar esa SHA-1.

### 2.5 Instalar las dependencias

```bash
cd fase2/app
flutter pub get
```

El `pubspec.lock` esta en el repo: con el, `pub get` baja **exactamente** las mismas versiones en las dos PCs, incluidas las que no aparecen en el `pubspec.yaml` (por ejemplo `google_sign_in_android 7.2.11`; con una version mas nueva de Flutter, sin el lock, pub podria elegir otra).

### 2.6 Correr

La URL del backend **no esta hardcodeada**: entra por `--dart-define`.

```bash
# Contra el backend local, desde el emulador de Android.
# 10.0.2.2 es como el emulador ve el "localhost" de la computadora:
# 'localhost' adentro del emulador es el emulador mismo.
flutter run --dart-define=API_URL=http://10.0.2.2:8080

# Contra el backend publicado en Render.
flutter run --dart-define=API_URL=https://neurodesk-api-u97j.onrender.com

# Compilar el APK para la entrega.
flutter build apk --release --dart-define=API_URL=https://neurodesk-api-u97j.onrender.com
```

### 2.7 Permisos de Android (ya estan puestos en el repo)

- `android/app/src/main/AndroidManifest.xml` tiene, arriba de `<application>`, `<uses-permission android:name="android.permission.INTERNET"/>`. `flutter create` lo deja solo en el manifest de debug: sin esta linea el APK release no podria hablar con Firebase, con Google ni con Render.
- `android/app/src/debug/AndroidManifest.xml` tiene `<application android:usesCleartextTraffic="true"/>`, **solo para desarrollo**: deja pegarle a `http://10.0.2.2:8080` (sin la `s`), que Android bloquea desde la API 28. **No va en release**: contra Render se usa `https://`.
- "Continuar con Google" **no necesita ningun permiso ni tocar Gradle**: el paquete ya trae Credential Manager, y `minSdk` queda en 24 (el de Flutter 3.41, que es justo el que pide `google_sign_in_android`). Lo que si necesita es que el celular tenga **Google Play services** y una cuenta de Google. En el emulador hay que usar una imagen "Google Play" o "Google APIs".

Para iOS habria que agregar `NSCameraUsageDescription` y `NSPhotoLibraryUsageDescription` en el `Info.plist` (la entrega es Android, queda anotado).

### 2.8 La version web

Es **la misma app**, compilada para el navegador. No hace falta el Android SDK.

```bash
# --base-href /app/ porque se publica en https://neurodesk-6to.web.app/app/
# (la raiz del sitio es la landing). Sin eso la pagina queda en blanco.
flutter build web --release --base-href /app/ --dart-define=API_URL=https://neurodesk-api-u97j.onrender.com
# -> queda en app/build/web (scripts/armar-sitio.mjs lo copia al sitio)
```

> En **Git Bash**, `/app/` se convierte solo en una ruta de Windows (`C:/Program Files/Git/app/`) y el build se queja. Ahi va `MSYS_NO_PATHCONV=1 flutter.bat build web ...`. En cmd o PowerShell no pasa.

Lo que cambia en la web, y por que:

- **Firebase** arranca con las opciones de `lib/firebase_web.dart` (ver 2.3). En Android sigue el `google-services.json`.
- **Continuar con Google** abre la ventanita (popup) de Google de Firebase Auth (`signInWithPopup`), con el selector de cuentas siempre (`prompt: select_account`). En Android sigue la hoja nativa de `google_sign_in`. Para que el popup ande, el dominio de la pagina tiene que estar en Firebase Console → Authentication → Settings → **Dominios autorizados** (`neurodesk-6to.web.app` y `localhost` vienen de fabrica; cualquier otro hay que sumarlo).
- **Los archivos viajan como bytes** (`XFile.readAsBytes()` y `PlatformFile.bytes`): en el navegador no existe `dart:io`. En Android es el mismo camino.
- **Sin el boton Camara** en la web: en una compu no hay camara que abrir y en un celular el boton *Fotos* ya ofrece sacar una.
- **Sin persistencia offline** de Firestore (ver 5).
- **Una columna centrada de 720 px** en una pantalla ancha (`MarcoDeLaApp` en `tema.dart`); en un celular ocupa todo el ancho, como siempre.
- **El backend tiene que aceptar el origen** `https://neurodesk-6to.web.app` (CORS): si no, el navegador corta cada pedido a Render aunque el servidor conteste bien.

---

## 3. Las cuatro cosas que hay que saber explicar en la defensa oral

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

### 3.4 "Continuar con Google" reusa el mismo camino que el email

```
 [Android] hoja nativa con las cuentas del telefono (Credential Manager)
   |  google_sign_in: GoogleSignIn.instance.authenticate()
   v
 [Google] devuelve un ID TOKEN firmado que prueba quien es la persona
   |  GoogleAuthProvider.credential(idToken) + signInWithCredential
   v
 [Firebase Auth] verifica el token y crea (o encuentra) el usuario
   |  authStateChanges() avisa a la Puerta de main.dart
   v
 [Puerta] no existe usuarios/{uid} -> "Preparando tu cuenta..." -> POST /v1/auth/registro
```

Desde que Firebase acepta el token, **todo es igual al login con email**: ni `main.dart` ni el backend saben con que proveedor entro la persona (el backend solo verifica el ID token de Firebase). El nombre que se manda al registro es el de la cuenta de Google; si no tiene, la parte del email antes del `@`, siempre ajustado a 2..60 caracteres (`AuthServicio.armarNombreParaRegistro`, probado en `test/widget_test.dart`).

- **Por que el paquete `google_sign_in` y no `signInWithProvider(GoogleAuthProvider())`:** el segundo, en Android, abre un **navegador** (Custom Tab) y si el sistema cierra la app mientras el navegador esta abierto, el login se pierde. La documentacion de FlutterFire dice que en plataformas nativas hace falta una libreria aparte, y la que usa su propio ejemplo es esta.
- **Cancelar no es un error:** si la persona cierra el selector, la app vuelve al login sin cartel.
- **Cerrar sesion** hace `FirebaseAuth.signOut()` y despues `GoogleSignIn.signOut()`, que limpia el Credential Manager: asi la proxima vez aparece de nuevo el selector de cuentas en vez de entrar solo con la anterior.
- **En la web** el primer paso es el popup de Google de Firebase (`signInWithPopup`); lo demas es igual. Cerrar el popup tampoco es un error.

### 3.5 La carga universal: la app decide el tipo

La persona ya no elige "Nota / Foto / Documento / Link": escribe un titulo, un texto si quiere, y adjunta lo que quiera (hasta **8 archivos** y **5 links**; **10 MB** por archivo y **25 MB** entre todos, controlado antes de mandar). Al guardar, la app decide el tipo:

| Lo que se cargo | Tipo | Que viaja |
|---|---|---|
| Solo texto | `nota` | `textoOriginal` en el doc; POST sin cuerpo |
| Un solo link y nada mas | `link` | `url` en el doc; POST sin cuerpo |
| Un solo archivo y nada mas | `pdf` / `word` / `foto` | `nombreArchivo` en el doc; multipart con la parte `archivo` |
| Cualquier mezcla, o mas de uno | `mixto` (en pantalla: **«Varios»**) | `textoOriginal` y `links` en el doc **solo si hay**; multipart con 0 a 8 partes `archivos` |

**Por que asi:** lo de siempre sigue siendo lo de siempre (un PDF suelto es un `pdf` con su "pág. 3", y el backend, el panel y el reproceso no cambian para el). Y el `mixto` nunca lleva `url` ni `nombreArchivo`: las reglas lo rechazarian entero (`hasOnly`). El backend arma una **parte** por cada cosa (el texto, cada link, cada archivo), las guarda en `texto` separadas por las marcas `<<<PARTE:etiqueta>>>` y las describe en la lista `partes`, y cada fuente de una respuesta dice de que parte salio ("Foto 2", "PDF «x.pdf» · pág. 3").

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

- **El archivo no se guarda.** Si un PDF, un Word o una foto fallan **antes** de que se les extraiga el texto, no se pueden reintentar: hay que volver a elegir el archivo. La app lo dice con esas palabras.
- **El texto de las fotos y de los PDF escaneados se procesa en OCR.space**, un servicio externo, **incluso en los items marcados como privados**. Esta avisado en el login y en la pantalla de captura.
- **Sacar a alguien del equipo corta el backend al instante, pero no la lectura directa a Firestore hasta que vence su token (1 hora).** Es una limitacion conocida del modelo de custom claims.
- **Render (plan gratis) se duerme a los 15 minutos** y el primer pedido tarda hasta 60 segundos. Por eso la app llama a `GET /salud` al arrancar, los timeouts de `/procesar` y `/preguntar` son de 90 s, y un timeout **no se muestra como error**: se muestra "sigue procesando" y el `StreamBuilder` avisa como termino.
- **Borrar un item solo se puede desde el backend** (`DELETE /v1/.../items/:itemId`): las reglas tienen `allow delete: if false` porque borrarlo desde el cliente dejaria vivos sus *chunks* con el texto adentro, y la IA los podria seguir citando.
- **No se crea el workspace desde la app.** Se invita desde el panel web; la app muestra `sin_workspace.dart` hasta que alguien te agregue.
- **Google necesita Google Play services y la SHA-1 de cada PC registrada.** Un celular sin servicios de Google (algunos Huawei) o un emulador sin imagen "Google Play" muestra "El ingreso con Google no esta disponible en este celular. Entra con tu email."
- **Una persona, una cuenta por email.** Si alguien creo la cuenta con email y contrasena usando un `@gmail.com` y despues entra con Google, Firebase la pasa a Google (es un proveedor de confianza para Gmail): **mantiene el mismo uid**, asi que no pierde nada, pero si el email no estaba verificado la contrasena deja de servir. Con otros dominios puede salir "Ya tenes una cuenta con ese email".
- **El icono del boton no es el logo oficial de Google** (es `Icons.g_mobiledata` de Material). Para la entrega alcanza; las guias de marca de Google piden la "G" de colores.
- **Un «Varios» con archivos que fallo ANTES de leerse no se puede reintentar**, por lo mismo que un PDF: los archivos no se guardan. Y como la app no anota en el item que archivos llevaba, el que decide es el backend (si no tiene texto guardado contesta `ESTADO_INVALIDO` y la app muestra su mensaje). Uno de solo texto y links si se puede reintentar.
- **En la web no hay persistencia offline** de Firestore, A PROPOSITO: la copia quedaria en el navegador (IndexedDB) despues de cerrar sesion, y en una compu compartida (como las de la escuela) el siguiente tendria en el disco los items privados del anterior. Ademas esa persistencia es de una sola pestana. Sin red, lo que se guarda espera en la memoria de la pestana: la app avisa "No cierres esta pestaña".

---

## 6. Que probar antes de entregar (checklist de QA — Martin)

Antes de tocar el celular: `flutter analyze` tiene que decir **No issues found!** y `flutter test` **All tests passed!**.

- [ ] Crear cuenta nueva → aparece **"Preparando tu cuenta..."** y despues, si el servidor la suma al **espacio de prueba** (`espacioDeBienvenida` en la respuesta de `/v1/auth/registro`), se abre directo el muro de ese espacio, sin ningun `permission-denied` (la app pide el token nuevo antes de abrirlo). Si el servidor no la suma a ninguno: **"Todavia no perteneces a ningun equipo"**.
- [ ] **Continuar con Google** con una cuenta que nunca entro → **"Preparando tu cuenta..."** y despues **"Todavia no perteneces a ningun equipo"** con el nombre y el email de esa cuenta de Google.
- [ ] Abrir el selector de Google y cerrarlo sin elegir → vuelve al login **sin cartel rojo** y los botones se pueden volver a tocar.
- [ ] Cerrar sesion despues de entrar con Google y tocar otra vez **Continuar con Google** → aparece el selector de cuentas (no entra solo con la anterior).
- [ ] Mientras esta abierto el selector de Google, el boton **Entrar** queda gris (no se pueden mandar dos logins a la vez).
- [ ] En la PC del companero, **sin** registrar su SHA-1 → elegir la cuenta no hace nada (es el sintoma de 2.4). Registrarla → anda.
- [ ] Que el admin invite a esa cuenta desde el panel → **la pantalla se abre sola**, sin cerrar y volver a abrir la app (esa es la vigilancia de claims funcionando).
- [ ] Subir una nota → aparece en **Pendiente** al instante y cambia solo a **Procesando** y a **Listo**.
- [ ] Apagar el backend, subir una nota → queda en **Pendiente** con *Reintentar*. Prender el backend, tocar *Reintentar* → pasa a **Listo**.
- [ ] Modo avion → banda roja de sin conexion y banda amarilla de "lo ultimo guardado en el telefono".
- [ ] Doble tap rapido en *Guardar* y en *Enviar* → **no** se crean dos items ni dos respuestas.
- [ ] Subir un PDF de mas de 10 MB → lo frena la app, sin subir nada.
- [ ] Subir un Word (`.docx`) solo con *Documento* → aparece con el icono de hoja en **Pendiente** y pasa solo a **Listo**. En el panel figura como tipo **Word**.
- [ ] Elegir un Word viejo (`.doc`) → la app lo frena y pide guardarlo como `.docx`.
- [ ] **Carga universal:** titulo + un texto + 2 fotos + un PDF + un link → la pantalla dice "Se guarda como «Varios»: 5 partes…", la fila aparece con el icono de capas y, al quedar **Listo**, dice "Varios · 5 partes". Al tocarla, "Lo que leyó NeuroDesk" muestra cada parte con su encabezado.
- [ ] Sacar un adjunto con la cruz antes de guardar → desaparece de la lista y cambia el "Se guarda como…".
- [ ] Sumar archivos hasta pasar los 25 MB entre todos → la app frena el que no entra, sin subir nada.
- [ ] Preguntar algo que esta en la Foto 2 de un «Varios» → la fuente dice "Foto 2" y al tocarla el cian queda en esa parte.
- [ ] Un texto solo, un link solo o un PDF solo → siguen guardandose como **nota**, **link** y **PDF**, como antes.
- [ ] **Web** (`https://neurodesk-6to.web.app/app/`): entrar con email y con *Continuar con Google* (popup); en una compu la app se ve en una columna centrada; subir fotos y un PDF desde la compu.
- [ ] **La prueba del requisito de roles:** A sube una nota **privada**, B pregunta exactamente por su contenido → la respuesta viene **sin fuentes**, con "Respondido solo con lo que vos podés ver" y sin ningun numero de fragmentos. Si el admin hace la misma pregunta, la respuesta la cita y la app le dice "Como sos admin, busqué en todo el espacio, incluido lo privado de cada uno." y "Miré los N fragmentos del espacio."
