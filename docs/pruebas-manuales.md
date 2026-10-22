# Pruebas manuales

Lista para probar con Postman o Thunder Client, sin programar. Se completa al terminar la fase 9.

Pendiente el resto. Ya se puede probar:

## Foto de evidencia
1. Inicia sesión, crea un aporte con `POST /api/v1/aportes` y copia su `id`.
2. En Postman, `POST /api/v1/aportes/<id>/evidencia`, Body → form-data, clave `foto` de tipo File, elige una foto del celular.
3. Esperado: 201 y `evidencia.url`. Abre la url: se ve la foto. A los 10 minutos deja de abrir.
4. Descarga la foto y revisa sus propiedades: no debe tener ubicación GPS ni modelo de cámara.
5. Repite el paso 2: esperado 409 ("El aporte ya tiene evidencia").
6. Con otra cuenta, repite el paso 2 con el mismo `id`: esperado 404.
