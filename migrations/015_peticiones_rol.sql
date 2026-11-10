-- 015: cualquier persona registrada puede pedir el rol de moderadora o editora (D-45).
--
--   * La persona escribe un motivo y, si quiere, su zona o colectivo. Una petición pendiente a la vez.
--   * Un administrador la aprueba (el rol cambia en ese momento) o la rechaza con una respuesta opcional.
--   * Tras un rechazo hay que esperar 7 días para volver a pedir. Ser administrador no se pide: lo
--     da otro administrador con la regla de dos administradores (014).
--   * La tabla está cerrada (RLS sin políticas): solo se toca con las funciones de abajo.
--   * El backend avisa por correo. Los correos los lee solo la llave de servicio con
--     destinatarios_peticion_rol; la API nunca los devuelve a la persona que pide.
--
-- Distinta de solicitudes_rol (014): aquella es el control entre administradores; esta la inicia
-- la propia persona.

create table if not exists peticiones_rol (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references perfiles(id) on delete cascade,
  rol_actual text not null check (rol_actual in ('ciudadano', 'moderador', 'editor')),
  rol_pedido text not null check (rol_pedido in ('moderador', 'editor')),
  motivo text not null check (char_length(motivo) between 20 and 1000),
  zona text check (zona is null or char_length(zona) between 2 and 200),
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'aprobada', 'rechazada', 'cancelada')),
  respuesta text check (respuesta is null or char_length(respuesta) between 1 and 500),
  resuelto_por uuid references perfiles(id) on delete set null,
  creado_en timestamptz not null default now(),
  resuelto_en timestamptz,
  constraint peticiones_rol_distinto check (rol_actual <> rol_pedido),
  constraint peticiones_rol_resuelta check ((estado = 'pendiente') = (resuelto_en is null))
);
create unique index if not exists peticiones_rol_una_pendiente on peticiones_rol (usuario_id) where estado = 'pendiente';
create index if not exists peticiones_rol_creado_idx on peticiones_rol (creado_en desc);

alter table peticiones_rol enable row level security;
revoke all on peticiones_rol from anon, authenticated;
grant all on peticiones_rol to service_role;

-- Auditoría: roles y estados, nunca el motivo, la zona ni datos de contacto.
create or replace function auditar_peticiones_rol()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
    values (auth.uid(), 'rol_pedido', 'peticiones_rol', new.id,
            jsonb_build_object('usuario_id', new.usuario_id, 'rol_actual', new.rol_actual, 'rol_pedido', new.rol_pedido));
  elsif old.estado is distinct from new.estado then
    insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
    values (auth.uid(), 'peticion_' || new.estado, 'peticiones_rol', new.id,
            jsonb_build_object('usuario_id', new.usuario_id, 'rol_pedido', new.rol_pedido));
  end if;
  return null;
end;
$$;

drop trigger if exists peticiones_rol_auditar on peticiones_rol;
create trigger peticiones_rol_auditar
  after insert or update on peticiones_rol for each row execute function auditar_peticiones_rol();

-- Vista para la propia persona: sin quién la resolvió.
create or replace function peticion_rol_propia_json(p peticiones_rol)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p.id, 'rol_actual', p.rol_actual, 'rol_pedido', p.rol_pedido, 'motivo', p.motivo, 'zona', p.zona,
    'estado', p.estado, 'respuesta', p.respuesta, 'creado_en', p.creado_en, 'resuelto_en', p.resuelto_en
  )
$$;

-- Vista para administración: nombre público de la persona, sin correo.
create or replace function peticion_rol_json(p peticiones_rol)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select peticion_rol_propia_json(p) || jsonb_build_object(
    'usuario', jsonb_build_object('id', p.usuario_id, 'nombre', (select nombre from perfiles where id = p.usuario_id)),
    'resuelto_por', case when p.resuelto_por is null then null
                         else jsonb_build_object('id', p.resuelto_por, 'nombre', (select nombre from perfiles where id = p.resuelto_por)) end
  )
$$;

