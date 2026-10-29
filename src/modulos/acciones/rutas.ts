import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { cachePublica } from "../../compartido/cache.js";
import { armarPagina, desplazamiento, esquemaPaginacion, llamarFuncion } from "../../compartido/consultas.js";
import { validar } from "../../middleware/validar.js";

/** Deben coincidir con el check de acciones.tipo (migración 002). */
export const TIPOS_ACCION = ["denuncia", "firma", "donacion", "voluntariado"] as const;

const consulta = esquemaPaginacion.extend({
  tipo: z.enum(TIPOS_ACCION).optional(),
  punto_id: z.uuid().optional(),
});

const accion = z.object({
  id: z.uuid(),
  tipo: z.enum(TIPOS_ACCION),
  nombre: z.string(),
  descripcion: z.string().nullable(),
  enlace: z.string().nullable(),
  punto_id: z.uuid().nullable(),
  organizacion: z.object({ id: z.uuid(), nombre: z.string() }).nullable(),
});

/** GET /acciones: catálogo de cómo ayudar. Solo acciones activas (RLS). */
export function crearRutasAcciones(publico: SupabaseClient): Router {
  const rutas = Router();
  rutas.get("/", cachePublica, validar({ query: consulta }), (req, res, siguiente) => {
    const q = req.query as unknown as z.infer<typeof consulta>;
    llamarFuncion(publico, "listar_acciones_publicas", {
      tipo_filtro: q.tipo ?? null,
      punto: q.punto_id ?? null,
      limite: q.limite,
      desplazamiento: desplazamiento(q),
    })
      .then((r) => res.json(armarPagina(r, accion, { pagina: q.pagina, limite: q.limite })))
      .catch(siguiente);
  });
  return rutas;
}
