-- 010: administración (fase 7): acciones, organizaciones, usuarios, roles y auditoría.
-- Mismo patrón que la 008: funciones con la sesión del usuario (security invoker) para que
-- RLS siga aplicando, y auditoría con triggers security definer (D-23). La única función
-- security definer es listar_usuarios, porque el correo vive en auth.users (D-29).

-- ---------------------------------------------------------------------------
-- Los enlaces de las acciones deben ser https, también si se insertan por fuera de la API.
-- ---------------------------------------------------------------------------
alter table acciones drop constraint if exists acciones_enlace_https;
alter table acciones add constraint acciones_enlace_https
  check (enlace is null or enlace ~ '^https://[^[:space:]]+$');

-- ---------------------------------------------------------------------------
-- Nadie cambia su propio rol ni se desactiva a sí mismo, aunque use la API de Supabase
-- directo. Así siempre queda al menos un administrador. La llave de servicio (sin
-- usuario) no tiene esta restricción: es la vía para nombrar al primer administrador.
-- ---------------------------------------------------------------------------
create or replace function proteger_perfil_propio()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is not null and old.id = auth.uid()
     and (old.rol is distinct from new.rol or old.activo is distinct from new.activo) then
    raise exception 'No puedes cambiar tu propio rol ni desactivar tu cuenta'
      using errcode = '42501', hint = 'publico';
  end if;
  return new;
end;
$$;

drop trigger if exists perfiles_proteger_propio on perfiles;
create trigger perfiles_proteger_propio
  before update of rol, activo on perfiles for each row execute function proteger_perfil_propio();

-- ---------------------------------------------------------------------------
-- Auditoría de perfiles, acciones y organizaciones. Una fila por cambio.
-- El detalle guarda roles, estados, ids y nombres de columnas; nunca textos ni contactos.
-- ---------------------------------------------------------------------------
create or replace function auditar_perfiles()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.rol is distinct from new.rol then
    insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
    values (auth.uid(), 'rol_cambiado', 'perfiles', new.id,
            jsonb_build_object('rol_anterior', old.rol, 'rol_nuevo', new.rol));
  end if;
  if old.activo is distinct from new.activo then
    insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
    values (auth.uid(), case when new.activo then 'usuario_activado' else 'usuario_desactivado' end,
            'perfiles', new.id, '{}'::jsonb);
  end if;
  return new;
end;
$$;

-- Columnas que cambiaron entre dos versiones de una fila, sin actualizado_en.
create or replace function columnas_cambiadas(anterior jsonb, nueva jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(jsonb_agg(n.key order by n.key), '[]'::jsonb)
  from jsonb_each(nueva) n
  where n.key <> 'actualizado_en' and n.value is distinct from anterior -> n.key
$$;

create or replace function auditar_catalogo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  entidad text := case tg_table_name when 'acciones' then 'accion' else 'organizacion' end;
  nueva jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  anterior jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
  detalle jsonb;
  sufijo text;
begin
  if tg_op = 'INSERT' then
    sufijo := '_creada';
    detalle := jsonb_strip_nulls(jsonb_build_object('tipo', nueva ->> 'tipo', 'activa', nueva -> 'activa'));
  elsif tg_op = 'UPDATE' then
    sufijo := '_actualizada';
    detalle := jsonb_build_object('columnas', columnas_cambiadas(anterior, nueva));
  else
    sufijo := '_eliminada';
    detalle := '{}'::jsonb;
  end if;
  insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
  values (auth.uid(), entidad || sufijo, tg_table_name, (coalesce(nueva, anterior) ->> 'id')::uuid, detalle);
  return null; -- trigger after: el valor de retorno se ignora
end;
$$;

revoke execute on function auditar_perfiles(), auditar_catalogo(), proteger_perfil_propio() from public;

drop trigger if exists perfiles_auditar on perfiles;
create trigger perfiles_auditar
  after update of rol, activo on perfiles for each row
  when (old.rol is distinct from new.rol or old.activo is distinct from new.activo)
  execute function auditar_perfiles();

drop trigger if exists acciones_auditar on acciones;
create trigger acciones_auditar
  after insert or update or delete on acciones for each row execute function auditar_catalogo();

drop trigger if exists organizaciones_auditar on organizaciones;
create trigger organizaciones_auditar
  after insert or update or delete on organizaciones for each row execute function auditar_catalogo();

-- ---------------------------------------------------------------------------
-- Formas JSON para el panel (incluyen datos internos: solo las ve el personal).
-- ---------------------------------------------------------------------------
create or replace function accion_json(a acciones)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', a.id, 'tipo', a.tipo, 'nombre', a.nombre, 'descripcion', a.descripcion, 'enlace', a.enlace,
    'organizacion_id', a.organizacion_id, 'punto_id', a.punto_id, 'activa', a.activa,
    'creado_en', a.creado_en, 'actualizado_en', a.actualizado_en
  )
