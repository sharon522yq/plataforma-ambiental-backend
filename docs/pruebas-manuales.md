# Pruebas manuales

Lista para probar con Postman o Thunder Client, sin programar. Usa `http://localhost:3000` con `npm run dev`, o la URL de Render cuando esté desplegado. Toda respuesta trae la cabecera `X-Id-Solicitud`: si algo falla, anótala, sirve para encontrar el error en el registro.

Para conseguir un token: inicia sesión en Supabase Auth y copia el `access_token`. En Postman, Authorization → Bearer Token.

## Consultas públicas (sin token)
1. `GET /api/v1/salud`: esperado 200 con `estado: "ok"` y `base: "ok"`.
2. `GET /api/v1/puntos?limite=5`: esperado 200 con `datos` (máximo 5) y `paginacion`.
3. `GET /api/v1/puntos/cercanos?lat=20.67&lng=-103.35&radio_metros=3000`: esperado 200, cada punto con `distancia_metros`.
4. `GET /api/v1/puntos/cercanos?lat=95&lng=-103.35`: esperado 400 con `detalles` que mencionan `lat`.
5. `GET /api/v1/organizaciones`: ninguna organización trae `contacto`.

## Sesión y permisos
1. `GET /api/v1/sesion` sin token: esperado 401.
2. Con el token de un ciudadano: esperado 200 con `{ id, rol: "ciudadano" }`.
3. Con ese mismo token, `GET /api/v1/admin/aportes`: esperado 403.
4. Con el token de un moderador, `GET /api/v1/admin/aportes`: esperado 200. Con ese token, `GET /api/v1/admin/usuarios`: esperado 403.
5. Cambia una letra del token y repite el paso 2: esperado 401.

## Aportes y moderación
1. Ciudadano: `POST /api/v1/aportes` con `{ "tipo": "residuos", "descripcion": "Basura junto al canal, llamar al 3312345678", "ubicacion": { "lat": 20.67, "lng": -103.35 } }`. Esperado 201, estado `pendiente`, y el teléfono reemplazado en la descripción.
2. Repite con `"lat": 120`: esperado 400.
3. Repite agregando `"estado": "aprobado"`: esperado 400 (campo no permitido).
4. `GET /api/v1/aportes/mis`: aparece el aporte. Con otra cuenta de ciudadano no aparece.
5. Moderador: `PATCH /api/v1/admin/aportes/<id>/revision` con `{ "decision": "aprobado", "titulo": "Basura en el canal", "publicar": false }`. Esperado 200; `GET /api/v1/puntos` sin token todavía no lo muestra (queda en revisión).
6. Moderador: `PATCH /api/v1/admin/puntos/<punto_id>/estado` con `{ "estado": "publicado" }`. Ahora sí aparece en `GET /api/v1/puntos`.
7. Con la misma cuenta que creó el aporte, si tiene rol de moderador, intenta revisarlo: esperado 403 ("No puedes revisar tu propio aporte").

## Administración
1. Administrador: `GET /api/v1/admin/usuarios`: trae correo y nunca teléfono.
2. `PATCH /api/v1/admin/usuarios/<tu propio id>/rol` con `{ "rol": "ciudadano" }`: esperado 403.
3. Editor: `POST /api/v1/admin/acciones` con `{ "tipo": "firma", "nombre": "Firma por el río", "enlace": "http://ejemplo.org" }`: esperado 400 (exige https). Con `https://` responde 201.
4. Administrador: `GET /api/v1/admin/auditoria?tabla=acciones`: aparece exactamente un registro por la acción creada.

## Seguridad
1. Cualquier `GET`: la respuesta trae `X-Content-Type-Options: nosniff`, `Strict-Transport-Security` y `Content-Security-Policy`, y no trae `X-Powered-By`.
2. `POST /api/v1/agente/consulta` con Body raw `{"pregunta": ` (JSON cortado): esperado 400 `SOLICITUD_INVALIDA`, sin rastros del código.
3. Una ruta que no existe, `GET /api/v1/no-existe`: esperado 404 con la forma `{ error: { codigo, mensaje, detalles } }`.
4. Repite `GET /api/v1/puntos` más de 60 veces en un minuto (Postman → Runner, 70 iteraciones): las últimas responden 429 `LIMITE_EXCEDIDO`. `GET /api/v1/salud` nunca responde 429.

