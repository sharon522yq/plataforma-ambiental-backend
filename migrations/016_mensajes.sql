-- 016: mensajes entre personas usuarias sobre un punto publicado (D-46).
--
--   * Desde un punto publicado, cualquier cuenta activa escribe a quien lo reportó. Se abre una
--     conversación privada entre las dos; nadie más la lee.
--   * Quien reportó sigue anónimo: la otra persona lo ve como «Quien reportó el punto», nunca su
--     nombre ni su correo. Quien escribe primero aparece con su nombre público.
--   * Ninguna de las dos ve el correo de la otra. El aviso por correo lo envía el backend con la
--     llave de servicio (destinatario_mensaje) y no lleva el texto del mensaje.
--   * Cualquiera de las dos puede cerrar la conversación (bloquear) o denunciarla. Una denuncia la
--     cierra y la deja visible para moderación, que es la única forma en que alguien más la lee.
--   * Límites contra abuso: 30 mensajes por hora y 10 conversaciones nuevas por día por persona.
--   * Las tablas están cerradas (RLS sin políticas): solo se tocan con las funciones de abajo.

create table if not exists hilos (
  id uuid primary key default gen_random_uuid(),
  punto_id uuid not null references puntos(id) on delete cascade,
  iniciador_id uuid not null references perfiles(id) on delete cascade,
  destinatario_id uuid not null references perfiles(id) on delete cascade,
  estado text not null default 'abierto' check (estado in ('abierto', 'cerrado')),
  cerrado_por uuid references perfiles(id) on delete set null,
  creado_en timestamptz not null default now(),
  ultimo_mensaje_en timestamptz not null default now(),
  constraint hilos_distintos check (iniciador_id <> destinatario_id),
  constraint hilos_uno_por_punto unique (punto_id, iniciador_id)
);
create index if not exists hilos_iniciador_idx on hilos (iniciador_id, ultimo_mensaje_en desc);
create index if not exists hilos_destinatario_idx on hilos (destinatario_id, ultimo_mensaje_en desc);

create table if not exists mensajes (
  id uuid primary key default gen_random_uuid(),
  hilo_id uuid not null references hilos(id) on delete cascade,
  autor_id uuid not null references perfiles(id) on delete cascade,
  texto text not null check (char_length(texto) between 1 and 2000),
  creado_en timestamptz not null default now(),
  leido_en timestamptz
);
create index if not exists mensajes_hilo_idx on mensajes (hilo_id, creado_en);
create index if not exists mensajes_autor_idx on mensajes (autor_id, creado_en desc);

create table if not exists denuncias_hilo (
  id uuid primary key default gen_random_uuid(),
  hilo_id uuid not null references hilos(id) on delete cascade,
  denunciante_id uuid not null references perfiles(id) on delete cascade,
  motivo text not null check (char_length(motivo) between 10 and 500),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'revisada')),
  nota text check (nota is null or char_length(nota) between 1 and 500),
  revisada_por uuid references perfiles(id) on delete set null,
  creado_en timestamptz not null default now(),
  revisada_en timestamptz,
  constraint denuncias_hilo_una unique (hilo_id, denunciante_id),
  constraint denuncias_hilo_revisada check ((estado = 'pendiente') = (revisada_en is null))
);

alter table hilos enable row level security;
alter table mensajes enable row level security;
alter table denuncias_hilo enable row level security;
revoke all on hilos, mensajes, denuncias_hilo from anon, authenticated;
grant all on hilos, mensajes, denuncias_hilo to service_role;

-- Auditoría de las denuncias (quién y cuándo), nunca del texto de los mensajes.
create or replace function auditar_denuncias_hilo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
    values (auth.uid(), 'conversacion_denunciada', 'denuncias_hilo', new.id, jsonb_build_object('hilo_id', new.hilo_id));
  elsif old.estado is distinct from new.estado then
    insert into auditoria (usuario_id, accion, tabla, registro_id, detalle)
    values (auth.uid(), 'denuncia_revisada', 'denuncias_hilo', new.id, jsonb_build_object('hilo_id', new.hilo_id));
  end if;
  return null;
