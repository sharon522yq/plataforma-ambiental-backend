import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { cachePublica } from "../../compartido/cache.js";
import { armarPagina, desplazamiento, esquemaPaginacion, llamarFuncion } from "../../compartido/consultas.js";
import { validar } from "../../middleware/validar.js";

const consulta = esquemaPaginacion.extend({
  zona: z.string().trim().min(1).max(80).optional(),
});

// Sin `contacto`: es un dato interno y no sale en la API pública.
const organizacion = z.object({ id: z.uuid(), nombre: z.string(), zona: z.string().nullable() });

/** GET /organizaciones: organizaciones activas (RLS). */
export function crearRutasOrganizaciones(publico: SupabaseClient): Router {
  const rutas = Router();
  rutas.get("/", cachePublica, validar({ query: consulta }), (req, res, siguiente) => {
    const q = req.query as unknown as z.infer<typeof consulta>;
    llamarFuncion(publico, "listar_organizaciones_publicas", {
      zona_filtro: q.zona ?? null,
      limite: q.limite,
      desplazamiento: desplazamiento(q),
    })
      .then((r) => res.json(armarPagina(r, organizacion, { pagina: q.pagina, limite: q.limite })))
      .catch(siguiente);
  });
  return rutas;
}
