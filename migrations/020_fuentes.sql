-- 020: fuentes en los casos (pedido de sharon, 2026-11-18).
--
-- Cada caso (punto) y cada reporte (aporte) lleva una lista de fuentes: enlaces a noticias,
-- documentos oficiales u otras páginas que respaldan la información. Antes iban como texto al
-- final de la descripción y no se podían abrir con un clic.
--   * De cada fuente solo el enlace es obligatorio (https, sin espacios, hasta 500 caracteres).
--     El nombre (medio o título de la nota) es opcional, de 2 a 150 caracteres.
--   * Hasta 5 fuentes en un reporte y 10 en un caso. Un enlace repetido se guarda una vez.
--   * Quien reporta las envía con su reporte y las corrige igual que el título y la descripción
--     (019): en un reporte pendiente, o en su caso, que vuelve a revisión si estaba publicado.
--   * Al aprobar un reporte nuevo, sus fuentes pasan al caso; un aporte sobre un caso existente
--     (aprobado o duplicado) suma las suyas a las del caso.
--   * Moderación cambia las fuentes de cualquier caso sin cambiar su estado.
--   * Son públicas en el detalle del caso. La auditoría registra que cambiaron, no los enlaces.

-- ---------------------------------------------------------------------------
-- Validación
-- ---------------------------------------------------------------------------
create or replace function validar_fuente(nombre text, enlace text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  n text := nullif(btrim(nombre), '');
  e text := btrim(enlace);
begin
  if e is null or char_length(e) > 500 or e !~ '^https://[^[:space:]]+$' then
    raise exception 'Cada fuente necesita un enlace que empiece con https:// y no tenga espacios' using errcode = '22023', hint = 'publico';
  end if;
  if n is not null and char_length(n) not between 2 and 150 then
    raise exception 'El nombre de la fuente debe tener entre 2 y 150 caracteres' using errcode = '22023', hint = 'publico';
  end if;
  return jsonb_strip_nulls(jsonb_build_object('enlace', e, 'nombre', n));
end;
$$;

-- Devuelve la lista validada, sin enlaces repetidos. null cuenta como lista vacía.
create or replace function fuentes_limpias(fuentes jsonb, maximo integer)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  x jsonb;
  limpia jsonb;
  resultado jsonb := '[]'::jsonb;
begin
  if fuentes is null then
    return resultado;
  end if;
  if jsonb_typeof(fuentes) <> 'array' then
    raise exception 'Las fuentes deben ser una lista' using errcode = '22023', hint = 'publico';
  end if;
  for x in select * from jsonb_array_elements(fuentes) loop
    if jsonb_typeof(x) <> 'object' then
      raise exception 'Cada fuente debe tener al menos un enlace' using errcode = '22023', hint = 'publico';
    end if;
    limpia := validar_fuente(x ->> 'nombre', x ->> 'enlace');
    if not exists (select 1 from jsonb_array_elements(resultado) r where r ->> 'enlace' = limpia ->> 'enlace') then
      resultado := resultado || jsonb_build_array(limpia);
    end if;
  end loop;
  if jsonb_array_length(resultado) > maximo then
    raise exception 'Puedes incluir hasta % fuentes', maximo using errcode = '22023', hint = 'publico';
  end if;
  return resultado;
end;
$$;

-- Para el check de las tablas: un INSERT o UPDATE directo tampoco guarda fuentes inválidas.
create or replace function fuentes_validas(fuentes jsonb, maximo integer)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
begin
  return fuentes_limpias(fuentes, maximo) = fuentes;
end;
$$;

-- Suma fuentes nuevas a las de un caso, sin repetir y hasta el máximo (las de más se ignoran).
create or replace function unir_fuentes(actuales jsonb, nuevas jsonb, maximo integer)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  x jsonb;
  resultado jsonb := coalesce(actuales, '[]'::jsonb);
begin
  for x in select * from jsonb_array_elements(coalesce(nuevas, '[]'::jsonb)) loop
    exit when jsonb_array_length(resultado) >= maximo;
    if not exists (select 1 from jsonb_array_elements(resultado) r where r ->> 'enlace' = x ->> 'enlace') then
      resultado := resultado || jsonb_build_array(x);
    end if;
  end loop;
  return resultado;
end;
$$;

alter table puntos add column if not exists fuentes jsonb not null default '[]'::jsonb;
alter table puntos drop constraint if exists puntos_fuentes_check;
alter table puntos add constraint puntos_fuentes_check check (fuentes_validas(fuentes, 10));

alter table aportes add column if not exists fuentes jsonb not null default '[]'::jsonb;
alter table aportes drop constraint if exists aportes_fuentes_check;
alter table aportes add constraint aportes_fuentes_check check (fuentes_validas(fuentes, 5));

-- Las fuentes son públicas, como el título y la descripción.
grant select (fuentes) on puntos to anon;

-- ---------------------------------------------------------------------------
-- Formas JSON con las fuentes
-- ---------------------------------------------------------------------------
create or replace function punto_json(p puntos)
returns jsonb
language sql
stable
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'id', p.id, 'titulo', p.titulo, 'tipo', p.tipo, 'gravedad', p.gravedad, 'descripcion', p.descripcion,
    'lat', st_y(p.ubicacion::geometry), 'lng', st_x(p.ubicacion::geometry),
    'estado', p.estado, 'fuentes', p.fuentes, 'creado_en', p.creado_en, 'actualizado_en', p.actualizado_en
  )
