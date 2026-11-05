-- 013: base de conocimiento del asistente (F14, B-02).
-- Editores y administradores cargan documentos de fuentes confiables; el backend los parte en
-- fragmentos y calcula sus embeddings con Gemini (gemini-embedding-001, 768 dimensiones,
-- normalizados: cierra D-01). El agente busca en los documentos activos y cita la fuente.
-- Compatible con el backend anterior: solo agrega columnas con valor por defecto y funciones.

-- ---------------------------------------------------------------------------
-- Columnas nuevas
-- ---------------------------------------------------------------------------
alter table documentos_conocimiento add column if not exists enlace text;
alter table documentos_conocimiento drop constraint if exists documentos_enlace_https;
alter table documentos_conocimiento add constraint documentos_enlace_https
  check (enlace is null or enlace ~ '^https://[^[:space:]]+$');

alter table fragmentos add column if not exists posicion integer not null default 0;
alter table fragmentos add column if not exists modelo text;
create unique index if not exists fragmentos_documento_posicion_idx on fragmentos (documento_id, posicion);

-- ---------------------------------------------------------------------------
-- Forma JSON de un documento para el panel (incluye cuántos fragmentos tiene).
-- ---------------------------------------------------------------------------
create or replace function documento_json(d documentos_conocimiento)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', d.id,
    'titulo', d.titulo,
    'fuente', d.fuente,
    'enlace', d.enlace,
    'fecha_fuente', d.fecha_fuente,
    'activo', d.activo,
    'fragmentos', (select count(*) from fragmentos f where f.documento_id = d.id),
    'modelo', (select f.modelo from fragmentos f where f.documento_id = d.id order by f.posicion limit 1),
    'creado_en', d.creado_en,
    'actualizado_en', d.actualizado_en
  )
$$;

