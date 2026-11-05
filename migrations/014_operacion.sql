-- 014: operación y gobierno (F15). B-08: los cambios que dan o quitan el rol de administrador
-- necesitan la confirmación de un segundo administrador. B-12: métricas para administración.
--
-- Regla de dos administradores:
--   * Dar o quitar el rol de administrador crea una solicitud; otro administrador la aprueba.
--     La persona afectada sí puede aprobar que le quiten el rol (es su consentimiento).
--   * Si solo hay un administrador activo, puede nombrar al segundo sin confirmación
--     (si no, nadie podría nombrarlo nunca).
--   * A un administrador no se le desactiva directamente: primero se le quita el rol.
--   * La llave de servicio (sin usuario) no tiene la regla: es la vía de recuperación.
--   * Los demás cambios de rol (ciudadano, moderador, editor) siguen siendo inmediatos.
-- Lo impone un trigger sobre perfiles, así que aplica también a quien use la API de Supabase directo.

create table if not exists solicitudes_rol (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references perfiles(id) on delete cascade,
  rol_anterior text not null check (rol_anterior in ('ciudadano', 'moderador', 'editor', 'administrador')),
  rol_nuevo text not null check (rol_nuevo in ('ciudadano', 'moderador', 'editor', 'administrador')),
  solicitado_por uuid not null references perfiles(id),
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'aprobada', 'rechazada', 'cancelada', 'vencida')),
  resuelto_por uuid references perfiles(id),
  creado_en timestamptz not null default now(),
  resuelto_en timestamptz,
  constraint solicitudes_rol_distinto check (rol_anterior <> rol_nuevo),
  constraint solicitudes_rol_ajeno check (usuario_id <> solicitado_por),
  constraint solicitudes_rol_resuelta check ((estado = 'pendiente') = (resuelto_en is null))
);
create unique index if not exists solicitudes_rol_una_pendiente on solicitudes_rol (usuario_id) where estado = 'pendiente';
create index if not exists solicitudes_rol_creado_idx on solicitudes_rol (creado_en desc);

-- Solo se toca con las funciones de abajo. Supabase da permisos por defecto en tablas nuevas:
-- se quitan, y RLS sin políticas cierra cualquier otra vía.
alter table solicitudes_rol enable row level security;
revoke all on solicitudes_rol from anon, authenticated;
grant all on solicitudes_rol to service_role;

-- Una solicitud vale 7 días.
create or replace function solicitud_vencida(s solicitudes_rol)
returns boolean
language sql
stable
as $$
  select s.estado = 'pendiente' and s.creado_en < now() - interval '7 days'
$$;

-- ¿Hay en esta misma transacción una solicitud aprobada por el usuario actual para este cambio?
-- now() es la hora de inicio de la transacción: solo coincide con lo que aprobó
-- resolver_solicitud_rol en esta misma llamada.
create or replace function cambio_rol_aprobado(perfil_id uuid, rol_nuevo text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from solicitudes_rol s
    where s.usuario_id = perfil_id and s.rol_nuevo = cambio_rol_aprobado.rol_nuevo
      and s.estado = 'aprobada' and s.resuelto_en = now() and s.resuelto_por = auth.uid()
  )
$$;

-- ---------------------------------------------------------------------------
-- Trigger de la 010, con una excepción: aprobar que te quiten el rol de administrador.
-- ---------------------------------------------------------------------------
create or replace function proteger_perfil_propio()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is not null and old.id = auth.uid()
     and (old.rol is distinct from new.rol or old.activo is distinct from new.activo)
     and not (old.activo = new.activo and new.rol <> 'administrador' and cambio_rol_aprobado(old.id, new.rol)) then
    raise exception 'No puedes cambiar tu propio rol ni desactivar tu cuenta'
      using errcode = '42501', hint = 'publico';
  end if;
  return new;
end;
$$;

