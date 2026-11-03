-- 012: enlaces de la comunidad para ayudar (D-40).
-- Cualquier cuenta activa agrega enlaces (firma, evento, donación…) a un punto publicado y se
-- publican al momento. Quien reporta puede incluir hasta 3 en su aporte; se publican cuando se
-- aprueba (o se marca duplicado de un punto). Moderador, editor y administrador los retiran.
-- Compatible con el backend anterior: crear_aporte conserva sus parámetros (enlaces es opcional)
-- y las respuestas solo agregan campos.

-- ---------------------------------------------------------------------------
-- Columnas nuevas
-- ---------------------------------------------------------------------------
alter table acciones drop constraint if exists acciones_tipo_check;
alter table acciones add constraint acciones_tipo_check
  check (tipo in ('denuncia', 'firma', 'donacion', 'voluntariado', 'evento'));

alter table acciones add column if not exists autor_id uuid references perfiles(id);   -- nulo: catálogo oficial
alter table acciones add column if not exists aporte_id uuid references aportes(id);  -- el aporte que lo propuso
alter table acciones add column if not exists de_la_comunidad boolean not null default false;
create index if not exists acciones_punto_idx on acciones (punto_id) where activa;

alter table aportes add column if not exists enlaces jsonb not null default '[]'::jsonb;
alter table aportes drop constraint if exists aportes_enlaces_check;
alter table aportes add constraint aportes_enlaces_check
  check (jsonb_typeof(enlaces) = 'array' and jsonb_array_length(enlaces) <= 3);

-- Anónimo: sin autor_id ni aporte_id (como puntos en la 003).
revoke select on acciones from anon;
grant select (id, tipo, nombre, descripcion, enlace, organizacion_id, activa, punto_id, de_la_comunidad, creado_en, actualizado_en)
  on acciones to anon;

-- ---------------------------------------------------------------------------
-- Validación común de un enlace. Devuelve el enlace normalizado como jsonb.
-- ---------------------------------------------------------------------------
create or replace function validar_enlace(tipo text, nombre text, enlace text, descripcion text default null)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
begin
  if tipo is null or tipo not in ('denuncia', 'firma', 'donacion', 'voluntariado', 'evento') then
    raise exception 'Tipo de enlace no válido' using errcode = '22023', hint = 'publico';
  end if;
  if nombre is null or char_length(btrim(nombre)) < 3 or char_length(btrim(nombre)) > 120 then
    raise exception 'El nombre del enlace debe tener entre 3 y 120 caracteres' using errcode = '22023', hint = 'publico';
  end if;
  if enlace is null or char_length(enlace) > 500 or enlace !~ '^https://[^[:space:]]+$' then
    raise exception 'El enlace debe empezar con https:// y no tener espacios' using errcode = '22023', hint = 'publico';
  end if;
  if descripcion is not null and char_length(descripcion) > 500 then
    raise exception 'La descripción del enlace no puede pasar de 500 caracteres' using errcode = '22023', hint = 'publico';
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'tipo', tipo, 'nombre', btrim(nombre), 'enlace', enlace, 'descripcion', nullif(btrim(descripcion), '')
  ));
end;
$$;

-- ---------------------------------------------------------------------------
-- JSON de aportes y acciones con los campos nuevos.
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
    'enlaces', a.enlaces,
    'creado_en', a.creado_en, 'actualizado_en', a.actualizado_en
  )
$$;

create or replace function accion_json(a acciones)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', a.id, 'tipo', a.tipo, 'nombre', a.nombre, 'descripcion', a.descripcion, 'enlace', a.enlace,
    'organizacion_id', a.organizacion_id, 'punto_id', a.punto_id, 'activa', a.activa,
    'de_la_comunidad', a.de_la_comunidad,
    'creado_en', a.creado_en, 'actualizado_en', a.actualizado_en
  )
$$;

