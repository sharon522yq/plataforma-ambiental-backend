-- 007: funciones de consulta pública para la API (fase 5, D-21).
-- Devuelven JSON listo para la API, con coordenadas como lat y lng (la columna
-- geography no sirve tal cual para el frontend). Son security invoker: corren con el
-- rol de quien llama (anon o authenticated), así que RLS y los permisos por columna de
-- la 003 siguen decidiendo qué se ve. Validan rangos aunque el endpoint ya valide.

-- ---------------------------------------------------------------------------
-- Puntos publicados, con filtros y paginación.
-- ---------------------------------------------------------------------------
create or replace function listar_puntos_publicos(
  tipo_filtro text default null,
  gravedad_minima integer default null,
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
  if limite is null or limite < 1 or limite > 100 then
    raise exception 'El límite debe estar entre 1 y 100' using errcode = '22023';
  end if;
  if desplazamiento is null or desplazamiento < 0 then
    raise exception 'El desplazamiento no puede ser negativo' using errcode = '22023';
  end if;

  with filtrados as (
    select p.id, p.titulo, p.tipo, p.gravedad, p.descripcion, p.ubicacion, p.creado_en, p.actualizado_en
    from puntos p
    where p.estado = 'publicado'
      and (tipo_filtro is null or p.tipo = tipo_filtro)
      and (gravedad_minima is null or p.gravedad >= gravedad_minima)
  ),
  pagina as (
    select * from filtrados
    order by creado_en desc, id
    limit limite offset desplazamiento
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrados),
    'datos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', g.id, 'titulo', g.titulo, 'tipo', g.tipo, 'gravedad', g.gravedad,
        'descripcion', g.descripcion,
        'lat', st_y(g.ubicacion::geometry), 'lng', st_x(g.ubicacion::geometry),
        'creado_en', g.creado_en, 'actualizado_en', g.actualizado_en
      ) order by g.creado_en desc, g.id)
      from pagina g
    ), '[]'::jsonb)
  ) into resultado;

  return resultado;
end;
$$;

-- ---------------------------------------------------------------------------
-- Un punto publicado. Devuelve null si no existe o no está publicado.
-- Incluye las acciones activas asociadas al punto.
-- ---------------------------------------------------------------------------
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
        'id', a.id, 'tipo', a.tipo, 'nombre', a.nombre, 'descripcion', a.descripcion, 'enlace', a.enlace
      ) order by a.nombre)
      from acciones a
      where a.punto_id = p.id and a.activa
    ), '[]'::jsonb)
  )
  from puntos p
  where p.id = obtener_punto_publico.punto_id and p.estado = 'publicado'
$$;

-- ---------------------------------------------------------------------------
-- Puntos publicados cerca de una ubicación, con coordenadas.
-- Reutiliza puntos_cercanos (004) para la búsqueda y sus validaciones.
-- ---------------------------------------------------------------------------
create or replace function puntos_cercanos_publicos(
  lat double precision,
  lng double precision,
  radio_metros integer,
  tipo_filtro text default null,
  limite integer default 20
)
returns jsonb
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  resultado jsonb;
begin
  if limite is null or limite < 1 or limite > 100 then
    raise exception 'El límite debe estar entre 1 y 100' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'titulo', c.titulo, 'tipo', c.tipo, 'gravedad', c.gravedad,
    'lat', st_y(p.ubicacion::geometry), 'lng', st_x(p.ubicacion::geometry),
    'distancia_metros', round(c.distancia_metros::numeric, 1)
  ) order by c.distancia_metros), '[]'::jsonb)
  into resultado
  from (
    select * from puntos_cercanos(lat, lng, radio_metros, tipo_filtro) limit limite
  ) c
  join puntos p on p.id = c.id;

  return resultado;
end;
$$;

-- ---------------------------------------------------------------------------
-- Acciones activas (cómo ayudar), con su organización si está activa.
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
    select a.id, a.tipo, a.nombre, a.descripcion, a.enlace, a.punto_id, a.organizacion_id
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
        'enlace', g.enlace, 'punto_id', g.punto_id,
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

-- ---------------------------------------------------------------------------
-- Organizaciones activas. Nunca incluye contacto (dato interno).
-- ---------------------------------------------------------------------------
create or replace function listar_organizaciones_publicas(
  zona_filtro text default null,
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
    select o.id, o.nombre, o.zona
    from organizaciones o
    where o.activa
      and (zona_filtro is null or o.zona ilike '%' || zona_filtro || '%')
  ),
  pagina as (
    select * from filtradas order by nombre, id limit limite offset desplazamiento
  )
  select jsonb_build_object(
    'total', (select count(*) from filtradas),
    'datos', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'nombre', g.nombre, 'zona', g.zona) order by g.nombre, g.id)
      from pagina g
    ), '[]'::jsonb)
  ) into resultado;

  return resultado;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos explícitos: el proyecto no expone funciones nuevas por su cuenta (D-17).
-- Se revoca a PUBLIC y se concede solo a los roles de la API.
-- ---------------------------------------------------------------------------
revoke execute on function
  listar_puntos_publicos(text, integer, integer, integer),
  obtener_punto_publico(uuid),
  puntos_cercanos(double precision, double precision, integer, text),
  puntos_cercanos_publicos(double precision, double precision, integer, text, integer),
  listar_acciones_publicas(text, uuid, integer, integer),
  listar_organizaciones_publicas(text, integer, integer)
from public;

grant execute on function
  listar_puntos_publicos(text, integer, integer, integer),
  obtener_punto_publico(uuid),
  puntos_cercanos(double precision, double precision, integer, text),
  puntos_cercanos_publicos(double precision, double precision, integer, text, integer),
  listar_acciones_publicas(text, uuid, integer, integer),
  listar_organizaciones_publicas(text, integer, integer)
to anon, authenticated, service_role;
