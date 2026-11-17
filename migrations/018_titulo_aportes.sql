-- 018: título propio en los reportes ciudadanos (aportes).
--
-- Antes el reporte solo tenía descripción y la moderación inventaba el título al aprobar, así
-- que la sugerencia salía de los primeros 50 caracteres de la descripción. Ahora quien reporta
-- escribe un título corto (3 a 120 caracteres, igual que puntos.titulo):
--   * aportes.titulo es opcional en la base: los reportes viejos no tienen y un aporte sobre un
--     punto que ya existe no lo necesita.
--   * crear_aporte recibe el título; aporte_json lo devuelve (mis aportes y la cola lo ven).
--   * revisar_aporte usa el título del moderador si escribe uno y, si no, el del reporte.

alter table aportes add column if not exists titulo text;
alter table aportes drop constraint if exists aportes_titulo_check;
alter table aportes add constraint aportes_titulo_check
  check (titulo is null or char_length(titulo) between 3 and 120);

create or replace function aporte_json(a aportes)
returns jsonb
language sql
stable
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'id', a.id, 'punto_id', a.punto_id, 'titulo', a.titulo, 'tipo', a.tipo, 'gravedad_sugerida', a.gravedad_sugerida,
    'descripcion', a.descripcion,
    'lat', st_y(a.ubicacion::geometry), 'lng', st_x(a.ubicacion::geometry),
    'estado', a.estado, 'motivo_revision', a.motivo_revision,
    'evidencia_ruta', a.evidencia_url,
    'enlaces', a.enlaces,
    'creado_en', a.creado_en, 'actualizado_en', a.actualizado_en
  )
$$;

-- crear_aporte (012) con un parámetro más al final: el título opcional.
drop function if exists crear_aporte(text, text, double precision, double precision, integer, uuid, jsonb);
create or replace function crear_aporte(
  tipo text,
  descripcion text,
  lat double precision,
  lng double precision,
  gravedad_sugerida integer default null,
  punto_id uuid default null,
  enlaces jsonb default '[]'::jsonb,
  titulo text default null
)
returns jsonb
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  nuevo aportes;
  limpios jsonb := '[]'::jsonb;
  e jsonb;
  t text := nullif(btrim(crear_aporte.titulo), '');
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión' using errcode = '42501', hint = 'publico';
  end if;
  if lat < -90 or lat > 90 or lng < -180 or lng > 180 then
    raise exception 'Coordenadas fuera de rango' using errcode = '22023', hint = 'publico';
  end if;
  if t is not null and char_length(t) not between 3 and 120 then
    raise exception 'El título debe tener entre 3 y 120 caracteres' using errcode = '22023', hint = 'publico';
  end if;
  if crear_aporte.punto_id is not null
     and not exists (select 1 from puntos p where p.id = crear_aporte.punto_id) then
    raise exception 'El punto indicado no existe' using errcode = '22023', hint = 'publico';
  end if;
  if crear_aporte.enlaces is not null then
    if jsonb_typeof(crear_aporte.enlaces) <> 'array' or jsonb_array_length(crear_aporte.enlaces) > 3 then
      raise exception 'Puedes incluir hasta 3 enlaces' using errcode = '22023', hint = 'publico';
    end if;
    for e in select * from jsonb_array_elements(crear_aporte.enlaces) loop
      limpios := limpios || jsonb_build_array(validar_enlace(e ->> 'tipo', e ->> 'nombre', e ->> 'enlace'));
    end loop;
  end if;

  insert into aportes (punto_id, titulo, tipo, gravedad_sugerida, descripcion, ubicacion, autor_id, enlaces)
  values (crear_aporte.punto_id, t, crear_aporte.tipo, crear_aporte.gravedad_sugerida, crear_aporte.descripcion,
          st_setsrid(st_makepoint(lng, lat), 4326)::geography, auth.uid(), limpios)
  returning * into nuevo;

  return aporte_json(nuevo);
end;
$$;

