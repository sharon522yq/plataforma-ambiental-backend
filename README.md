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
