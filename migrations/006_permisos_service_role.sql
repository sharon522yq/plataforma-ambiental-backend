-- 006: permisos explícitos para service_role.
-- El proyecto de Supabase se creó con "Exponer automáticamente nuevas tablas" apagado,
-- así que las tablas nuevas no reciben permisos por defecto. anon y authenticated ya
-- tienen sus permisos en la 003; aquí se da acceso completo a service_role, que solo
-- usa el backend (nunca el frontend) para tareas del sistema, como escribir en auditoria.
-- La inmutabilidad de auditoria la sigue garantizando su trigger.

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