create or replace function exigir_segundo_administrador()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  activos integer;
begin
  if auth.uid() is null then
    return new;  -- llave de servicio o consola: vía de recuperación
  end if;
  if old.rol = 'administrador' and old.activo and not new.activo then
    raise exception 'Para desactivar a un administrador, primero quítale el rol (otro administrador debe confirmarlo)'
      using errcode = '42501', hint = 'publico';
  end if;
  if old.rol is not distinct from new.rol or (old.rol <> 'administrador' and new.rol <> 'administrador') then
    return new;
  end if;

  select count(*) into activos from perfiles where rol = 'administrador' and activo;
  if new.rol = 'administrador' and activos <= 1 then
    return new;  -- el único administrador nombra al segundo
  end if;
  if not cambio_rol_aprobado(new.id, new.rol) then
    raise exception 'Dar o quitar el rol de administrador necesita la confirmación de otro administrador'
      using errcode = '42501', hint = 'publico';
  end if;
  if old.rol = 'administrador' and old.activo and activos <= 1 then
    raise exception 'Debe quedar al menos un administrador activo' using errcode = '42501', hint = 'publico';
  end if;
  return new;
end;
$$;

drop trigger if exists perfiles_segundo_administrador on perfiles;
create trigger perfiles_segundo_administrador
  before update of rol, activo on perfiles for each row execute function exigir_segundo_administrador();

-- ---------------------------------------------------------------------------
-- Auditoría de solicitudes. El detalle lleva roles y estados, nunca nombres ni correos.
-- ---------------------------------------------------------------------------
create or replace function auditar_solicitudes_rol()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
    values (auth.uid(), 'rol_solicitado', 'solicitudes_rol', new.id,
            jsonb_build_object('usuario_id', new.usuario_id, 'rol_anterior', new.rol_anterior, 'rol_nuevo', new.rol_nuevo));
  elsif old.estado is distinct from new.estado then
    insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
    values (auth.uid(), 'solicitud_' || new.estado, 'solicitudes_rol', new.id,
            jsonb_build_object('usuario_id', new.usuario_id, 'rol_nuevo', new.rol_nuevo));
  end if;
  return null;
end;
$$;

drop trigger if exists solicitudes_rol_auditar on solicitudes_rol;
create trigger solicitudes_rol_auditar
  after insert or update on solicitudes_rol for each row execute function auditar_solicitudes_rol();

create or replace function solicitud_rol_json(s solicitudes_rol)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', s.id,
    'usuario', jsonb_build_object('id', s.usuario_id, 'nombre', (select nombre from perfiles where id = s.usuario_id)),
    'rol_anterior', s.rol_anterior,
    'rol_nuevo', s.rol_nuevo,
    'solicitado_por', jsonb_build_object('id', s.solicitado_por, 'nombre', (select nombre from perfiles where id = s.solicitado_por)),
    'estado', case when solicitud_vencida(s) then 'vencida' else s.estado end,
    'resuelto_por', case when s.resuelto_por is null then null
                         else jsonb_build_object('id', s.resuelto_por, 'nombre', (select nombre from perfiles where id = s.resuelto_por)) end,
    'creado_en', s.creado_en,
    'resuelto_en', s.resuelto_en
  )
$$;

