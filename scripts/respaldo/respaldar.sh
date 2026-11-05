#!/usr/bin/env bash
# Respaldo cifrado de la base (F15, B-06). Lo corre la acción «Respaldo semanal» de GitHub.
#
#   RESPALDO_DATABASE_URL=… RESPALDO_CLAVE=… scripts/respaldo/respaldar.sh <carpeta>
#
# Deja en <carpeta> un archivo respaldo-<fecha>.tar.gpg cifrado con AES-256 (gpg simétrico) que
# contiene:
#   app.dump        esquemas public y esquema_migraciones (estructura, datos, permisos y políticas)
#   cuentas.dump    datos de auth.users y auth.identities (cuentas de Supabase Auth)
#   usuarios.csv    solo los id de auth.users, para la prueba de restauración
#   extensiones.txt en qué esquema está cada extensión (postgis, vector, pgcrypto)
#   conteos.txt     filas por tabla al momento del respaldo, para comparar al restaurar
#   auth-triggers.sql los triggers del proyecto sobre auth.users (crean el perfil al registrarse),
#                   que pg_dump no guarda con el esquema public
#   storage.sql     la definición de los buckets de Storage (sin los archivos)
# No incluye las fotos (Storage): ver docs/respaldos.md.
# La clave y la URL nunca se imprimen: van por variables de entorno y la clave por un descriptor.
set -euo pipefail

salida=${1:?"Uso: respaldar.sh <carpeta de salida>"}
: "${RESPALDO_DATABASE_URL:?Falta RESPALDO_DATABASE_URL}"
: "${RESPALDO_CLAVE:?Falta RESPALDO_CLAVE}"
if [ "${#RESPALDO_CLAVE}" -lt 20 ]; then
  echo "RESPALDO_CLAVE debe tener al menos 20 caracteres." >&2
  exit 1
fi

mkdir -p "$salida"
fecha=$(date -u +%Y-%m-%dT%H%MZ)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

consulta() { psql "$RESPALDO_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -At -c "$1"; }

# Conteos y extensiones primero: si los datos cambian durante el volcado, la prueba de
# restauración solo exige que lo restaurado tenga al menos estas filas.
consulta "select e.extname || ' ' || n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
          where e.extname in ('postgis', 'vector', 'pgcrypto') order by 1" > "$tmp/extensiones.txt"
consulta "select string_agg(format('select %L || '' '' || count(*) from %I.%I', table_schema || '.' || table_name, table_schema, table_name), ' union all ' order by table_schema, table_name)
          from information_schema.tables
          where table_schema in ('public', 'esquema_migraciones') and table_type = 'BASE TABLE'
            and table_name <> 'spatial_ref_sys'" > "$tmp/conteos.sql"
consulta "$(cat "$tmp/conteos.sql")" | sort > "$tmp/conteos.txt"
rm "$tmp/conteos.sql"

pg_dump "$RESPALDO_DATABASE_URL" --format=custom --no-owner --schema=public --schema=esquema_migraciones \
  --exclude-table=public.spatial_ref_sys --file="$tmp/app.dump"
pg_dump "$RESPALDO_DATABASE_URL" --format=custom --no-owner --data-only \
  --table=auth.users --table=auth.identities --file="$tmp/cuentas.dump"
consulta "select id from auth.users order by id" > "$tmp/usuarios.csv"
# Con search_path vacío, pg_get_triggerdef escribe los nombres con su esquema.
psql "$RESPALDO_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -At -c "set search_path = ''" \
  -c "select pg_get_triggerdef(t.oid) || ';' from pg_trigger t
      where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal order by t.tgname" > "$tmp/auth-triggers.sql"
: > "$tmp/storage.sql"
if [ "$(consulta "select to_regclass('storage.buckets') is not null")" = "t" ]; then
  consulta "select format('insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values (%L, %L, %L, %s, %L) on conflict (id) do nothing;',
                          id, name, public, coalesce(file_size_limit::text, 'null'), allowed_mime_types)
            from storage.buckets order by id" > "$tmp/storage.sql"
fi

archivo="$salida/respaldo-$fecha.tar.gpg"
tar -C "$tmp" -cf - . | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 \
  --symmetric --cipher-algo AES256 --output "$archivo" 3<<<"$RESPALDO_CLAVE"

echo "Respaldo listo: $(basename "$archivo") ($(du -h "$archivo" | cut -f1))"
echo "Tablas: $(wc -l < "$tmp/conteos.txt"), cuentas: $(wc -l < "$tmp/usuarios.csv")"
