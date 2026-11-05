# Base de conocimiento del asistente

**Como** editor **quiero** cargar documentos de fuentes confiables **para** que el asistente responda con información verificada y diga de dónde sale.

## Criterios de aceptación

1. Solo editor y administrador listan, cargan y activan o desactivan documentos (`/api/v1/admin/conocimiento`); la base vuelve a revisar el rol. *Prueba:* `conocimiento.test.ts` → "permisos…"; `conocimiento-sql.test.ts` → "ciudadana, moderador y anónimo no pueden…".
2. El texto se parte en fragmentos de hasta 1 200 caracteres sin cortar párrafos que caben. *Prueba:* `fragmentar.test.ts`.
3. Cada fragmento se guarda con un embedding normalizado de 768 dimensiones, calculado con el título; el documento y sus fragmentos se guardan juntos o nada. *Prueba:* `embeddings.test.ts`; `conocimiento.test.ts` → "parte el texto…"; `conocimiento-sql.test.ts` → "rechaza … sin guardar nada".
4. Si Gemini no calcula los embeddings, responde 503 y no guarda nada. *Prueba:* `conocimiento.test.ts` → "503 si Gemini…".
5. El enlace a la fuente debe ser https, también insertando directo en la tabla. *Prueba:* `conocimiento-sql.test.ts`; `conocimiento.test.ts`.
6. El asistente busca solo en documentos activos, descarta los fragmentos poco parecidos y devuelve las fuentes para citarlas; el anónimo no ve quién cargó cada documento. *Prueba:* `conocimiento-sql.test.ts` → "el anónimo busca solo en documentos activos…"; `herramientas.test.ts` → "buscar_conocimiento".
7. Cargar y cambiar el estado de un documento queda en la auditoría. *Prueba:* `conocimiento-sql.test.ts`.
8. Las respuestas de la base cumplen los esquemas de la API. *Prueba:* `contratos-sql.test.ts` → "base de conocimiento".

## Pendiente

Los documentos los carga el personal: falta definir la zona del piloto y reunir las fuentes (PROFEPA, SEMARNAT, gobierno estatal y municipal).
