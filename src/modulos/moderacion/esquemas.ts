import { z } from "zod";
import { esquemaPaginacion } from "../../compartido/consultas.js";
import { ESTADOS_APORTE, esquemaUbicacion } from "../aportes/esquemas.js";
import { TIPOS_PUNTO } from "../puntos/esquemas.js";

export const ESTADOS_PUNTO = ["en_revision", "publicado", "archivado"] as const;

export const consultaCola = esquemaPaginacion.extend({
  estado: z.enum(ESTADOS_APORTE).default("pendiente"),
});

export const parametrosId = z.object({ id: z.uuid() });

/** Cada decisión pide sus propios datos: rechazar exige motivo_revision y duplicado exige el punto. */
export const cuerpoRevision = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("aprobado"),
    titulo: z.string().trim().min(3).max(120).optional(),
    gravedad: z.number().int().min(1).max(5).optional(),
    publicar: z.boolean().default(true),
    motivo_revision: z.string().trim().max(500).optional(),
  }).strict(),
  z.object({
    decision: z.literal("rechazado"),
    motivo_revision: z.string().trim().min(3).max(500),
  }).strict(),
  z.object({
    decision: z.literal("duplicado"),
    duplicado_de: z.uuid(),
    motivo_revision: z.string().trim().max(500).optional(),
  }).strict(),
]);

export const cuerpoNuevoPunto = z.object({
  titulo: z.string().trim().min(3).max(120),
  tipo: z.enum(TIPOS_PUNTO),
  gravedad: z.number().int().min(1).max(5),
  descripcion: z.string().trim().min(1).max(2000),
  ubicacion: esquemaUbicacion,
  estado: z.enum(ESTADOS_PUNTO).default("en_revision"),
}).strict();

export const cuerpoEstadoPunto = z.object({ estado: z.enum(ESTADOS_PUNTO) }).strict();

export const puntoModeracion = z
  .object({
    id: z.uuid(),
    titulo: z.string(),
    tipo: z.enum(TIPOS_PUNTO),
    gravedad: z.number().int(),
    descripcion: z.string(),
    lat: z.number(),
    lng: z.number(),
    estado: z.enum(ESTADOS_PUNTO),
    creado_en: z.string(),
    actualizado_en: z.string(),
  })
  .transform(({ lat, lng, ...resto }) => ({ ...resto, ubicacion: { lat, lng } }));
