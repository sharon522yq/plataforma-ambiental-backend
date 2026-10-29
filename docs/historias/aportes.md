# Aportes ciudadanos y fotos de evidencia

**Como** ciudadana registrada **quiero** reportar una problemática con su ubicación y una foto **para** que, después de revisarla, aparezca en el mapa.

## Criterios de aceptación

1. `POST /api/v1/aportes` crea el aporte siempre en `pendiente` y a nombre de quien llama; el autor no puede marcarlo como aprobado ni ponerlo a nombre de otra persona. *Prueba:* `aportes-sql.test.ts` → "crea el aporte pendiente…", "insertar directo en aportes con otro autor o ya aprobado lo bloquea RLS"; `rls.test.ts`.
2. Valida tipo, descripción (10 a 2 000 caracteres), coordenadas en rango y gravedad 1 a 5; un campo de más (`estado`, `autor_id`) es 400. *Prueba:* `paginacion-validacion.test.ts` → "validación de un aporte".
3. Se quitan correos y teléfonos de la descripción antes de guardarla (D-24). *Prueba:* `aportes-moderacion.test.ts` → "201, quita el teléfono…"; `privacidad.test.ts`.
4. `GET /api/v1/aportes/mis` devuelve solo los aportes propios, paginados. *Prueba:* `aportes-sql.test.ts` → "cada ciudadano ve solo sus aportes"; `rls.test.ts` → "no ve aportes de otra persona".
5. `POST /api/v1/aportes/:id/evidencia` acepta una foto (JPG, PNG o WebP, hasta 8 MB) solo del autor y solo con el aporte pendiente; una sola por aporte (409 si ya hay). *Prueba:* `aportes-moderacion.test.ts`, `aportes-sql.test.ts` → "adjuntar_evidencia".
6. La foto se guarda sin GPS ni datos de cámara, reducida a 1 600 px, en un bucket privado, y solo se muestra con enlaces que caducan a los 10 minutos (D-27). *Prueba:* `evidencias.test.ts`.
7. Cada aporte creado y cada foto adjunta quedan en `auditoria`. *Prueba:* `aportes-sql.test.ts`.
