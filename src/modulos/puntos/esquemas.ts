import { z } from "zod";
import { esquemaPaginacion } from "../../compartido/consultas.js";

/** Deben coincidir con el check de puntos.tipo (migración 002). */
export const TIPOS_PUNTO = ["contaminacion_agua", "contaminacion_aire", "deforestacion", "residuos", "tala_ilegal", "otro"] as const;

export const consultaListado = esquemaPaginacion.extend({
  tipo: z.enum(TIPOS_PUNTO).optional(),
  gravedad_min: z.coerce.number().int().min(1).max(5).optional(),
});

export const consultaCercanos = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radio: z.coerce.number().int().min(1).max(50000).default(5000),
  tipo: z.enum(TIPOS_PUNTO).optional(),
  limite: z.coerce.number().int().min(1).max(100).default(20),
});

export const parametrosId = z.object({ id: z.string().uuid() });

// Respuestas. Las coordenadas salen agrupadas en `ubicacion`. Las llaves que no estén
// aquí se descartan, así que un campo interno nunca llega al cliente por accidente.
const coordenadas = { lat: z.number(), lng: z.number() };
const agruparUbicacion = <T extends { lat: number; lng: number }>({ lat, lng, ...resto }: T) => ({
  ...resto,
  ubicacion: { lat, lng },
});

const base = {
  id: z.string().uuid(),
  titulo: z.string(),
  tipo: z.enum(TIPOS_PUNTO),
  gravedad: z.number().int(),
};

export const puntoResumen = z
  .object({ ...base, ...coordenadas, descripcion: z.string(), creado_en: z.string(), actualizado_en: z.string() })
  .transform(agruparUbicacion);

export const puntoCercano = z.object({ ...base, ...coordenadas, distancia_metros: z.number() }).transform(agruparUbicacion);

export const puntoDetalle = z.object({
  ...coordenadas,
  ...base,
  descripcion: z.string(),
  creado_en: z.string(),
  actualizado_en: z.string(),
  acciones: z.array(
    z.object({
      id: z.string().uuid(),
      tipo: z.string(),
      nombre: z.string(),
      descripcion: z.string().nullable(),
      enlace: z.string().nullable(),
    }),
  ),
}).transform(agruparUbicacion);
