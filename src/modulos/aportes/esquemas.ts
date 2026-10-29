import { z } from "zod";
import { esquemaPaginacion } from "../../compartido/consultas.js";
import { TIPOS_PUNTO } from "../puntos/esquemas.js";

export const ESTADOS_APORTE = ["pendiente", "aprobado", "rechazado", "duplicado"] as const;

export const esquemaUbicacion = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
}).strict();

/** `strict`: un campo de más (p. ej. estado o autor_id) es un 400, no se ignora en silencio. */
export const cuerpoNuevoAporte = z.object({
  tipo: z.enum(TIPOS_PUNTO),
  descripcion: z.string().trim().min(10).max(2000),
  ubicacion: esquemaUbicacion,
  gravedad_sugerida: z.number().int().min(1).max(5).optional(),
  punto_id: z.uuid().optional(),
}).strict();

export const consultaMisAportes = esquemaPaginacion;

export const parametrosAporte = z.object({ id: z.uuid() });

const agruparUbicacion = <T extends { lat: number; lng: number }>({ lat, lng, ...resto }: T) => ({
  ...resto,
  ubicacion: { lat, lng },
});

const camposAporte = {
  id: z.uuid(),
  punto_id: z.uuid().nullable(),
  tipo: z.enum(TIPOS_PUNTO),
  gravedad_sugerida: z.number().int().nullable(),
  descripcion: z.string(),
  lat: z.number(),
  lng: z.number(),
  estado: z.enum(ESTADOS_APORTE),
  motivo_revision: z.string().nullable(),
  /** Ruta interna en Storage. Nunca sale tal cual: `conEnlaces` la cambia por un enlace temporal. */
  evidencia_ruta: z.string().nullable().default(null),
  creado_en: z.string(),
  actualizado_en: z.string(),
};

/** Lo que ve el autor de su propio aporte. */
export const aportePropio = z.object(camposAporte).transform(agruparUbicacion);

/** Lo que ve un moderador: además, quién lo envió y quién lo revisó. */
export const aporteModeracion = z
  .object({ ...camposAporte, autor_id: z.uuid(), revisor_id: z.uuid().nullable() })
  .transform(agruparUbicacion);
