# Plan de trabajo por fases

Cada fase tiene: alcance, criterio de salida, pruebas y permisos que hay que pedir antes de empezar. **No se pasa a la siguiente fase con pruebas en rojo.** Ver también `docs/auditoria.md`.

**Reglas transversales**
- Antes de cualquier acción que cambie dependencias, borre archivos, ejecute SQL contra una base o use un servicio externo, se pide permiso.
- Cada fase termina con `npm run typecheck`, `npm run lint` y `npm test` en verde.
- Cada fase deja su registro en `docs/`; no se dejan archivos temporales dentro del proyecto.
- Los pasos M1 a M10 los hace el usuario. El agente solo verifica que la variable exista en `.env`, sin mostrar su valor.

## Fase 0: Auditoría y documentación base
- **Estado:** completada (esta entrega).
- **Alcance:** auditoría, plan, decisiones pendientes, README, placeholders de documentación.
- **Criterio de salida:** los documentos existen y las pruebas siguen en verde.
- **Permisos:** ninguno (solo escritura de documentos).

## Fase 1: Dependencias y calidad
- **Estado:** completada. `npm audit` sin vulnerabilidades; typecheck, lint, 6 pruebas y build en verde; arranque verificado.
- **Alcance:** corregir A-01 y A-02 (subir Vitest y cobertura a la versión 5, ESLint a 10 y ajustar configuración).
- **Criterio de salida:** `npm audit` sin vulnerabilidades críticas ni altas; pruebas, lint y tipos en verde.
- **Pruebas:** las 6 pruebas actuales pasan sin cambios de lógica.
- **Permisos:** **requerido** (cambio mayor de dependencias; D-05, D-06).

## Fase 2: Esquema de base de datos (migraciones)
- **Estado:** completada. 5 migraciones aplicadas sin errores; 57 pruebas de integración en verde (esquema, RLS por rol y funciones).
- **Alcance:** escribir `001` a `005` según la sección 6 del prompt, y el script `migrar` que aplica en orden.
- **Criterio de salida:** las migraciones se aplican en una base PostgreSQL limpia sin errores, y RLS está activo en todas las tablas. Las migraciones usan `if not exists` para poder reaplicarse sin error.
- **Pruebas:** prueba de integración que aplica las migraciones y consulta `pg_tables` y `pg_policies`; prueba de que un usuario anónimo no puede leer `aportes`.
- **Permisos:** **requerido** para instalar PostgreSQL local con PostGIS y pgvector (D-09). Aplicar en Supabase necesita M3 y M4.

## Fase 3: Conexión a Supabase y salud real
- **Estado:** **Completa (2026-10-22).** Migraciones 001 a 006 aplicadas en Supabase (proyecto East US, `npm run migrar`). `tests/integracion/supabase.test.ts` pasa contra el proyecto real (2 de 2). En la PC: 16 pruebas en verde y 51 omitidas por no tener base local. Durante la verificación se corrigió un bug: las variables vacías de `.env` (p. ej. `PORT=`) se leían como 0; ahora se tratan como ausentes (2 pruebas nuevas en `env.test.ts`). Se agregó la migración 006 con permisos de `service_role` (D-17).
- **Alcance:** `src/config/supabase.ts` (clientes anon y service role), `GET /salud` con comprobación de base (D-07).
- **Criterio de salida:** `base: "ok"` cuando responde la base; `"no_disponible"` cuando no; ninguna llave aparece en respuestas ni logs.
- **Pruebas:** con base simulada y con base real de pruebas; prueba de que la llave de servicio no sale en la respuesta.
- **Permisos:** **requerido** antes de usar la base de pruebas de Supabase (M3 listo).