## Foto de evidencia
1. Inicia sesión, crea un aporte con `POST /api/v1/aportes` y copia su `id`.
2. En Postman, `POST /api/v1/aportes/<id>/evidencia`, Body → form-data, clave `foto` de tipo File, elige una foto del celular.
3. Esperado: 201 y `evidencia.url`. Abre la url: se ve la foto. A los 10 minutos deja de abrir.
4. Descarga la foto y revisa sus propiedades: no debe tener ubicación GPS ni modelo de cámara.
5. Repite el paso 2: esperado 409 ("El aporte ya tiene evidencia").
6. Con otra cuenta, repite el paso 2 con el mismo `id`: esperado 404.

## Agente
1. `POST /api/v1/agente/consulta`, Body → raw JSON: `{ "pregunta": "¿Cómo separo la basura en casa?" }`, sin token.
2. Esperado: 200 con `respuesta`, `modelo` y `aviso`. La respuesta es en español y sobre el tema.
3. Pregunta algo que no sea ambiental (por ejemplo, una receta): el asistente debe decir con amabilidad que solo ayuda con temas ambientales.
4. Incluye tu correo en la pregunta: la respuesta no debe repetirlo.
5. Repite la consulta 11 veces seguidas en menos de un minuto: la número 11 responde 429.
6. Administrador: `GET /api/v1/salud/ia`: esperado `{ "ia": "ok", "modelo": ... }`. Con `?generar=1` (gasta un poco de cuota) trae además `prueba` con una frase sobre separar la basura.

## Agente con herramientas (F13)
1. En tu PC, con `.env` completo: `npm run evaluar:agente -- --limite=3`. Esperado: 3 líneas `OK` y el informe en `docs/evaluaciones/`. Si sale 429, el script reintenta solo; si se detiene por el límite, la cuota diaria se acabó: repite al día siguiente o usa `-- --pausa=60`.
2. `npm run evaluar:agente` (las 20, tarda unos 6 minutos). Esperado: «Aprobados: 18 de 20» o más.
3. En el sitio (Asistente), pregunta «¿Qué problemas de agua hay en el mapa?». Esperado: una respuesta con títulos reales del mapa y el botón «Ver N puntos en el mapa», que lleva al mapa con solo esos puntos. «Quitar filtro» regresa a todos.
4. Marca «Usar mi ubicación», acepta el permiso del navegador y pregunta «¿Qué hay cerca de mí?». Esperado: puntos cercanos, o que diga que no hay. Sin la casilla, debe pedirte la ubicación o una ciudad.
5. Respaldo: en Render pon `GEMINI_MODELO=modelo-que-no-existe`, pregunta «¿hay basura reportada?» y espera «Respuesta automática sin IA» con la lista del mapa. Regresa `GEMINI_MODELO` a su valor.

## Base de conocimiento (F14)
1. Con la migración 013 aplicada, entra como editor y ve a Administración → «Base de conocimiento».
2. Carga un documento real: título, fuente (por ejemplo, PROFEPA), el enlace https y el texto copiado de la página oficial. Esperado: «Documento cargado en N fragmentos» y la fila en la lista.
3. En el asistente, pregunta algo que responda ese documento. Esperado: la respuesta usa esa información y abajo aparece «Fuentes» con el título y el enlace.
4. Desactiva el documento y repite la pregunta: ya no debe aparecer como fuente.
5. Como administrador, en Auditoría: aparecen `documento_creado` y `documento_actualizado`.

## Sitio público y aviso de privacidad (F12)
1. Abre la URL del sitio desde un teléfono. Esperado: el mapa con los puntos publicados, la etiqueta «piloto» y sin selector «Datos».
2. Pulsa «Aviso de privacidad» en el pie: se lee completo, con la sección de derechos ARCO.
3. Iniciar sesión → «No tengo cuenta». Llena correo y contraseña sin marcar la casilla: esperado el mensaje «necesitas aceptar el aviso de privacidad».
4. Marca la casilla y crea la cuenta. El correo de confirmación debe llevarte de vuelta al sitio público, no a `localhost`.
5. Entra y ve a Reportar. Llena todo sin marcar la casilla del aviso: esperado el mensaje «Marca la casilla del aviso de privacidad». Márcala y envía: queda en «Mis aportes» como pendiente.
6. En Supabase → Authentication → Users, abre la cuenta nueva: en *User metadata* aparece `aviso_privacidad` con la fecha de la versión.
