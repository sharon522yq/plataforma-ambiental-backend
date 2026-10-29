# Mapa público: puntos, acciones y organizaciones

**Como** visitante sin cuenta **quiero** ver las problemáticas ambientales publicadas, las cercanas a mí y qué puedo hacer **para** informarme y actuar.

## Criterios de aceptación

1. `GET /api/v1/puntos` lista solo puntos publicados, con filtros `tipo` y `gravedad_minima` (1 a 5) y paginación `{ datos, paginacion }`. *Prueba:* `endpoints-publicos.test.ts`, `consultas-publicas.test.ts` → "solo cuenta y devuelve puntos publicados", "filtra por gravedad mínima".
2. Un punto en revisión o archivado nunca aparece, y esto lo garantiza RLS en la base, no solo el código. *Prueba:* `rls.test.ts` → "solo ve puntos publicados", "no ve un punto en revisión aunque conozca su id".
3. `GET /api/v1/puntos/cercanos` exige `lat` y `lng` válidas, acepta `radio_metros` de 1 a 50 000 (5 000 por defecto) y ordena por distancia. *Prueba:* `consultas-publicas.test.ts` → "devuelve publicados ordenados por distancia"; `paginacion-validacion.test.ts`.
4. `GET /api/v1/puntos/:id` devuelve el punto con sus acciones activas; 404 si no existe o no está publicado; 400 si el id no es uuid. *Prueba:* `endpoints-publicos.test.ts`.
5. Las coordenadas salen como `ubicacion: { lat, lng }` y nunca salen campos internos (`autor_id`, `aprobado_por`). *Prueba:* `endpoints-publicos.test.ts` → "descarta campos internos aunque la base los devuelva".
6. `GET /api/v1/acciones` lista solo acciones activas, filtrables por `tipo` y `punto_id`. *Prueba:* `consultas-publicas.test.ts` → "solo acciones activas…".
7. `GET /api/v1/organizaciones` lista solo las activas y nunca su `contacto`. *Prueba:* `endpoints-publicos.test.ts`, `rls.test.ts` → "no ve el contacto interno de las organizaciones".
8. Paginación: `pagina` desde 1, `limite` de 1 a 100 (20 por defecto); fuera de rango es 400 con detalles. *Prueba:* `paginacion-validacion.test.ts`.
9. Las respuestas públicas se pueden guardar en caché un minuto. *Prueba:* `endpoints-publicos.test.ts` → "marca la respuesta como cacheable un minuto".