-- ---------------------------------------------------------------------------
-- La persona: pedir, ver y cancelar.
-- ---------------------------------------------------------------------------
create or replace function pedir_rol(rol text, motivo text, zona text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  yo uuid := auth.uid();
  actual text := obtener_rol_actual();
  limpio_motivo text := nullif(btrim(pedir_rol.motivo), '');
  limpia_zona text := nullif(btrim(pedir_rol.zona), '');
  p peticiones_rol;
begin
  if yo is null or actual is null then
    raise exception 'Inicia sesión con una cuenta activa para pedir un rol' using errcode = '42501', hint = 'publico';
  end if;
  if pedir_rol.rol is null or pedir_rol.rol not in ('moderador', 'editor') then
    raise exception 'Solo se puede pedir el rol de moderador o de editor' using errcode = '22023', hint = 'publico';
  end if;
  if actual = 'administrador' then
    raise exception 'Ya eres administrador' using errcode = '22023', hint = 'publico';
  end if;
  if actual = pedir_rol.rol then
    raise exception 'Ya tienes ese rol' using errcode = '22023', hint = 'publico';
  end if;
  if limpio_motivo is null or char_length(limpio_motivo) < 20 or char_length(limpio_motivo) > 1000 then
    raise exception 'Explica el motivo en 20 a 1000 caracteres' using errcode = '22023', hint = 'publico';
  end if;
  if limpia_zona is not null and (char_length(limpia_zona) < 2 or char_length(limpia_zona) > 200) then
    raise exception 'La zona o colectivo debe tener de 2 a 200 caracteres' using errcode = '22023', hint = 'publico';
  end if;
  if exists (select 1 from peticiones_rol x where x.usuario_id = yo and x.estado = 'pendiente') then
    raise exception 'Ya tienes una petición pendiente' using errcode = '55000', hint = 'publico';
  end if;
  if exists (select 1 from peticiones_rol x where x.usuario_id = yo and x.estado = 'rechazada'
             and x.resuelto_en > now() - interval '7 days') then
    raise exception 'Tu última petición fue rechazada hace menos de 7 días; espera para volver a pedir'
      using errcode = '55000', hint = 'publico';
  end if;

  insert into peticiones_rol (usuario_id, rol_actual, rol_pedido, motivo, zona)
  values (yo, actual, pedir_rol.rol, limpio_motivo, limpia_zona)
  returning * into p;
  return peticion_rol_propia_json(p);
end;
$$;

-- Las de los últimos 12 meses, la más reciente primero.
create or replace function mis_peticiones_rol()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(peticion_rol_propia_json(p) order by p.creado_en desc), '[]'::jsonb)
  from peticiones_rol p
  where p.usuario_id = auth.uid() and p.creado_en > now() - interval '12 months'
$$;

