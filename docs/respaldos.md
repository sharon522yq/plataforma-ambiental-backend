# Respaldos de la base

La acción **Respaldo** de GitHub (`.github/workflows/respaldo.yml`) respalda la base de producción los lunes y jueves a las 03:00 de Guadalajara, y también cuando la lanzas a mano. Cada respaldo:

1. Se cifra con AES-256 usando una frase que solo tú conoces (`RESPALDO_CLAVE`). Sin esa frase nadie puede abrirlo, ni siquiera GitHub.
2. Sale de una sola instantánea de la base: las tablas, las cuentas y los conteos son del mismo instante, aunque alguien se registre mientras corre.
3. **Se prueba antes de guardarse:** se restaura en un PostgreSQL desechable con PostGIS y pgvector, se comparan las filas de cada tabla (tienen que coincidir exactamente), se comprueba que cada cuenta tenga su perfil, se comprueba que una cuenta nueva reciba su perfil y se hace una consulta real de la API sobre lo restaurado. Si algo no cuadra, la acción falla en rojo y GitHub te avisa por correo.
4. Se guarda como artefacto de la corrida durante 90 días.

Además, al conectarse dos veces por semana, evita que Supabase pause el proyecto gratuito por inactividad (B-13).

## Qué incluye y qué no

| Incluye | No incluye |
|---|---|
| Todas las tablas del proyecto con sus datos (puntos, aportes, acciones, organizaciones, perfiles, auditoría, base de conocimiento, conversaciones, solicitudes de rol) | **Las fotos de evidencia** (Supabase Storage). Ver «Fotos» abajo |
| Funciones, triggers, políticas RLS y permisos | Las contraseñas en texto: Supabase solo guarda su huella, que sí va en el respaldo |
| El registro de migraciones aplicadas | La configuración del panel de Supabase (URLs de Auth, plantillas de correo) |
| Las cuentas de Supabase Auth (`auth.users` y `auth.identities`) | |

El archivo es `respaldo-AAAA-MM-DDTHHMMZ.tar.gpg` y adentro trae `app.dump` (esquema y datos), `cuentas.dump` (cuentas), `auth-triggers.sql` (el trigger que crea el perfil al registrarse), `storage.sql` (el bucket de fotos, sin archivos), `conteos.txt`, `extensiones.txt` y `usuarios.csv`.

## Configurarlo (paso M11, lo haces tú una vez)

1. **Cadena de conexión.** En Supabase → **Project Settings → Database → Connection string**, elige **Session pooler** (no «Direct connection»: esa es solo IPv6 y GitHub no la alcanza). Copia la cadena y cambia `[YOUR-PASSWORD]` por la contraseña de la base.
2. **Frase de cifrado.** Inventa una frase larga (20 caracteres o más, por ejemplo cuatro palabras al azar con números). **Guárdala en tu gestor de contraseñas:** si la pierdes, los respaldos no se pueden abrir.
3. En GitHub → el repositorio → **Settings → Secrets and variables → Actions → New repository secret**, crea:
   - `RESPALDO_DATABASE_URL` con la cadena del paso 1.
   - `RESPALDO_CLAVE` con la frase del paso 2.
4. En **Actions → Respaldo → Run workflow**, lánzalo una vez. Debe terminar en verde con «Restauración correcta: N tablas con sus filas y M cuentas».

Sin esos secretos la acción no falla: termina en verde con el aviso «Faltan los secretos».

## Descargar y abrir un respaldo

En **Actions → Respaldo**, abre la corrida que quieras y descarga el artefacto `respaldo-…` (GitHub lo entrega en un .zip). Para abrirlo hace falta `gpg` (en Windows viene con Git for Windows, en la terminal «Git Bash»):

```bash
unzip respaldo-123456789.zip
gpg --decrypt respaldo-2026-11-06T0900Z.tar.gpg | tar -xf -   # pide la frase
```

## Restaurar de verdad

Solo si se perdió la base de producción. Es mejor restaurar en un **proyecto nuevo** de Supabase y luego cambiar las variables de Render, que encima del proyecto dañado.

1. Crea el proyecto nuevo en Supabase (misma región).
2. Abre el respaldo como arriba y restaura con la cadena **Session pooler** del proyecto nuevo, con un `pg_restore` de la versión 17 o más nueva (la de Supabase):

   ```bash
   DESTINO='postgresql://postgres.xxxx:TU_CLAVE@aws-0-us-east-1.pooler.supabase.com:5432/postgres'
   pg_restore --dbname="$DESTINO" --no-owner --data-only cuentas.dump                # 1. cuentas
   pg_restore --list app.dump | grep -v ' SCHEMA - public ' > lista
   pg_restore --dbname="$DESTINO" --no-owner --use-list=lista app.dump               # 2. tablas, funciones y datos
   psql "$DESTINO" -f auth-triggers.sql -f storage.sql                               # 3. trigger de registro y bucket
   ```

   Las cuentas van primero porque los perfiles apuntan a ellas. `auth-triggers.sql` vuelve a crear el trigger que da un perfil a cada cuenta nueva, y `storage.sql` el bucket privado de fotos (vacío). Si `pg_restore` avisa de objetos que el proyecto nuevo ya trae (por ejemplo, extensiones), revisa que el resto termine sin errores.
3. Compara las filas con `conteos.txt`: `select count(*) from puntos;` y así con cada tabla.
4. En Render cambia `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` y `SUPABASE_JWT_SECRET` por los del proyecto nuevo; en tu `.env`, `DATABASE_URL`. En Supabase → Authentication → URL Configuration vuelve a poner la URL del sitio.
5. Prueba entrar con una cuenta existente y enviar un reporte.

Esta restauración completa en un proyecto de Supabase **no se ha ensayado todavía** (la acción ensaya la restauración en un PostgreSQL normal). Si un día se usa, anota en `docs/incidencias.md` cualquier paso que haya cambiado.

## Fotos

Las fotos de evidencia no van en el respaldo: Supabase Storage no se exporta con `pg_dump`, y guardarlas en GitHub las expondría más. Son evidencia de apoyo para moderar, no el dato principal (el punto publicado sí está respaldado). Si un día hacen falta, se descargan desde Supabase → Storage → `evidencias`.

## Probar la restauración en tu PC

Con un PostgreSQL local que tenga PostGIS y pgvector (nunca producción):

```bash
RESPALDO_CLAVE='…' PRUEBA_DATABASE_URL=postgresql://postgres@127.0.0.1/postgres \
  scripts/respaldo/probar-restauracion.sh respaldo-2026-11-06T0900Z.tar.gpg
```

Crea una base temporal, restaura, compara y la borra al terminar.
