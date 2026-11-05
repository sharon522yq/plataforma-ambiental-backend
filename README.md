# Plataforma ambiental: backend

API de la plataforma ciudadana que muestra problemáticas ambientales en un mapa. Node.js 22, TypeScript, Express, Supabase (PostgreSQL con PostGIS y pgvector) y Gemini.

## Requisitos

- Node.js 22.12 o superior (ver D-10 en `docs/decisiones-pendientes.md`)
- npm

## Instalación

```
npm ci
```

Copia `.env.example` a `.env` y escribe los valores tú mismo. El archivo `.env` nunca se sube a Git.

## Base de datos

Las migraciones están en `migrations/` y se aplican en orden. Cada una corre en su propia transacción y se registra en `esquema_migraciones.aplicadas`, así que no se vuelve a aplicar.

```
npm run migrar      # usa DATABASE_URL del .env
```

### Pruebas de base de datos

Las pruebas de esquema, RLS y funciones necesitan un PostgreSQL de pruebas con PostGIS y pgvector. Sin `TEST_DATABASE_URL`, se omiten (las demás pruebas siguen corriendo). Cada corrida crea bases temporales y las borra al terminar.

Requisitos del servidor: PostgreSQL 15 o 16 con las extensiones `postgis` y `pgvector`. El rol de la URL debe ser superusuario, porque crea bases y roles.

```
TEST_DATABASE_URL=postgresql://postgres:TU_CLAVE@127.0.0.1:5432/postgres npm test
```

Las pruebas simulan los roles `anon` y `authenticated` y el esquema `auth` que Supabase ya trae (`tests/ayudas/base-local.sql`). **Nunca apuntes `TEST_DATABASE_URL` a producción.**

## Pruebas contra Supabase

`tests/integracion/supabase.test.ts` verifica la salud contra un proyecto real. Se ejecuta solo si pones `PRUEBAS_SUPABASE=1` y las variables `SUPABASE_*` de un proyecto de **pruebas** (nunca producción).

```
PRUEBAS_SUPABASE=1 npm test
```

Con eso también se comprueba que el backend lee `perfiles` con la llave de servicio (migración 006) y que `/sesion` rechaza la llave anon como token.

Para probar un inicio de sesión real, crea un usuario de prueba en **Authentication → Users** y agrega `PRUEBAS_SUPABASE_EMAIL` y `PRUEBAS_SUPABASE_CLAVE`. Sin ellas, esa prueba se omite.

## Autenticación

- Las rutas protegidas exigen `Authorization: Bearer <access_token>` de Supabase Auth. Sin token o con uno inválido o vencido responden 401.
- El token se verifica con `SUPABASE_JWT_SECRET` (HS256) o con las llaves públicas del proyecto (`/auth/v1/.well-known/jwks.json`, ES256/RS256), según cómo lo firme Supabase (D-16).
- El rol se lee de `perfiles` en cada solicitud, nunca del token. Una cuenta desactivada o sin perfil recibe 403, igual que un rol insuficiente.
- `GET /api/v1/sesion` devuelve `{ id, rol }` del usuario que inició sesión (D-19).
- `GET /api/v1/configuracion-publica` devuelve `{ supabase_url, supabase_anon_key }` para que el navegador inicie sesión con Supabase Auth (D-39). Es pública y nunca incluye llaves secretas.

## Endpoints públicos

No requieren sesión. Los listados aceptan `?pagina` (desde 1) y `?limite` (1 a 100, por defecto 20) y responden `{ datos, paginacion }`. Las coordenadas salen como `ubicacion: { lat, lng }` (D-22).

| Ruta | Filtros |
|---|---|
| `GET /api/v1/puntos` | `tipo`, `gravedad_minima` (1 a 5) |
| `GET /api/v1/puntos/cercanos` | `lat`, `lng` (obligatorios), `radio_metros` (1 a 50000, por defecto 5000), `tipo`, `limite` |
| `GET /api/v1/puntos/:id` | Incluye las acciones activas del punto (con `de_la_comunidad`). 404 si no existe o no está publicado |
| `GET /api/v1/acciones` | `tipo` (denuncia, firma, donacion, voluntariado, evento), `punto_id`. `de_la_comunidad` indica si la agregó una persona y no el catálogo oficial |
| `GET /api/v1/organizaciones` | `zona` (búsqueda parcial). Nunca incluye el contacto |

Solo se muestran puntos publicados, y acciones y organizaciones activas. Lo decide RLS en la base, no solo el código.

## Aportes y moderación

Requieren `Authorization: Bearer <token>`. Corren con la sesión del usuario, así que las políticas de la base deciden además del rol (D-15).

