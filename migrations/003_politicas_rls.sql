-- 003: Row Level Security, permisos y funciones de rol.
-- Nota (D-12): obtener_rol_actual() se define aquí, antes de las políticas que la usan.
-- PostgreSQL exige que la función exista al crear la política.

-- ---------------------------------------------------------------------------
-- Rol del usuario autenticado. Se lee de la base, nunca del token.
-- security definer evita recursión: perfiles también tiene RLS.
-- ---------------------------------------------------------------------------
create or replace function obtener_rol_actual()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.rol from perfiles p
  where p.id = auth.uid() and p.activo
$$;

-- ---------------------------------------------------------------------------
-- Activar RLS en las tablas del proyecto (no en tablas de extensiones).
-- ---------------------------------------------------------------------------
alter table perfiles enable row level security;
alter table organizaciones enable row level security;
alter table puntos enable row level security;
alter table aportes enable row level security;
alter table acciones enable row level security;
alter table documentos_conocimiento enable row level security;
alter table fragmentos enable row level security;
alter table auditoria enable row level security;
alter table conversaciones_agente enable row level security;

-- ---------------------------------------------------------------------------
-- perfiles
-- ---------------------------------------------------------------------------
create policy perfiles_propio_lectura on perfiles
  for select to authenticated
  using (id = auth.uid());

create policy perfiles_administrador_lectura on perfiles
  for select to authenticated
  using (obtener_rol_actual() = 'administrador');

create policy perfiles_administrador_actualizacion on perfiles
  for update to authenticated
  using (obtener_rol_actual() = 'administrador')
  with check (obtener_rol_actual() = 'administrador');

-- ---------------------------------------------------------------------------
-- organizaciones
-- ---------------------------------------------------------------------------
create policy organizaciones_publico_lectura_activas on organizaciones
  for select to anon, authenticated
  using (activa);

create policy organizaciones_editor_gestion on organizaciones
  for all to authenticated
  using (obtener_rol_actual() in ('editor', 'administrador'))
  with check (obtener_rol_actual() in ('editor', 'administrador'));

-- ---------------------------------------------------------------------------
-- puntos
-- ---------------------------------------------------------------------------
create policy puntos_publico_lectura_publicados on puntos
  for select to anon, authenticated
  using (estado = 'publicado');

create policy puntos_moderacion_lectura on puntos
  for select to authenticated
  using (obtener_rol_actual() in ('moderador', 'administrador'));

create policy puntos_moderacion_insercion on puntos
  for insert to authenticated
  with check (
    obtener_rol_actual() in ('moderador', 'administrador')
    and (estado = 'en_revision' or obtener_rol_actual() = 'administrador')
  );

-- El moderador puede publicar o archivar puntos en revisión o publicados.
-- Solo el administrador toca puntos archivados.
create policy puntos_moderacion_actualizacion on puntos
  for update to authenticated
  using (
    obtener_rol_actual() in ('moderador', 'administrador')
    and (estado in ('en_revision', 'publicado') or obtener_rol_actual() = 'administrador')
  )
  with check (obtener_rol_actual() in ('moderador', 'administrador'));

-- ---------------------------------------------------------------------------
-- aportes
-- ---------------------------------------------------------------------------
-- El ciudadano solo puede crear aportes propios, siempre pendientes y sin revisión.
create policy aportes_ciudadano_insercion on aportes
  for insert to authenticated
  with check (
    autor_id = auth.uid()
    and estado = 'pendiente'
    and revisor_id is null
    and motivo_revision is null
  );

create policy aportes_propio_lectura on aportes
  for select to authenticated
  using (autor_id = auth.uid());

-- Un moderador lee la cola (pendientes) y también los aportes que él mismo revisó.
-- Sin lo segundo, la fila aprobada dejaría de ser legible tras el UPDATE.
create policy aportes_moderacion_lectura on aportes
  for select to authenticated
  using (
    obtener_rol_actual() in ('moderador', 'administrador')
    and (estado = 'pendiente' or revisor_id = auth.uid())
  );

create policy aportes_moderacion_actualizacion on aportes
  for update to authenticated
  using (obtener_rol_actual() in ('moderador', 'administrador') and estado = 'pendiente')
  with check (obtener_rol_actual() in ('moderador', 'administrador'));

-- ---------------------------------------------------------------------------
-- acciones
-- ---------------------------------------------------------------------------
create policy acciones_publico_lectura_activas on acciones
  for select to anon, authenticated
  using (activa);

create policy acciones_editor_gestion on acciones
  for all to authenticated
  using (obtener_rol_actual() in ('editor', 'administrador'))
  with check (obtener_rol_actual() in ('editor', 'administrador'));

-- ---------------------------------------------------------------------------
-- documentos_conocimiento (base del RAG)
-- ---------------------------------------------------------------------------
create policy documentos_editor_gestion on documentos_conocimiento
  for all to authenticated
  using (obtener_rol_actual() in ('editor', 'administrador'))
  with check (obtener_rol_actual() in ('editor', 'administrador'));

-- ---------------------------------------------------------------------------
-- auditoria: solo lectura para administradores.
-- No hay políticas de insert, update ni delete. El backend escribe con la llave
-- de servicio, que omite RLS; por eso el trigger de abajo bloquea cambios.
-- ---------------------------------------------------------------------------
create policy auditoria_administrador_lectura on auditoria
  for select to authenticated
  using (obtener_rol_actual() = 'administrador');

-- fragmentos y conversaciones_agente: sin políticas. Solo acceso con llave de servicio.

-- ---------------------------------------------------------------------------
-- Inmutabilidad de auditoria: ni la llave de servicio puede modificarla.
-- ---------------------------------------------------------------------------
create or replace function auditoria_inmutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'La tabla auditoria es solo de lectura' using errcode = 'P0001';
end;
$$;

create trigger auditoria_no_modificar
  before update or delete on auditoria
  for each row execute function auditoria_inmutable();

create trigger auditoria_no_vaciar
  before truncate on auditoria
  for each statement execute function auditoria_inmutable();

-- ---------------------------------------------------------------------------
-- Permisos a nivel de tabla y columna. RLS decide las filas; esto limita columnas.
-- ---------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
revoke all on all tables in schema public from anon, authenticated;

-- anónimo: solo lo público. Sin autor_id ni aprobado_por.
grant select (id, titulo, tipo, gravedad, descripcion, ubicacion, estado, creado_en, actualizado_en)
  on puntos to anon;
grant select on acciones to anon;
-- anónimo: sin contacto (dato interno).
grant select (id, nombre, zona, activa, creado_en, actualizado_en)
  on organizaciones to anon;

-- autenticado: el acceso fino lo deciden las políticas de arriba.
grant select, update on perfiles to authenticated;
grant select, insert, update on puntos, aportes to authenticated;
grant select, insert, update, delete on organizaciones, acciones, documentos_conocimiento to authenticated;
grant select on auditoria to authenticated;