-- ---------------------------------------------------------------------------
-- Ciudadano: crear un aporte, ahora con enlaces opcionales (máximo 3).
-- ---------------------------------------------------------------------------
drop function if exists crear_aporte(text, text, double precision, double precision, integer, uuid);
create or replace function crear_aporte(
  tipo text,
  descripcion text,
  lat double precision,
  lng double precision,
  gravedad_sugerida integer default null,
  punto_id uuid default null,
  enlaces jsonb default '[]'::jsonb
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
  if crear_aporte.enlaces is not null then
    if jsonb_typeof(crear_aporte.enlaces) <> 'array' or jsonb_array_length(crear_aporte.enlaces) > 3 then
      raise exception 'Puedes incluir hasta 3 enlaces' using errcode = '22023', hint = 'publico';
    end if;
    for e in select * from jsonb_array_elements(crear_aporte.enlaces) loop
      limpios := limpios || jsonb_build_array(validar_enlace(e ->> 'tipo', e ->> 'nombre', e ->> 'enlace'));
    end loop;
  end if;

  insert into aportes (punto_id, tipo, gravedad_sugerida, descripcion, ubicacion, autor_id, enlaces)
  values (crear_aporte.punto_id, crear_aporte.tipo, crear_aporte.gravedad_sugerida, crear_aporte.descripcion,
          st_setsrid(st_makepoint(lng, lat), 4326)::geography, auth.uid(), limpios)
  returning * into nuevo;

  return aporte_json(nuevo);
end;
$$;

-- ---------------------------------------------------------------------------
-- Publicar los enlaces de un aporte ya revisado. La llama revisar_aporte. security definer
-- porque el moderador no tiene política de INSERT sobre acciones; por eso comprueba a mano el
-- rol, que el aporte esté aprobado o duplicado y que lo haya revisado quien llama. Una sola vez:
-- si el aporte ya tiene acciones (aunque luego se retiraran) no vuelve a publicar.
-- ---------------------------------------------------------------------------
create or replace function publicar_enlaces_aporte(aporte_id uuid)
returns integer
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  a aportes;
  e jsonb;
  n integer := 0;
begin
  if coalesce(obtener_rol_actual(), '') not in ('moderador', 'administrador') then
    raise exception 'Solo moderadores' using errcode = '42501', hint = 'publico';
  end if;
  select * into a from aportes x where x.id = publicar_enlaces_aporte.aporte_id;
  if not found or a.estado not in ('aprobado', 'duplicado') or a.punto_id is null or a.revisor_id is distinct from auth.uid() then
    raise exception 'El aporte no está revisado por ti' using errcode = '55000', hint = 'publico';
  end if;
  if exists (select 1 from acciones x where x.aporte_id = a.id) then
    return 0;
  end if;
  for e in select * from jsonb_array_elements(a.enlaces) loop
    insert into acciones (tipo, nombre, enlace, punto_id, autor_id, aporte_id, de_la_comunidad)
    values (e ->> 'tipo', e ->> 'nombre', e ->> 'enlace', a.punto_id, a.autor_id, a.id, true);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- revisar_aporte (008) con un paso más: al aprobar o marcar duplicado publica los enlaces.
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

  if decision in ('aprobado', 'duplicado') and jsonb_array_length(a.enlaces) > 0 then
    perform publicar_enlaces_aporte(aporte_id);
  end if;

  select * into a from aportes x where x.id = aporte_id;
  return aporte_json(a) || jsonb_build_object('revisor_id', a.revisor_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Cualquier cuenta activa: agregar un enlace a un punto publicado. Se publica al momento.
-- security definer porque el ciudadano no tiene política de INSERT sobre acciones; el autor
-- siempre es quien llama. Límites contra abuso: 10 enlaces por cuenta cada 24 horas y el
-- mismo enlace no se repite en un punto.
-- ---------------------------------------------------------------------------
create or replace function proponer_accion(
  punto_id uuid,
  tipo text,
  nombre text,
  enlace text,
  descripcion text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  limpio jsonb;
  a acciones;
begin
  if auth.uid() is null or obtener_rol_actual() is null then
    raise exception 'Debes iniciar sesión con una cuenta activa' using errcode = '42501', hint = 'publico';
  end if;
  if not exists (select 1 from puntos p where p.id = proponer_accion.punto_id and p.estado = 'publicado') then
    raise exception 'El punto no existe o no está publicado' using errcode = 'P0002', hint = 'publico';
  end if;
  limpio := validar_enlace(tipo, nombre, enlace, descripcion);
  if exists (select 1 from acciones x where x.punto_id = proponer_accion.punto_id and x.activa and x.enlace = limpio ->> 'enlace') then
    raise exception 'Ese enlace ya está en este punto' using errcode = '55000', hint = 'publico';
  end if;
  if (select count(*) from acciones x where x.autor_id = auth.uid() and x.creado_en > now() - interval '24 hours') >= 10 then
    raise exception 'Llegaste al límite de 10 enlaces por día' using errcode = '55000', hint = 'publico';
  end if;

  insert into acciones (tipo, nombre, enlace, descripcion, punto_id, autor_id, de_la_comunidad)
  values (limpio ->> 'tipo', limpio ->> 'nombre', limpio ->> 'enlace', limpio ->> 'descripcion',
          proponer_accion.punto_id, auth.uid(), true)
  returning * into a;
  return accion_json(a);
end;
$$;

-- ---------------------------------------------------------------------------
-- Moderador, editor o administrador: retirar un enlace (queda inactivo y auditado).
-- security definer porque el moderador no tiene política de UPDATE sobre acciones.
-- ---------------------------------------------------------------------------
create or replace function retirar_accion(accion_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  a acciones;
begin
  if coalesce(obtener_rol_actual(), '') not in ('moderador', 'editor', 'administrador') then
    raise exception 'Solo moderadores, editores o administradores pueden retirar enlaces' using errcode = '42501', hint = 'publico';
  end if;
  update acciones x set activa = false, actualizado_en = now()
  where x.id = retirar_accion.accion_id and x.activa
  returning * into a;
  if not found then
    raise exception 'El enlace no existe o ya fue retirado' using errcode = 'P0002', hint = 'publico';
  end if;
  return accion_json(a);
end;
$$;

-- ---------------------------------------------------------------------------
-- Consultas públicas (007) con de_la_comunidad y el tipo evento.
-- ---------------------------------------------------------------------------
create or replace function listar_acciones_publicas(
  tipo_filtro text default null,
  punto uuid default null,
  limite integer default 20,
  desplazamiento integer default 0
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  resultado jsonb;
begin
  if limite is null or limite < 1 or limite > 100 then
    raise exception 'El límite debe estar entre 1 y 100' using errcode = '22023';
  end if;
  if desplazamiento is null or desplazamiento < 0 then
    raise exception 'El desplazamiento no puede ser negativo' using errcode = '22023';
  end if;

  with filtradas as (
    select a.id, a.tipo, a.nombre, a.descripcion, a.enlace, a.punto_id, a.organizacion_id, a.de_la_comunidad
    from acciones a
    where a.activa
      and (tipo_filtro is null or a.tipo = tipo_filtro)
      and (punto is null or a.punto_id = punto)
  ),
  pagina as (
    select * from filtradas order by nombre, id limit limite offset desplazamiento
  )
  select jsonb_build_object(
    'total', (select count(*) from filtradas),
    'datos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', g.id, 'tipo', g.tipo, 'nombre', g.nombre, 'descripcion', g.descripcion,
        'enlace', g.enlace, 'punto_id', g.punto_id, 'de_la_comunidad', g.de_la_comunidad,
        'organizacion', case when o.id is null then null
                             else jsonb_build_object('id', o.id, 'nombre', o.nombre) end
      ) order by g.nombre, g.id)
      from pagina g
      left join organizaciones o on o.id = g.organizacion_id and o.activa
    ), '[]'::jsonb)
  ) into resultado;

  return resultado;
end;
$$;

create or replace function obtener_punto_publico(punto_id uuid)
returns jsonb
language sql
stable
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'id', p.id, 'titulo', p.titulo, 'tipo', p.tipo, 'gravedad', p.gravedad,
    'descripcion', p.descripcion,
    'lat', st_y(p.ubicacion::geometry), 'lng', st_x(p.ubicacion::geometry),
    'creado_en', p.creado_en, 'actualizado_en', p.actualizado_en,
    'acciones', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'tipo', a.tipo, 'nombre', a.nombre, 'descripcion', a.descripcion, 'enlace', a.enlace,
        'de_la_comunidad', a.de_la_comunidad
      ) order by a.nombre)
      from acciones a
      where a.punto_id = p.id and a.activa
    ), '[]'::jsonb)
  )
  from puntos p
  where p.id = obtener_punto_publico.punto_id and p.estado = 'publicado'
$$;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución
-- ---------------------------------------------------------------------------
revoke execute on function
  validar_enlace(text, text, text, text),
  crear_aporte(text, text, double precision, double precision, integer, uuid, jsonb),
  publicar_enlaces_aporte(uuid),
  proponer_accion(uuid, text, text, text, text),
  retirar_accion(uuid)
from public, anon;

grant execute on function
  validar_enlace(text, text, text, text),
  crear_aporte(text, text, double precision, double precision, integer, uuid, jsonb),
  publicar_enlaces_aporte(uuid),
  proponer_accion(uuid, text, text, text, text),
  retirar_accion(uuid)
to authenticated, service_role;