create or replace function cancelar_peticion_rol(peticion_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  p peticiones_rol;
begin
  if auth.uid() is null then
    raise exception 'Inicia sesión' using errcode = '42501', hint = 'publico';
  end if;
  update peticiones_rol x set estado = 'cancelada', resuelto_por = auth.uid(), resuelto_en = now()
  where x.id = peticion_id and x.usuario_id = auth.uid() and x.estado = 'pendiente'
  returning * into p;
  if not found then
    -- Mismo mensaje si no existe o es de otra persona: no se revela que exista.
    raise exception 'No tienes una petición pendiente con ese id' using errcode = 'P0002', hint = 'publico';
  end if;
  return peticion_rol_propia_json(p);
end;
$$;

-- ---------------------------------------------------------------------------
-- Administración: listar y resolver.
-- ---------------------------------------------------------------------------
-- Pendientes primero (todas) y luego las resueltas de los últimos 30 días (máximo 50).
create or replace function listar_peticiones_rol()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(obtener_rol_actual(), '') <> 'administrador' then
    raise exception 'Solo un administrador puede ver las peticiones de rol' using errcode = '42501', hint = 'publico';
  end if;
  return coalesce((
    select jsonb_agg(peticion_rol_json(p) order by (p.estado = 'pendiente') desc, p.creado_en desc)
    from peticiones_rol p
    where p.estado = 'pendiente'
       or p.id in (select x.id from peticiones_rol x
                   where x.estado <> 'pendiente' and x.creado_en > now() - interval '30 days'
                   order by x.creado_en desc limit 50)
  ), '[]'::jsonb);
end;
$$;

create or replace function resolver_peticion_rol(peticion_id uuid, aprobar boolean, respuesta text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  p peticiones_rol;
  yo uuid := auth.uid();
  texto text := nullif(btrim(resolver_peticion_rol.respuesta), '');
  rol_hoy text;
  activo_hoy boolean;
begin
  if coalesce(obtener_rol_actual(), '') <> 'administrador' then
    raise exception 'Solo un administrador puede resolver peticiones de rol' using errcode = '42501', hint = 'publico';
  end if;
  if aprobar is null then
    raise exception 'Falta la decisión' using errcode = '22023', hint = 'publico';
  end if;
  if texto is not null and char_length(texto) > 500 then
    raise exception 'La respuesta debe tener como máximo 500 caracteres' using errcode = '22023', hint = 'publico';
  end if;
  select * into p from peticiones_rol x where x.id = peticion_id for update;
  if not found then
    raise exception 'La petición no existe' using errcode = 'P0002', hint = 'publico';
  end if;
  if p.estado <> 'pendiente' then
    raise exception 'La petición ya fue resuelta' using errcode = '55000', hint = 'publico';
  end if;
  if p.usuario_id = yo then
    raise exception 'No puedes resolver tu propia petición' using errcode = '42501', hint = 'publico';
  end if;

  if aprobar then
    select x.rol, x.activo into rol_hoy, activo_hoy from perfiles x where x.id = p.usuario_id for update;
    if not activo_hoy then
      raise exception 'La cuenta está desactivada' using errcode = '55000', hint = 'publico';
    end if;
    if rol_hoy is distinct from p.rol_actual then
      raise exception 'El rol de la persona cambió desde que pidió; recházala y que pida de nuevo'
        using errcode = '55000', hint = 'publico';
    end if;
    -- El trigger de la 010 audita el cambio de rol (rol_cambiado) con este administrador.
    update perfiles x set rol = p.rol_pedido, actualizado_en = now() where x.id = p.usuario_id;
  end if;

  update peticiones_rol x
  set estado = case when aprobar then 'aprobada' else 'rechazada' end,
      respuesta = texto, resuelto_por = yo, resuelto_en = now()
  where x.id = p.id
  returning * into p;
  return peticion_rol_json(p);
end;
$$;

-- ---------------------------------------------------------------------------
-- Solo para el backend (llave de servicio): a quién avisar por correo.
--   evento 'nueva'    → administradores activos (menos la propia persona, por si acaso).
--   evento 'resuelta' → la persona que pidió.
-- ---------------------------------------------------------------------------
create or replace function destinatarios_peticion_rol(peticion_id uuid, evento text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  p peticiones_rol;
begin
  select * into p from peticiones_rol x where x.id = peticion_id;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'peticion', jsonb_build_object('id', p.id, 'rol_pedido', p.rol_pedido, 'estado', p.estado, 'respuesta', p.respuesta,
                                   'nombre', (select nombre from perfiles where id = p.usuario_id)),
    'destinatarios', coalesce((
      select jsonb_agg(jsonb_build_object('email', u.email, 'nombre', f.nombre) order by f.creado_en)
      from perfiles f join auth.users u on u.id = f.id
      where u.email is not null
        and case evento
              when 'nueva' then f.rol = 'administrador' and f.activo and f.id <> p.usuario_id
              when 'resuelta' then f.id = p.usuario_id
              else false
            end
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución
-- ---------------------------------------------------------------------------
revoke execute on function
  auditar_peticiones_rol(),
  peticion_rol_propia_json(peticiones_rol),
  peticion_rol_json(peticiones_rol),
  pedir_rol(text, text, text),
  mis_peticiones_rol(),
  cancelar_peticion_rol(uuid),
  listar_peticiones_rol(),
  resolver_peticion_rol(uuid, boolean, text),
  destinatarios_peticion_rol(uuid, text)
from public, anon;

grant execute on function
  pedir_rol(text, text, text),
  mis_peticiones_rol(),
  cancelar_peticion_rol(uuid),
  listar_peticiones_rol(),
  resolver_peticion_rol(uuid, boolean, text)
to authenticated, service_role;

-- Los correos solo los lee el backend.
grant execute on function destinatarios_peticion_rol(uuid, text) to service_role;
