-- 005: datos de prueba.
-- ATENCIÓN: estos datos deben borrarse antes del lanzamiento público.
-- Todos llevan el prefijo "[PRUEBA]". Para borrarlos:
--   delete from acciones where nombre like '[PRUEBA]%';
--   delete from organizaciones where nombre like '[PRUEBA]%';
--   delete from puntos where titulo like '[PRUEBA]%';

-- 3 puntos publicados en el Área Metropolitana de Guadalajara (coordenadas aproximadas).
insert into puntos (titulo, tipo, gravedad, descripcion, ubicacion, estado)
values
  ('[PRUEBA] Descarga de aguas residuales en arroyo de Tlaquepaque', 'contaminacion_agua', 3,
   'Dato de prueba. Se observa espuma y mal olor en la orilla del arroyo.',
   st_setsrid(st_makepoint(-103.2972, 20.6408), 4326)::geography, 'publicado'),
  ('[PRUEBA] Humo industrial sobre Periférico Sur', 'contaminacion_aire', 4,
   'Dato de prueba. Columna de humo visible en horas de la tarde.',
   st_setsrid(st_makepoint(-103.3700, 20.6100), 4326)::geography, 'publicado'),
  ('[PRUEBA] Tala en zona de Bosque Los Colomos', 'tala_ilegal', 4,
   'Dato de prueba. Árboles derribados en el perímetro norte.',
   st_setsrid(st_makepoint(-103.3930, 20.7115), 4326)::geography, 'publicado');

-- 2 organizaciones de prueba (el contacto es interno y no se publica).
insert into organizaciones (nombre, contacto, zona, activa)
values
  ('[PRUEBA] Colectivo Agua Limpia', 'contacto interno de prueba', 'Tlaquepaque', true),
  ('[PRUEBA] Red de voluntarios verdes', 'contacto interno de prueba', 'Guadalajara', true);

-- 3 acciones de prueba asociadas a las organizaciones y a un punto.
insert into acciones (tipo, nombre, descripcion, enlace, organizacion_id, activa, punto_id)
values
  ('denuncia', '[PRUEBA] Canal de denuncia ambiental',
   'Dato de prueba.', 'https://ejemplo.org/denuncia',
   (select id from organizaciones where nombre = '[PRUEBA] Colectivo Agua Limpia'),
   true,
   (select id from puntos where titulo like '[PRUEBA] Descarga%')),
  ('firma', '[PRUEBA] Firma para proteger el arbolado',
   'Dato de prueba.', 'https://ejemplo.org/firma',
   (select id from organizaciones where nombre = '[PRUEBA] Red de voluntarios verdes'),
   true,
   (select id from puntos where titulo like '[PRUEBA] Tala%')),
  ('voluntariado', '[PRUEBA] Jornada de limpieza',
   'Dato de prueba.', 'https://ejemplo.org/voluntariado',
   (select id from organizaciones where nombre = '[PRUEBA] Red de voluntarios verdes'),
   true,
   null);