$$;

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
    'fuentes', a.fuentes,
    'creado_en', a.creado_en, 'actualizado_en', a.actualizado_en
  )
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
    'fuentes', p.fuentes,
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
-- Auditoría (019) con las fuentes: solo el nombre del campo, nunca los enlaces.
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
  if new.fuentes is distinct from old.fuentes then
    campos := campos || '["fuentes"]'::jsonb;
  end if;
  insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
  values (auth.uid(), case tg_table_name when 'puntos' then 'punto_editado' else 'aporte_editado' end,
          tg_table_name, new.id, jsonb_build_object('campos', campos));
  return new;
end;
$$;

drop trigger if exists puntos_auditar_edicion on puntos;
create trigger puntos_auditar_edicion
  after update of titulo, descripcion, fuentes on puntos for each row
  when (old.titulo is distinct from new.titulo or old.descripcion is distinct from new.descripcion
        or old.fuentes is distinct from new.fuentes)
  execute function auditar_edicion_texto();

drop trigger if exists aportes_auditar_edicion on aportes;
create trigger aportes_auditar_edicion
  after update of titulo, descripcion, fuentes on aportes for each row
  when (old.titulo is distinct from new.titulo or old.descripcion is distinct from new.descripcion
        or old.fuentes is distinct from new.fuentes)
  execute function auditar_edicion_texto();

