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
| 2026-10-29 | Prototipo y D-39 (inicio de sesión real) | 532 | — | — | `GET /configuracion-publica` solo entrega la llave anon |
| 2026-11-03 | Contratos SQL ↔ API | 540 | 91,14 % | — | Incidencia I-04 encontrada en la prueba real y cerrada; 8 pruebas de contrato nuevas |
| 2026-11-03 | D-40: enlaces de la comunidad (migración 012) | 596 | 91,39 % | — | 23 pruebas SQL, 14 HTTP, 2 filas nuevas en la matriz de permisos y 2 contratos. Mutaciones detectadas: dejar retirar a un ciudadano, mostrar `autor_id` al anónimo, publicar dos veces los enlaces de un aporte, quitar el candado por cuenta (dos propuestas simultáneas pasaban el límite) y quitar la validación en la tabla (un INSERT directo aceptaba enlaces inválidos). Las dos últimas las señaló la revisión automática del PR #1 |
| 2026-11-05 | F12: sitio público y aviso de privacidad | 603 | 91,39 % | — | 7 pruebas nuevas en `sitio-publico.test.ts`. Mutaciones detectadas: quitar Nominatim de la política de contenido, quitar `<meta charset>` e inventar un correo de contacto. En navegador (Playwright, servidor local con las cabeceras de `render.yaml`): 25 de 25 comprobaciones, cero violaciones de la política |
| 2026-11-05 | F13: agente con herramientas y respaldo sin IA | 650 | 89,54 % | Pendiente (`npm run evaluar:agente` en la PC de sharon) | 47 pruebas nuevas: `gemini.paso`, ciclo del agente, herramientas, evaluación y ruta. Mutaciones detectadas (7 de 7): no forzar la respuesta en el último paso, no limitar herramientas por paso, no devolverle a Gemini su turno, mandarle la ubicación, devolver el contacto de organizaciones, mostrar el razonamiento interno y pasar al respaldo con un 422. Playwright: 25 de 25 (ubicación solo con la casilla y redondeada, «Ver N puntos en el mapa», quitar filtro, respaldo, permiso negado, teléfono). La cobertura baja porque cuenta `src/evaluar-agente.ts`, que solo se corre a mano |
| 2026-11-05 | F14: base de conocimiento (migración 013, rama `f14-conocimiento`) | 701 | 90,74 % | — | 13 pruebas SQL, 16 HTTP, 1 de contrato y unitarias de embeddings, fragmentos, herramienta e instrucciones. Mutaciones detectadas (9 de 9): quitar la revisión del rol, buscar en documentos inactivos, aceptar otra dimensión, dar permiso de carga al anónimo, no filtrar por parecido, no normalizar, embeber sin el título, dar las reglas de conocimiento sin la herramienta y no devolver las fuentes. Playwright: 15 de 15 (carga, validaciones, activar y desactivar, error de Gemini, fuentes en el chat sin enlaces `javascript:`). Se corrigió de paso el tamaño del candado en los apartados de Administración |
| 2026-11-05 | Primera evaluación real del agente (sharon, `--limite=3`, gemini-2.5-flash) | — | — | 1 de 3 | Hallazgos: (1) la respuesta tras usar herramientas llegó vacía; causa probable: el razonamiento de los modelos 2.5 cuenta dentro del tope de 800 tokens; se subió a 2048 con presupuesto de razonamiento de 512 y el error ahora lleva su motivo técnico al informe. (2) La respuesta mostraba ids internos: nueva regla en las instrucciones y en la revisión. (3) Sin ubicación, el agente pidió la ubicación sin buscar: era correcto, se ajustó el caso. 705 pruebas en verde después de corregir |
| 2026-11-05 | Evaluación completa (sharon, gemini-2.5-flash) | — | — | Interrumpida | Desde la pregunta 9, Google respondió 429 (límite del plan gratuito) al segundo paso de cada pregunta, y `buscar_acciones`, `buscar_organizaciones` y `buscar_conocimiento` fallaron sin decir por qué. Cambios: el registro de `herramienta_fallida` ahora trae la causa (código de la base o estado HTTP, sin mensajes), la evaluación reintenta los 429 tras 30 s, espera 30 s entre preguntas y se detiene tras 3 preguntas seguidas con 429. 707 pruebas en verde. |
| 2026-11-05 | Revisión automática del PR #2 (F14) | 708 | — | — | Dos hallazgos ciertos y corregidos: (1) la migración 013 fallaba si un documento ya tenía varios fragmentos (todos quedaban en posición 0 y el índice único no se creaba); ahora los numera por orden de creación. Prueba nueva que actualiza una base con la 012 y fragmentos previos; sin el arreglo, falla. (2) El panel solo mostraba los primeros 100 documentos; ahora junta todas las páginas. Playwright de F14 con páginas de 1 documento: en verde. |
| 2026-11-05 | F15: respaldos, dos administradores y métricas (migración 014, rama `f15-operacion`) | 745 | 91,29 % | — | 14 pruebas SQL, 18 HTTP y 1 de contrato. Restauración del respaldo ensayada con la base simulada de producción (11 tablas, 2 cuentas, trigger de registro); falla con clave equivocada o archivo cortado. Mutaciones detectadas: 9 de 10 (la décima no aplica en local, ver plan). Playwright: 23 de 23 y F12 a F14 sin regresiones. ShellCheck y actionlint limpios. |
| 2026-11-05 | Revisión automática del PR #3 (F15) | 750 | — | — | Dos hallazgos ciertos y corregidos en la migración 014: (1) los dos últimos administradores podían quitarse el rol en transacciones simultáneas y no quedaba ninguno; ahora cada cambio de administrador toma un candado de transacción antes de contar. Reproducido con dos sesiones a la vez: sin el candado quedaban 0 administradores, con él la segunda falla. (2) Una solicitud pendiente desaparecía de la lista si había más de 50 resueltas después; ahora las pendientes van primero antes del límite. Mutaciones detectadas: 2 de 2. |

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
| 40917475066 | 2026-10-29 | `1920930` | Verde (prototipo del frontend) |
| 40923235702 | 2026-10-29 | `5c3f713` | Verde (D-39, inicio de sesión real) |
| 41684693860 | 2026-11-03 | `49a04fa` | Verde (corrección de I-04 y pruebas de contrato) |
| 41686067706 | 2026-11-03 | `93888df` | Verde (bitácora: flujo real completo) |
| 41686718508 | 2026-11-03 | `9e713cb` | Verde (ubicación por dirección o coordenadas) |
| 41689491198 | 2026-11-03 | `a59ec8a` | Verde (PR #1, D-40) |
| 41690270778 | 2026-11-03 | `b834946` | Verde (PR #1, arreglos de la revisión automática) |
| 41692002608 | 2026-11-03 | `b834946` | Verde (PR #1 fusionado a main; Render despliega) |

## Verificaciones en el servicio real

| Fecha | Qué se probó | Resultado |
|---|---|---|
| 2026-10-28 | `npm run verificar:gemini` | Llave y modelo `gemini-2.5-flash` confirmados |
| 2026-10-28 | Consulta real al agente, con permiso de sharon | Respuesta en español, sobre el tema, con modelo y aviso; viene en Markdown |
| 2026-10-28 | Primer arranque en Render | Falló: `TypeError: Invalid URL` (I-03) |
| 2026-10-28 | `/api/v1/salud` en Render, desde el navegador | `{"estado":"ok","base":"ok"}` |
| 2026-10-30 | Prototipo en vivo (`localhost:5173`): crear cuenta e iniciar sesión | Sesión como ciudadano, «API ok · base ok», mapa con un punto real de Supabase |
| 2026-11-03 | Reporte real desde el prototipo con la cuenta ciudadana | Aparece en «Mis aportes» como PENDIENTE |
| 2026-11-03 | Nombrar administradora por SQL y volver a entrar | El prototipo muestra el rol Administrador y habilita Moderación y Administración |
| 2026-11-03 | Aprobar el reporte con una segunda cuenta moderadora | Se guardó, pero la API respondió con error y el reintento dio 409 (I-04) |
| 2026-11-03 | Ver el reporte aprobado en el mapa público, tras corregir I-04 | Punto publicado en 19.2783, -98.2225 con el título y la gravedad 1 que puso la moderadora; detalle y «Cómo ayudar» correctos |
| 2026-11-03 | `npm run migrar` desde la PC de sharon, con la versión corregida de la 012 (hash igual al de `b834946`) | «Aplicadas: 1 012_enlaces_comunidad.sql», «Ya estaban aplicadas: 11». Después se fusionó el PR #1 a main |

## Incidencias encontradas por las pruebas

Detalle completo en `docs/incidencias.md`. Todas cerradas.

| Id | Fecha | Problema | Cómo se detectó |
|---|---|---|---|
| I-01 | 2026-10-28 | Un cuerpo JSON de más de 100 KB respondía 500 en vez de 413 | `tests/integracion/seguridad.test.ts` |
| I-02 | 2026-10-28 | Un JSON con charset no soportado respondía 500 en vez de 415 | la misma prueba |
| I-03 | 2026-10-28 | Un espacio al final de `SUPABASE_URL` impedía arrancar en Render | registros de Render; pruebas nuevas en `env.test.ts` |
| I-04 | 2026-11-03 | Aprobar un aporte respondía 500 aunque se guardaba (la respuesta no traía `autor_id`) | prueba real con dos cuentas; reproducida en `contratos-sql.test.ts` |

## Última corrida

- **2026-11-05** (F15), base local PostgreSQL 16: 40 archivos en verde y 1 omitido (Supabase real); 745 pruebas en verde y 12 omitidas; cobertura de líneas 91,29 %.