| Ruta | Quién | Qué hace |
|---|---|---|
| `POST /api/v1/aportes` | Cualquier cuenta activa | Crea un aporte pendiente. Se quitan correos y teléfonos de la descripción (D-24). Opcional `enlaces`: hasta 3 `{tipo, nombre, enlace}` (https) que se publican en el punto al aprobar o marcar duplicado (D-40) |
| `POST /api/v1/puntos/:id/acciones` | Cualquier cuenta activa | Agrega un enlace para ayudar (`tipo`, `nombre`, `enlace` https, opcional `descripcion`) a un punto publicado; se publica al momento. Máximo 10 por cuenta al día y sin repetir el mismo enlace en un punto (D-40) |
| `DELETE /api/v1/admin/acciones/:id` | Moderador, editor, administrador | Retira un enlace o acción: queda inactivo y auditado (D-40) |
| `GET /api/v1/aportes/mis` | Cualquier cuenta activa | Aportes propios, paginados |
| `POST /api/v1/aportes/:id/evidencia` | El autor del aporte | Foto de evidencia (multipart, campo `foto`; JPG, PNG o WebP de hasta 8 MB). Una sola por aporte y solo si está pendiente |
| `GET /api/v1/admin/aportes` | Moderador, administrador | Cola por `estado` (por defecto `pendiente`) |
| `PATCH /api/v1/admin/aportes/:id/revision` | Moderador, administrador | `aprobado` (crea o actualiza el punto; `titulo` obligatorio si es nuevo), `rechazado` (exige `motivo_revision`) o `duplicado` (exige `duplicado_de`). El autor no puede revisar su propio aporte |
| `POST /api/v1/admin/puntos` | Moderador, administrador | Crea un punto. El moderador solo en revisión |
| `PATCH /api/v1/admin/puntos/:id/estado` | Moderador, administrador | Publica o archiva. Solo el administrador reabre un archivado |

Cada cambio de estado queda en `auditoria` mediante triggers (D-23).

### Fotos de evidencia

Las fotos se guardan en el bucket privado `evidencias` de Supabase Storage (lo crea la migración 009). Antes de guardarlas, el backend les quita la ubicación GPS y los datos de la cámara, y las reduce a 1600 px. En las respuestas, cada aporte trae `evidencia: null` o `evidencia: { url, expira_en_segundos: 600 }`: el enlace caduca a los 10 minutos y hay que volver a pedir el aporte para obtener otro. Las fotos nunca aparecen en los endpoints públicos (D-27).

Ejemplo con curl:

```bash
curl -X POST http://localhost:3000/api/v1/aportes/<id>/evidencia \
  -H "Authorization: Bearer <token>" -F "foto=@foto.jpg"
```

## Administración

Requieren sesión. Las acciones y organizaciones las gestionan el editor y el administrador; usuarios, roles y auditoría, solo el administrador.

| Ruta | Quién | Qué hace |
|---|---|---|
| `POST /api/v1/admin/acciones` | Editor, administrador | Crea una acción (`tipo`, `nombre`, opcionales `descripcion`, `enlace` https, `organizacion_id`, `punto_id` de un punto publicado) |
| `POST /api/v1/admin/organizaciones` | Editor, administrador | Crea una organización (`nombre`, opcionales `contacto` interno y `zona`) |
| `GET /api/v1/admin/usuarios` | Administrador | Lista con correo, sin teléfono. Filtros `rol` y `busqueda` (nombre o correo) |
| `PATCH /api/v1/admin/usuarios/:id/rol` | Administrador | Cambia el rol. Nadie puede cambiar el suyo. Si el cambio da o quita el rol de administrador, responde 202 con una `solicitud` pendiente en vez de aplicarlo |
| `GET /api/v1/admin/solicitudes-rol` | Administrador | Solicitudes de administrador: pendientes y las resueltas en los últimos 30 días |
| `PATCH /api/v1/admin/solicitudes-rol/:id` | Administrador | `{ "aprobar": true }` confirma (solo otro administrador); `false` rechaza o, si es tuya, cancela |
| `GET /api/v1/admin/metricas` | Administrador | Conteos de puntos, reportes, tiempo de revisión, cuentas, catálogo y asistente. Sin datos personales |
| `GET /api/v1/admin/auditoria` | Administrador | Registros del más reciente al más antiguo. Filtros `tabla`, `accion`, `usuario_id`, `registro_id`, `desde`, `hasta` (fechas ISO) |

Cada creación, cambio o borrado de acciones y organizaciones, y cada cambio de rol, activación o solicitud de administrador, deja un registro en `auditoria` (triggers de las migraciones 010 y 014).