## Fase 4: Autenticación y autorización
- **Estado:** **Completa en código y pruebas (2026-10-22).** `src/config/jwt.ts` (verificador HS256 y JWKS), `src/middleware/autenticar.ts`, `src/middleware/autorizar.ts`, `src/compartido/perfiles.ts` (rol desde `perfiles`), `src/compartido/sesion.ts`, `GET /api/v1/sesion` (D-19). 97 pruebas en verde con base local, 5 omitidas (Supabase real). Cobertura de líneas 94,7 %. Prueba de mutación: quitar la comprobación de rol o de emisor y audiencia hace fallar las pruebas. Se corrigió además una condición de carrera en `tests/ayudas/base-local.sql` (roles creados en paralelo en un servidor nuevo). `supabase.test.ts` pasó contra el proyecto real (4 de 4, 2026-10-22), incluida la lectura de `perfiles` con la llave de servicio (migración 006). En la PC: 50 pruebas en verde y 52 omitidas por no tener base local. **Pendiente opcional:** un inicio de sesión real para cerrar D-16.
- **Alcance:** `autenticar.ts` (verifica JWT con `SUPABASE_JWT_SECRET`), `autorizar.ts` (rol leído de la base, no del token), `express.d.ts`, y `tests/ayudas/` para generar tokens por rol.
- **Criterio de salida:** token inválido, vencido o ausente da 401; rol insuficiente da 403; el rol se lee de `perfiles`.
- **Pruebas:** unitarias de verificación de JWT; integración con roles público, ciudadano, moderador, editor y administrador.
- **Permisos:** no requiere, salvo que se use un proyecto de Supabase de pruebas (M9).

## Fase 5: Endpoints públicos
- **Estado:** **Completa en código y pruebas (2026-10-22).** Migración 007 con funciones de consulta pública (`listar_puntos_publicos`, `obtener_punto_publico`, `puntos_cercanos_publicos`, `listar_acciones_publicas`, `listar_organizaciones_publicas`) y permisos de ejecución explícitos (D-21). Rutas en `src/modulos/puntos`, `acciones` y `organizaciones`, con el cliente anon (RLS decide qué se ve). 142 pruebas en verde con base local, 7 omitidas (Supabase real). Cobertura de líneas 97 %. Prueba de mutación: dar permiso de ejecución a PUBLIC hace fallar la prueba de permisos. La 007 se aplicó en Supabase y `supabase.test.ts` pasó contra el proyecto real (6 de 6, 2026-10-22). En la PC: 80 pruebas en verde y 69 omitidas por no tener base local.
- **Alcance:** `GET /puntos`, `GET /puntos/cercanos`, `GET /puntos/:id`, `GET /acciones`, `GET /organizaciones`; paginación `?pagina&limite` (máximo 100).
- **Criterio de salida:** nunca se devuelven puntos en revisión o archivados; coordenadas validadas; sin datos de contacto internos.
- **Pruebas:** éxito, error de validación (400), no encontrado (404), y aislamiento por RLS.

## Fase 6: Aportes y moderación
- **Estado:** **Completa en código y pruebas (2026-10-22).** Migración 008: funciones `crear_aporte`, `mis_aportes`, `cola_aportes`, `revisar_aporte`, `crear_punto` y `cambiar_estado_punto` (security invoker, con la sesión del usuario), y auditoría automática con triggers (D-23). La política de actualización de aportes ahora impide que el autor revise su propio aporte. Rutas en `src/modulos/aportes` y `src/modulos/moderacion`; el texto público pasa por `quitarDatosPersonales` (D-24). 208 pruebas en verde con base local, 7 omitidas (Supabase real). Cobertura de líneas 97,7 %. Prueba de mutación: quitar la regla del autor o la exigencia de motivo hace fallar las pruebas. La 008 se aplicó en Supabase y `supabase.test.ts` pasó contra el proyecto real (7 de 7, 2026-10-22). En la PC: 129 pruebas en verde y 87 omitidas por no tener base local.
- **Alcance:** `POST /aportes`, `GET /aportes/mis`, `GET /admin/aportes`, `PATCH /admin/aportes/:id/revision`, `POST /admin/puntos`, `PATCH /admin/puntos/:id/estado`.
- **Criterio de salida:** el autor no puede aprobar su propio aporte; rechazar exige `motivo_revision`; aprobar crea o actualiza el punto.
- **Pruebas:** matriz de permisos de estos endpoints; un ciudadano no ve aportes de otro.

