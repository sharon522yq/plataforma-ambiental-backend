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
| `GET /api/v1/puntos` | `tipo`, `gravedad_min` (1 a 5) |
| `GET /api/v1/puntos/cercanos` | `lat`, `lng` (obligatorios), `radio` en metros (1 a 50000, por defecto 5000), `tipo`, `limite` |
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
| `PATCH /api/v1/admin/aportes/:id/revision` | Moderador, administrador | `aprobado` (crea o actualiza el punto; `titulo` obligatorio si es nuevo), `rechazado` (exige `motivo`) o `duplicado` (exige `duplicado_de`). El autor no puede revisar su propio aporte |
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

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor en desarrollo con recarga |
| `npm run build` | Compila a `dist/` |
| `npm start` | Ejecuta `dist/server.js` |
| `npm run typecheck` | Revisa tipos (src y pruebas) |
| `npm run migrar` | Aplica las migraciones pendientes a `DATABASE_URL` |
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

- El plan gratuito de Render se duerme tras 15 minutos sin tráfico. La primera petición tarda más. Ver D-02.
