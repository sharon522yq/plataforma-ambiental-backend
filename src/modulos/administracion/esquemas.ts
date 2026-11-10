import { z } from "zod";
import { esquemaPaginacion } from "../../compartido/consultas.js";
import { enlaceSeguro } from "../../compartido/enlaces.js";
import { ROLES } from "../../compartido/sesion.js";
import { TIPOS_ACCION } from "../acciones/rutas.js";

const textoOpcional = (maximo: number) => z.string().trim().min(1).max(maximo).optional();


export const cuerpoNuevaAccion = z.object({
  tipo: z.enum(TIPOS_ACCION),
  nombre: z.string().trim().min(3).max(120),
  descripcion: textoOpcional(1000),
  enlace: enlaceSeguro.optional(),
  organizacion_id: z.uuid().optional(),
  punto_id: z.uuid().optional(),
}).strict();

export const cuerpoNuevaOrganizacion = z.object({
  nombre: z.string().trim().min(3).max(120),
  /** Dato interno: lo ve el personal, nunca la API pública. */
  contacto: textoOpcional(200),
  zona: textoOpcional(80),
}).strict();

export const consultaUsuarios = esquemaPaginacion.extend({
  rol: z.enum(ROLES).optional(),
  busqueda: z.string().trim().min(1).max(80).optional(),
});

export const parametrosUsuario = z.object({ id: z.uuid() });

export const cuerpoRol = z.object({ rol: z.enum(ROLES) }).strict();

/** Tablas que registra la auditoría (triggers de la 008, 009, 010, 013, 014, 015 y 016). */
export const TABLAS_AUDITADAS = [
  "aportes", "puntos", "perfiles", "acciones", "organizaciones", "documentos_conocimiento", "solicitudes_rol", "peticiones_rol", "denuncias_hilo",
] as const;

export const consultaAuditoria = esquemaPaginacion.extend({
  tabla: z.enum(TABLAS_AUDITADAS).optional(),
  accion: z.string().regex(/^[a-z_]{3,40}$/).optional(),
  usuario_id: z.uuid().optional(),
  registro_id: z.uuid().optional(),
  desde: z.iso.datetime({ offset: true }).optional(),
  hasta: z.iso.datetime({ offset: true }).optional(),
}).refine((q) => !q.desde || !q.hasta || new Date(q.desde) <= new Date(q.hasta), {
  message: "desde debe ser anterior a hasta",
  path: ["desde"],
});

export const accionAdmin = z.object({
  id: z.uuid(),
  tipo: z.enum(TIPOS_ACCION),
  nombre: z.string(),
  descripcion: z.string().nullable(),
  enlace: z.string().nullable(),
  organizacion_id: z.uuid().nullable(),
  punto_id: z.uuid().nullable(),
  activa: z.boolean(),
  de_la_comunidad: z.boolean().default(false),
  creado_en: z.string(),
  actualizado_en: z.string(),
});

export const parametrosAccion = z.object({ id: z.uuid() });

export const organizacionAdmin = z.object({
  id: z.uuid(),
  nombre: z.string(),
  contacto: z.string().nullable(),
  zona: z.string().nullable(),
  activa: z.boolean(),
  creado_por: z.uuid().nullable(),
  creado_en: z.string(),
  actualizado_en: z.string(),
});

/** Sin teléfono: zod descarta cualquier campo no declarado aunque la base lo enviara. */
export const usuarioAdmin = z.object({
  id: z.uuid(),
  nombre: z.string(),
  email: z.string().nullable(),
  rol: z.enum(ROLES),
  activo: z.boolean(),
  creado_en: z.string(),
});

const persona = z.object({ id: z.uuid(), nombre: z.string() });

/** Solicitud para dar o quitar el rol de administrador (migración 014). */
export const solicitudRol = z.object({
  id: z.uuid(),
  usuario: persona,
  rol_anterior: z.enum(ROLES),
  rol_nuevo: z.enum(ROLES),
  solicitado_por: persona,
  estado: z.enum(["pendiente", "aprobada", "rechazada", "cancelada", "vencida"]),
  resuelto_por: persona.nullable(),
  creado_en: z.string(),
  resuelto_en: z.string().nullable(),
});

export const parametrosSolicitud = z.object({ id: z.uuid() });

export const cuerpoDecisionRol = z.object({ aprobar: z.boolean() }).strict();

/** Si el cambio necesita a otro administrador, rol sigue igual y solicitud trae la pendiente. */
export const usuarioRolCambiado = z.object({
  id: z.uuid(),
  nombre: z.string(),
  rol: z.enum(ROLES),
  activo: z.boolean(),
  actualizado_en: z.string(),
  solicitud: solicitudRol.nullable().default(null),
});

const conteo = z.number().int().nonnegative();
const conteosPor = z.record(z.string(), conteo);

/** Métricas de la plataforma (migración 014): solo conteos, sin datos personales. */
export const metricas = z.object({
  generado_en: z.string(),
  puntos: z.object({ publicados: conteo, en_revision: conteo, archivados: conteo, por_tipo: conteosPor, por_gravedad: conteosPor }),
  aportes: z.object({
    pendientes: conteo,
    aprobados: conteo,
    rechazados: conteo,
    duplicados: conteo,
    ultimos_30_dias: conteo,
    horas_revision_mediana: z.number().nonnegative().nullable(),
    por_semana: z.array(z.object({ semana: z.string(), recibidos: conteo })),
  }),
  usuarios: z.object({ total: conteo, activos: conteo, nuevos_30_dias: conteo, por_rol: conteosPor }),
  catalogo: z.object({ acciones_activas: conteo, organizaciones_activas: conteo, documentos_activos: conteo, fragmentos: conteo }),
  asistente: z.object({ conversaciones_7_dias: conteo, con_herramientas: conteo, con_documentos: conteo, sin_ia: conteo }),
  pendientes_de_rol: conteo,
});

export const registroAuditoria = z.object({
  id: z.uuid(),
  usuario_id: z.uuid().nullable(),
  accion: z.string(),
  tabla: z.string(),
  registro_id: z.uuid().nullable(),
  detalle: z.record(z.string(), z.unknown()).nullable(),
  creado_en: z.string(),
});
