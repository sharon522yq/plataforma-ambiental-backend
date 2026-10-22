-- 008: aportes ciudadanos, moderación y auditoría automática (fase 6, D-23 a D-25).
-- Las funciones son security invoker: corren con la sesión del usuario (authenticated),
-- así que las políticas de la 003 deciden quién puede qué. La auditoría la escriben
-- triggers security definer, así que ningún cambio de estado queda sin registro,
-- venga de la API o de otra vía.

-- ---------------------------------------------------------------------------
-- El autor de un aporte no puede revisarlo, aunque sea moderador (criterio de la fase 6).
-- Se aplica en la política, no solo en la función.
-- ---------------------------------------------------------------------------
drop policy if exists aportes_moderacion_actualizacion on aportes;
create policy aportes_moderacion_actualizacion on aportes
  for update to authenticated
  using (
    obtener_rol_actual() in ('moderador', 'administrador')
    and estado = 'pendiente'
    and autor_id <> auth.uid()
  )
  with check (obtener_rol_actual() in ('moderador', 'administrador'));

-- ---------------------------------------------------------------------------
-- Auditoría automática. Sin textos libres: solo estados e ids (sin datos personales).
-- ---------------------------------------------------------------------------
create or replace function auditar_aportes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
    values (auth.uid(), 'aporte_creado', 'aportes', new.id,
            jsonb_build_object('estado', new.estado, 'tipo', new.tipo, 'punto_id', new.punto_id));
  else
    insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
    values (auth.uid(), 'aporte_revisado', 'aportes', new.id,
            jsonb_build_object('estado_anterior', old.estado, 'estado_nuevo', new.estado, 'punto_id', new.punto_id));
  end if;
  return new;
end;
$$;

create or replace function auditar_puntos()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
    values (auth.uid(), 'punto_creado', 'puntos', new.id, jsonb_build_object('estado', new.estado, 'tipo', new.tipo));
  else
    insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
    values (auth.uid(), 'punto_estado_cambiado', 'puntos', new.id,
            jsonb_build_object('estado_anterior', old.estado, 'estado_nuevo', new.estado));
  end if;
  return new;
end;
$$;

-- Las funciones de trigger no deben poder llamarse desde la API.
revoke execute on function auditar_aportes(), auditar_puntos() from public;


create trigger aportes_auditar_insercion
  after insert on aportes for each row execute function auditar_aportes();

create trigger aportes_auditar_estado
  after update of estado on aportes for each row
  when (old.estado is distinct from new.estado)
  execute function auditar_aportes();


create trigger puntos_auditar_insercion
  after insert on puntos for each row execute function auditar_puntos();

create trigger puntos_auditar_estado
  after update of estado on puntos for each row
  when (old.estado is distinct from new.estado)
  execute function auditar_puntos();

-- ---------------------------------------------------------------------------
-- Forma JSON de un aporte, con coordenadas. Uso interno de las funciones de abajo.
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
    'creado_en', a.creado_en, 'actualizado_en', a.actualizado_en
  )
$$;

create or replace function punto_json(p puntos)
returns jsonb
language sql
stable
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'id', p.id, 'titulo', p.titulo, 'tipo', p.tipo, 'gravedad', p.gravedad, 'descripcion', p.descripcion,
    'lat', st_y(p.ubicacion::geometry), 'lng', st_x(p.ubicacion::geometry),
    'estado', p.estado, 'creado_en', p.creado_en, 'actualizado_en', p.actualizado_en
  )
$$;

