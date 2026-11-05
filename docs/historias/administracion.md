# Administración

**Como** editora **quiero** mantener el catálogo de acciones y organizaciones, y **como** administradora **quiero** gestionar roles con un segundo par de ojos, ver las métricas y revisar la auditoría **para** que la plataforma funcione con responsables claros.

## Criterios de aceptación

1. `POST /api/v1/admin/acciones` y `POST /api/v1/admin/organizaciones` son para editor y administrador; el moderador y el ciudadano reciben 403. *Prueba:* `administracion.test.ts`, `administracion-sql.test.ts`, `matriz-permisos.test.ts`.
2. El enlace de una acción debe ser https, también si se inserta directo en la tabla; solo se cuelga de un punto publicado y de una organización activa (D-28). *Prueba:* `administracion-sql.test.ts`.
3. `GET /api/v1/admin/usuarios` es solo para el administrador; trae correo y nunca teléfono; filtra por rol y busca por nombre o correo (D-29). *Prueba:* `administracion-sql.test.ts` → "el administrador lista con correo y sin teléfono".
4. `PATCH /api/v1/admin/usuarios/:id/rol` cambia el rol; nadie puede cambiar el suyo ni desactivarse (D-30). *Prueba:* `administracion-sql.test.ts` → "un administrador no puede cambiar su propio rol…".
5. `GET /api/v1/admin/auditoria` es de solo lectura, paginada y filtrable por usuario, tabla, acción y fechas. *Prueba:* `administracion-sql.test.ts` → "listar_auditoria"; `rls.test.ts` → "no puede modificar la auditoría".
6. Cada acción administrativa deja **exactamente un** registro en `auditoria`. *Prueba:* `administracion-sql.test.ts` → "…queda exactamente un registro de auditoría", "…deja un solo registro".
7. Dar o quitar el rol de administrador necesita la confirmación de otro administrador; quien lo pide no puede confirmarlo, la persona afectada sí puede consentir que se lo quiten, y el único administrador puede nombrar al segundo sin esperar. Tampoco se salta por la tabla ni desactivando a un administrador (B-08, migración 014). *Prueba:* `operacion-sql.test.ts` → "regla de dos administradores" (11 casos, incluidos vencimiento, rol cambiado y quien pidió ya no es administrador); `administracion.test.ts` → "solicitudes de rol".
8. `GET /api/v1/admin/metricas` es solo para el administrador, trae solo conteos (sin nombres ni correos) y cuadra con datos conocidos (B-12). *Prueba:* `operacion-sql.test.ts` → "métricas"; `contratos-sql.test.ts` → "operación (migración 014)".
