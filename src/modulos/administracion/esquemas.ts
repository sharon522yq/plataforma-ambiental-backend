import { z } from "zod";
import { esquemaPaginacion } from "../../compartido/consultas.js";
import { ROLES } from "../../compartido/sesion.js";
import { TIPOS_ACCION } from "../acciones/rutas.js";

const textoOpcional = (maximo: number) => z.string().trim().min(1).max(maximo).optional();

/** Solo https: un enlace http o javascript: en el catálogo público sería un riesgo para quien lo abre. */
const enlaceSeguro = z
  .string()
  .trim()
  .max(500)
  .pipe(z.url())
  .refine((v) => /^https:\/\/\S+$/.test(v), { message: "El enlace debe empezar con https://" });

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

/** Tablas que registra la auditoría (triggers de la 008, 009 y 010). */
export const TABLAS_AUDITADAS = ["aportes", "puntos", "perfiles", "acciones", "organizaciones"] as const;

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
  creado_en: z.string(),
  actualizado_en: z.string(),
});

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

export const usuarioRolCambiado = z.object({
  id: z.uuid(),
  nombre: z.string(),
  rol: z.enum(ROLES),
  activo: z.boolean(),
  actualizado_en: z.string(),
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
