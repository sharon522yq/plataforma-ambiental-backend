-- Imita lo que Supabase ya trae en cada proyecto: roles y el esquema auth.
-- Solo para pruebas locales. NUNCA se ejecuta contra Supabase.

-- Los roles son globales del servidor y varios archivos de prueba crean bases en paralelo.
-- Si otro proceso crea el mismo rol al mismo tiempo, se ignora el duplicado.
do $$
declare
  r record;
begin
  for r in select * from (values ('anon', 'nologin'), ('authenticated', 'nologin'), ('service_role', 'nologin bypassrls')) as v(nombre, opciones) loop
    if not exists (select 1 from pg_roles where rolname = r.nombre) then
      begin
        execute format('create role %I %s', r.nombre, r.opciones);
      exception when duplicate_object or unique_violation then
        null;
      end;
    end if;
  end loop;
end
$$;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

-- Igual que en Supabase: lee el sujeto del JWT que la sesión declara.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(coalesce(
    current_setting('request.jwt.claim.sub', true),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  ), '')::uuid
$$;