## Fase 6b: Fotos de evidencia (D-26, D-27)
- **Estado:** **Completa en código y pruebas (2026-10-22).** Migración 009: bucket privado `evidencias` y función `adjuntar_evidencia`. `POST /aportes/:id/evidencia` limpia la foto con `sharp` (sin GPS ni datos de cámara, máximo 1600 px) y la sube con multer en memoria. Enlaces temporales de 10 minutos en mis aportes, la cola de moderación y la revisión. 240 pruebas en verde con base local, 10 omitidas (Supabase real). Cobertura de líneas 96,6 %. Prueba de mutación: quitar la comprobación de la ruta o del autor en la 009, no borrar lo subido si la base falla, devolver la foto sin recodificar, aceptar GIF o SVG, o no firmar los enlaces hacen fallar las pruebas. **Pendiente:** `npm ci`, `npm run migrar` y `supabase.test.ts` contra el proyecto real.
- **Criterio de salida:** solo el autor adjunta, una vez y en pendiente; la foto guardada no trae EXIF; nadie sin sesión lista ni sube fotos; el bucket no es público.

## Fase 7: Administración
- **Alcance:** `POST /admin/acciones` (editor, enlace https), `POST /admin/organizaciones`, `GET /admin/usuarios`, `PATCH /admin/usuarios/:id/rol` (administrador no puede quitarse su propio rol), `GET /admin/auditoria`.
- **Criterio de salida:** cada acción administrativa genera exactamente un registro en `auditoria`.
- **Pruebas:** conteo exacto de registros de auditoría; `telefono` nunca sale en listas.

## Fase 8: Agente con Gemini
- **Alcance:** servicio de Gemini, `GET /salud/ia` (administrador), `POST /agente/consulta` (público, sin RAG todavía).
- **Criterio de salida:** la llave no aparece en respuestas; `conversaciones_agente` no guarda datos personales; el límite `LIMITE_AGENTE_POR_MINUTO` responde 429.
- **Pruebas:** Gemini simulado en pruebas automáticas; una prueba manual con la llave real.
- **Permisos:** **requerido** antes de cualquier llamada real a Gemini (consume la cuota del usuario). Decidir D-01.

## Fase 9: Seguridad transversal
- **Alcance:** `limitador.ts` (general y agente), revisión de helmet, CORS y 500 sin stack.
- **Criterio de salida:** matriz completa de la sección 8; límites responden 429.
- **Pruebas:** las siete categorías de la sección 8 del prompt; cada fallo se registra en `docs/incidencias.md`.

## Fase 10: Integración continua y despliegue
- **Alcance:** `.github/workflows/ci.yml` (typecheck, lint, test en push a `main`), `render.yaml`, README final.
- **Criterio de salida:** el workflow pasa en GitHub; `render.yaml` valida.
- **Permisos:** **requerido** para hacer el primer push (el token de `gh` no es válido; ver paso M1).

## Fase 11: Cierre
- **Alcance:** `docs/pruebas-manuales.md` completo, cobertura de al menos 70 %, revisión de secretos (`git log -p | grep -i key`), eliminación de carpetas vacías que no se usaron, resumen final de 10 líneas como pide el prompt.
- **Criterio de salida:** se cumplen los diez puntos de la sección 13 del prompt.
- **Permisos:** **requerido** para cualquier commit o push final.

## Orden de ejecución
F1 → F2 → F3 → F4 → F5 → F6 → F7 → F8 → F9 → F10 → F11. Cada fase espera tu aprobación antes de empezar.
