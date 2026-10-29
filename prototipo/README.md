# Prototipo del frontend

Prototipo navegable de la interfaz web de la plataforma, en un solo archivo (`index.html`) sin compilación. Sirve para enseñar el flujo completo y validar la experiencia antes de construir el frontend definitivo.

Versión publicada para verlo y compartirlo: https://claude.ai/artifact/GKoo8YfjdbLHNgasTYiAoQ (privada hasta que se comparta).

## Qué incluye

| Sección | Rol necesario | Endpoint del backend que representa |
|---|---|---|
| Mapa: filtros por tipo y gravedad, búsqueda por radio, detalle y «Cómo ayudar» | Ninguno | `GET /puntos`, `GET /puntos/cercanos`, `GET /puntos/:id` |
| Reportar: tipo, descripción, gravedad, ubicación en el mapa y foto | Ciudadano o superior | `POST /aportes`, `POST /aportes/:id/evidencia` |
| Mis aportes: estado y motivo de revisión | Ciudadano o superior | `GET /aportes/mis` |
| Moderación: aprobar, rechazar con motivo o marcar duplicado | Moderador o administrador | `GET /admin/aportes`, `PATCH /admin/aportes/:id/revision` |
| Administración: catálogo, usuarios y roles, auditoría | Editor (catálogo) o administrador | `POST /admin/acciones`, `POST /admin/organizaciones`, `GET /admin/usuarios`, `PATCH /admin/usuarios/:id/rol`, `GET /admin/auditoria` |
| Asistente con IA | Ninguno | `POST /agente/consulta` |

Las reglas de validación son las mismas del backend (descripción de 10 a 2000 caracteres, gravedad 1 a 5, fotos JPG, PNG o WebP de hasta 8 MB, enlaces solo `https://`, motivo obligatorio para rechazar, nadie revisa su propio aporte ni cambia su propio rol). Si una sección pide un rol que no se tiene, la pantalla muestra el mismo 401 o 403 que devuelve la API.

## Dos modos de datos

- **De ejemplo** (por defecto): no llama a ningún servidor. Los puntos `[PRUEBA]` son los de la migración `005`; los `[EJEMPLO]`, los aportes y los usuarios son inventados para la demo. El selector «Ver como» simula el rol que daría el inicio de sesión. Nada se guarda: al recargar vuelve al inicio.
- **API en vivo**: el mapa, el detalle de cada punto y el asistente llaman a `https://plataforma-ambiental-backend.onrender.com/api/v1`. Cada pregunta al asistente usa cuota de Gemini. Las secciones con sesión siguen en modo de ejemplo, porque falta conectar el inicio de sesión de Supabase.

## Cómo abrirlo en tu PC

Con doble clic sobre `index.html` se ve en modo de ejemplo, con las calles de OpenStreetMap.

Para el modo **API en vivo**, el navegador exige que la página venga de un origen permitido por `CORS_ORIGENES` en Render. El valor sugerido en el README del backend es `http://localhost:5173`; si pusiste otro, agrégalo separado por coma. En PowerShell, dentro de `C:\plataforma geoespacial`:

```
npx --yes serve -l 5173 prototipo
```

y abre `http://localhost:5173`. El plan gratuito de Render puede tardar unos 50 segundos en despertar con la primera llamada.

## Límites conocidos

- La versión publicada en claude.ai no puede cargar el mapa base de OpenStreetMap ni llamar a la API (la página está aislada); allí se ve una cuadrícula de coordenadas reales y el modo de ejemplo.
- No hay inicio de sesión real. Para el frontend definitivo hace falta la llave pública (*anon*) de Supabase en el navegador, que está pensada para eso y la protege RLS; es una decisión pendiente porque hoy la regla del proyecto es no poner llaves en el frontend.
- Leaflet 1.9.4 se carga desde cdnjs; su hoja de estilos va copiada dentro del archivo (licencia BSD-2).
