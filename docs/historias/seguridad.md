# Seguridad transversal

**Como** responsable de la plataforma **quiero** que la API resista abusos y no filtre datos **para** proteger a quienes la usan.

## Criterios de aceptación

1. Todas las respuestas llevan las cabeceras de helmet y no anuncian Express. *Prueba:* `seguridad.test.ts`.
2. CORS solo autoriza los orígenes de `CORS_ORIGENES`. *Prueba:* `seguridad.test.ts`, `salud.test.ts`.
3. Un 500 nunca trae stack, rutas de archivos ni mensajes internos; todos los errores usan `{ error: { codigo, mensaje, detalles } }`. *Prueba:* `seguridad.test.ts`.
4. Cuerpo JSON de más de 100 KB es 413 y un charset no soportado es 415 (I-01, I-02). *Prueba:* `seguridad.test.ts`.
5. Más de `LIMITE_SOLICITUDES_POR_MINUTO` solicitudes por IP es 429; `/salud` no cuenta (D-34). *Prueba:* `seguridad.test.ts`.
6. Cada respuesta lleva `X-Id-Solicitud`; el registro no guarda cuerpos, tokens, correos ni teléfonos (D-35). *Prueba:* `registro-solicitudes.test.ts`.
7. Ningún archivo del repositorio contiene llaves, tokens o contraseñas. *Prueba:* `secretos.test.ts`.
8. Las variables de entorno se validan al arrancar: si falta una obligatoria, el servidor no arranca y dice cuál (I-03 para los espacios de más). *Prueba:* `env.test.ts`.
