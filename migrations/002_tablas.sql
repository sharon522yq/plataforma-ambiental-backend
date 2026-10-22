-- 002: tablas del modelo de datos.
-- Convención: id uuid, creado_en y actualizado_en en timestamptz (UTC).
-- Excepciones: auditoria (solo creado_en, es inmutable) y perfiles (id viene de auth.users).

create table if not exists perfiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text not null,
  rol text not null default 'ciudadano'
    check (rol in ('ciudadano', 'moderador', 'editor', 'administrador')),
  telefono text,                       -- nunca se expone públicamente
  activo boolean not null default true,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create table if not exists organizaciones (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  contacto text,                       -- dato interno: no se expone a visitantes anónimos
  zona text,
  activa boolean not null default true,
  creado_por uuid references perfiles(id),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create table if not exists puntos (
  id uuid primary key default gen_random_uuid(),
  titulo text not null check (char_length(titulo) between 3 and 120),
  tipo text not null
    check (tipo in ('contaminacion_agua', 'contaminacion_aire', 'deforestacion', 'residuos', 'tala_ilegal', 'otro')),
  gravedad smallint not null check (gravedad between 1 and 5),
  descripcion text not null,
  ubicacion geography(point, 4326) not null,
  estado text not null default 'en_revision'
    check (estado in ('en_revision', 'publicado', 'archivado')),
  autor_id uuid references perfiles(id),
  aprobado_por uuid references perfiles(id),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index if not exists puntos_ubicacion_idx on puntos using gist (ubicacion);
create index if not exists puntos_estado_idx on puntos (estado);

create table if not exists aportes (
  id uuid primary key default gen_random_uuid(),
  punto_id uuid references puntos(id),                 -- nulo si es un punto nuevo
  tipo text not null
    check (tipo in ('contaminacion_agua', 'contaminacion_aire', 'deforestacion', 'residuos', 'tala_ilegal', 'otro')),
  gravedad_sugerida smallint check (gravedad_sugerida between 1 and 5),
  descripcion text not null,
  evidencia_url text,                                  -- ruta en Supabase Storage, nunca una URL pública permanente
  ubicacion geography(point, 4326) not null,
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'aprobado', 'rechazado', 'duplicado')),
  autor_id uuid not null references perfiles(id),
  revisor_id uuid references perfiles(id),
  motivo_revision text,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index if not exists aportes_ubicacion_idx on aportes using gist (ubicacion);
create index if not exists aportes_estado_idx on aportes (estado);

create table if not exists acciones (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('denuncia', 'firma', 'donacion', 'voluntariado')),
  nombre text not null,
  descripcion text,
  enlace text,
  organizacion_id uuid references organizaciones(id),
  activa boolean not null default true,
  punto_id uuid references puntos(id),                 -- nulo si aplica a todo el catálogo
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create table if not exists documentos_conocimiento (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  fuente text not null,
  fecha_fuente date,
  version integer not null default 1,
  activo boolean not null default true,
  creado_por uuid references perfiles(id),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create table if not exists fragmentos (
  id uuid primary key default gen_random_uuid(),
  documento_id uuid not null references documentos_conocimiento(id) on delete cascade,
  texto text not null,
  embedding vector(768),                               -- dimensión pendiente de confirmar (D-01)
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index if not exists fragmentos_embedding_hnsw_idx
  on fragmentos using hnsw (embedding vector_cosine_ops);

create table if not exists auditoria (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references perfiles(id),
  accion text not null,
  tabla text not null,
  registro_id uuid,
  detalle jsonb,                                       -- sin datos personales
  creado_en timestamptz not null default now()
);

create table if not exists conversaciones_agente (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references perfiles(id),            -- nulo si es público anónimo
  pregunta text not null,
  respuesta text,
  fuentes jsonb,
  expira_en timestamptz not null default now() + interval '7 days',
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
