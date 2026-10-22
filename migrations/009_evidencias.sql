-- 009: fotos de evidencia en los aportes (D-26, D-27).
-- Las fotos viven en un bucket PRIVADO de Supabase Storage. El backend las sube con la llave
-- de servicio después de quitarles los metadatos (GPS, cámara) y reducirlas. Nadie las ve
-- con un enlace permanente: el autor y los moderadores reciben enlaces temporales.

-- ---------------------------------------------------------------------------
-- Bucket privado. Solo existe en Supabase (esquema storage); en la base local de pruebas
-- no hay Storage y este bloque no hace nada.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage')
     and exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('evidencias', 'evidencias', false, 2097152, array['image/jpeg'])
    on conflict (id) do update
      set public = false, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg'];
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- La forma JSON de un aporte ahora incluye la ruta de su evidencia (no un enlace).
-- ---------------------------------------------------------------------------
create or replace function aporte_json(a aportes)
returns jsonb
language sql
stable
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'id', a.id, 'punto_id', a.punto_id, 'tipo', a.tipo, 'gravedad_sugerida', a.gravedad_sugerida,
    'descripcion', a.descripcion,
    'lat', st_y(a.ubicacion::geometry), 'lng', st_x(a.ubicacion::geometry),
    'estado', a.estado, 'motivo_revision', a.motivo_revision,
    'evidencia_ruta', a.evidencia_url,
    'creado_en', a.creado_en, 'actualizado_en', a.actualizado_en
  )
$$;

-- ---------------------------------------------------------------------------
-- Adjuntar la evidencia a un aporte propio y pendiente, una sola vez.
-- security definer porque el ciudadano no tiene política de UPDATE sobre aportes
-- (y no debe tenerla: podría cambiar la descripción o la ubicación). Por eso esta
-- función solo toca evidencia_url y comprueba todo a mano.
-- La ruta debe estar dentro de la carpeta del usuario: <uid>/<aporte>.jpg
-- ---------------------------------------------------------------------------
create or replace function adjuntar_evidencia(aporte_id uuid, ruta text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  a aportes;
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión' using errcode = '42501', hint = 'publico';
  end if;
  if ruta is null or ruta <> auth.uid()::text || '/' || aporte_id::text || '.jpg' then
    raise exception 'Ruta de evidencia no válida' using errcode = '22023', hint = 'publico';
  end if;

  select * into a from aportes x where x.id = aporte_id and x.autor_id = auth.uid();
  if not found then
    raise exception 'El aporte no existe' using errcode = 'P0002', hint = 'publico';
  end if;
  if a.estado <> 'pendiente' then
    raise exception 'Solo se puede agregar evidencia a un aporte pendiente' using errcode = '55000', hint = 'publico';
  end if;
  if a.evidencia_url is not null then
    raise exception 'El aporte ya tiene evidencia' using errcode = '55000', hint = 'publico';
  end if;

  update aportes x set evidencia_url = ruta, actualizado_en = now() where x.id = aporte_id
  returning * into a;

  insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
  values (auth.uid(), 'evidencia_adjuntada', 'aportes', aporte_id, jsonb_build_object('estado', a.estado));

  return aporte_json(a);
end;
$$;

revoke execute on function adjuntar_evidencia(uuid, text) from public;
grant execute on function adjuntar_evidencia(uuid, text) to authenticated, service_role;
