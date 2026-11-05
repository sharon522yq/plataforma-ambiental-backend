# Piloto con colectivos (F17)

Guía para probar la plataforma con 2 o 3 colectivos antes de abrirla al público. Cumple el criterio del plan maestro para el piloto («2 o 3 colectivos y accesibilidad revisada») y deja lista la decisión de lanzamiento («lista de correcciones prioritarias cerrada y al menos un moderador por zona»).

Los hallazgos se anotan en [`hallazgos-piloto.md`](hallazgos-piloto.md). Lo que dice «(sharon)» lo decides o haces tú; nada de eso lo puedo inventar yo.

## 1. Antes de invitar a nadie

Todo esto tiene que estar listo, en este orden. Cada punto remite a donde está explicado.

| # | Paso | Dónde está | Hecho |
|---|---|---|---|
| 1 | Aplicar las migraciones 013 y 014 con `npm run migrar` | README, «Base de datos» | ☐ |
| 2 | Fusionar los PR #2, #3, #4 y #5, en ese orden, con la CI en verde | GitHub | ☐ |
| 3 | Sincronizar el Blueprint en Render y anotar la URL del sitio | README, «Sitio público (F12)» | ☐ |
| 4 | Poner esa URL en `CORS_ORIGENES` (Render) y en Site URL y Redirect URLs (Supabase Auth) | README, «Sitio público (F12)» | ☐ |
| 5 | Escribir el correo de contacto del aviso de privacidad (`CONTACTO_PRIVACIDAD` en `prototipo/index.html`) y que alguien que conozca la LFPDPPP revise el aviso (sharon) | `#privacidad` en el sitio | ☐ |
| 6 | Activar la facturación de Gemini (D-03), para que Google no use las preguntas de la gente y no se acabe la cuota a media sesión (sharon) | `docs/decisiones-pendientes.md`, D-03 | ☐ |
| 7 | Crear los secretos del respaldo (M11) y lanzar «Respaldo» una vez, en verde | `docs/respaldos.md` | ☐ |
| 8 | Nombrar a un segundo administrador real y hacer la prueba «Operación (F15)» | `docs/pruebas-manuales.md` | ☐ |
| 9 | Elegir la zona del piloto (sharon) y cargar al menos 5 documentos oficiales de esa zona en «Base de conocimiento» (leyes, normas, dónde denunciar) | `docs/pruebas-manuales.md`, «Base de conocimiento (F14)» | ☐ |
| 10 | Dar de alta las organizaciones reales de la zona que acepten aparecer, con su permiso por escrito | Administración → Catálogo | ☐ |
| 11 | Retirar los datos de prueba (ver abajo) | Esta guía | ☐ |
| 12 | Correr `npm run evaluar:agente` con la facturación activa: «Aprobados: 18 de 20» o más | `docs/pruebas-manuales.md`, «Agente con herramientas (F13)» | ☐ |
| 13 | Recorrer tú todo `docs/pruebas-manuales.md` en el sitio publicado y anotar lo que falle | `docs/pruebas-manuales.md` | ☐ |

### Retirar los datos de prueba

La migración 005 cargó 3 puntos, 2 organizaciones y 3 acciones de ejemplo con el prefijo `[PRUEBA]`. Para el piloto conviene **archivarlos en vez de borrarlos**: desaparecen del sitio y se pueden recuperar. En Supabase → SQL Editor, después de un respaldo en verde:

```sql
update puntos set estado = 'archivado' where titulo like '[PRUEBA]%';
update acciones set activa = false where nombre like '[PRUEBA]%';
update organizaciones set activa = false where nombre like '[PRUEBA]%';
```

Esperado: el mapa del sitio público queda solo con los puntos reales. Si un día quieres borrarlos del todo, las sentencias `delete` están al inicio de `migrations/005_datos_iniciales.sql`.

## 2. Quiénes participan

- **Colectivos:** 2 o 3 de la zona del piloto, con 3 a 5 personas cada uno. Busca que haya personas que solo usen el teléfono, al menos una persona mayor de 50 años y, si es posible, una persona que use lector de pantalla (cumple la revisión de accesibilidad con una persona real, no solo con axe).
- **Moderación:** al menos una persona por zona con rol de moderador. Lo ideal es que sea alguien de un colectivo, no tú, para cumplir la meta de «no depender de una sola persona técnica».
- **Observación:** una persona por sesión que mira y anota sin ayudar (puedes ser tú).

No anotes nombres de participantes en los hallazgos: usa «Colectivo A, persona 2». Así el registro no guarda datos personales.

## 3. Mensaje de invitación

Plantilla para enviar desde tu correo o WhatsApp. Cambia lo que está entre corchetes; no lo envío yo.