-- ---------------------------------------------------------------------------
-- crear_aporte (018) con las fuentes como último parámetro.
-- ---------------------------------------------------------------------------
drop function if exists crear_aporte(text, text, double precision, double precision, integer, uuid, jsonb, text);
create or replace function crear_aporte(
  tipo text,
  descripcion text,
  lat double precision,
  lng double precision,
  gravedad_sugerida integer default null,
  punto_id uuid default null,
  enlaces jsonb default '[]'::jsonb,
  titulo text default null,
  fuentes jsonb default '[]'::jsonb
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
  f jsonb := fuentes_limpias(crear_aporte.fuentes, 5);
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

  insert into aportes (punto_id, titulo, tipo, gravedad_sugerida, descripcion, ubicacion, autor_id, enlaces, fuentes)
  values (crear_aporte.punto_id, t, crear_aporte.tipo, crear_aporte.gravedad_sugerida, crear_aporte.descripcion,
          st_setsrid(st_makepoint(lng, lat), 4326)::geography, auth.uid(), limpios, f)
  returning * into nuevo;

  return aporte_json(nuevo);
end;
$$;

-- ---------------------------------------------------------------------------
-- revisar_aporte (019): el caso nuevo nace con las fuentes del reporte, y un aporte sobre un
-- caso existente suma las suyas.
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
  -- Bloquea el aporte y lo vuelve a leer: si su autor lo está editando (editar_aporte), espera
  -- a que termine y usa el texto guardado, no el que había antes de la edición.
  select * into a from aportes x where x.id = aporte_id for update;
  if not found or a.estado <> 'pendiente' then
    raise exception 'El aporte ya fue revisado' using errcode = '55000', hint = 'publico';
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
      insert into puntos (titulo, tipo, gravedad, descripcion, ubicacion, estado, autor_id, fuentes)
      values (titulo_final, a.tipo, coalesce(gravedad, a.gravedad_sugerida, 3), a.descripcion, a.ubicacion,
              'en_revision', a.autor_id, a.fuentes)
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

  -- Las fuentes de un aporte sobre un caso que ya existe se suman a las del caso (020).
  -- p.id solo tiene valor si este aporte acaba de crear el caso (ese ya nació con sus fuentes).
  if decision in ('aprobado', 'duplicado') and punto_destino is not null and p.id is null
     and jsonb_array_length(a.fuentes) > 0 then
    update puntos x set fuentes = unir_fuentes(x.fuentes, a.fuentes, 10), actualizado_en = now()
    where x.id = punto_destino;
  end if;

  if decision in ('aprobado', 'duplicado') and jsonb_array_length(a.enlaces) > 0 then
    perform publicar_enlaces_aporte(aporte_id);
  end if;

  select * into a from aportes x where x.id = aporte_id;
  return aporte_json(a) || jsonb_build_object('revisor_id', a.revisor_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- editar_aporte y editar_mi_punto (019) con las fuentes. null = no cambiar; [] = quitarlas.
-- ---------------------------------------------------------------------------
drop function if exists editar_aporte(uuid, text, text);
create or replace function editar_aporte(aporte_id uuid, titulo text default null, descripcion text default null, fuentes jsonb default null)
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
  f jsonb := case when editar_aporte.fuentes is null then null else fuentes_limpias(editar_aporte.fuentes, 5) end;
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión' using errcode = '42501', hint = 'publico';
  end if;
  if t is null and d is null and f is null then
    raise exception 'Indica el título, la descripción o las fuentes' using errcode = '22023', hint = 'publico';
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
  set titulo = coalesce(t, x.titulo), descripcion = coalesce(d, x.descripcion), fuentes = coalesce(f, x.fuentes),
      actualizado_en = now()
  where x.id = a.id
  returning * into a;
  return aporte_json(a);
end;
$$;

drop function if exists editar_mi_punto(uuid, text, text);
create or replace function editar_mi_punto(punto_id uuid, titulo text default null, descripcion text default null, fuentes jsonb default null)
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
  f jsonb := case when editar_mi_punto.fuentes is null then null else fuentes_limpias(editar_mi_punto.fuentes, 10) end;
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión' using errcode = '42501', hint = 'publico';
  end if;
  if t is null and d is null and f is null then
    raise exception 'Indica el título, la descripción o las fuentes' using errcode = '22023', hint = 'publico';
  end if;

  select * into p from puntos x where x.id = editar_mi_punto.punto_id and x.autor_id = auth.uid() for update;
  if not found then
    raise exception 'El caso no existe' using errcode = 'P0002', hint = 'publico';
  end if;
  if p.estado = 'archivado' then
    raise exception 'Un caso archivado ya no se puede editar' using errcode = '55000', hint = 'publico';
  end if;
  if coalesce(t, p.titulo) = p.titulo and coalesce(d, p.descripcion) = p.descripcion
     and coalesce(f, p.fuentes) = p.fuentes then
    return punto_json(p);
  end if;

  update puntos x
  set titulo = coalesce(t, x.titulo),
      descripcion = coalesce(d, x.descripcion),
      fuentes = coalesce(f, x.fuentes),
      estado = 'en_revision',
      actualizado_en = now()
  where x.id = p.id
  returning * into p;
  return punto_json(p);
end;
$$;

-- ---------------------------------------------------------------------------
-- Moderación: cambiar las fuentes de un caso sin cambiar su estado. Con la sesión de quien
-- llama: la política de 003 aplica (el moderador no toca archivados; el administrador sí).
-- ---------------------------------------------------------------------------
create or replace function editar_fuentes_punto(punto_id uuid, fuentes jsonb)
returns jsonb
language plpgsql
volatile
set search_path = public, extensions
as $$
declare
  p puntos;
  f jsonb := fuentes_limpias(editar_fuentes_punto.fuentes, 10);
begin
  if obtener_rol_actual() is null or obtener_rol_actual() not in ('moderador', 'administrador') then
    raise exception 'Solo moderadores' using errcode = '42501', hint = 'publico';
  end if;
  if not exists (select 1 from puntos x where x.id = editar_fuentes_punto.punto_id) then
    raise exception 'El caso no existe' using errcode = 'P0002', hint = 'publico';
  end if;

  update puntos x set fuentes = f, actualizado_en = now()
  where x.id = editar_fuentes_punto.punto_id
  returning * into p;
  if not found then
    raise exception 'No tienes permiso para editar este caso' using errcode = '42501', hint = 'publico';
  end if;
  return punto_json(p);
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución (Supabase concede EXECUTE a anon en cada función nueva; ver 017).
-- Las validaciones se conceden a authenticated porque corren dentro de funciones con la sesión
-- de quien llama y en los checks de las tablas.
-- ---------------------------------------------------------------------------
revoke execute on function
  validar_fuente(text, text),
  fuentes_limpias(jsonb, integer),
  fuentes_validas(jsonb, integer),
  unir_fuentes(jsonb, jsonb, integer),
  crear_aporte(text, text, double precision, double precision, integer, uuid, jsonb, text, jsonb),
  editar_aporte(uuid, text, text, jsonb),
  editar_mi_punto(uuid, text, text, jsonb),
  editar_fuentes_punto(uuid, jsonb)
from public, anon;

revoke execute on function auditar_edicion_texto() from public, anon, authenticated;

grant execute on function
  validar_fuente(text, text),
  fuentes_limpias(jsonb, integer),
  fuentes_validas(jsonb, integer),
  unir_fuentes(jsonb, jsonb, integer),
  crear_aporte(text, text, double precision, double precision, integer, uuid, jsonb, text, jsonb),
  editar_aporte(uuid, text, text, jsonb),
  editar_mi_punto(uuid, text, text, jsonb),
  editar_fuentes_punto(uuid, jsonb)
to authenticated, service_role;
