# NeuroDesk AI — Fase 2 (desarrollo)

> El segundo cerebro con IA de tu equipo. · Entrega: **16/10/2026**

## Reglas de trabajo (leer antes de tocar nada)

**1. Propiedad por carpeta.** Nadie edita la carpeta del otro sin avisar.

| Carpeta | Dueño | Qué es |
|---|---|---|
| `api/` | Valentino | Backend Node + Express |
| `firebase/` | Valentino | `firestore.rules`, índices, scripts |
| `app/` | Martín | App móvil Flutter |
| `panel/` | Martín | Panel web del admin |
| `CONTRATO.md` | **compartido** | Si se toca, se avisa en voz alta |

**2. `git pull` al empezar la clase, `git push` al terminar.** Siempre, aunque esté a
medio hacer (commit `wip`). Si no, el próximo conflicto se come una clase entera.

**3. Trabajamos directo en `main`.** Con dos personas y carpetas separadas, las
ramas agregan ceremonia sin beneficio.

**4. Versiones congeladas.** Flutter **3.41.6** — no correr `flutter upgrade` hasta
después del 16/10. `package-lock.json` y `pubspec.lock` van al repo.

## Regla de oro
Los secretos van en `.env` (copiado de `.env.example`) y **nunca** al repo.
El `.gitignore` es el primer commit del proyecto, antes que cualquier código.

## Documentos
- `MODELO-DATOS.md` — las colecciones, sus campos y las invariantes
- `CONTRATO.md` — los endpoints del backend y el formato único de error
- `firebase/firestore.rules` — las reglas de seguridad (desplegadas desde el día 1)
