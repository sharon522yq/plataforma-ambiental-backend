-- 004: funciones de consulta y creación automática de perfiles.
-- obtener_rol_actual() está en 003 (ver D-12).

-- ---------------------------------------------------------------------------
-- Puntos publicados dentro de un radio, ordenados por distancia.
-- La usa el agente. Valida rangos aunque el endpoint ya valide.
-- ---------------------------------------------------------------------------
create or replace function puntos_cercanos(
  lat double precision,
  lng double precision,
  radio_metros integer,
  tipo_filtro text default null
)
returns table (
  id uuid,
  titulo text,
  tipo text,
  gravedad smallint,
  distancia_metros double precision
)
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  origen geography;
begin
  if lat < -90 or lat > 90 or lng < -180 or lng > 180 then
    raise exception 'Coordenadas fuera de rango' using errcode = '22023';
  end if;
  if radio_metros is null or radio_metros < 1 or radio_metros > 50000 then
    raise exception 'El radio debe estar entre 1 y 50000 metros' using errcode = '22023';
  end if;

  origen := st_setsrid(st_makepoint(lng, lat), 4326)::geography;

  return query
    select p.id, p.titulo, p.tipo, p.gravedad,
           st_distance(p.ubicacion, origen)::double precision as distancia_metros
    from puntos p
    where p.estado = 'publicado'
      and (tipo_filtro is null or p.tipo = tipo_filtro)
      and st_dwithin(p.ubicacion, origen, radio_metros)
    order by distancia_metros;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fragmentos más cercanos a un vector de consulta (RAG).
-- Solo para la llave de servicio: se revoca EXECUTE a PUBLIC.
-- ---------------------------------------------------------------------------
create or replace function buscar_fragmentos(consulta vector, cantidad integer default 5)
returns table (
  fragmento_id uuid,
  documento_id uuid,
  texto text,
  distancia double precision
)
language plpgsql
stable
set search_path = public, extensions
as $$
begin
  if vector_dims(consulta) <> 768 then
    raise exception 'El vector de consulta debe tener 768 dimensiones' using errcode = '22000';
  end if;
  if cantidad is null or cantidad < 1 or cantidad > 50 then
    raise exception 'La cantidad debe estar entre 1 y 50' using errcode = '22023';
  end if;

  return query
    select f.id, f.documento_id, f.texto,
           (f.embedding <=> consulta)::double precision as distancia
    from fragmentos f
    join documentos_conocimiento d on d.id = f.documento_id
    where d.activo and f.embedding is not null
    order by f.embedding <=> consulta
    limit cantidad;
end;
$$;

revoke execute on function buscar_fragmentos(vector, integer) from public;

-- ---------------------------------------------------------------------------
-- Cada usuario nuevo de Supabase Auth recibe un perfil de ciudadano.
-- El rol nunca sale de los metadatos del registro: siempre empieza en 'ciudadano'.
-- ---------------------------------------------------------------------------
create or replace function crear_perfil_nuevo_usuario()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into perfiles (id, nombre)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'nombre', ''), 'Ciudadano')
  );
  return new;
end;
$$;

create trigger perfil_al_registrar
  after insert on auth.users
  for each row execute function crear_perfil_nuevo_usuario();
