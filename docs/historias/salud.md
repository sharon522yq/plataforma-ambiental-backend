# Salud del servicio

**Como** responsable del despliegue **quiero** saber si el backend y la base están vivos **para** que Render reinicie solo cuando el servicio de verdad cayó.

## Criterios de aceptación

1. `GET /api/v1/salud` es público y responde 200 con `{ estado: "ok", base: "ok" }` cuando la base responde. *Prueba:* `salud.test.ts` → "responde 200 con estado ok y base ok".
2. Si la base no responde, sigue en 200 con `{ estado: "degradado", base: "no_disponible" }` (D-07). *Prueba:* `salud.test.ts` → "responde 200 con estado degradado…".
3. La respuesta nunca trae llaves ni detalles técnicos. *Prueba:* `salud.test.ts` → "nunca incluye llaves…".
4. `GET /api/v1/salud/ia` solo lo usa el administrador (401 sin sesión, 403 con otro rol) y muestra el estado de Gemini y el modelo, nunca la llave. *Prueba:* `agente.test.ts` → "GET /api/v1/salud/ia".
5. `/salud` no cuenta para el límite general de solicitudes (D-34). *Prueba:* `seguridad.test.ts`.

## Diferencia con la especificación

La sección 7 pide que `/salud/ia` haga "una llamada de prueba a Gemini" y responda "texto breve". Se comprueba el modelo sin generar texto, para no gastar cuota cada vez que se consulta (D-38).
