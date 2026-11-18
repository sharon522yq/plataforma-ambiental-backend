-- 019: editar casos desde la plataforma (pedido de sharon, 2026-11-18).
--
--   * Quien reporta corrige el título y la descripción de su reporte mientras sigue pendiente
--     (editar_aporte).
--   * Quien reporta también corrige su caso ya creado en el mapa (editar_mi_punto). Si el caso
--     estaba publicado, sale del mapa y vuelve a revisión hasta que moderación lo publique otra
--     vez: nadie cambia sin control un caso que ya se aprobó. mis_puntos lista sus casos.
--   * Moderación corrige el título de cualquier caso en cualquier momento, sin SQL
--     (editar_titulo_punto), y ve los casos en revisión para volver a publicarlos (cola_puntos).
--   * Cada edición queda en la auditoría con los campos que cambiaron, nunca con el texto.
--
-- Errores: P0002 no existe (o no es tuyo), 55000 ya no se puede editar, 22023 datos no válidos,
-- 42501 sin sesión o sin permiso.

-- ---------------------------------------------------------------------------
-- Auditoría de ediciones de texto (título y descripción). Solo nombres de campos.
-- ---------------------------------------------------------------------------
create or replace function auditar_edicion_texto()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  campos jsonb := '[]'::jsonb;
begin
  if new.titulo is distinct from old.titulo then
    campos := campos || '["titulo"]'::jsonb;
  end if;
  if new.descripcion is distinct from old.descripcion then
    campos := campos || '["descripcion"]'::jsonb;
  end if;
  insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
  values (auth.uid(), case tg_table_name when 'puntos' then 'punto_editado' else 'aporte_editado' end,
          tg_table_name, new.id, jsonb_build_object('campos', campos));
  return new;
end;
$$;

drop trigger if exists puntos_auditar_edicion on puntos;
create trigger puntos_auditar_edicion
  after update of titulo, descripcion on puntos for each row
  when (old.titulo is distinct from new.titulo or old.descripcion is distinct from new.descripcion)
  execute function auditar_edicion_texto();

drop trigger if exists aportes_auditar_edicion on aportes;
create trigger aportes_auditar_edicion
  after update of titulo, descripcion on aportes for each row
  when (old.titulo is distinct from new.titulo or old.descripcion is distinct from new.descripcion)
  execute function auditar_edicion_texto();

