// ============================================================================
//  sin_workspace.dart — "todavia no perteneces a ningun equipo"
//
//  Se muestra cuando usuarios/{uid}.workspaces esta VACIO. Es un estado normal
//  y esperado: en el MVP no hay invitaciones por mail ni auto-alta; primero la
//  persona se registra y despues un admin la invita desde el panel web.
//
//  POR QUE ESTA PANTALLA EXISTE Y NO MANDAMOS DIRECTO AL HOME VACIO:
//  sin workspace no hay NADA que consultar (todas las colecciones cuelgan de
//  workspaces/{wsId}), asi que un Home vacio seria una lista en blanco sin
//  explicacion, y la persona pensaria que la app esta rota. Aca le decimos
//  exactamente que tiene que hacer: pedirle al admin que la invite.
//
//  EL BOTON "YA ME INVITARON": cuando el admin invita a alguien, el backend
//  escribe members/{uid}, actualiza usuarios/{uid}.workspaces y toca los
//  custom claims. El mapa 'workspaces' llega SOLO por el listener (esta
//  pantalla se cierra sola), pero el TOKEN todavia puede ser el viejo, sin el
//  claim del workspace nuevo, y entonces Firestore contestaria permission-denied
//  al abrir el Home. El boton fuerza getIdToken(true) para adelantarse a eso.
//  Igual, AuthServicio.vigilarClaims() ya lo hace solo: el boton es la salida
//  manual para cuando la persona esta impaciente en el medio de la demo.
// ============================================================================

import 'package:flutter/material.dart';

import '../servicios/auth_servicio.dart';
import '../tema.dart';

class SinWorkspacePantalla extends StatefulWidget {
  const SinWorkspacePantalla({
    super.key,
    required this.nombre,
    required this.email,
  });

  final String nombre;
  final String email;

  @override
  State<SinWorkspacePantalla> createState() => _SinWorkspacePantallaState();
}

class _SinWorkspacePantallaState extends State<SinWorkspacePantalla> {
  bool _refrescando = false;

  Future<void> _refrescar() async {
    if (_refrescando) return;
    setState(() => _refrescando = true);
    try {
      await AuthServicio.refrescarToken();
      if (!mounted) return; // context.mounted despues del await, siempre
      mostrarAviso(
        context,
        'Listo. Si ya te invitaron, la pantalla se abre sola en unos segundos.',
      );
    } catch (e) {
      if (!mounted) return;
      debugPrint('[NeuroDesk] no se pudo refrescar el token: $e');
      mostrarAviso(context, 'No pudimos actualizar. Revisá tu conexion.', esError: true);
    } finally {
      if (mounted) setState(() => _refrescando = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: azulNoche,
        foregroundColor: grisClaro,
        title: const Text('NeuroDesk AI'),
        actions: <Widget>[
          IconButton(
            tooltip: 'Cerrar sesion',
            icon: const Icon(Icons.logout),
            onPressed: () => AuthServicio.salir(),
          ),
        ],
      ),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: <Widget>[
              const Icon(Icons.groups_outlined, size: 80, color: azulRoyal),
              const SizedBox(height: 24),
              const Text(
                'Todavia no perteneces a ningun equipo',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: grisClaro,
                  fontSize: 22,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 14),
              const Text(
                'Pedile a tu admin que te invite desde el panel web. '
                'Te va a invitar con este email:',
                textAlign: TextAlign.center,
                style: TextStyle(color: grisApagado, fontSize: 15, height: 1.4),
              ),
              const SizedBox(height: 16),

              // El email se muestra grande y seleccionable porque es EL dato
              // que la persona le tiene que pasar al admin. SelectableText
              // para que lo pueda copiar y mandar por WhatsApp.
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                decoration: BoxDecoration(
                  color: superficie,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: azulRoyal.withValues(alpha: 0.4)),
                ),
                child: SelectableText(
                  widget.email.isEmpty ? '(sin email)' : widget.email,
                  style: const TextStyle(
                    color: cianElectrico,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),

              if (widget.nombre.isNotEmpty) ...<Widget>[
                const SizedBox(height: 10),
                Text(
                  'Estas entrando como ${widget.nombre}',
                  style: const TextStyle(color: grisApagado, fontSize: 13),
                ),
              ],

              const SizedBox(height: 32),
              FilledButton.icon(
                onPressed: _refrescando ? null : _refrescar,
                style: FilledButton.styleFrom(
                  backgroundColor: cian,
                  foregroundColor: azulNoche,
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                ),
                icon: _refrescando
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2.5,
                          color: azulNoche,
                        ),
                      )
                    : const Icon(Icons.refresh),
                label: const Text('Ya me invitaron'),
              ),
              const SizedBox(height: 24),
              const Text(
                'Cuando te agreguen, esta pantalla se cierra sola: la app '
                'escucha tu ficha en tiempo real.',
                textAlign: TextAlign.center,
                style: TextStyle(color: grisApagado, fontSize: 12.5),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