-- revisar_aporte (012): sin título del moderador, aprueba con el título del reporte.
create or replace function revisar_aporte(
  aporte_id uuid,
  decision text,
  motivo text default null,
  titulo text default null,
  gravedad integer default null,
  publicar boolean default true,
  duplicado_de uuid default null
)
returns jsonb
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  a aportes;
  p puntos;
  rol text := obtener_rol_actual();
  punto_destino uuid;
  filas integer;
  titulo_final text;
begin
  if rol is null or rol not in ('moderador', 'administrador') then
    raise exception 'Solo moderadores' using errcode = '42501', hint = 'publico';
  end if;
  if decision not in ('aprobado', 'rechazado', 'duplicado') then
    raise exception 'Decisión no válida' using errcode = '22023', hint = 'publico';
  end if;

  select * into a from aportes x where x.id = aporte_id;
  if not found then
    raise exception 'El aporte no existe' using errcode = 'P0002', hint = 'publico';
  end if;
  if a.estado <> 'pendiente' then
    raise exception 'El aporte ya fue revisado' using errcode = '55000', hint = 'publico';
  end if;
  if a.autor_id = auth.uid() then
    raise exception 'No puedes revisar tu propio aporte' using errcode = '42501', hint = 'publico';
  end if;

  punto_destino := a.punto_id;

  if decision = 'rechazado' and nullif(btrim(motivo), '') is null then
    raise exception 'Rechazar exige un motivo' using errcode = '22023', hint = 'publico';
  end if;

  if decision = 'duplicado' then
    if duplicado_de is null or not exists (select 1 from puntos x where x.id = duplicado_de) then
      raise exception 'Indica el punto existente del que es duplicado' using errcode = '22023', hint = 'publico';
    end if;
    punto_destino := duplicado_de;
  end if;

  if decision = 'aprobado' then
    if gravedad is not null and (gravedad < 1 or gravedad > 5) then
      raise exception 'La gravedad debe estar entre 1 y 5' using errcode = '22023', hint = 'publico';
    end if;
    if a.punto_id is null then
      -- El título del moderador manda; si no escribe uno, se usa el que propuso quien reportó.
      titulo_final := coalesce(nullif(btrim(titulo), ''), nullif(btrim(a.titulo), ''));
      if titulo_final is null then
        raise exception 'Aprobar un punto nuevo exige un título' using errcode = '22023', hint = 'publico';
      end if;
      insert into puntos (titulo, tipo, gravedad, descripcion, ubicacion, estado, autor_id)
      values (titulo_final, a.tipo, coalesce(gravedad, a.gravedad_sugerida, 3), a.descripcion, a.ubicacion,
              'en_revision', a.autor_id)
      returning * into p;
      if publicar then
        update puntos x set estado = 'publicado', aprobado_por = auth.uid(), actualizado_en = now()
        where x.id = p.id;
      end if;
      punto_destino := p.id;
    elsif gravedad is not null then
      update puntos x set gravedad = revisar_aporte.gravedad, actualizado_en = now() where x.id = a.punto_id;
      get diagnostics filas = row_count;
      if filas = 0 then
        raise exception 'No tienes permiso sobre el punto de este aporte' using errcode = '42501', hint = 'publico';
      end if;
    end if;
  end if;

  update aportes x
  set estado = decision, revisor_id = auth.uid(), motivo_revision = nullif(btrim(motivo), ''),
      punto_id = punto_destino, actualizado_en = now()
  where x.id = aporte_id;
  get diagnostics filas = row_count;
  if filas = 0 then
    raise exception 'No tienes permiso para revisar este aporte' using errcode = '42501', hint = 'publico';
  end if;

  if decision in ('aprobado', 'duplicado') and jsonb_array_length(a.enlaces) > 0 then
    perform publicar_enlaces_aporte(aporte_id);
  end if;

  select * into a from aportes x where x.id = aporte_id;
  return aporte_json(a) || jsonb_build_object('revisor_id', a.revisor_id);
end;
$$;


-- Permisos de ejecución (Supabase concede EXECUTE a anon en cada función nueva; ver 017).
revoke execute on function
  crear_aporte(text, text, double precision, double precision, integer, uuid, jsonb, text)
from public, anon;
grant execute on function
  crear_aporte(text, text, double precision, double precision, integer, uuid, jsonb, text)
to authenticated, service_role;