-- ---------------------------------------------------------------------------
-- cambiar_rol (de la 010): ahora crea una solicitud cuando el cambio la necesita.
-- Pasa a security definer porque escribe en solicitudes_rol; revisa el rol igual que antes
-- y los triggers de perfiles siguen aplicando con el usuario de la sesión.
-- Devuelve el perfil y, si quedó pendiente, la solicitud (si no, solicitud es null).
-- ---------------------------------------------------------------------------
create or replace function cambiar_rol(usuario_id uuid, rol text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  p perfiles;
  s solicitudes_rol;
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

  select * into p from perfiles x where x.id = cambiar_rol.usuario_id for update;
  if not found then
    raise exception 'El usuario no existe' using errcode = 'P0002', hint = 'publico';
  end if;

  if p.rol is distinct from cambiar_rol.rol
     and (p.rol = 'administrador' or cambiar_rol.rol = 'administrador')
     and not (cambiar_rol.rol = 'administrador' and (select count(*) from perfiles where perfiles.rol = 'administrador' and activo) <= 1) then
    update solicitudes_rol x set estado = 'vencida', resuelto_en = now()
    where x.usuario_id = p.id and solicitud_vencida(x);
    if exists (select 1 from solicitudes_rol x where x.usuario_id = p.id and x.estado = 'pendiente') then
      raise exception 'Ya hay una solicitud pendiente para este usuario' using errcode = '55000', hint = 'publico';
    end if;
    insert into solicitudes_rol (usuario_id, rol_anterior, rol_nuevo, solicitado_por)
    values (p.id, p.rol, cambiar_rol.rol, auth.uid())
    returning * into s;
  else
    update perfiles x set rol = cambiar_rol.rol, actualizado_en = now()
    where x.id = p.id and x.rol is distinct from cambiar_rol.rol
    returning * into p;
    if not found then
      select * into p from perfiles x where x.id = cambiar_rol.usuario_id;
    end if;
  end if;
  return jsonb_build_object('id', p.id, 'nombre', p.nombre, 'rol', p.rol, 'activo', p.activo,
                            'actualizado_en', p.actualizado_en,
                            'solicitud', case when s.id is null then null else solicitud_rol_json(s) end);
end;
$$;

-- Aprobar (otro administrador) o rechazar (cualquier administrador; si es quien la pidió, se cancela).
create or replace function resolver_solicitud_rol(solicitud_id uuid, aprobar boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  s solicitudes_rol;
  yo uuid := auth.uid();
begin
  if coalesce(obtener_rol_actual(), '') <> 'administrador' then
    raise exception 'Solo un administrador puede resolver solicitudes de rol' using errcode = '42501', hint = 'publico';
  end if;
  if aprobar is null then
    raise exception 'Falta la decisión' using errcode = '22023', hint = 'publico';
  end if;
  select * into s from solicitudes_rol x where x.id = solicitud_id for update;
  if not found then
    raise exception 'La solicitud no existe' using errcode = 'P0002', hint = 'publico';
  end if;
  if s.estado <> 'pendiente' then
    raise exception 'La solicitud ya fue resuelta' using errcode = '55000', hint = 'publico';
  end if;

  if not aprobar then
    update solicitudes_rol x
    set estado = case when solicitud_vencida(s) then 'vencida' when yo = s.solicitado_por then 'cancelada' else 'rechazada' end,
        resuelto_por = yo, resuelto_en = now()
    where x.id = s.id
    returning * into s;
    return solicitud_rol_json(s);
  end if;

  if yo = s.solicitado_por then
    raise exception 'Otro administrador debe confirmar el cambio' using errcode = '42501', hint = 'publico';
  end if;
  if solicitud_vencida(s) then
    raise exception 'La solicitud venció (dura 7 días); pide el cambio de nuevo' using errcode = '55000', hint = 'publico';
  end if;
  if (select x.rol from perfiles x where x.id = s.usuario_id) is distinct from s.rol_anterior then
    raise exception 'El rol de la persona cambió desde la solicitud' using errcode = '55000', hint = 'publico';
  end if;
  if not exists (select 1 from perfiles x where x.id = s.solicitado_por and x.rol = 'administrador' and x.activo) then
    raise exception 'Quien pidió el cambio ya no es administrador' using errcode = '55000', hint = 'publico';
  end if;

  update solicitudes_rol x set estado = 'aprobada', resuelto_por = yo, resuelto_en = now()
  where x.id = s.id
  returning * into s;
  update perfiles x set rol = s.rol_nuevo, actualizado_en = now() where x.id = s.usuario_id;
  return solicitud_rol_json(s);
end;
$$;

-- Pendientes primero y luego las resueltas de los últimos 30 días (máximo 50).
create or replace function listar_solicitudes_rol()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(obtener_rol_actual(), '') <> 'administrador' then
    raise exception 'Solo un administrador puede ver las solicitudes de rol' using errcode = '42501', hint = 'publico';
  end if;
  return coalesce((
    select jsonb_agg(solicitud_rol_json(s) order by (s.estado = 'pendiente' and not solicitud_vencida(s)) desc, s.creado_en desc)
    from solicitudes_rol s
    where s.id in (
      select x.id from solicitudes_rol x
      where x.estado = 'pendiente' or x.creado_en > now() - interval '30 days'
      order by x.creado_en desc
      limit 50
    )
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Métricas (B-12): solo conteos, sin datos personales. Solo administrador.
-- Las conversaciones del asistente se borran a los 7 días, así que sus cifras son de 7 días.
-- ---------------------------------------------------------------------------
create or replace function metricas_plataforma()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  semana_actual date := date_trunc('week', now())::date;
begin
  if coalesce(obtener_rol_actual(), '') <> 'administrador' then
    raise exception 'Solo un administrador puede ver las métricas' using errcode = '42501', hint = 'publico';
  end if;
  return jsonb_build_object(
    'generado_en', now(),
    'puntos', jsonb_build_object(
      'publicados', (select count(*) from puntos where estado = 'publicado'),
      'en_revision', (select count(*) from puntos where estado = 'en_revision'),
      'archivados', (select count(*) from puntos where estado = 'archivado'),
      'por_tipo', coalesce((select jsonb_object_agg(tipo, n) from (
        select tipo, count(*) n from puntos where estado = 'publicado' group by tipo) t), '{}'::jsonb),
      'por_gravedad', coalesce((select jsonb_object_agg(gravedad::text, n) from (
        select gravedad, count(*) n from puntos where estado = 'publicado' group by gravedad) g), '{}'::jsonb)
    ),
    'aportes', jsonb_build_object(
      'pendientes', (select count(*) from aportes where estado = 'pendiente'),
      'aprobados', (select count(*) from aportes where estado = 'aprobado'),
      'rechazados', (select count(*) from aportes where estado = 'rechazado'),
      'duplicados', (select count(*) from aportes where estado = 'duplicado'),
      'ultimos_30_dias', (select count(*) from aportes where creado_en > now() - interval '30 days'),
      -- Desde que llega hasta que se decide (la última actualización), en los últimos 90 días.
      'horas_revision_mediana', (
        select round((percentile_cont(0.5) within group (order by extract(epoch from actualizado_en - creado_en)) / 3600)::numeric, 1)
        from aportes where estado <> 'pendiente' and creado_en > now() - interval '90 days'),
      'por_semana', (
        select jsonb_agg(jsonb_build_object('semana', s.semana, 'recibidos',
          (select count(*) from aportes a where a.creado_en >= s.semana and a.creado_en < s.semana + 7)) order by s.semana)
        from (select (semana_actual - 7 * i) as semana from generate_series(0, 7) i) s)
    ),
    'usuarios', jsonb_build_object(
      'total', (select count(*) from perfiles),
      'activos', (select count(*) from perfiles where activo),
      'nuevos_30_dias', (select count(*) from perfiles where creado_en > now() - interval '30 days'),
      'por_rol', coalesce((select jsonb_object_agg(rol, n) from (
        select rol, count(*) n from perfiles where activo group by rol) r), '{}'::jsonb)
    ),
    'catalogo', jsonb_build_object(
      'acciones_activas', (select count(*) from acciones where activa),
      'organizaciones_activas', (select count(*) from organizaciones where activa),
      'documentos_activos', (select count(*) from documentos_conocimiento where activo),
      'fragmentos', (select count(*) from fragmentos f join documentos_conocimiento d on d.id = f.documento_id where d.activo)
    ),
    'asistente', jsonb_build_object(
      'conversaciones_7_dias', (select count(*) from conversaciones_agente where creado_en > now() - interval '7 days'),
      'con_herramientas', (select count(*) from conversaciones_agente
        where creado_en > now() - interval '7 days' and jsonb_typeof(fuentes -> 'herramientas') = 'array'
          and jsonb_array_length(fuentes -> 'herramientas') > 0),
      'con_documentos', (select count(*) from conversaciones_agente
        where creado_en > now() - interval '7 days' and jsonb_typeof(fuentes -> 'documentos') = 'array'
          and jsonb_array_length(fuentes -> 'documentos') > 0),
      'sin_ia', (select count(*) from conversaciones_agente
        where creado_en > now() - interval '7 days' and fuentes ->> 'modelo' = 'respaldo-sin-ia')
    ),
    'pendientes_de_rol', (select count(*) from solicitudes_rol x where x.estado = 'pendiente' and not solicitud_vencida(x))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución
-- ---------------------------------------------------------------------------
revoke execute on function
  solicitud_vencida(solicitudes_rol),
  cambio_rol_aprobado(uuid, text),
  exigir_segundo_administrador(),
  auditar_solicitudes_rol(),
  solicitud_rol_json(solicitudes_rol),
  cambiar_rol(uuid, text),
  resolver_solicitud_rol(uuid, boolean),
  listar_solicitudes_rol(),
  metricas_plataforma()
from public, anon;

grant execute on function
  cambiar_rol(uuid, text),
  resolver_solicitud_rol(uuid, boolean),
  listar_solicitudes_rol(),
  metricas_plataforma()
to authenticated, service_role;

-- proteger_perfil_propio corre con la sesión del usuario y llama a cambio_rol_aprobado.
grant execute on function cambio_rol_aprobado(uuid, text) to authenticated, service_role;
