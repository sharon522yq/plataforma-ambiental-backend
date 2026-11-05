# Prototipo del frontend

Prototipo navegable de la interfaz web de la plataforma, en un solo archivo (`index.html`) sin compilación. Sirve para enseñar el flujo completo y validar la experiencia antes de construir el frontend definitivo.

Versión publicada para verlo y compartirlo: https://claude.ai/artifact/GKoo8YfjdbLHNgasTYiAoQ (privada hasta que se comparta).

## Qué incluye

| Sección | Rol necesario | Endpoint del backend que representa |
|---|---|---|
| Mapa: filtros por tipo y gravedad, búsqueda por radio, detalle y «Cómo ayudar» | Ninguno | `GET /puntos`, `GET /puntos/cercanos`, `GET /puntos/:id` |
| «Cómo ayudar»: agregar un enlace (firma, evento, donación, voluntariado, denuncia) | Cualquier cuenta activa | `POST /puntos/:id/acciones` |
| «Cómo ayudar»: retirar un enlace | Moderador, editor o administrador | `DELETE /admin/acciones/:id` |
| Reportar: tipo, descripción, gravedad, ubicación por dirección o por coordenadas, foto y hasta 3 enlaces para ayudar | Ciudadano o superior | `POST /aportes`, `POST /aportes/:id/evidencia` |
| Mis aportes: estado y motivo de revisión | Ciudadano o superior | `GET /aportes/mis` |
| Moderación: aprobar, rechazar con motivo o marcar duplicado | Moderador o administrador | `GET /admin/aportes`, `PATCH /admin/aportes/:id/revision` |
| Administración: catálogo, usuarios y roles, auditoría | Editor (catálogo) o administrador | `POST /admin/acciones`, `POST /admin/organizaciones`, `GET /admin/usuarios`, `PATCH /admin/usuarios/:id/rol`, `GET /admin/auditoria` |
| Asistente con IA | Ninguno | `POST /agente/consulta` |

Las reglas de validación son las mismas del backend (descripción de 10 a 2000 caracteres, gravedad 1 a 5, fotos JPG, PNG o WebP de hasta 8 MB, enlaces solo `https://`, motivo obligatorio para rechazar, nadie revisa su propio aporte ni cambia su propio rol). Si una sección pide un rol que no se tiene, la pantalla muestra el mismo 401 o 403 que devuelve la API.

## Sitio público

Desde F12 este mismo archivo se publica en Render como sitio estático (ver «Sitio público» en el README del backend). En el dominio `*.onrender.com` la página:

- entra siempre en modo **API en vivo** y oculta el selector de datos de ejemplo;
- cambia la etiqueta a «piloto» y usa textos para el público (sin rutas de la API ni instrucciones de desarrollo);
- muestra el **aviso de privacidad** (`#privacidad`, enlazado en el pie y en el aviso superior), pide aceptarlo al crear la cuenta y al enviar un reporte, y guarda en la cuenta la versión aceptada (`aviso_privacidad` en los metadatos de Supabase Auth);
- pide a Supabase que el correo de confirmación regrese a la misma página.

Para simularlo en tu PC agrega `?publico=1`: `http://localhost:5173/?publico=1`.

El aviso es un borrador basado en lo que la plataforma hace de verdad; conviene que lo revise alguien que conozca la Ley Federal de Protección de Datos Personales en Posesión de los Particulares. Antes del piloto hay que poner el correo de contacto en `CONTACTO_PRIVACIDAD` (al inicio del script); mientras esté vacío, la página dice que se publicará antes del piloto en lugar de inventar uno.

## Dos modos de datos

- **De ejemplo** (por defecto): no llama a ningún servidor. Los puntos `[PRUEBA]` son los de la migración `005`; los `[EJEMPLO]`, los aportes y los usuarios son inventados para la demo. El selector «Ver como» simula el rol que daría el inicio de sesión. Nada se guarda: al recargar vuelve al inicio.
- **API en vivo**: todo lee y escribe en `https://plataforma-ambiental-backend.onrender.com/api/v1`, con una sesión real de Supabase Auth (botón «Iniciar sesión» arriba a la derecha; también se puede crear una cuenta). El rol sale de `GET /sesion`. Lo que se envía queda en la base de producción y cada pregunta al asistente usa cuota de Gemini.

## Cómo abrirlo en tu PC

Con doble clic sobre `index.html` se ve en modo de ejemplo, con las calles de OpenStreetMap.

Para el modo **API en vivo**, el navegador exige que la página venga de un origen permitido por `CORS_ORIGENES` en Render. El valor sugerido en el README del backend es `http://localhost:5173`; si pusiste otro, agrégalo separado por coma. En PowerShell, dentro de `C:\plataforma geoespacial`:

```
npx --yes serve -l 5173 prototipo
```

y abre `http://localhost:5173`. El plan gratuito de Render puede tardar unos 50 segundos en despertar con la primera llamada.

## Iniciar sesión de verdad

1. Abre el prototipo en `http://localhost:5173` (ver arriba) y cambia «Datos» a **API en vivo**.
2. Pulsa **Iniciar sesión → No tengo cuenta** y crea tu cuenta. Las cuentas nuevas empiezan como ciudadano.
3. Si Supabase pide confirmar el correo, el enlace del correo te lleva a la *Site URL* del proyecto. Ponla en `http://localhost:5173` en Supabase → Authentication → URL Configuration, o desactiva «Confirm email» mientras dure el piloto.
4. Para entrar como administrador, nombra tu cuenta desde el SQL Editor como explica el README del backend («Nombrar al primer administrador»). Después cambias los demás roles desde Administración → Usuarios y roles.

## Límites conocidos

- La versión publicada en claude.ai no puede cargar el mapa base de OpenStreetMap ni llamar a la API (la página está aislada); allí se ve una cuadrícula de coordenadas reales y el modo de ejemplo.
- El navegador recibe la llave pública *anon* de Supabase desde `GET /configuracion-publica` (D-39). Ninguna llave secreta llega al frontend.
- La ubicación de un reporte se escribe: una dirección, que se convierte a coordenadas con Nominatim de OpenStreetMap (solo México, una búsqueda por clic, como pide su política de uso), o las coordenadas exactas (`19.2783, -98.2225`). El mapa de Reportar solo muestra la vista previa. La API guarda las coordenadas, no la dirección. En la versión publicada en claude.ai el buscador de direcciones no responde; las coordenadas sí funcionan.
- Leaflet 1.9.4 se carga desde cdnjs; su hoja de estilos va copiada dentro del archivo (licencia BSD-2).