end;
$$;

drop trigger if exists denuncias_hilo_auditar on denuncias_hilo;
create trigger denuncias_hilo_auditar
  after insert or update on denuncias_hilo for each row execute function auditar_denuncias_hilo();

-- ---------------------------------------------------------------------------
-- Vistas JSON. `yo` decide cómo se nombra a la otra persona.
-- ---------------------------------------------------------------------------
create or replace function hilo_json(h hilos, yo uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'id', h.id,
    'punto', jsonb_build_object('id', p.id, 'titulo', p.titulo),
    -- Quien reportó nunca se nombra. Quien inició aparece con su nombre público.
    'con', case when yo = h.iniciador_id then 'Quien reportó el punto'
                else coalesce(nullif(btrim((select f.nombre from perfiles f where f.id = h.iniciador_id)), ''), 'Una persona') end,
    'soy_quien_reporto', yo = h.destinatario_id,
    'estado', h.estado,
    'cerrado_por_mi', h.cerrado_por is not null and h.cerrado_por = yo,
    'no_leidos', (select count(*) from mensajes m where m.hilo_id = h.id and m.autor_id <> yo and m.leido_en is null),
    'creado_en', h.creado_en,
    'ultimo_mensaje_en', h.ultimo_mensaje_en
  )
  from puntos p where p.id = h.punto_id
$$;

