#!/usr/bin/env bash
# Prueba que un respaldo se puede restaurar (F15, B-06). Corre después de cada respaldo.
#
#   RESPALDO_CLAVE=… PRUEBA_DATABASE_URL=postgresql://postgres@127.0.0.1/postgres \
#     scripts/respaldo/probar-restauracion.sh <respaldo.tar.gpg>
#
# PRUEBA_DATABASE_URL es un PostgreSQL DESECHABLE con PostGIS y pgvector (nunca producción):
# se crea una base temporal, se restaura ahí, se comparan los conteos y se borra.
set -euo pipefail

archivo=${1:?"Uso: probar-restauracion.sh <respaldo.tar.gpg>"}
: "${RESPALDO_CLAVE:?Falta RESPALDO_CLAVE}"
: "${PRUEBA_DATABASE_URL:?Falta PRUEBA_DATABASE_URL}"
export PGOPTIONS="-c client_min_messages=warning"
raiz=$(cd "$(dirname "$0")/../.." && pwd)

tmp=$(mktemp -d)
base="restauracion_$(date +%s)_$$"
limpiar() {
  psql "$PRUEBA_DATABASE_URL" -X -q -c "drop database if exists $base" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap limpiar EXIT

gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt "$archivo" 3<<<"$RESPALDO_CLAVE" | tar -C "$tmp" -xf -
for f in app.dump cuentas.dump usuarios.csv extensiones.txt conteos.txt auth-triggers.sql storage.sql; do
  [ -f "$tmp/$f" ] || { echo "El respaldo no trae $f" >&2; exit 1; }
done
pg_restore --list "$tmp/cuentas.dump" | grep -q "TABLE DATA auth users" || { echo "cuentas.dump no trae auth.users" >&2; exit 1; }

psql "$PRUEBA_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 -c "create database $base" >/dev/null
url=$(python3 -c 'import sys, urllib.parse as u; p = u.urlsplit(sys.argv[1]); print(u.urlunsplit(p._replace(path="/" + sys.argv[2])))' "$PRUEBA_DATABASE_URL" "$base")
sql() { psql "$url" -X -q -v ON_ERROR_STOP=1 "$@"; }

# Lo que Supabase ya trae: roles, esquema auth (simulado) y las extensiones en su esquema.
sql -f "$raiz/tests/ayudas/base-local.sql" >/dev/null
while read -r ext esquema; do
  sql -c "create schema if not exists \"$esquema\"; create extension if not exists \"$ext\" schema \"$esquema\"" >/dev/null
done < "$tmp/extensiones.txt"
sql -c "\copy auth.users (id) from '$tmp/usuarios.csv'" >/dev/null

# El esquema public ya existe en cualquier base nueva: se quita de la lista para no fallar.
pg_restore --list "$tmp/app.dump" | grep -v ' SCHEMA - public ' > "$tmp/lista"
pg_restore --dbname="$url" --no-owner --exit-on-error --use-list="$tmp/lista" "$tmp/app.dump"

fallas=0
while read -r tabla esperado; do
  real=$(sql -At -c "select count(*) from $tabla")
  # Los conteos y los volcados salen de la misma instantánea: tienen que coincidir exactamente.
  if [ "$real" -ne "$esperado" ]; then
    echo "FALLA $tabla: $real filas restauradas, se esperaban $esperado" >&2
    fallas=$((fallas + 1))
  fi
done < "$tmp/conteos.txt"
[ "$fallas" -eq 0 ] || exit 1

# Cada cuenta respaldada tiene su perfil (si no, la API rechaza sus peticiones).
sin_perfil=$(sql -At -c "select count(*) from auth.users u where not exists (select 1 from perfiles p where p.id = u.id)")
[ "$sin_perfil" = "0" ] || { echo "FALLA: $sin_perfil cuentas restauradas sin perfil" >&2; exit 1; }

# Los triggers sobre auth.users: una cuenta nueva debe recibir su perfil, como en producción.
# (storage.sql no se prueba aquí: este PostgreSQL no tiene el esquema storage de Supabase.)
grep -q "perfil_al_registrar" "$tmp/auth-triggers.sql" || { echo "El respaldo no trae el trigger de registro de auth.users" >&2; exit 1; }
sql -f "$tmp/auth-triggers.sql" >/dev/null
nueva=$(python3 -c 'import uuid; print(uuid.uuid4())')
sql -c "insert into auth.users (id) values ('$nueva')" >/dev/null
[ "$(sql -At -c "select count(*) from perfiles where id = '$nueva'")" = "1" ] \
  || { echo "El trigger de registro no creó el perfil de una cuenta nueva" >&2; exit 1; }

# Una consulta real de la API sobre lo restaurado, como visitante.
sql -At -c "begin; set local role anon; select (listar_puntos_publicos(null, null, 1, 0) ->> 'total') is not null; rollback;" | grep -q t \
  || { echo "La función pública no respondió sobre la base restaurada" >&2; exit 1; }

echo "Restauración correcta: $(wc -l < "$tmp/conteos.txt") tablas con sus filas y $(wc -l < "$tmp/usuarios.csv") cuentas."