-- ---------------------------------------------------------------------------
-- Guarda un documento con sus fragmentos en una sola transacción.
-- fragmentos: [{ "texto": "...", "embedding": [768 números] }, ...] en orden.
-- SECURITY DEFINER porque fragmentos no tiene políticas; el rol se revisa aquí.
-- ---------------------------------------------------------------------------
create or replace function guardar_documento_conocimiento(
  titulo text,
  fuente text,
  fragmentos jsonb,
  modelo text,
  enlace text default null,
  fecha_fuente date default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  d documentos_conocimiento;
  f jsonb;
  indice integer := 0;
  vec vector;
begin
  if coalesce(obtener_rol_actual(), '') not in ('editor', 'administrador') then
    raise exception 'Solo un editor o administrador puede cargar documentos' using errcode = '42501', hint = 'publico';
  end if;
  if length(trim(coalesce(titulo, ''))) not between 3 and 200 then
    raise exception 'El título debe tener de 3 a 200 caracteres' using errcode = '22023', hint = 'publico';
  end if;
  if length(trim(coalesce(fuente, ''))) not between 2 and 200 then
    raise exception 'La fuente debe tener de 2 a 200 caracteres' using errcode = '22023', hint = 'publico';
  end if;
  if enlace is not null and enlace !~ '^https://[^[:space:]]+$' then
    raise exception 'El enlace debe empezar con https://' using errcode = '22023', hint = 'publico';
  end if;
  if length(trim(coalesce(modelo, ''))) = 0 then
    raise exception 'Falta el modelo de embeddings' using errcode = '22023';
  end if;
  if jsonb_typeof(fragmentos) is distinct from 'array'
     or jsonb_array_length(fragmentos) not between 1 and 200 then
    raise exception 'El documento debe tener de 1 a 200 fragmentos' using errcode = '22023', hint = 'publico';
  end if;

  insert into documentos_conocimiento (titulo, fuente, enlace, fecha_fuente, creado_por)
  values (trim(guardar_documento_conocimiento.titulo), trim(guardar_documento_conocimiento.fuente),
          guardar_documento_conocimiento.enlace, guardar_documento_conocimiento.fecha_fuente, auth.uid())
  returning * into d;

  for f in select value from jsonb_array_elements(fragmentos) loop
    if jsonb_typeof(f -> 'texto') is distinct from 'string'
       or length(trim(f ->> 'texto')) not between 1 and 4000
       or jsonb_typeof(f -> 'embedding') is distinct from 'array' then
      raise exception 'Fragmento % inválido', indice + 1 using errcode = '22023';
    end if;
    vec := (f ->> 'embedding')::vector;
    if vector_dims(vec) <> 768 then
      raise exception 'El embedding del fragmento % debe tener 768 dimensiones', indice + 1 using errcode = '22023';
    end if;
    insert into fragmentos (documento_id, texto, embedding, posicion, modelo)
    values (d.id, trim(f ->> 'texto'), vec, indice, trim(guardar_documento_conocimiento.modelo));
    indice := indice + 1;
  end loop;

  return documento_json(d);
end;
$$;

-- ---------------------------------------------------------------------------
-- Lista los documentos para el panel (activos e inactivos).
-- ---------------------------------------------------------------------------
create or replace function listar_documentos_conocimiento(limite integer default 20, desplazamiento integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(obtener_rol_actual(), '') not in ('editor', 'administrador') then
    raise exception 'Solo un editor o administrador puede ver los documentos' using errcode = '42501', hint = 'publico';
  end if;
  if limite is null or limite < 1 or limite > 100 or desplazamiento is null or desplazamiento < 0 then
    raise exception 'Paginación inválida' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'total', (select count(*) from documentos_conocimiento),
    'datos', coalesce((
      select jsonb_agg(documento_json(d) order by d.creado_en desc, d.id)
      from (select * from documentos_conocimiento order by creado_en desc, id limit limite offset desplazamiento) d
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Activa o desactiva un documento. Uno inactivo deja de usarse en las respuestas.
-- ---------------------------------------------------------------------------
create or replace function cambiar_estado_documento(documento_id uuid, activo boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  d documentos_conocimiento;
begin
  if coalesce(obtener_rol_actual(), '') not in ('editor', 'administrador') then
    raise exception 'Solo un editor o administrador puede cambiar documentos' using errcode = '42501', hint = 'publico';
  end if;
  if activo is null then
    raise exception 'Indica si el documento queda activo' using errcode = '22023';
  end if;
  update documentos_conocimiento c
     set activo = cambiar_estado_documento.activo, actualizado_en = now()
   where c.id = cambiar_estado_documento.documento_id
  returning * into d;
  if not found then
    raise exception 'El documento no existe' using errcode = 'P0002', hint = 'publico';
  end if;
  return documento_json(d);
end;
$$;

-- ---------------------------------------------------------------------------
-- Búsqueda para el asistente: fragmentos de documentos ACTIVOS más parecidos a la consulta.
-- Pública (anon): los documentos son material de consulta para cualquiera. No devuelve quién
-- los cargó.
-- ---------------------------------------------------------------------------
create or replace function buscar_conocimiento_publico(consulta vector, cantidad integer default 4)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
begin
  if consulta is null or vector_dims(consulta) <> 768 then
    raise exception 'El vector de consulta debe tener 768 dimensiones' using errcode = '22023';
  end if;
  if cantidad is null or cantidad < 1 or cantidad > 8 then
    raise exception 'La cantidad debe estar entre 1 y 8' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(r order by r.distancia)
    from (
      select f.texto, d.titulo, d.fuente, d.enlace, d.fecha_fuente,
             (f.embedding <=> consulta)::double precision as distancia
      from fragmentos f
      join documentos_conocimiento d on d.id = f.documento_id
      where d.activo and f.embedding is not null
      order by f.embedding <=> consulta
      limit cantidad
    ) r
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Auditoría de documentos (como el catálogo en la 010).
-- ---------------------------------------------------------------------------
create or replace function auditar_documentos()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  nueva jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  anterior jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  accion text;
  detalle jsonb;
begin
  if tg_op = 'INSERT' then
    accion := 'documento_creado';
    detalle := jsonb_build_object('titulo', nueva ->> 'titulo', 'fuente', nueva ->> 'fuente');
  elsif tg_op = 'UPDATE' then
    accion := 'documento_actualizado';
    detalle := jsonb_build_object('columnas', columnas_cambiadas(anterior, nueva));
  else
    accion := 'documento_eliminado';
    detalle := jsonb_build_object('titulo', anterior ->> 'titulo');
  end if;
  insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
  values (auth.uid(), accion, tg_table_name, (coalesce(nueva, anterior) ->> 'id')::uuid, detalle);
  return null;
end;
$$;

drop trigger if exists documentos_auditar on documentos_conocimiento;
create trigger documentos_auditar
  after insert or update or delete on documentos_conocimiento for each row execute function auditar_documentos();

-- ---------------------------------------------------------------------------
-- Permisos de ejecución
-- ---------------------------------------------------------------------------
revoke execute on function
  documento_json(documentos_conocimiento),
  guardar_documento_conocimiento(text, text, jsonb, text, text, date),
  listar_documentos_conocimiento(integer, integer),
  cambiar_estado_documento(uuid, boolean),
  buscar_conocimiento_publico(vector, integer),
  auditar_documentos()
from public, anon;

grant execute on function
  guardar_documento_conocimiento(text, text, jsonb, text, text, date),
  listar_documentos_conocimiento(integer, integer),
  cambiar_estado_documento(uuid, boolean)
to authenticated, service_role;

grant execute on function buscar_conocimiento_publico(vector, integer) to anon, authenticated, service_role;