-- ---------------------------------------------------------------------------
-- Validaciones comunes. Devuelven el texto recortado o null si no viene.
-- ---------------------------------------------------------------------------
create or replace function validar_titulo_caso(titulo text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  t text := nullif(btrim(titulo), '');
begin
  if t is not null and char_length(t) not between 3 and 120 then
    raise exception 'El título debe tener entre 3 y 120 caracteres' using errcode = '22023', hint = 'publico';
  end if;
  return t;
end;
$$;

create or replace function validar_descripcion_caso(descripcion text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  d text := nullif(btrim(descripcion), '');
begin
  if d is not null and char_length(d) not between 10 and 2000 then
    raise exception 'La descripción debe tener entre 10 y 2000 caracteres' using errcode = '22023', hint = 'publico';
  end if;
  return d;
end;
$$;

-- ---------------------------------------------------------------------------
-- Quien reporta: corregir su reporte pendiente. security definer porque el ciudadano no tiene
-- política de UPDATE sobre aportes; por eso se comprueba a mano que sea suyo y pendiente.
-- Un aporte sobre un punto que ya existe no lleva título (el punto ya tiene uno).
-- ---------------------------------------------------------------------------
create or replace function editar_aporte(aporte_id uuid, titulo text default null, descripcion text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  a aportes;
  t text := validar_titulo_caso(editar_aporte.titulo);
  d text := validar_descripcion_caso(editar_aporte.descripcion);
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión' using errcode = '42501', hint = 'publico';
  end if;
  if t is null and d is null then
    raise exception 'Indica el título o la descripción' using errcode = '22023', hint = 'publico';
  end if;

  select * into a from aportes x where x.id = editar_aporte.aporte_id and x.autor_id = auth.uid() for update;
  if not found then
    raise exception 'El aporte no existe' using errcode = 'P0002', hint = 'publico';
  end if;
  if a.estado <> 'pendiente' then
    raise exception 'Solo puedes editar un reporte pendiente' using errcode = '55000', hint = 'publico';
  end if;
  if t is not null and a.punto_id is not null then
    raise exception 'Un aporte sobre un punto existente no lleva título' using errcode = '22023', hint = 'publico';
  end if;

  update aportes x
  set titulo = coalesce(t, x.titulo), descripcion = coalesce(d, x.descripcion), actualizado_en = now()
  where x.id = a.id
  returning * into a;
  return aporte_json(a);
end;
$$;

-- ---------------------------------------------------------------------------
-- Quien reporta: sus casos en el mapa (los puntos que nacieron de sus reportes), en cualquier
-- estado. security definer porque RLS solo le deja leer puntos publicados.
-- ---------------------------------------------------------------------------
create or replace function mis_puntos(limite integer default 20, desplazamiento integer default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  resultado jsonb;
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión' using errcode = '42501', hint = 'publico';
  end if;
  if limite is null or limite < 1 or limite > 100 or desplazamiento is null or desplazamiento < 0 then
    raise exception 'Paginación fuera de rango' using errcode = '22023', hint = 'publico';
  end if;

  with propios as (
    select p.* from puntos p where p.autor_id = auth.uid()
  ),
  pagina as (
    select * from propios order by creado_en desc, id limit limite offset desplazamiento
  )
  select jsonb_build_object(
    'total', (select count(*) from propios),
    'datos', coalesce((select jsonb_agg(punto_json(g) order by g.creado_en desc, g.id) from pagina g), '[]'::jsonb)
  ) into resultado;
  return resultado;
end;
$$;

-- ---------------------------------------------------------------------------
-- Quien reporta: corregir su caso. Si estaba publicado, vuelve a revisión (sale del mapa).
-- Un caso archivado ya no se edita. Si no cambia nada, no toca el estado.
-- ---------------------------------------------------------------------------
create or replace function editar_mi_punto(punto_id uuid, titulo text default null, descripcion text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, extensions
as $$
declare
  p puntos;
  t text := validar_titulo_caso(editar_mi_punto.titulo);
  d text := validar_descripcion_caso(editar_mi_punto.descripcion);
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión' using errcode = '42501', hint = 'publico';
  end if;
  if t is null and d is null then
    raise exception 'Indica el título o la descripción' using errcode = '22023', hint = 'publico';
  end if;

  select * into p from puntos x where x.id = editar_mi_punto.punto_id and x.autor_id = auth.uid() for update;
  if not found then
    raise exception 'El caso no existe' using errcode = 'P0002', hint = 'publico';
  end if;
  if p.estado = 'archivado' then
    raise exception 'Un caso archivado ya no se puede editar' using errcode = '55000', hint = 'publico';
  end if;
  if coalesce(t, p.titulo) = p.titulo and coalesce(d, p.descripcion) = p.descripcion then
    return punto_json(p);
  end if;

  update puntos x
  set titulo = coalesce(t, x.titulo),
      descripcion = coalesce(d, x.descripcion),
      estado = 'en_revision',
      actualizado_en = now()
  where x.id = p.id
  returning * into p;
  return punto_json(p);
end;
$$;

-- ---------------------------------------------------------------------------
-- Moderación: corregir el título de un caso sin cambiar su estado. Corre con la sesión de
-- quien llama, así que la política de 003 aplica: el moderador no toca casos archivados y el
-- administrador sí.
-- ---------------------------------------------------------------------------
create or replace function editar_titulo_punto(punto_id uuid, titulo text)
returns jsonb
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  p puntos;
  t text := validar_titulo_caso(editar_titulo_punto.titulo);
begin
  if obtener_rol_actual() is null or obtener_rol_actual() not in ('moderador', 'administrador') then
    raise exception 'Solo moderadores' using errcode = '42501', hint = 'publico';
  end if;
  if t is null then
    raise exception 'El título debe tener entre 3 y 120 caracteres' using errcode = '22023', hint = 'publico';
  end if;
  if not exists (select 1 from puntos x where x.id = editar_titulo_punto.punto_id) then
    raise exception 'El caso no existe' using errcode = 'P0002', hint = 'publico';
  end if;

  update puntos x set titulo = t, actualizado_en = now()
  where x.id = editar_titulo_punto.punto_id
  returning * into p;
  if not found then
    raise exception 'No tienes permiso para editar este caso' using errcode = '42501', hint = 'publico';
  end if;
  return punto_json(p);
end;
$$;

-- ---------------------------------------------------------------------------
-- Moderación: casos por estado (sobre todo los que volvieron a revisión), los más antiguos
-- primero, como la cola de aportes.
-- ---------------------------------------------------------------------------
create or replace function cola_puntos(
  estado_filtro text default 'en_revision',
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
  if estado_filtro not in ('en_revision', 'publicado', 'archivado') then
    raise exception 'Estado no válido' using errcode = '22023', hint = 'publico';
  end if;
  if limite is null or limite < 1 or limite > 100 or desplazamiento is null or desplazamiento < 0 then
    raise exception 'Paginación fuera de rango' using errcode = '22023', hint = 'publico';
  end if;

  with visibles as (
    select p.* from puntos p where p.estado = estado_filtro
  ),
  pagina as (
    select * from visibles order by actualizado_en, id limit limite offset desplazamiento
  )
  select jsonb_build_object(
    'total', (select count(*) from visibles),
    'datos', coalesce((select jsonb_agg(punto_json(g) order by g.actualizado_en, g.id) from pagina g), '[]'::jsonb)
  ) into resultado;
  return resultado;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución (Supabase concede EXECUTE a anon en cada función nueva; ver 017).
-- ---------------------------------------------------------------------------
revoke execute on function
  auditar_edicion_texto(),
  validar_titulo_caso(text),
  validar_descripcion_caso(text),
  editar_aporte(uuid, text, text),
  mis_puntos(integer, integer),
  editar_mi_punto(uuid, text, text),
  editar_titulo_punto(uuid, text),
  cola_puntos(text, integer, integer)
from public, anon, authenticated;

-- Las validaciones son funciones puras; editar_titulo_punto corre con la sesión de quien llama
-- y las necesita.
grant execute on function
  validar_titulo_caso(text),
  validar_descripcion_caso(text),
  editar_aporte(uuid, text, text),
  mis_puntos(integer, integer),
  editar_mi_punto(uuid, text, text),
  editar_titulo_punto(uuid, text),
  cola_puntos(text, integer, integer)
to authenticated, service_role;
