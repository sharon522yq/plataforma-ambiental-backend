# Agente con IA

**Como** visitante **quiero** preguntarle a un asistente sobre temas ambientales **para** saber cómo actuar ante una problemática.

## Criterios de aceptación

1. `POST /api/v1/agente/consulta` es público; con sesión, la conversación se asocia al usuario. Responde `{ respuesta, modelo, aviso }` con el aviso de que es IA. *Prueba:* `agente.test.ts`.
2. La pregunta va de 3 a 1 000 caracteres; fuera de eso, 400. *Prueba:* `agente.test.ts`.
3. Se quitan correos y teléfonos de la pregunta antes de enviarla a Gemini y de la respuesta antes de guardarla (D-33). *Prueba:* `agente.test.ts` → "quita correos y teléfonos…".
4. Al pasar `LIMITE_AGENTE_POR_MINUTO` responde 429, sin llamar más a Gemini; las preguntas inválidas también cuentan. *Prueba:* `agente.test.ts` → "429 al pasar el límite…".
5. Si Gemini falla, 503 sin guardar nada y sin mostrar la llave. *Prueba:* `agente.test.ts`; `gemini.test.ts`.
6. Las conversaciones solo las lee el backend y se borran a los 7 días. *Prueba:* `agente-sql.test.ts`.

## Agente con herramientas (F13)

**Como** visitante **quiero** preguntar qué problemas hay en una zona y cómo ayudar **para** encontrarlos en el mapa sin buscar a mano.

7. Gemini consulta el mapa con herramientas de solo lectura (puntos, detalle, acciones y organizaciones) que usan la llave pública: no ven aportes pendientes, autores ni contactos. *Prueba:* `herramientas.test.ts`.
8. Con «Usar mi ubicación», «cerca de mí» busca alrededor de la persona; la ubicación no llega a Gemini ni se guarda. Sin ubicación, el agente pide activarla o nombrar una ciudad. *Prueba:* `agente.test.ts` (integración) → "usa herramientas…"; `herramientas.test.ts`.
9. La respuesta trae los puntos encontrados y el chat ofrece «Ver N puntos en el mapa», que filtra el mapa hasta «Quitar filtro». *Prueba:* Playwright (bitácora, F13).
10. El ciclo tiene un máximo de 4 pasos y 5 herramientas por paso; en el último paso Gemini debe responder con lo que tiene. *Prueba:* `agente.test.ts` (unitaria).
11. Si Gemini no está disponible, responde un respaldo sin IA que busca por palabras clave y lo indica; una pregunta bloqueada por seguridad no pasa al respaldo. *Prueba:* `agente.test.ts` (unitaria e integración).
12. La calidad se mide con `npm run evaluar:agente`: 20 preguntas, aprueba con 18. *Prueba:* `evaluacion.test.ts` (la revisión) y la corrida real de sharon.

## Pendiente

Todavía no consulta documentos propios (RAG, F14). La dimensión de los embeddings sigue abierta (D-01).
