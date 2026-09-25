// ============================================================================
//  login.dart — entrar o crear la cuenta
//
//  Una sola pantalla con un interruptor: "Entrar" / "Crear cuenta". Son dos
//  formularios casi iguales (el de registro suma el nombre), asi que dos
//  pantallas separadas serian el mismo codigo copiado dos veces.
//
//  LO IMPORTANTE ACA: la persona NUNCA ve un codigo de Firebase. Ni
//  'user-not-found', ni 'invalid-credential', ni un stack trace. Todo pasa por
//  AuthServicio.traducirErrorDeAuth(), que devuelve castellano.
//
//  Esta pantalla NO navega a ningun lado despues de un login exitoso: cuando
//  Firebase confirma la sesion, el stream authStateChanges() que escucha la
//  Puerta de main.dart cambia y la Puerta dibuja lo que corresponde. Si
//  ademas hicieramos un Navigator.push aca, terminariamos con dos Home
//  apiladas.
// ============================================================================

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../servicios/auth_servicio.dart';
import '../tema.dart';

class LoginPantalla extends StatefulWidget {
  const LoginPantalla({super.key});

  @override
  State<LoginPantalla> createState() => _LoginPantallaState();
}

class _LoginPantallaState extends State<LoginPantalla> {
  final GlobalKey<FormState> _formulario = GlobalKey<FormState>();
  final TextEditingController _email = TextEditingController();
  final TextEditingController _contrasena = TextEditingController();
  final TextEditingController _nombre = TextEditingController();

  bool _modoRegistro = false;
  bool _trabajando = false;
  bool _verContrasena = false;

  @override
  void dispose() {
    // Los controllers SIEMPRE se liberan: cada uno se queda escuchando el
    // teclado y, si no se cierran, quedan colgados en memoria.
    _email.dispose();
    _contrasena.dispose();
    _nombre.dispose();
    super.dispose();
  }