> Hola, [nombre del colectivo]. Estamos probando una plataforma para ver en un mapa los problemas ambientales de [zona], preguntarle a un asistente qué hacer y reportar lo que vean. Buscamos [3 a 5] personas que la usen durante unos 45 minutos el [fecha] en [lugar o videollamada] y nos digan qué no se entiende. No hace falta saber de tecnología: solo traer un teléfono con internet.
>
> Para participar hay que crear una cuenta con un correo y aceptar el aviso de privacidad del sitio. Lo que reporten durante la prueba lo revisa una persona antes de publicarse, y pueden pedir que se borre su cuenta cuando quieran escribiendo a [correo de contacto del aviso].
>
> ¿Les interesa? — [tu nombre]

## 4. Sesión con un colectivo (unos 45 minutos)

**Antes:** abre el sitio en tu teléfono y comprueba que cargue (Render gratuito tarda hasta un minuto en despertar). Ten a la mano esta guía y [`hallazgos-piloto.md`](hallazgos-piloto.md).

**Reglas para quien observa:** lee cada tarea en voz alta tal cual, sin explicar dónde está el botón. Si la persona se traba más de 2 minutos, anota «no completó», ayúdala y sigue con la siguiente. Pide que piense en voz alta.

| Tarea | Lo que dices | Se completa cuando |
|---|---|---|
| T1 | «Busca en el mapa un problema de agua cerca de [lugar conocido de la zona]» | Abre el detalle de un punto de agua |
| T2 | «¿Cómo llegarías a ese lugar desde donde estás?» | Abre la ruta en Google Maps u OpenStreetMap |
| T3 | «Pregúntale al asistente qué puedes hacer por ese problema» | Recibe una respuesta con acciones o con la fuente |
| T4 | «Crea una cuenta» | Confirma el correo y entra |
| T5 | «Reporta algo que hayas visto en tu colonia, con una foto» | El aporte aparece en «Mis aportes» como pendiente |
| T6 | «Agrega a un punto un enlace para ayudar (una firma, un evento)» | El enlace aparece en el punto |
| T7 | (Solo quien use lector de pantalla o teclado) repetir T1 y T5 sin tocar la pantalla con el dedo o sin ratón | Las completa |

**Al final, tres preguntas:** ¿Qué fue lo más difícil? ¿Qué te faltó? ¿Lo usarías otra vez, y para qué?

**Después:** pasa cada traba a [`hallazgos-piloto.md`](hallazgos-piloto.md) el mismo día, con la gravedad.

## 5. Sesión con moderadores (unos 30 minutos)

Con su cuenta ya con rol de moderador (lo das en Administración → Usuarios y roles):

1. En Moderación, revisar los aportes que dejaron los colectivos: aprobar uno, rechazar otro (el motivo es obligatorio) y marcar uno como duplicado.
2. Publicar el punto aprobado y comprobar que aparece en el sitio sin sesión.
3. Retirar un enlace de la comunidad que no corresponda.
4. Ver Auditoría (solo administradores) para que sepan que cada decisión queda registrada.

Acuerden por escrito cada cuánto revisan (por ejemplo, cada 48 horas) y qué hacen con un reporte de emergencia: la plataforma no atiende emergencias (ante un riesgo inmediato el asistente recomienda llamar al 911), así que conviene decidir a quién avisan si llega un reporte así. Esa regla la deciden ustedes; anótala en la sección «Acuerdos» de [`hallazgos-piloto.md`](hallazgos-piloto.md).

## 6. Qué medir

Después de las sesiones, en Administración → Métricas:

| Dato | Dónde | Meta para lanzar (propuesta) |
|---|---|---|
| Tareas completadas sin ayuda | `hallazgos-piloto.md`, tabla de tareas | T1, T4 y T5 sin ayuda en al menos 4 de cada 5 personas |
| Mediana de horas de revisión | Métricas → Aportes | Menos de 48 horas |
| Consultas con documentos | Métricas → Asistente (`con_documentos` frente al total) | Que las preguntas sobre leyes y denuncias citen fuente |
| Respuestas sin IA | Métricas → Asistente (`sin_ia`) | 0 con la facturación activa |
| Hallazgos que bloquean | `hallazgos-piloto.md` | 0 abiertos |

Las metas son una propuesta mía para que haya un criterio; ajústalas con tu docente.

## 7. Lista de lanzamiento

Se abre al público cuando todo esto está marcado:

- ☐ Todos los pasos de la sección 1.
- ☐ Ningún hallazgo «Bloquea» abierto y los «Molesta» revisados (corregidos o aceptados por escrito).
- ☐ Al menos un moderador por zona que no seas tú, con el acuerdo de revisión anotado.
- ☐ Un respaldo en verde de la última semana.
- ☐ Dominio: decidir si se compra uno o se queda `*.onrender.com` (sharon). Si se compra, repetir el paso 4 de la sección 1 con el dominio nuevo y agregarlo a la política de contenido en `render.yaml`.
- ☐ Informe final actualizado con los resultados del piloto.