-- ---------------------------------------------------------------------------
-- Ciudadano: crear un aporte. Siempre queda pendiente y a nombre de quien llama.
-- La descripción llega ya sin teléfonos ni correos (lo hace el backend).
-- ---------------------------------------------------------------------------
create or replace function crear_aporte(
  tipo text,
  descripcion text,
  lat double precision,
  lng double precision,
  gravedad_sugerida integer default null,
  punto_id uuid default null
)
returns jsonb
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  nuevo aportes;
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión' using errcode = '42501', hint = 'publico';
  end if;
  if lat < -90 or lat > 90 or lng < -180 or lng > 180 then
    raise exception 'Coordenadas fuera de rango' using errcode = '22023', hint = 'publico';
  end if;
  if crear_aporte.punto_id is not null
     and not exists (select 1 from puntos p where p.id = crear_aporte.punto_id) then
    raise exception 'El punto indicado no existe' using errcode = '22023', hint = 'publico';
  end if;

  insert into aportes (punto_id, tipo, gravedad_sugerida, descripcion, ubicacion, autor_id)
  values (crear_aporte.punto_id, crear_aporte.tipo, crear_aporte.gravedad_sugerida, crear_aporte.descripcion,
          st_setsrid(st_makepoint(lng, lat), 4326)::geography, auth.uid())
  returning * into nuevo;

  return aporte_json(nuevo);
end;
$$;

-- ---------------------------------------------------------------------------
-- Ciudadano: sus propios aportes (RLS ya lo limita; el filtro lo hace explícito).
-- ---------------------------------------------------------------------------
create or replace function mis_aportes(limite integer default 20, desplazamiento integer default 0)
returns jsonb
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  resultado jsonb;
begin
  if limite is null or limite < 1 or limite > 100 or desplazamiento is null or desplazamiento < 0 then
    raise exception 'Paginación fuera de rango' using errcode = '22023', hint = 'publico';
  end if;

  with propios as (
    select a.* from aportes a where a.autor_id = auth.uid()
  ),
  pagina as (
    select * from propios order by creado_en desc, id limit limite offset desplazamiento
  )
  select jsonb_build_object(
    'total', (select count(*) from propios),
    'datos', coalesce((select jsonb_agg(aporte_json(g) order by g.creado_en desc, g.id) from pagina g), '[]'::jsonb)
  ) into resultado;
  return resultado;
end;
$$;

-- ---------------------------------------------------------------------------
-- Moderación: cola de aportes. RLS deja ver pendientes y los que revisó quien llama.
-- ---------------------------------------------------------------------------
create or replace function cola_aportes(
  estado_filtro text default 'pendiente',
  limite integer default 20,
  desplazamiento integer default 0
)
returns jsonb
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  resultado jsonb;
begin
  if obtener_rol_actual() is null or obtener_rol_actual() not in ('moderador', 'administrador') then
    raise exception 'Solo moderadores' using errcode = '42501', hint = 'publico';
  end if;
  if limite is null or limite < 1 or limite > 100 or desplazamiento is null or desplazamiento < 0 then
    raise exception 'Paginación fuera de rango' using errcode = '22023', hint = 'publico';
  end if;

  with visibles as (
    select a.* from aportes a where a.estado = estado_filtro
  ),
  pagina as (
    -- La cola se atiende en orden de llegada.
    select * from visibles order by creado_en, id limit limite offset desplazamiento
  )
  select jsonb_build_object(
    'total', (select count(*) from visibles),
    'datos', coalesce((
      select jsonb_agg(aporte_json(g) || jsonb_build_object('autor_id', g.autor_id, 'revisor_id', g.revisor_id)
                       order by g.creado_en, g.id)
      from pagina g
    ), '[]'::jsonb)
  ) into resultado;
  return resultado;
end;
$$;

