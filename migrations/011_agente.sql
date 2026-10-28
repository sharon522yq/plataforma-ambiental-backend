-- 011: conversaciones del agente (fase 8).
-- La tabla conversaciones_agente (002) no tiene políticas: solo el backend la usa, con la
-- llave de servicio. Cada fila caduca a los 7 días (expira_en) y esta función borra las
-- vencidas. El backend la llama como máximo una vez por hora.

create index if not exists conversaciones_agente_expira_idx on conversaciones_agente (expira_en);

create or replace function purgar_conversaciones_agente()
returns integer
language sql
volatile
set search_path = public
as $$
  with borradas as (
    delete from conversaciones_agente where expira_en < now() returning 1
  )
  select count(*)::integer from borradas
$$;

revoke execute on function purgar_conversaciones_agente() from public;
grant execute on function purgar_conversaciones_agente() to service_role;