$$;

create or replace function organizacion_json(o organizaciones)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'id', o.id, 'nombre', o.nombre, 'contacto', o.contacto, 'zona', o.zona, 'activa', o.activa,
    'creado_por', o.creado_por, 'creado_en', o.creado_en, 'actualizado_en', o.actualizado_en
  )
$$;

-- ---------------------------------------------------------------------------
-- Acciones y organizaciones: editor y administrador (políticas de la 003).
-- ---------------------------------------------------------------------------
create or replace function crear_accion(
  tipo text,
  nombre text,
  descripcion text default null,
  enlace text default null,
  organizacion_id uuid default null,
  punto_id uuid default null
)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  a acciones;
begin
  if coalesce(obtener_rol_actual(), '') not in ('editor', 'administrador') then
    raise exception 'Solo un editor o administrador puede crear acciones' using errcode = '42501', hint = 'publico';
  end if;
  if enlace is not null and enlace !~ '^https://[^[:space:]]+$' then
    raise exception 'El enlace debe empezar con https://' using errcode = '22023', hint = 'publico';
  end if;
  if crear_accion.organizacion_id is not null
     and not exists (select 1 from organizaciones o where o.id = crear_accion.organizacion_id and o.activa) then
    raise exception 'La organización indicada no existe o no está activa' using errcode = '22023', hint = 'publico';
  end if;
  -- Con RLS, el editor solo ve puntos publicados: una acción no puede colgar de uno oculto.
  if crear_accion.punto_id is not null
     and not exists (select 1 from puntos p where p.id = crear_accion.punto_id and p.estado = 'publicado') then
    raise exception 'El punto indicado no existe o no está publicado' using errcode = '22023', hint = 'publico';
  end if;

  insert into acciones (tipo, nombre, descripcion, enlace, organizacion_id, punto_id)
  values (crear_accion.tipo, crear_accion.nombre, crear_accion.descripcion, crear_accion.enlace,
          crear_accion.organizacion_id, crear_accion.punto_id)
  returning * into a;
  return accion_json(a);
end;
$$;

create or replace function crear_organizacion(nombre text, contacto text default null, zona text default null)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  o organizaciones;
begin
  if coalesce(obtener_rol_actual(), '') not in ('editor', 'administrador') then
    raise exception 'Solo un editor o administrador puede crear organizaciones' using errcode = '42501', hint = 'publico';
  end if;
  insert into organizaciones (nombre, contacto, zona, creado_por)
  values (crear_organizacion.nombre, crear_organizacion.contacto, crear_organizacion.zona, auth.uid())
  returning * into o;
  return organizacion_json(o);
end;
$$;

-- ---------------------------------------------------------------------------
-- Usuarios: solo administrador. Nunca devuelve el teléfono.
-- security definer para leer el correo de auth.users; por eso comprueba el rol a mano.
-- ---------------------------------------------------------------------------
create or replace function listar_usuarios(
  rol_filtro text default null,
  busqueda text default null,
  limite integer default 20,
  desplazamiento integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  texto text := nullif(lower(trim(busqueda)), '');
  resultado jsonb;
begin
  if coalesce(obtener_rol_actual(), '') <> 'administrador' then
    raise exception 'Solo un administrador puede ver los usuarios' using errcode = '42501', hint = 'publico';
  end if;
  if limite is null or limite < 1 or limite > 100 then
    raise exception 'El límite debe estar entre 1 y 100' using errcode = '22023';
  end if;
  if desplazamiento is null or desplazamiento < 0 then
    raise exception 'El desplazamiento no puede ser negativo' using errcode = '22023';
  end if;

  with filtrados as (
    select p.id, p.nombre, u.email::text as email, p.rol, p.activo, p.creado_en
    from perfiles p
    join auth.users u on u.id = p.id
    where (rol_filtro is null or p.rol = rol_filtro)
      -- position() y no like: los % o _ de la búsqueda se toman como texto.
      and (texto is null or position(texto in lower(p.nombre)) > 0 or position(texto in lower(coalesce(u.email::text, ''))) > 0)
  ),
  pagina as (
    select * from filtrados order by creado_en desc, id limit limite offset desplazamiento
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrados),
    'datos', coalesce((select jsonb_agg(to_jsonb(g) order by g.creado_en desc, g.id) from pagina g), '[]'::jsonb)
  ) into resultado;
  return resultado;