  Future<void> _enviar() async {
    // Corta el doble tap: sin esto, dos toques rapidos mandan dos pedidos y el
    // backend contesta DEMASIADOS_PEDIDOS.
    if (_trabajando) return;
    if (!(_formulario.currentState?.validate() ?? false)) return;

    setState(() => _trabajando = true);
    try {
      if (_modoRegistro) {
        await AuthServicio.registrarse(
          _email.text,
          _contrasena.text,
          _nombre.text,
        );
        // El documento usuarios/{uid} NO se crea aca: lo crea el backend con
        // POST /v1/auth/registro, y la Puerta de main.dart se encarga apenas
        // ve que la ficha no existe ("Preparando tu cuenta...").
      } else {
        await AuthServicio.entrar(_email.text, _contrasena.text);
      }
      // Exito: no navegamos. Lo hace la Puerta al ver el cambio de sesion.
    } on FirebaseAuthException catch (e) {
      // context.mounted DESPUES DE CADA AWAIT: si la persona salio de la
      // pantalla mientras esperabamos, usar el context tira una excepcion.
      if (!mounted) return;
      mostrarAviso(context, AuthServicio.traducirErrorDeAuth(e), esError: true);
    } catch (e) {
      if (!mounted) return;
      debugPrint('[NeuroDesk] error inesperado en el login: $e');
      mostrarAviso(
        context,
        'No pudimos completar la accion. Proba de nuevo en un rato.',
        esError: true,
      );
    } finally {
      // El finally corre igual si hubo error: si no, el boton queda
      // deshabilitado para siempre y hay que cerrar la app.
      if (mounted) setState(() => _trabajando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            // El scroll es obligatorio: cuando sube el teclado, la pantalla
            // se achica y sin scroll salta el clasico "bottom overflowed".
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _formulario,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: <Widget>[
                    const Icon(Icons.psychology, size: 72, color: cianElectrico),
                    const SizedBox(height: 12),
                    const Text(
                      'NeuroDesk AI',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: grisClaro,
                        fontSize: 30,
                        fontWeight: FontWeight.bold,
                        letterSpacing: -0.5,
                      ),
                    ),
                    const SizedBox(height: 6),
                    const Text(
                      'El segundo cerebro de tu equipo',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: grisApagado, fontSize: 15),
                    ),
                    const SizedBox(height: 32),

                    // El nombre solo aparece cuando se esta creando la cuenta.
                    if (_modoRegistro) ...<Widget>[
                      TextFormField(
                        controller: _nombre,
                        textCapitalization: TextCapitalization.words,
                        decoration: _decoracion('Tu nombre', Icons.person),
                        // 2 a 60 caracteres: EL MISMO rango que piden las
                        // reglas de Firestore y el contrato del backend. Si
                        // aca dejaramos pasar uno de 1 caracter, el backend lo
                        // rechazaria con DATOS_INVALIDOS y la persona no
                        // entenderia por que.
                        validator: (String? v) {
                          final String t = (v ?? '').trim();
                          if (t.length < 2) return 'Poné al menos 2 caracteres.';
                          if (t.length > 60) return 'Maximo 60 caracteres.';
                          return null;
                        },
                      ),
                      const SizedBox(height: 14),
                    ],

                    TextFormField(
                      controller: _email,
                      keyboardType: TextInputType.emailAddress,
                      autocorrect: false,
                      decoration: _decoracion('Email', Icons.alternate_email),
                      validator: (String? v) {
                        final String t = (v ?? '').trim();
                        // Validacion a ojo: que tenga arroba y un punto
                        // despues. La de verdad la hace Firebase; esta es solo
                        // para no gastar un viaje al servidor por un tipeo.
                        if (!t.contains('@') || !t.contains('.')) {
                          return 'Escribi un email valido.';
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: 14),

                    TextFormField(
                      controller: _contrasena,
                      obscureText: !_verContrasena,
                      decoration: _decoracion('Contrasena', Icons.lock).copyWith(
                        suffixIcon: IconButton(
                          icon: Icon(
                            _verContrasena ? Icons.visibility_off : Icons.visibility,
                            color: grisApagado,
                          ),
                          onPressed: () =>
                              setState(() => _verContrasena = !_verContrasena),
                        ),
                      ),
                      validator: (String? v) {
                        // 6 es el minimo que exige Firebase Auth.
                        if ((v ?? '').length < 6) {
                          return 'Al menos 6 caracteres.';
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: 24),

                    FilledButton(
                      // onPressed en null = boton gris y no clickeable. Es la
                      // forma mas simple de que no entren dos pedidos juntos.
                      onPressed: _trabajando ? null : _enviar,
                      style: FilledButton.styleFrom(
                        backgroundColor: cian,
                        foregroundColor: azulNoche,
                        padding: const EdgeInsets.symmetric(vertical: 16),
                      ),
                      child: _trabajando
                          ? const SizedBox(
                              width: 22,
                              height: 22,
                              child: CircularProgressIndicator(
                                strokeWidth: 2.5,
                                color: azulNoche,
                              ),
                            )
                          : Text(
                              _modoRegistro ? 'Crear cuenta' : 'Entrar',
                              style: const TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                    ),
                    const SizedBox(height: 12),

                    TextButton(
                      onPressed: _trabajando
                          ? null
                          : () => setState(() => _modoRegistro = !_modoRegistro),
                      child: Text(
                        _modoRegistro
                            ? 'Ya tengo cuenta: entrar'
                            : 'No tengo cuenta: crear una',
                        style: const TextStyle(color: cianElectrico),
                      ),
                    ),

                    const SizedBox(height: 20),
                    const Text(
                      'Al entrar aceptas que el texto de los PDF escaneados y '
                      'de las fotos se procesa en un servicio externo (OCR.space) '
                      'para poder leerlo.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: grisApagado, fontSize: 11.5),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// La decoracion de los tres campos, escrita una sola vez.
  InputDecoration _decoracion(String etiqueta, IconData icono) {
    return InputDecoration(
      labelText: etiqueta,
      labelStyle: const TextStyle(color: grisApagado),
      prefixIcon: Icon(icono, color: grisApagado),
      filled: true,
      fillColor: superficie,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide.none,
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: cianElectrico, width: 1.6),
      ),
    );
  }
}