### Dos administradores para cambiar administradores (migración 014)

Dar o quitar el rol de administrador lo confirma **otro** administrador: así una sola cuenta robada o un error no deja a la plataforma sin control. La regla vive en un trigger de la base, de modo que aplica también a quien use la API de Supabase directo.

- Quien pide el cambio no puede confirmarlo. La persona a la que le quitan el rol sí puede confirmarlo (es su consentimiento).
- Si solo hay un administrador activo, puede nombrar al segundo sin confirmación.
- A un administrador no se le desactiva directamente: primero se le quita el rol con esta regla.
- Las solicitudes vencen a los 7 días, y no se aplican si el rol cambió mientras tanto o si quien la pidió ya no es administrador.
- Los cambios entre ciudadano, moderador y editor siguen siendo inmediatos.
- La llave de servicio (Supabase → SQL Editor) no tiene la regla: es la vía para recuperar el acceso.

### Nombrar al primer administrador

Como nadie puede darse un rol a sí mismo, el primero se nombra en Supabase → SQL Editor, con el correo de tu cuenta:

```sql
update perfiles set rol = 'administrador'
where id = (select id from auth.users where email = 'tu-correo@ejemplo.com');
```

Después, ese administrador cambia los demás roles desde la API y nombra al segundo administrador (inmediato mientras sea el único). Desde ahí, cualquier cambio de administrador necesita a los dos.

## Agente

`POST /api/v1/agente/consulta` con `{ "pregunta": "...", "ubicacion": { "lat": 20.67, "lng": -103.35 } }` (pregunta de 3 a 1000 caracteres; `ubicacion` es opcional). Es público; si viene un token, la conversación se asocia al usuario. Responde `{ respuesta, modelo, aviso, puntos, respaldo }`. Límite: `LIMITE_AGENTE_POR_MINUTO` consultas por minuto por persona (429 al pasarlo). Todavía no consulta documentos propios (RAG, F14).

Desde F13 Gemini usa herramientas de solo lectura sobre el mapa (`src/modulos/agente/herramientas.ts`): `buscar_puntos` (por tipo, gravedad, cerca de la persona o de un lugar de México), `detalle_punto`, `buscar_acciones` y `buscar_organizaciones`. Todas usan la llave pública, así que ven lo mismo que un visitante. El ciclo hace como máximo 4 pasos y 5 herramientas por paso. `puntos` trae los puntos que encontró, para que el mapa los muestre.

- **Ubicación:** la manda el navegador solo si la persona marca «Usar mi ubicación» (redondeada a unos 100 m). Se queda en el servidor: Gemini solo pide `cerca_de_mi` y nunca recibe las coordenadas, y no se guarda en la conversación.
- **Respaldo sin IA:** si Gemini no responde (cuota agotada, caída o error), el servidor busca por palabras clave en el mapa y responde con una lista fija, `modelo: "respaldo-sin-ia"` y `respaldo: true`. Una pregunta bloqueada por seguridad (422) no pasa al respaldo.
- **Base de conocimiento (F14):** con la herramienta `buscar_conocimiento`, Gemini consulta documentos de fuentes confiables que cargó el personal y la respuesta trae `fuentes` (título, fuente, enlace y fecha) para citarlas. Los documentos se buscan por parecido (embeddings `gemini-embedding-001` de 768 dimensiones, `GEMINI_MODELO_EMBEDDINGS`); solo se usan los activos.
- **Evaluación:** `npm run evaluar:agente` hace 20 preguntas de prueba al agente real (Gemini y la base con la llave pública) y guarda el informe en `docs/evaluaciones/`. Gasta unas 40 llamadas de cuota; aprueba con 18 de 20. `-- --limite=3` hace una prueba rápida. Espera 30 s entre preguntas; si Google responde 429 (límite por minuto del plan gratuito) reintenta tras 30 s, y si tres preguntas seguidas chocan con el límite se detiene, porque casi seguro se acabó la cuota diaria. `-- --pausa=60` espera más.

`GET /api/v1/salud/ia` (solo administrador) comprueba que la llave y el modelo responden, sin generar texto. Con `?generar=1` además pide una respuesta corta real (gasta un poco de cuota) y la muestra en `prueba`.

Para comprobar la llave sin gastar cuota: `npm run verificar:gemini`. Muestra si es válida, si el modelo de `GEMINI_MODELO` existe y qué modelos "flash" hay.

La respuesta es texto generado por IA: el frontend debe mostrarla como texto (no como HTML) y con el aviso (D-33).

### Base de conocimiento

Editor y administrador (migración 013):