create or replace function mensaje_json(m mensajes, yo uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object('id', m.id, 'mio', m.autor_id = yo, 'texto', m.texto, 'creado_en', m.creado_en, 'leido_en', m.leido_en)
$$;

-- Reglas comunes al escribir: cuenta activa y límite por hora. El candado por persona se queda
-- hasta el final de la transacción: dos envíos en paralelo de la misma persona esperan su turno,
-- así no pueden contar 29 los dos y pasarse del límite (ni del de conversaciones nuevas).
-- Es volatile para que el conteo vea lo que el envío anterior ya confirmó.
create or replace function revisar_puede_escribir(texto text)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  limpio text := nullif(btrim(texto), '');
begin
  if auth.uid() is null or obtener_rol_actual() is null then
    raise exception 'Inicia sesión con una cuenta activa para escribir' using errcode = '42501', hint = 'publico';
  end if;
  perform pg_advisory_xact_lock(hashtext('mensajes:' || auth.uid()::text));
  if limpio is null or char_length(limpio) > 2000 then
    raise exception 'El mensaje debe tener de 1 a 2000 caracteres' using errcode = '22023', hint = 'publico';
  end if;
  if (select count(*) from mensajes m where m.autor_id = auth.uid() and m.creado_en > now() - interval '1 hour') >= 30 then
    raise exception 'Escribiste muchos mensajes en la última hora; espera un poco' using errcode = '55000', hint = 'publico';
  end if;
  return limpio;
end;
$$;

-- ---------------------------------------------------------------------------
-- Escribir
-- ---------------------------------------------------------------------------
-- Primer mensaje (o siguiente, si ya existe la conversación) sobre un punto publicado.
create or replace function escribir_sobre_punto(punto_id uuid, texto text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  yo uuid := auth.uid();
  limpio text := revisar_puede_escribir(texto);
  p puntos;
  h hilos;
  m mensajes;
begin
  select * into p from puntos x where x.id = escribir_sobre_punto.punto_id and x.estado = 'publicado';
  if not found then
    raise exception 'El punto no existe o no está publicado' using errcode = 'P0002', hint = 'publico';
  end if;
  if p.autor_id = yo then
    raise exception 'Es tu propio reporte' using errcode = '22023', hint = 'publico';
  end if;
  if p.autor_id is null or not exists (select 1 from perfiles f where f.id = p.autor_id and f.activo) then
    raise exception 'No se puede escribir sobre este punto: quien lo reportó ya no tiene una cuenta activa'
      using errcode = '55000', hint = 'publico';
  end if;

  select * into h from hilos x where x.punto_id = p.id and x.iniciador_id = yo for update;
  if not found then
    if (select count(*) from hilos x where x.iniciador_id = yo and x.creado_en > now() - interval '1 day') >= 10 then
      raise exception 'Abriste muchas conversaciones hoy; intenta mañana' using errcode = '55000', hint = 'publico';
    end if;
    insert into hilos (punto_id, iniciador_id, destinatario_id) values (p.id, yo, p.autor_id) returning * into h;
  elsif h.estado = 'cerrado' then
    raise exception 'La conversación está cerrada' using errcode = '55000', hint = 'publico';
  end if;

  insert into mensajes (hilo_id, autor_id, texto) values (h.id, yo, limpio) returning * into m;
  update hilos x set ultimo_mensaje_en = m.creado_en where x.id = h.id returning * into h;
  return jsonb_build_object('hilo', hilo_json(h, yo), 'mensaje', mensaje_json(m, yo));
end;
$$;

create or replace function responder_hilo(hilo_id uuid, texto text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  yo uuid := auth.uid();
  limpio text := revisar_puede_escribir(texto);
  h hilos;
  otra uuid;
  m mensajes;
begin
  select * into h from hilos x where x.id = responder_hilo.hilo_id and yo in (x.iniciador_id, x.destinatario_id) for update;
  if not found then
    raise exception 'No tienes una conversación con ese id' using errcode = 'P0002', hint = 'publico';
  end if;
  if h.estado = 'cerrado' then
    raise exception 'La conversación está cerrada' using errcode = '55000', hint = 'publico';
  end if;
  otra := case when yo = h.iniciador_id then h.destinatario_id else h.iniciador_id end;
  if not exists (select 1 from perfiles f where f.id = otra and f.activo) then
    raise exception 'La otra persona ya no tiene una cuenta activa' using errcode = '55000', hint = 'publico';
  end if;
  insert into mensajes (hilo_id, autor_id, texto) values (h.id, yo, limpio) returning * into m;
  update hilos x set ultimo_mensaje_en = m.creado_en where x.id = h.id returning * into h;
  return jsonb_build_object('hilo', hilo_json(h, yo), 'mensaje', mensaje_json(m, yo));
end;
$$;

-- ---------------------------------------------------------------------------
-- Leer
-- ---------------------------------------------------------------------------
create or replace function mis_hilos()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(hilo_json(h, auth.uid()) order by h.ultimo_mensaje_en desc), '[]'::jsonb)
  from (select * from hilos x where auth.uid() in (x.iniciador_id, x.destinatario_id)
        order by x.ultimo_mensaje_en desc limit 100) h
$$;

-- Los últimos 200 mensajes. Marca como leídos los que recibí.
create or replace function leer_hilo(hilo_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  yo uuid := auth.uid();
  h hilos;
begin
  if yo is null or obtener_rol_actual() is null then
    raise exception 'Inicia sesión con una cuenta activa' using errcode = '42501', hint = 'publico';
  end if;
  select * into h from hilos x where x.id = leer_hilo.hilo_id and yo in (x.iniciador_id, x.destinatario_id);
  if not found then
    raise exception 'No tienes una conversación con ese id' using errcode = 'P0002', hint = 'publico';
  end if;
  update mensajes m set leido_en = now() where m.hilo_id = h.id and m.autor_id <> yo and m.leido_en is null;
  return jsonb_build_object(
    'hilo', hilo_json(h, yo),
    'mensajes', coalesce((
      select jsonb_agg(mensaje_json(m, yo) order by m.creado_en)
      from (select * from mensajes x where x.hilo_id = h.id order by x.creado_en desc limit 200) m
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Cerrar, reabrir y denunciar
-- ---------------------------------------------------------------------------
create or replace function cerrar_hilo(hilo_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  h hilos;
begin
  update hilos x set estado = 'cerrado', cerrado_por = auth.uid()
  where x.id = cerrar_hilo.hilo_id and auth.uid() in (x.iniciador_id, x.destinatario_id) and x.estado = 'abierto'
  returning * into h;
  if not found then
    raise exception 'No tienes una conversación abierta con ese id' using errcode = 'P0002', hint = 'publico';
  end if;
  return hilo_json(h, auth.uid());
end;
$$;

-- Solo quien la cerró la reabre, y no si hay una denuncia sin revisar.
create or replace function reabrir_hilo(hilo_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  h hilos;
begin
  if exists (select 1 from denuncias_hilo d where d.hilo_id = reabrir_hilo.hilo_id and d.estado = 'pendiente') then
    raise exception 'La conversación tiene una denuncia en revisión' using errcode = '55000', hint = 'publico';
  end if;
  update hilos x set estado = 'abierto', cerrado_por = null
  where x.id = reabrir_hilo.hilo_id and x.cerrado_por = auth.uid() and x.estado = 'cerrado'
  returning * into h;
  if not found then
    raise exception 'Solo quien cerró la conversación puede reabrirla' using errcode = 'P0002', hint = 'publico';
  end if;
  return hilo_json(h, auth.uid());
end;
$$;

create or replace function denunciar_hilo(hilo_id uuid, motivo text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  yo uuid := auth.uid();
  limpio text := nullif(btrim(denunciar_hilo.motivo), '');
  h hilos;
begin
  select * into h from hilos x where x.id = denunciar_hilo.hilo_id and yo in (x.iniciador_id, x.destinatario_id) for update;
  if not found then
    raise exception 'No tienes una conversación con ese id' using errcode = 'P0002', hint = 'publico';
  end if;
  if limpio is null or char_length(limpio) < 10 or char_length(limpio) > 500 then
    raise exception 'Explica la denuncia en 10 a 500 caracteres' using errcode = '22023', hint = 'publico';
  end if;
  if exists (select 1 from denuncias_hilo d where d.hilo_id = h.id and d.denunciante_id = yo) then
    raise exception 'Ya denunciaste esta conversación' using errcode = '55000', hint = 'publico';
  end if;
  insert into denuncias_hilo (hilo_id, denunciante_id, motivo) values (h.id, yo, limpio);
  if h.estado = 'abierto' then
    update hilos x set estado = 'cerrado', cerrado_por = yo where x.id = h.id returning * into h;
  end if;
  return hilo_json(h, yo);
end;
$$;

-- ---------------------------------------------------------------------------
-- Moderación: solo las conversaciones denunciadas.
-- ---------------------------------------------------------------------------
create or replace function listar_denuncias_hilos()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if coalesce(obtener_rol_actual(), '') not in ('moderador', 'administrador') then
    raise exception 'Solo moderación puede ver las denuncias' using errcode = '42501', hint = 'publico';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', d.id, 'motivo', d.motivo, 'estado', d.estado, 'nota', d.nota, 'creado_en', d.creado_en, 'revisada_en', d.revisada_en,
      'denunciante', jsonb_build_object('id', d.denunciante_id, 'nombre', (select f.nombre from perfiles f where f.id = d.denunciante_id)),
      'hilo', jsonb_build_object(
        'id', h.id, 'punto', jsonb_build_object('id', p.id, 'titulo', p.titulo),
        'mensajes', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'id', m.id, 'texto', m.texto, 'creado_en', m.creado_en,
                   'autor', jsonb_build_object('id', m.autor_id, 'nombre', (select f.nombre from perfiles f where f.id = m.autor_id)))
                 order by m.creado_en)
          from (select * from mensajes x where x.hilo_id = h.id order by x.creado_en desc limit 50) m
        ), '[]'::jsonb))
    ) order by (d.estado = 'pendiente') desc, d.creado_en desc)
    -- Todas las pendientes, y aparte las 50 revisadas más recientes: una pendiente vieja nunca
    -- queda fuera por el límite.
    from (select * from denuncias_hilo x
          where x.estado = 'pendiente'
             or x.id in (select y.id from denuncias_hilo y
                         where y.estado = 'revisada' and y.revisada_en > now() - interval '30 days'
                         order by y.revisada_en desc limit 50)) d
    join hilos h on h.id = d.hilo_id
    join puntos p on p.id = h.punto_id
  ), '[]'::jsonb);
end;
$$;

create or replace function revisar_denuncia_hilo(denuncia_id uuid, nota text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  limpia text := nullif(btrim(revisar_denuncia_hilo.nota), '');
  d denuncias_hilo;
begin
  if coalesce(obtener_rol_actual(), '') not in ('moderador', 'administrador') then
    raise exception 'Solo moderación puede revisar denuncias' using errcode = '42501', hint = 'publico';
  end if;
  if limpia is not null and char_length(limpia) > 500 then
    raise exception 'La nota debe tener como máximo 500 caracteres' using errcode = '22023', hint = 'publico';
  end if;
  update denuncias_hilo x set estado = 'revisada', nota = limpia, revisada_por = auth.uid(), revisada_en = now()
  where x.id = revisar_denuncia_hilo.denuncia_id and x.estado = 'pendiente'
  returning * into d;
  if not found then
    raise exception 'La denuncia no existe o ya fue revisada' using errcode = 'P0002', hint = 'publico';
  end if;
  return jsonb_build_object('id', d.id, 'estado', d.estado, 'nota', d.nota, 'revisada_en', d.revisada_en);
end;
$$;

-- ---------------------------------------------------------------------------
-- Solo para el backend (llave de servicio): a quién avisar de un mensaje nuevo.
-- Avisa solo si es el primer mensaje sin leer de esa conversación para esa persona, para no
-- mandar un correo por cada mensaje. Nunca devuelve el texto.
-- ---------------------------------------------------------------------------
create or replace function destinatario_mensaje(mensaje_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  m mensajes;
  h hilos;
  otra uuid;
begin
  select * into m from mensajes x where x.id = destinatario_mensaje.mensaje_id;
  if not found then
    return null;
  end if;
  select * into h from hilos x where x.id = m.hilo_id;
  otra := case when m.autor_id = h.iniciador_id then h.destinatario_id else h.iniciador_id end;
  if h.estado <> 'abierto' or exists (
    select 1 from mensajes x where x.hilo_id = h.id and x.autor_id <> otra and x.leido_en is null and x.id <> m.id and x.creado_en <= m.creado_en
  ) then
    return null;
  end if;
  return (
    select jsonb_build_object('punto', jsonb_build_object('titulo', p.titulo), 'destinatario', jsonb_build_object('email', u.email, 'nombre', f.nombre))
    from perfiles f join auth.users u on u.id = f.id, puntos p
    where f.id = otra and f.activo and u.email is not null and p.id = h.punto_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Permisos de ejecución. Supabase da EXECUTE explícito a anon y authenticated en cada función
-- nueva (privilegios por defecto), así que revocar a PUBLIC no basta: se revoca a los tres y se
-- concede solo lo que cada rol necesita.
-- ---------------------------------------------------------------------------
revoke execute on function
  auditar_denuncias_hilo(),
  hilo_json(hilos, uuid),
  mensaje_json(mensajes, uuid),
  revisar_puede_escribir(text),
  escribir_sobre_punto(uuid, text),
  responder_hilo(uuid, text),
  mis_hilos(),
  leer_hilo(uuid),
  cerrar_hilo(uuid),
  reabrir_hilo(uuid),
  denunciar_hilo(uuid, text),
  listar_denuncias_hilos(),
  revisar_denuncia_hilo(uuid, text),
  destinatario_mensaje(uuid)
from public, anon, authenticated;

grant execute on function
  escribir_sobre_punto(uuid, text),
  responder_hilo(uuid, text),
  mis_hilos(),
  leer_hilo(uuid),
  cerrar_hilo(uuid),
  reabrir_hilo(uuid),
  denunciar_hilo(uuid, text),
  listar_denuncias_hilos(),
  revisar_denuncia_hilo(uuid, text)
to authenticated, service_role;

-- Los correos solo los lee el backend.
grant execute on function destinatario_mensaje(uuid) to service_role;
