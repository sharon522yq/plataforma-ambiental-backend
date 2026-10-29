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

## Endpoints públicos

No requieren sesión. Los listados aceptan `?pagina` (desde 1) y `?limite` (1 a 100, por defecto 20) y responden `{ datos, paginacion }`. Las coordenadas salen como `ubicacion: { lat, lng }` (D-22).

| Ruta | Filtros |
|---|---|
| `GET /api/v1/puntos` | `tipo`, `gravedad_minima` (1 a 5) |
| `GET /api/v1/puntos/cercanos` | `lat`, `lng` (obligatorios), `radio_metros` (1 a 50000, por defecto 5000), `tipo`, `limite` |
| `GET /api/v1/puntos/:id` | Incluye las acciones activas del punto. 404 si no existe o no está publicado |
| `GET /api/v1/acciones` | `tipo` (denuncia, firma, donacion, voluntariado), `punto_id` |
| `GET /api/v1/organizaciones` | `zona` (búsqueda parcial). Nunca incluye el contacto |

Solo se muestran puntos publicados, y acciones y organizaciones activas. Lo decide RLS en la base, no solo el código.

## Aportes y moderación

Requieren `Authorization: Bearer <token>`. Corren con la sesión del usuario, así que las políticas de la base deciden además del rol (D-15).

| Ruta | Quién | Qué hace |
|---|---|---|
| `POST /api/v1/aportes` | Cualquier cuenta activa | Crea un aporte pendiente. Se quitan correos y teléfonos de la descripción (D-24) |
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
| `PATCH /api/v1/admin/usuarios/:id/rol` | Administrador | Cambia el rol. Nadie puede cambiar el suyo |
| `GET /api/v1/admin/auditoria` | Administrador | Registros del más reciente al más antiguo. Filtros `tabla`, `accion`, `usuario_id`, `registro_id`, `desde`, `hasta` (fechas ISO) |

Cada creación, cambio o borrado de acciones y organizaciones, y cada cambio de rol o activación, deja un registro en `auditoria` (triggers de la migración 010).

### Nombrar al primer administrador

Como nadie puede darse un rol a sí mismo, el primero se nombra en Supabase → SQL Editor, con el correo de tu cuenta:

```sql
update perfiles set rol = 'administrador'
where id = (select id from auth.users where email = 'tu-correo@ejemplo.com');
```

Después, ese administrador cambia los demás roles desde la API.

## Agente

`POST /api/v1/agente/consulta` con `{ "pregunta": "..." }` (de 3 a 1000 caracteres). Es público; si viene un token, la conversación se asocia al usuario. Responde `{ respuesta, modelo, aviso }`. Límite: `LIMITE_AGENTE_POR_MINUTO` consultas por minuto por persona (429 al pasarlo). Todavía no consulta documentos propios (RAG, fase posterior).

`GET /api/v1/salud/ia` (solo administrador) comprueba que la llave y el modelo responden, sin generar texto. Con `?generar=1` además pide una respuesta corta real (gasta un poco de cuota) y la muestra en `prueba`.

Para comprobar la llave sin gastar cuota: `npm run verificar:gemini`. Muestra si es válida, si el modelo de `GEMINI_MODELO` existe y qué modelos "flash" hay.

La respuesta es texto generado por IA: el frontend debe mostrarla como texto (no como HTML) y con el aviso (D-33).

## Seguridad

- **Cabeceras:** helmet en todas las respuestas (CSP, HSTS, `nosniff`, sin `X-Powered-By`).
- **CORS:** solo los orígenes de `CORS_ORIGENES`, separados por comas. Las solicitudes sin `Origin` (curl, el health check de Render) no son de navegador y pasan.
- **Límites:** `LIMITE_SOLICITUDES_POR_MINUTO` por IP para toda la API, salvo `/salud` (D-34), y `LIMITE_AGENTE_POR_MINUTO` para el agente. Al pasarlos, 429 `LIMITE_EXCEDIDO`. Detrás de Render hay que poner `PROXIES_DE_CONFIANZA=1` (D-32).
- **Cuerpos:** JSON de hasta 100 KB (413 si es más grande, 415 si el charset no es válido); fotos de hasta 8 MB.
- **Errores:** siempre `{ error: { codigo, mensaje, detalles } }`. Un 500 nunca trae stack, rutas de archivos ni mensajes de la base.
- **Registro:** cada respuesta lleva `X-Id-Solicitud`. El registro guarda id, método, ruta, código y duración; nunca cuerpos, tokens, correos ni teléfonos (D-35).
- **Llaves:** la llave de servicio de Supabase y la de Gemini solo viven en el backend (`.env`, nunca en el repositorio ni en el frontend). La prueba `secretos.test.ts` falla si algún archivo trae una llave, un token o una contraseña.
- **Dependencias:** `npm audit` debe quedar limpio, salvo lo anotado en D-36 (zod 4 pendiente).

## Integración continua

`.github/workflows/ci.yml` corre en cada push y pull request a `main`: `typecheck`, `lint`, `build`, todas las pruebas con cobertura y `npm audit` (falla solo con vulnerabilidades críticas, D-36). Las pruebas de base de datos usan un PostgreSQL 16 con PostGIS y pgvector que GitHub crea y borra en cada corrida; nunca tocan Supabase.

Las pruebas contra Supabase corren solo si el repositorio tiene estos secretos de un proyecto **de pruebas** (Settings → Secrets and variables → Actions): `PRUEBAS_SUPABASE_URL`, `PRUEBAS_SUPABASE_ANON_KEY`, `PRUEBAS_SUPABASE_SERVICE_ROLE_KEY`, `PRUEBAS_SUPABASE_JWT_SECRET` y, opcionales, `PRUEBAS_SUPABASE_EMAIL` y `PRUEBAS_SUPABASE_CLAVE`. Sin ellos, ese paso se omite con un aviso. No pongas ahí las llaves de producción.

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

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor en desarrollo con recarga |
| `npm run build` | Compila a `dist/` |
| `npm start` | Ejecuta `dist/server.js` |
| `npm run typecheck` | Revisa tipos (src y pruebas) |
| `npm run migrar` | Aplica las migraciones pendientes a `DATABASE_URL` |
| `npm run verificar:gemini` | Comprueba la llave de Gemini sin gastar cuota |
| `npm run lint` | Revisa estilo y errores |
| `npm test` | Ejecuta las pruebas |
| `npm run test:cobertura` | Pruebas con cobertura (meta 70 %) |

## Documentación

- `docs/auditoria.md`: estado del proyecto frente al prompt
- `docs/plan-de-trabajo.md`: fases y criterios de aceptación
- `docs/decisiones-pendientes.md`: decisiones abiertas y supuestos
- `docs/incidencias.md`: fallos de pruebas
- `docs/pruebas-manuales.md`: casos para probar sin programar

## Riesgos conocidos

- El plan gratuito de Render se duerme tras 15 minutos sin tráfico. La primera petición después de eso puede tardar cerca de un minuto. Para el piloto se acepta; avísalo a quienes lo prueben. Ver D-02.
- El límite de solicitudes se cuenta en memoria: se reinicia cuando Render duerme o redespliega el servicio (D-34).
