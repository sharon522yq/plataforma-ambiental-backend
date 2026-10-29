# Sesión y permisos

**Como** persona registrada **quiero** que la API me reconozca con mi sesión de Supabase **para** hacer lo que mi rol permite y nada más.

## Criterios de aceptación

1. Sin cabecera `Authorization`, toda ruta protegida responde 401 con la forma uniforme de error. *Prueba:* `autenticacion.test.ts`, `matriz-permisos.test.ts`.
2. Un token vencido, mal firmado o de otro proyecto responde 401 sin detalles. *Prueba:* `autenticacion.test.ts` → "401 con token vencido, inválido o de otro proyecto"; `jwt.test.ts`.
3. El rol se lee de `perfiles` en cada solicitud; el rol que venga dentro del token se ignora. *Prueba:* `autenticacion.test.ts` → "ignora el rol que venga dentro del token".
4. Una cuenta desactivada o sin perfil recibe 403, aunque sea administradora. *Prueba:* `autenticacion.test.ts`, `matriz-permisos.test.ts`.
5. `GET /api/v1/sesion` devuelve `{ id, rol }` y nunca el token (D-19). *Prueba:* `autenticacion.test.ts`.
6. Si no se puede leer el perfil, 500 sin detalles técnicos. *Prueba:* `autenticacion.test.ts`.
7. Cada endpoint protegido responde 401 sin sesión y 403 al rol sin permiso, según la tabla de la sección 7. *Prueba:* `matriz-permisos.test.ts` (14 endpoints contra 4 roles, cuenta inactiva y token inválido).
