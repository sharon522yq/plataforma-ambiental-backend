# Incidencias

Cada fallo de prueba se registra aquí con: identificador, pasos para reproducir, resultado esperado, resultado real y causa probable.

Sin incidencias abiertas.

## I-01: cuerpo JSON de más de 100 KB respondía 500 (cerrada)

- **Fecha:** 2026-10-28, fase 9, `tests/integracion/seguridad.test.ts`.
- **Pasos:** `POST /api/v1/agente/consulta` con `Content-Type: application/json` y un cuerpo de unos 110 KB.
- **Esperado:** 413 con la forma uniforme `{ error: { codigo: "SOLICITUD_DEMASIADO_GRANDE", mensaje, detalles: [] } }`.
- **Real:** 500 `ERROR_INTERNO`, y el fallo quedaba registrado como error no controlado.
- **Causa:** el manejador de errores solo reconocía el JSON mal formado (`entity.parse.failed`). Los demás errores de `express.json()` (`entity.too.large` y otros) caían en el caso genérico.
- **Solución:** `src/middleware/manejador-errores.ts` traduce cada tipo de error del lector de cuerpos a su código: 400 (mal formado o solicitud interrumpida), 413 (demasiado grande) y 415 (charset o compresión no soportados). La prueba de mutación confirma que, si se quita la traducción del 413, la prueba falla.

## I-02: charset no soportado respondía 500 (cerrada)

- **Fecha:** 2026-10-28, fase 9, misma prueba.
- **Pasos:** `POST /api/v1/agente/consulta` con `Content-Type: application/json; charset=latin9`.
- **Esperado:** 415 `FORMATO_NO_SOPORTADO` con la forma uniforme.
- **Real:** 500 `ERROR_INTERNO`.
- **Causa y solución:** las mismas de I-01 (`charset.unsupported` no estaba traducido).

## I-03: el servidor no arrancaba en Render por un espacio en `SUPABASE_URL` (cerrada)

- **Fecha:** 2026-10-28, fase 10, primer despliegue en Render.
- **Pasos:** poner en el panel de Render `SUPABASE_URL` con un espacio al final y desplegar.
- **Esperado:** el servidor arranca (o, si el valor fuera inválido, un mensaje claro de configuración).
- **Real:** `TypeError: Invalid URL` en `crearVerificadorSupabase` al armar `https://<proyecto>.supabase.co /auth/v1/.well-known/jwks.json`; Render reiniciaba el servicio una y otra vez.
- **Causa:** la validación de la URL la aceptaba (el estándar de URL ignora espacios al final), pero al concatenar `/auth/v1` el espacio quedaba en medio. El valor se copió con un espacio de más.
- **Solución:** `cargarEntorno` quita espacios y saltos de línea al inicio y al final de cada variable. Pruebas nuevas en `tests/unitarias/env.test.ts`; sin el cambio, fallan con el mismo error de Render.

## I-04: aprobar un aporte respondía con error aunque sí se guardaba (cerrada)

- **Fecha:** 2026-11-03, prueba real del prototipo en vivo con dos cuentas (sharon).
- **Pasos:** con una cuenta moderadora, en Moderación, pulsar «Aprobar y publicar» sobre un aporte pendiente de otra cuenta; si sale error, pulsar otra vez.
- **Esperado:** 200 con el aporte aprobado; la tarjeta desaparece de la cola.
- **Real:** la tarjeta se quedó en la cola y el reintento mostró «No se pudo guardar: El aporte ya fue revisado» (409). El primer intento sí había guardado la aprobación.
- **Causa:** la función `revisar_aporte` (migración 008) devuelve el aporte con `revisor_id` pero sin `autor_id`, y la ruta validaba la respuesta con `aporteModeracion`, que exige `autor_id`. La validación fallaba después de que la base ya había confirmado el cambio, y la API respondía 500. Las pruebas HTTP no lo vieron porque la respuesta falsa sí traía `autor_id`; las pruebas SQL no validaban con el esquema de la ruta.
- **Solución:** la ruta valida con `aporteRevisado` (sin `autor_id`). Prueba nueva `tests/integracion/contratos-sql.test.ts`: llama en una base real a cada función que usa la API y valida su respuesta con el mismo esquema de la ruta; sin el cambio, fallan las tres decisiones de `revisar_aporte`. La respuesta falsa de la prueba HTTP ahora tiene la misma forma que la función real. El prototipo, ante un 409, recarga la cola en lugar de dejar la tarjeta.


## I-05: funciones internas ejecutables por anon y authenticated en Supabase (cerrada)

- **Fecha:** 2026-11-10, revisión automática del PR #6 (Codex).
- **Hallazgo:** Supabase da EXECUTE explícito a `anon` y `authenticated` en cada función nueva del esquema public. Las migraciones revocaban solo a PUBLIC (y a veces a anon), así que esos permisos seguían ahí. Lo grave estaba en el PR #6: `destinatario_mensaje` y `destinatarios_peticion_rol` devuelven correos y cualquier sesión las habría podido llamar por RPC (el correo de quien reportó un punto o los de los administradores). En las migraciones anteriores, el visitante anónimo podía ejecutar funciones de administración y moderación que igual rechazaban por rol.
- **Por qué no lo vieron las pruebas:** la base local no imitaba esos privilegios por defecto.
- **Solución:** `tests/ayudas/base-local.sql` ahora los imita (`alter default privileges … grant execute on functions to anon, authenticated, service_role`); con eso fallaban 7 pruebas de permisos. Las migraciones 015 y 016 revocan a `public, anon, authenticated` antes de conceder, y la nueva 017 quita lo sobrante en las funciones de la 004 a la 014. Las 7 pruebas pasan.