end;
$$;

-- Con la sesión del administrador: RLS (perfiles_administrador_actualizacion) y el trigger
-- de perfil propio aplican. Si el rol no cambia, no se escribe nada ni se audita.
create or replace function cambiar_rol(usuario_id uuid, rol text)
returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  p perfiles;
begin
  if coalesce(obtener_rol_actual(), '') <> 'administrador' then
    raise exception 'Solo un administrador puede cambiar roles' using errcode = '42501', hint = 'publico';
  end if;
  if cambiar_rol.rol is null or cambiar_rol.rol not in ('ciudadano', 'moderador', 'editor', 'administrador') then
    raise exception 'Rol no válido' using errcode = '22023', hint = 'publico';
  end if;
  if cambiar_rol.usuario_id = auth.uid() then
    raise exception 'No puedes cambiar tu propio rol' using errcode = '42501', hint = 'publico';
  end if;

  update perfiles x set rol = cambiar_rol.rol, actualizado_en = now()
  where x.id = cambiar_rol.usuario_id and x.rol is distinct from cambiar_rol.rol
  returning * into p;
  if not found then
    select * into p from perfiles x where x.id = cambiar_rol.usuario_id;
    if not found then
      raise exception 'El usuario no existe' using errcode = 'P0002', hint = 'publico';
    end if;
  end if;
  return jsonb_build_object('id', p.id, 'nombre', p.nombre, 'rol', p.rol, 'activo', p.activo,
                            'actualizado_en', p.actualizado_en);
end;
$$;

-- ---------------------------------------------------------------------------
-- Auditoría: solo administrador (además de la política de la 003), de la más reciente
-- a la más antigua.
-- ---------------------------------------------------------------------------
create or replace function listar_auditoria(
  tabla_filtro text default null,
  accion_filtro text default null,
  usuario_filtro uuid default null,
  registro_filtro uuid default null,
  desde timestamptz default null,
  hasta timestamptz default null,
  limite integer default 50,
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
  if coalesce(obtener_rol_actual(), '') <> 'administrador' then
    raise exception 'Solo un administrador puede ver la auditoría' using errcode = '42501', hint = 'publico';
  end if;
  if limite is null or limite < 1 or limite > 100 then
    raise exception 'El límite debe estar entre 1 y 100' using errcode = '22023';
  end if;
  if desplazamiento is null or desplazamiento < 0 then
    raise exception 'El desplazamiento no puede ser negativo' using errcode = '22023';
  end if;
  if desde is not null and hasta is not null and desde > hasta then
    raise exception 'La fecha inicial es posterior a la final' using errcode = '22023';
  end if;

  with filtrados as (
    select a.id, a.usuario_id, a.accion, a.tabla, a.registro_id, a.detalle, a.creado_en
    from auditoria a
    where (tabla_filtro is null or a.tabla = tabla_filtro)
      and (accion_filtro is null or a.accion = accion_filtro)
      and (usuario_filtro is null or a.usuario_id = usuario_filtro)
      and (registro_filtro is null or a.registro_id = registro_filtro)
      and (desde is null or a.creado_en >= desde)
      and (hasta is null or a.creado_en <= hasta)
  ),
  pagina as (
    select * from filtrados order by creado_en desc, id limit limite offset desplazamiento
  )
  select jsonb_build_object(
    'total', (select count(*) from filtrados),
    'datos', coalesce((select jsonb_agg(to_jsonb(g) order by g.creado_en desc, g.id) from pagina g), '[]'::jsonb)
  ) into resultado;
  return resultado;
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución: solo sesiones autenticadas (y el backend).
-- ---------------------------------------------------------------------------
revoke execute on function
  accion_json(acciones),
  organizacion_json(organizaciones),
  columnas_cambiadas(jsonb, jsonb),
  crear_accion(text, text, text, text, uuid, uuid),
  crear_organizacion(text, text, text),
  listar_usuarios(text, text, integer, integer),
  cambiar_rol(uuid, text),
  listar_auditoria(text, text, uuid, uuid, timestamptz, timestamptz, integer, integer)
from public;

grant execute on function
  accion_json(acciones),
  organizacion_json(organizaciones),
  columnas_cambiadas(jsonb, jsonb),
  crear_accion(text, text, text, text, uuid, uuid),
  crear_organizacion(text, text, text),
  listar_usuarios(text, text, integer, integer),
  cambiar_rol(uuid, text),
  listar_auditoria(text, text, uuid, uuid, timestamptz, timestamptz, integer, integer)
to authenticated, service_role;
