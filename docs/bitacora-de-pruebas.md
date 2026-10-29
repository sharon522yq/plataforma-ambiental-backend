# Bitácora de pruebas

Registro cronológico de las corridas de pruebas del backend. Cada entrada sale de una fuente que se puede revisar: `docs/plan-de-trabajo.md` (cierre de cada fase), `docs/incidencias.md`, el historial de Git y las corridas de GitHub Actions.

## Cómo se prueba

| Nivel | Qué cubre | Cómo se corre |
|---|---|---|
| Automáticas con base local | Unitarias e integración con supertest contra PostgreSQL 16 + PostGIS + pgvector. Gemini siempre simulado. | `npm test` con `TEST_DATABASE_URL` (nunca la base de producción) |
| Contra Supabase real | `tests/integracion/supabase.test.ts`: esquema, permisos, bucket y funciones en el proyecto real | `PRUEBAS_SUPABASE=1 npm test` |
| Integración continua | Lo mismo que el primer nivel, en una base desechable, más typecheck, lint, build y `npm audit` | GitHub Actions en cada push a `main` |
| Manuales | Recorridos sin programar y verificaciones en el servicio en vivo | `docs/pruebas-manuales.md` |
| Mutación | Se rompe a propósito una regla y se confirma que alguna prueba falla; luego se revierte | a mano, en cada fase |

Las 12 pruebas omitidas en las corridas locales son las de Supabase real, que solo corren con `PRUEBAS_SUPABASE=1`.

## Registro por fase

| Fecha | Fase | Pruebas en verde (base local) | Cobertura de líneas | Supabase real | Mutación y notas |
|---|---|---|---|---|---|
| 2026-10-14 | 0. Auditoría | 6 | — | — | Línea base heredada |
| antes del 2026-10-20 | 1. Dependencias | 6 | — | — | Las 6 pruebas pasan sin cambios de lógica tras subir Vitest 5 y ESLint 10 |
| antes del 2026-10-20 | 2. Migraciones 001–005 | 57 de integración | — | — | Esquema, RLS por rol y funciones |
| 2026-10-22 | 3. Supabase y salud | 16 en la PC (sin base local) | — | 2 de 2 | Bug encontrado: variables vacías de `.env` se leían como 0 |
| 2026-10-22 | 4. Autenticación | 97 | 94,7 % | 4 de 4 | Quitar la comprobación de rol o de emisor y audiencia hace fallar las pruebas |
| 2026-10-22 | 5. Endpoints públicos | 142 | 97 % | 6 de 6 | Dar permiso de ejecución a PUBLIC hace fallar las pruebas |
| 2026-10-22 | 6. Aportes y moderación | 208 | 97,7 % | 7 de 7 | Quitar la regla del autor o la exigencia de motivo hace fallar las pruebas |
| 2026-10-22 | 6b. Fotos de evidencia | 240 | 96,6 % | 9 de 9 | Aceptar GIF o SVG, no recodificar la foto o no firmar enlaces hace fallar las pruebas |
| 2026-10-22 | 7. Administración | 301 | 96,9 % | 10 de 10 | Quitar el trigger del rol propio o la validación https hace fallar las pruebas |
| 2026-10-28 | 8. Agente con Gemini | 332 | 97,5 % | 11 de 11 | Consulta real a Gemini con permiso: respuesta correcta en español |
| 2026-10-28 | 9. Seguridad transversal | 517 | 98,3 % | — | Matriz de permisos completa; incidencias I-01 e I-02 encontradas y cerradas |
| 2026-10-28 | 10. CI y despliegue | 519 | — | — | Primera corrida de CI roja (pgvector), luego verde; incidencia I-03 en Render, cerrada |
| 2026-10-29 | 11. Cierre | 519 | — | — | Umbral de cobertura del 70 % activado en la CI |
| 2026-10-29 | Después del cierre: zod 4 | 527 | 91,05 % | — | Mensajes de validación en español; `/salud/ia?generar=1` |

La cobertura bajó de 98,3 % a 91,05 % en la fase 11 porque desde entonces se mide sobre todos los archivos de `src/` (`include: ["src/**/*.ts"]`), también los que ninguna prueba importa. Antes solo contaba los archivos cargados por las pruebas.

## Integración continua (GitHub Actions)

| Corrida | Fecha | Commit | Resultado |
|---|---|---|---|
| 40752287365 | 2026-10-28 | `28856e4` | Roja: apt no encontró pgvector dentro de la imagen de PostGIS |
| 40752516365 | 2026-10-28 | `b2f9b2a` | Verde: se usó el PostgreSQL 16 del runner con PostGIS y pgvector de Ubuntu |
| 40752878925 | 2026-10-28 | `1a22283` | Verde |
| 40755930506 | 2026-10-28 | `2e7251a` | Verde (corrección de I-03) |
| 40756742438 | 2026-10-28 | `c264372` | Verde |
| 40817292495 | 2026-10-29 | `79b6c3a` | Verde (cierre de la fase 11) |
| 40901927256 | 2026-10-29 | `87069d8` | Verde (zod 4) |

## Verificaciones en el servicio real

| Fecha | Qué se probó | Resultado |
|---|---|---|
| 2026-10-28 | `npm run verificar:gemini` | Llave y modelo `gemini-2.5-flash` confirmados |
| 2026-10-28 | Consulta real al agente, con permiso de sharon | Respuesta en español, sobre el tema, con modelo y aviso; viene en Markdown |
| 2026-10-28 | Primer arranque en Render | Falló: `TypeError: Invalid URL` (I-03) |
| 2026-10-28 | `/api/v1/salud` en Render, desde el navegador | `{"estado":"ok","base":"ok"}` |

## Incidencias encontradas por las pruebas

Detalle completo en `docs/incidencias.md`. Todas cerradas.

| Id | Fecha | Problema | Cómo se detectó |
|---|---|---|---|
| I-01 | 2026-10-28 | Un cuerpo JSON de más de 100 KB respondía 500 en vez de 413 | `tests/integracion/seguridad.test.ts` |
| I-02 | 2026-10-28 | Un JSON con charset no soportado respondía 500 en vez de 415 | la misma prueba |
| I-03 | 2026-10-28 | Un espacio al final de `SUPABASE_URL` impedía arrancar en Render | registros de Render; pruebas nuevas en `env.test.ts` |

## Última corrida

- **2026-10-29**, base local PostgreSQL 16: 27 archivos en verde y 1 omitido (Supabase real); 527 pruebas en verde y 12 omitidas.
