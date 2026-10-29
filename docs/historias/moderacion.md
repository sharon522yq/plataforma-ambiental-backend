# Moderación

**Como** moderadora **quiero** revisar los aportes pendientes y gestionar los puntos **para** que el mapa solo muestre información verificada.

## Criterios de aceptación

1. `GET /api/v1/admin/aportes` es solo para moderador y administrador; devuelve la cola paginada, filtrable por estado (pendiente por defecto), con tipo y ubicación. *Prueba:* `aportes-moderacion.test.ts`, `aportes-sql.test.ts` → "un ciudadano no puede ver la cola ni revisar".
2. `PATCH /api/v1/admin/aportes/:id/revision` con `decision`: `aprobado` crea o actualiza el punto; `rechazado` exige `motivo_revision`; `duplicado` exige `duplicado_de`. *Prueba:* `aportes-sql.test.ts` → "aprobar un aporte nuevo crea el punto…", "rechazar exige motivo…", "duplicado exige el punto original…".
3. El autor no puede revisar su propio aporte, ni por la API ni por la base directa. *Prueba:* `aportes-sql.test.ts` → "el autor no puede revisar su propio aporte…".
4. Un aporte no se revisa dos veces. *Prueba:* `aportes-sql.test.ts`.
5. `POST /api/v1/admin/puntos` crea el punto en revisión; solo el administrador puede crearlo ya publicado. *Prueba:* `aportes-sql.test.ts` → "la moderadora crea en revisión pero no publicado; el administrador sí".
6. `PATCH /api/v1/admin/puntos/:id/estado` publica o archiva; solo el administrador reabre un archivado. *Prueba:* `aportes-sql.test.ts`.
7. Cada revisión y cambio de estado queda en `auditoria`, sin textos personales (D-23). *Prueba:* `aportes-sql.test.ts`.
