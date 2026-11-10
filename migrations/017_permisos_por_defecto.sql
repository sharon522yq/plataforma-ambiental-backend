-- 017: quita permisos de ejecución que Supabase da por defecto (hallazgo de la revisión del PR #6).
--
-- En Supabase, cada función nueva del esquema public recibe EXECUTE explícito para anon,
-- authenticated y service_role. Las migraciones 004 a 014 revocaban solo a PUBLIC (y a veces a
-- anon), así que en el proyecto real esos roles podían seguir llamando funciones internas. Las
-- funciones ya revisaban el rol por dentro, pero cada permiso de más es una puerta abierta.
-- Aquí se deja cada función con los permisos que sus pruebas siempre esperaron. Revocar algo que
-- no estaba concedido no hace nada, así que esta migración es segura en cualquier proyecto.

-- Internas: triggers, ayudantes JSON de administración y tareas del sistema. Nadie las llama
-- directo (los triggers se disparan igual sin EXECUTE).
revoke execute on function
  auditar_aportes(),
  auditar_puntos(),
  auditar_perfiles(),
  auditar_catalogo(),
  auditar_documentos(),
  auditar_solicitudes_rol(),
  auditoria_inmutable(),
  crear_perfil_nuevo_usuario(),
  proteger_perfil_propio(),
  exigir_segundo_administrador(),
  documento_json(documentos_conocimiento),
  solicitud_rol_json(solicitudes_rol),
  solicitud_vencida(solicitudes_rol),
  purgar_conversaciones_agente()
from anon, authenticated;

-- Solo con sesión: el visitante anónimo no las ejecuta.
revoke execute on function
  columnas_cambiadas(jsonb, jsonb),
  crear_punto(text, text, integer, text, double precision, double precision, text),
  cambiar_estado_punto(uuid, text),
  mis_aportes(integer, integer),
  cola_aportes(text, integer, integer),
  revisar_aporte(uuid, text, text, text, integer, boolean, uuid),
  adjuntar_evidencia(uuid, text),
  crear_accion(text, text, text, text, uuid, uuid),
  crear_organizacion(text, text, text),
  listar_usuarios(text, text, integer, integer),
  listar_auditoria(text, text, uuid, uuid, timestamptz, timestamptz, integer, integer)
from anon;

grant execute on function purgar_conversaciones_agente() to service_role;
