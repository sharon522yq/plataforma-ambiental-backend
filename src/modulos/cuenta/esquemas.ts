import { z } from "zod";

export const ROLES_PEDIBLES = ["moderador", "editor"] as const;
export const ESTADOS_PETICION = ["pendiente", "aprobada", "rechazada", "cancelada"] as const;

/** Mismos límites que la migración 015; la base también los revisa. */
export const cuerpoPedirRol = z.object({
  rol: z.enum(ROLES_PEDIBLES),
  motivo: z.string().trim().min(20).max(1000),
  zona: z.string().trim().min(2).max(200).optional(),
}).strict();

export const parametrosPeticion = z.object({ id: z.uuid() });

export const cuerpoResolverPeticion = z.object({
  aprobar: z.boolean(),
  respuesta: z.string().trim().min(1).max(500).optional(),
}).strict();

/** Lo que ve la propia persona: sin quién la resolvió. */
export const peticionPropia = z.object({
  id: z.uuid(),
  rol_actual: z.enum(["ciudadano", "moderador", "editor"]),
  rol_pedido: z.enum(ROLES_PEDIBLES),
  motivo: z.string(),
  zona: z.string().nullable(),
  estado: z.enum(ESTADOS_PETICION),
  respuesta: z.string().nullable(),
  creado_en: z.string(),
  resuelto_en: z.string().nullable(),
});

const persona = z.object({ id: z.uuid(), nombre: z.string().nullable() });

/** Lo que ve administración: el nombre público, nunca el correo (zod descarta lo no declarado). */
export const peticionAdmin = peticionPropia.extend({
  usuario: persona,
  resuelto_por: persona.nullable(),
});
