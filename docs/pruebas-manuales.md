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
