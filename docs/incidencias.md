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
