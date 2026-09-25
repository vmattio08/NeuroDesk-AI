// ============================================================================
//  tema.dart — la paleta de la marca y los helpers de presentacion
//
//  Todo lo visual que se repite en mas de una pantalla vive ACA. Si el color
//  del chip "Procesando" se decide en cada pantalla, en la tercera pantalla ya
//  no coincide con las otras dos.
//
//  DECISION SOBRE EL ThemeData: le ponemos solo colorScheme y
//  scaffoldBackgroundColor, y todo lo demas (AppBar, tarjetas, inputs) se
//  estiliza en la pantalla. Motivo practico: los "sub-temas" de Material
//  (CardTheme, TabBarTheme, InputDecorationTheme...) le cambiaron el nombre y
//  el tipo entre versiones de Flutter, y un tema cargado de sub-temas es la
//  forma mas facil de que el proyecto no compile en la maquina del otro.
//  Menos magia = menos sorpresas.
// ============================================================================

import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/material.dart';

// --- PALETA DE LA MARCA -----------------------------------------------------
// Los cinco colores son los del logo. No se inventan colores nuevos en las
// pantallas: si hace falta uno, se agrega aca con su nombre.

/// Azul noche: el fondo de toda la app.
const Color azulNoche = Color(0xFF0F172A);

/// Cian: el color principal (botones, foco, links).
const Color cian = Color(0xFF06B6D4);

/// Cian electrico: acentos y estados activos (mas brillante que el cian).
const Color cianElectrico = Color(0xFF22D3EE);

/// Azul royal: el secundario (chips, iconos de apoyo).
const Color azulRoyal = Color(0xFF3B82F6);

/// Gris claro: el texto sobre el fondo oscuro.
const Color grisClaro = Color(0xFFE2E8F0);

/// Un azul un poco mas claro que el fondo, para las tarjetas.
/// (No es de la paleta oficial: es el mismo azul noche aclarado para que la
/// tarjeta se despegue del fondo sin meter un color nuevo a la marca.)
const Color superficie = Color(0xFF1E293B);

/// Gris apagado para las leyendas y los textos secundarios.
const Color grisApagado = Color(0xFF94A3B8);

// --- COLORES DE LOS ESTADOS DEL ITEM ---------------------------------------
// pendiente / procesando / listo / error. Son los mismos cuatro estados del
// modelo de datos: el chip de color es la maquina de estados hecha dibujo.
const Color colorPendiente = Color(0xFF64748B); // gris
const Color colorProcesando = Color(0xFFF59E0B); // amarillo
const Color colorListo = Color(0xFF22C55E); // verde
const Color colorError = Color(0xFFEF4444); // rojo

/// El tema de toda la app. Se arma una sola vez en main.dart.
ThemeData temaNeuroDesk() {
  return ThemeData(
    useMaterial3: true,
    brightness: Brightness.dark,
    scaffoldBackgroundColor: azulNoche,
    colorScheme: const ColorScheme.dark(
      primary: cian,
      onPrimary: azulNoche,
      secondary: azulRoyal,
      onSecondary: Colors.white,
      surface: superficie,
      onSurface: grisClaro,
      error: colorError,
      onError: Colors.white,
    ),
  );
}

// --- HELPERS DE PRESENTACION ------------------------------------------------
// Traducen un dato crudo de Firestore a algo que se pueda mirar. Viven aca (y
// no en cada pantalla) para que el mismo estado se vea igual en todos lados.

/// Color del chip segun el estado del item.
/// El default es el gris de 'pendiente': si algun dia aparece un estado que no
/// conocemos, la fila se dibuja igual y no se rompe la lista entera.
Color colorDeEstado(String estado) {
  switch (estado) {
    case 'procesando':
      return colorProcesando;
    case 'listo':
      return colorListo;
    case 'error':
      return colorError;
    case 'pendiente':
    default:
      return colorPendiente;
  }
}

/// Texto del chip, en castellano y para la persona (no el valor crudo).
String textoDeEstado(String estado) {
  switch (estado) {
    case 'procesando':
      return 'Procesando';
    case 'listo':
      return 'Listo';
    case 'error':
      return 'Error';
    case 'pendiente':
      return 'Pendiente';
    default:
      return 'Desconocido';
  }
}

/// Icono segun el tipo de item: nota, pdf, link o foto.
IconData iconoDeTipo(String tipo) {
  switch (tipo) {
    case 'pdf':
      return Icons.picture_as_pdf;
    case 'foto':
      return Icons.photo_camera;
    case 'link':
      return Icons.link;
    case 'nota':
    default:
      return Icons.sticky_note_2;
  }
}

