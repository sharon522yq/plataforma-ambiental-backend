# Decisiones pendientes y supuestos

Formato: cada decisión tiene opciones, recomendación y estado. Una decisión se marca **Cerrada** solo cuando la aprueba el usuario.

| ID | Tema | Opciones | Recomendación | Estado |
|---|---|---|---|---|
| D-01 | Dimensión de `fragmentos.embedding` | 768 (valor del prompt) u otra según el modelo de embeddings | 768 y confirmar el modelo en la fase de agente | Abierta (fase 8) |
| D-02 | Render plan gratuito se duerme tras 15 min sin tráfico | Aceptar el riesgo en el piloto, o pagar un plan | Aceptar en piloto y documentarlo para usuarios | Abierta (fase 10) |
| D-03 | Datos de Gemini en plan gratuito | Vincular facturación en Google Cloud (M5) o no | Vincular antes del lanzamiento público | Abierta (usuario, M5) |
| D-04 | Línea de Express | Express 4.x (prompt) o Express 5 | Express 4.x, como indica el prompt | Cerrada |
| D-05 | Vitest y cobertura: subir a versión 5 para corregir A-01 | Subir a 5 (cambio mayor) o mantener 2 con riesgo | Subir a 5 | Cerrada (aplicada en fase 1: Vitest y cobertura 5.0.4) |
| D-06 | ESLint 9 sin soporte (A-02) | Subir a ESLint 10 o mantener 9 | Subir a 10 | Cerrada (aplicada en fase 1: ESLint 10.12) |
| D-07 | Valor de `base` en `/salud` | `base: "ok"` o `"no_disponible"`; respuesta siempre 200 con `estado: "ok"` o `"degradado"` | Usar esa convención: el servicio sigue vivo y el campo `base` informa. Un 503 haría que Render reinicie por una caída de la base, lo que no ayuda | Cerrada (fase 3) |
| D-08 | Documentos de referencia (Plan maestro, Reporte técnico, Plan de trabajo) | No están en el repositorio | Si contradicen el prompt, prevalece el prompt | Cerrada |
| D-09 | Probar migraciones sin tocar producción | Base PostgreSQL local con PostGIS y pgvector, o proyecto de pruebas de Supabase | Base local para pruebas automáticas; Supabase de pruebas para la verificación final (M9) | Cerrada: PostgreSQL local con PostGIS 3.4 y pgvector 0.6 (fase 2) |
| D-10 | Versión mínima de Node | Node 20 (prompt) o Node 22.12+ (requisito de Vitest 5) | Node 22.12+. Node 20 salió de soporte en abril de 2026 | Aplicada en fase 1 (`engines`: `>=22.12`); **confirmar** |
| D-11 | Umbral de cobertura del 70 % | Activarlo ya o en la fase 11 | En la fase 11, cuando la cobertura lo permita. Hoy es 52 % | Aplazada (fase 11) |
| D-12 | Versión de PostgreSQL y orden de la función de rol | (a) PostgreSQL 15 como pide el prompt; (b) PostgreSQL 16 local | (b) para pruebas: PGDG (15) está bloqueado en este entorno y Ubuntu trae PostGIS y pgvector para 16. Las migraciones no usan nada exclusivo de 16. Supabase es quien fija la versión real; hay que confirmarla en M3. Además, `obtener_rol_actual()` se define en 003 porque las políticas la usan | Cerrada (fase 2). Confirmar versión de Supabase en M3 |
| D-13 | Piezas de esquema que el prompt no detalla | Ver lista en `docs/plan-de-trabajo.md`, fase 2 | Aplicarlas: trigger que crea el perfil al registrarse (sin él, ningún ciudadano puede aportar), inmutabilidad de `auditoria` a nivel de trigger, permisos por columna (`contacto` y `autor_id` no salen a visitantes anónimos) y que el revisor pueda leer lo que aprobó | Cerrada (fase 2) |
| D-14 | Versiones de dependencias de base | `pg` para migraciones y pruebas | `pg` 8.x y `@types/pg` 8.x | Cerrada (fase 2) |
| D-15 | Qué cliente de Supabase usa cada tipo de ruta | (a) todo con llave de servicio; (b) lecturas públicas con anon y escrituras con sesión del usuario; llave de servicio solo donde RLS no alcanza | (b). Así RLS decide qué ve cada quien, como exige la sección 8 del prompt. La llave de servicio solo se usa para tareas del sistema (p. ej. escribir en `auditoria`) | Cerrada (fase 3) |
| D-16 | Verificación de tokens (fase 4) | Secreto JWT compartido (`SUPABASE_JWT_SECRET`) o claves asimétricas con JWKS | Confirmar en M3 qué modo usa el proyecto. Si Supabase firma con claves asimétricas, el secreto compartido ya no sirve para verificar | Abierta (fase 4, con M3) |
| D-17 | Permisos de `service_role` con "Exponer automáticamente nuevas tablas" apagado en Supabase | Confiar en los permisos por defecto o darlos explícitamente | Darlos en la migración 006. Así el backend puede escribir aunque Supabase no exponga las tablas nuevas. anon y authenticated mantienen los permisos limitados de la 003 | Cerrada (fase 3, 2026-10-22) |