| Ruta | Qué hace |
|---|---|
| `GET /api/v1/admin/conocimiento` | Lista los documentos (activos e inactivos) con cuántos fragmentos tiene cada uno |
| `POST /api/v1/admin/conocimiento` | `{ titulo, fuente, enlace?, fecha_fuente?, texto }`. El servidor parte el texto (hasta 40 000 caracteres) en fragmentos de unos 1 200 caracteres, calcula sus embeddings con Gemini y los guarda en una sola transacción. 503 si Gemini no responde (no guarda nada) |
| `PATCH /api/v1/admin/conocimiento/:id` | `{ activo }`: un documento inactivo deja de usarse en las respuestas |

En el prototipo: Administración → «Base de conocimiento». Cada carga, cambio de estado o borrado queda en la auditoría. Cargar un documento gasta una llamada de embeddings por cada 100 fragmentos.

## Seguridad

- **Cabeceras:** helmet en todas las respuestas (CSP, HSTS, `nosniff`, sin `X-Powered-By`).
- **CORS:** solo los orígenes de `CORS_ORIGENES`, separados por comas. Las solicitudes sin `Origin` (curl, el health check de Render) no son de navegador y pasan.
- **Límites:** `LIMITE_SOLICITUDES_POR_MINUTO` por IP para toda la API, salvo `/salud` (D-34), y `LIMITE_AGENTE_POR_MINUTO` para el agente. Al pasarlos, 429 `LIMITE_EXCEDIDO`. Detrás de Render hay que poner `PROXIES_DE_CONFIANZA=1` (D-32).
- **Cuerpos:** JSON de hasta 100 KB (413 si es más grande, 415 si el charset no es válido); fotos de hasta 8 MB.
- **Errores:** siempre `{ error: { codigo, mensaje, detalles } }`. Un 500 nunca trae stack, rutas de archivos ni mensajes de la base.
- **Registro:** cada respuesta lleva `X-Id-Solicitud`. El registro guarda id, método, ruta, código y duración; nunca cuerpos, tokens, correos ni teléfonos (D-35).
- **Llaves:** la llave de servicio de Supabase, el secreto JWT y la llave de Gemini solo viven en el backend (`.env`, nunca en el repositorio ni en el frontend). La única que llega al navegador es la llave pública *anon* de Supabase, que está hecha para eso y queda limitada por RLS (D-39). La prueba `secretos.test.ts` falla si algún archivo trae una llave, un token o una contraseña.
- **Dependencias:** `npm audit` debe quedar limpio, salvo lo anotado en D-36 (zod 4 pendiente).

## Integración continua

`.github/workflows/ci.yml` corre en cada push y pull request a `main`: `typecheck`, `lint`, `build`, todas las pruebas con cobertura y `npm audit` (falla solo con vulnerabilidades críticas, D-36). Las pruebas de base de datos usan un PostgreSQL 16 con PostGIS y pgvector que GitHub crea y borra en cada corrida; nunca tocan Supabase.

Las pruebas contra Supabase corren solo si el repositorio tiene estos secretos de un proyecto **de pruebas** (Settings → Secrets and variables → Actions): `PRUEBAS_SUPABASE_URL`, `PRUEBAS_SUPABASE_ANON_KEY`, `PRUEBAS_SUPABASE_SERVICE_ROLE_KEY`, `PRUEBAS_SUPABASE_JWT_SECRET` y, opcionales, `PRUEBAS_SUPABASE_EMAIL` y `PRUEBAS_SUPABASE_CLAVE`. Sin ellos, ese paso se omite con un aviso. No pongas ahí las llaves de producción.

## Respaldos y mantenimiento

- **Respaldos:** `.github/workflows/respaldo.yml` respalda la base los lunes y jueves, cifrada con AES-256, la prueba restaurándola en una base desechable y la guarda 90 días. Necesita los secretos `RESPALDO_DATABASE_URL` y `RESPALDO_CLAVE`. Cómo configurarlo, abrir un respaldo y restaurar: `docs/respaldos.md`. Las fotos no se respaldan.
- **Pausa de Supabase:** el plan gratuito pausa el proyecto tras 7 días sin actividad; el respaldo se conecta dos veces por semana y lo evita.
- **Dependencias:** Dependabot (`.github/dependabot.yml`) abre un pull request semanal con actualizaciones de npm y uno mensual de las acciones de GitHub, solo con versiones publicadas hace 14 días o más. La CI las prueba; se fusionan a mano.

## Despliegue en Render

`render.yaml` define el servicio web (plan Free, región Virginia, cerca de la base):