-- ---------------------------------------------------------------------------
-- Moderación: revisar un aporte.
--   aprobado:  crea el punto (si el aporte no apunta a uno) o actualiza su gravedad.
--              Con publicar = true el punto nuevo queda publicado en el mapa.
--   rechazado: exige motivo.
--   duplicado: exige el punto del que es duplicado.
-- Errores: P0002 no existe (o no es visible), 55000 ya revisado, 42501 sin permiso.
-- ---------------------------------------------------------------------------
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
      if nullif(btrim(titulo), '') is null then
        raise exception 'Aprobar un punto nuevo exige un título' using errcode = '22023', hint = 'publico';
      end if;
      -- El punto nace en revisión (política de la 003) y, si se pide, se publica enseguida.
      insert into puntos (titulo, tipo, gravedad, descripcion, ubicacion, estado, autor_id)
      values (btrim(titulo), a.tipo, coalesce(gravedad, a.gravedad_sugerida, 3), a.descripcion, a.ubicacion,
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

  select * into a from aportes x where x.id = aporte_id;
  return aporte_json(a) || jsonb_build_object('revisor_id', a.revisor_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Moderación: crear un punto directamente. Un moderador solo puede crearlo en revisión;
-- un administrador puede crearlo publicado (política de la 003).
-- ---------------------------------------------------------------------------
create or replace function crear_punto(
  titulo text,
  tipo text,
  gravedad integer,
  descripcion text,
  lat double precision,
  lng double precision,
  estado text default 'en_revision'
)
returns jsonb
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  nuevo puntos;
begin
  if lat < -90 or lat > 90 or lng < -180 or lng > 180 then
    raise exception 'Coordenadas fuera de rango' using errcode = '22023', hint = 'publico';
  end if;
  insert into puntos (titulo, tipo, gravedad, descripcion, ubicacion, estado, autor_id, aprobado_por)
  values (crear_punto.titulo, crear_punto.tipo, crear_punto.gravedad, crear_punto.descripcion,
          st_setsrid(st_makepoint(lng, lat), 4326)::geography, crear_punto.estado, auth.uid(),
          case when crear_punto.estado = 'publicado' then auth.uid() end)
  returning * into nuevo;
  return punto_json(nuevo);
end;
$$;

-- ---------------------------------------------------------------------------
-- Moderación: cambiar el estado de un punto (publicar o archivar).
-- Un moderador no puede tocar puntos archivados (política de la 003).
-- ---------------------------------------------------------------------------
create or replace function cambiar_estado_punto(punto_id uuid, estado text)
returns jsonb
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  p puntos;
begin
  if obtener_rol_actual() is null or obtener_rol_actual() not in ('moderador', 'administrador') then
    raise exception 'Solo moderadores' using errcode = '42501', hint = 'publico';
  end if;
  if estado not in ('en_revision', 'publicado', 'archivado') then
    raise exception 'Estado no válido' using errcode = '22023', hint = 'publico';
  end if;

  select * into p from puntos x where x.id = punto_id;
  if not found then
    raise exception 'El punto no existe' using errcode = 'P0002', hint = 'publico';
  end if;

  update puntos x
  set estado = cambiar_estado_punto.estado,
      aprobado_por = case when cambiar_estado_punto.estado = 'publicado' then auth.uid() else x.aprobado_por end,
      actualizado_en = now()
  where x.id = punto_id
  returning * into p;
  if not found then
    raise exception 'No tienes permiso para cambiar este punto' using errcode = '42501', hint = 'publico';
  end if;
  return punto_json(p);
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos: solo usuarios con sesión (y el backend). Nunca anon.
-- ---------------------------------------------------------------------------
revoke execute on function
  aporte_json(aportes), punto_json(puntos),
  crear_aporte(text, text, double precision, double precision, integer, uuid),
  mis_aportes(integer, integer),
  cola_aportes(text, integer, integer),
  revisar_aporte(uuid, text, text, text, integer, boolean, uuid),
  crear_punto(text, text, integer, text, double precision, double precision, text),
  cambiar_estado_punto(uuid, text)
from public;

grant execute on function
  aporte_json(aportes), punto_json(puntos),
  crear_aporte(text, text, double precision, double precision, integer, uuid),
  mis_aportes(integer, integer),
  cola_aportes(text, integer, integer),
  revisar_aporte(uuid, text, text, text, integer, boolean, uuid),
  crear_punto(text, text, integer, text, double precision, double precision, text),
  cambiar_estado_punto(uuid, text)
to authenticated, service_role;
