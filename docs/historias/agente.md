# Agente con IA

**Como** visitante **quiero** preguntarle a un asistente sobre temas ambientales **para** saber cómo actuar ante una problemática.

## Criterios de aceptación

1. `POST /api/v1/agente/consulta` es público; con sesión, la conversación se asocia al usuario. Responde `{ respuesta, modelo, aviso }` con el aviso de que es IA. *Prueba:* `agente.test.ts`.
2. La pregunta va de 3 a 1 000 caracteres; fuera de eso, 400. *Prueba:* `agente.test.ts`.
3. Se quitan correos y teléfonos de la pregunta antes de enviarla a Gemini y de la respuesta antes de guardarla (D-33). *Prueba:* `agente.test.ts` → "quita correos y teléfonos…".
4. Al pasar `LIMITE_AGENTE_POR_MINUTO` responde 429, sin llamar más a Gemini; las preguntas inválidas también cuentan. *Prueba:* `agente.test.ts` → "429 al pasar el límite…".
5. Si Gemini falla, 503 sin guardar nada y sin mostrar la llave. *Prueba:* `agente.test.ts`; `gemini.test.ts`.
6. Las conversaciones solo las lee el backend y se borran a los 7 días. *Prueba:* `agente-sql.test.ts`.

## Pendiente

Todavía no consulta documentos propios (RAG). La dimensión de los embeddings sigue abierta (D-01).