- Compila con `npm ci --include=dev && npm run build` y arranca con `npm start` (D-37).
- Render comprueba `GET /api/v1/salud`. Responde 200 aunque la base falle (con `estado: "degradado"`), para que Render no reinicie el servicio por una caída de Supabase (D-07).
- Node 22, fijado en `.node-version`.
- `NODE_ENV=production` y `PROXIES_DE_CONFIANZA=1` vienen en el archivo. Los secretos no: Render los pide en el panel al crear el servicio.

Pasos (los haces tú, con tu cuenta):

1. En render.com → **New → Blueprint**, elige el repositorio. Render lee `render.yaml`.
2. Escribe en el panel los valores de `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `GEMINI_API_KEY` y `CORS_ORIGENES` (mientras no haya frontend, `http://localhost:5173`). `DATABASE_URL` **no** va en Render: solo sirve para migrar desde tu PC.
3. Al terminar el despliegue, abre `https://<tu-servicio>.onrender.com/api/v1/salud`: debe responder `{"estado":"ok","base":"ok"}`.

Cada push a `main` vuelve a desplegar. Las migraciones nuevas se siguen aplicando desde tu PC con `npm run migrar`, **antes** de subir el código que las usa.

### Sitio público (F12)

`render.yaml` define un segundo servicio, `plataforma-ambiental`: un sitio estático gratuito que publica la carpeta `prototipo/` tal cual, sin compilar, y solo se vuelve a desplegar cuando cambia algo dentro de ella. Envía una política de contenido (CSP) que solo permite los orígenes que usa la página; `tests/unitarias/sitio-publico.test.ts` falla si la página empieza a usar un origen que la política bloquearía. En ese dominio la página entra sola en modo real: sin selector de datos de ejemplo, con textos para el público y con el aviso de privacidad.

Pasos (los haces tú, una vez):

1. En Render, abre el Blueprint del proyecto y pulsa **Sync** (o **Manual sync**) para que cree el servicio `plataforma-ambiental`. Anota su URL (`https://plataforma-ambiental.onrender.com` o la que Render le asigne).
2. En el servicio del backend → **Environment**, agrega esa URL a `CORS_ORIGENES`, separada por coma de `http://localhost:5173`. Guarda: Render reinicia el backend.
3. En Supabase → **Authentication → URL Configuration**: pon la URL del sitio en **Site URL** y agrega `https://<tu-sitio>.onrender.com/**` en **Redirect URLs** (deja también `http://localhost:5173/**`). Así el correo de confirmación regresa al sitio público.
4. Abre el sitio desde tu teléfono, crea una cuenta y envía un reporte de prueba.

### Rutas y accesibilidad (F16)

El detalle de cada punto trae «Cómo llegar» con enlaces a Google Maps y OpenStreetMap que solo llevan las coordenadas del destino: la ruta la calcula el navegador de la persona y la plataforma nunca recibe su ubicación. El sitio cumple WCAG 2.1 AA según axe-core (claro, oscuro, alto contraste y teléfono) y se puede usar entero con el teclado. El botón «Alto contraste» del encabezado recuerda la elección y se activa solo si el sistema pide más contraste.

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor en desarrollo con recarga |
| `npm run build` | Compila a `dist/` |
| `npm start` | Ejecuta `dist/server.js` |
| `npm run typecheck` | Revisa tipos (src y pruebas) |
| `npm run migrar` | Aplica las migraciones pendientes a `DATABASE_URL` |
| `npm run verificar:gemini` | Comprueba la llave de Gemini sin gastar cuota |
| `npm run evaluar:agente` | Hace 20 preguntas de prueba al agente real (gasta cuota) |
| `npm run lint` | Revisa estilo y errores |
| `npm test` | Ejecuta las pruebas |
| `npm run test:cobertura` | Pruebas con cobertura (meta 70 %) |

## Documentación

- `docs/auditoria.md`: estado del proyecto frente al prompt
- `docs/plan-de-trabajo.md`: fases y criterios de aceptación
- `docs/decisiones-pendientes.md`: decisiones abiertas y supuestos
- `docs/incidencias.md`: fallos de pruebas
- `docs/pruebas-manuales.md`: casos para probar sin programar
- `docs/respaldos.md`: respaldos, cómo abrirlos y cómo restaurar

## Riesgos conocidos

- El plan gratuito de Render se duerme tras 15 minutos sin tráfico. La primera petición después de eso puede tardar cerca de un minuto. Para el piloto se acepta; avísalo a quienes lo prueben. Ver D-02.
- El límite de solicitudes se cuenta en memoria: se reinicia cuando Render duerme o redespliega el servicio (D-34).