/// Fecha corta "14/09 13:42" para las listas.
///
/// POR QUE A MANO Y NO CON intl: agregar el paquete intl solo para esto suma
/// una dependencia mas que puede pelearse de version con Flutter. Con dos
/// listas de digitos alcanza.
///
/// OJO CON EL null: 'creadoEn' se escribe con FieldValue.serverTimestamp(), y
/// mientras el servidor no confirma la escritura el campo llega en null en la
/// version local del documento (escritura optimista). Por eso devolvemos
/// "ahora" en vez de romper: es exactamente lo que esta pasando.
String fechaCorta(Object? valor) {
  if (valor is! Timestamp) return 'ahora';
  final DateTime f = valor.toDate();
  final String dia = f.day.toString().padLeft(2, '0');
  final String mes = f.month.toString().padLeft(2, '0');
  final String hora = f.hour.toString().padLeft(2, '0');
  final String min = f.minute.toString().padLeft(2, '0');
  return '$dia/$mes $hora:$min';
}

/// El chip de color que muestra el estado de un item.
class ChipDeEstado extends StatelessWidget {
  const ChipDeEstado({super.key, required this.estado});

  final String estado;

  @override
  Widget build(BuildContext context) {
    final Color color = colorDeEstado(estado);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        // El fondo es el mismo color pero casi transparente: se lee el texto
        // y el chip no le gana en peso visual al titulo del item.
        color: color.withValues(alpha: 0.18),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: color.withValues(alpha: 0.6)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          // Solo 'procesando' lleva spinner: es el unico estado que se mueve
          // solo y donde la persona tiene que esperar.
          if (estado == 'procesando')
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: SizedBox(
                width: 10,
                height: 10,
                child: CircularProgressIndicator(strokeWidth: 2, color: color),
              ),
            ),
          Text(
            textoDeEstado(estado),
            style: TextStyle(
              color: color,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

/// Cartelito gris de "no hay nada todavia", con un icono y un texto.
/// Lo usan el muro de items y el historial del chat.
class VacioMensaje extends StatelessWidget {
  const VacioMensaje({
    super.key,
    required this.icono,
    required this.titulo,
    required this.detalle,
  });

  final IconData icono;
  final String titulo;
  final String detalle;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Icon(icono, size: 56, color: grisApagado),
            const SizedBox(height: 16),
            Text(
              titulo,
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: grisClaro,
                fontSize: 18,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            Text(
              detalle,
              textAlign: TextAlign.center,
              style: const TextStyle(color: grisApagado, fontSize: 14),
            ),
          ],
        ),
      ),
    );
  }
}

/// Pantalla de error para los StreamBuilder / FutureBuilder que fallan.
///
/// TODO snapshot.hasError termina aca. Nunca se deja pasar un error de
/// Firestore sin dibujar nada: el sintoma clasico es "la lista quedo vacia" y
/// en realidad era un permission-denied (token viejo o falta un .where()).
class ErrorMensaje extends StatelessWidget {
  const ErrorMensaje({super.key, required this.error, this.alReintentar});

  final Object error;
  final VoidCallback? alReintentar;

  @override
  Widget build(BuildContext context) {
    // El texto crudo del error NO se le muestra a la persona (dice
    // 'permission-denied' y nombra a Firestore). Va al log para nosotros.
    debugPrint('[NeuroDesk] error en un stream: $error');
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            const Icon(Icons.cloud_off, size: 56, color: colorError),
            const SizedBox(height: 16),
            const Text(
              'No pudimos cargar esta lista',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: grisClaro,
                fontSize: 18,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'Puede ser la conexion o que tu sesion haya vencido. '
              'Proba salir y volver a entrar.',
              textAlign: TextAlign.center,
              style: TextStyle(color: grisApagado, fontSize: 14),
            ),
            if (alReintentar != null) ...<Widget>[
              const SizedBox(height: 16),
              FilledButton(
                onPressed: alReintentar,
                child: const Text('Reintentar'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// SnackBar en castellano, siempre igual en toda la app.
///
/// Se llama SIEMPRE despues de chequear context.mounted: si la pantalla ya se
/// cerro mientras esperabamos el await, mostrar un SnackBar tira una excepcion
/// ("Looking up a deactivated widget's ancestor").
void mostrarAviso(BuildContext context, String mensaje, {bool esError = false}) {
  mostrarAvisoEn(ScaffoldMessenger.of(context), mensaje, esError: esError);
}

/// La misma funcion, pero recibiendo el ScaffoldMessenger YA BUSCADO.
///
/// POR QUE EXISTE ESTA SEGUNDA VERSION: cuando una pantalla se cierra sola
/// (Navigator.pop) y despues quiere mostrar un aviso, ya no puede llamar a
/// ScaffoldMessenger.of(context): ese context quedo desactivado y la busqueda
/// tira "Looking up a deactivated widget's ancestor". La solucion es agarrar
/// el mensajero ANTES del primer await y usarlo despues. El SnackBar
/// sobrevive al cambio de pantalla porque el ScaffoldMessenger vive arriba del
/// Navigator, en el MaterialApp.
void mostrarAvisoEn(
  ScaffoldMessengerState mensajero,
  String mensaje, {
  bool esError = false,
}) {
  mensajero
    ..hideCurrentSnackBar() // que no se apilen tres avisos iguales
    ..showSnackBar(
      SnackBar(
        content: Text(mensaje),
        backgroundColor: esError ? colorError : superficie,
        behavior: SnackBarBehavior.floating,
        duration: const Duration(seconds: 4),
      ),
    );
}
