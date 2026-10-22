import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { cachePublica } from "../../compartido/cache.js";
import { validar } from "../../middleware/validar.js";
import { consultaCercanos, consultaListado, parametrosId } from "./esquemas.js";
import { listarPuntos, obtenerPunto, puntosCercanos } from "./servicio.js";

/** Rutas públicas de puntos. Usan el cliente anon: RLS decide qué se ve (D-15). */
export function crearRutasPuntos(publico: SupabaseClient): Router {
  const rutas = Router();
  rutas.use(cachePublica);

  rutas.get("/", validar({ query: consultaListado }), (req, res, siguiente) => {
    listarPuntos(publico, req.query as unknown as z.infer<typeof consultaListado>)
      .then((pagina) => res.json(pagina))
      .catch(siguiente);
  });

  // Antes de /:id, para que "cercanos" no se tome como un id.
  rutas.get("/cercanos", validar({ query: consultaCercanos }), (req, res, siguiente) => {
    puntosCercanos(publico, req.query as unknown as z.infer<typeof consultaCercanos>)
      .then((r) => res.json(r))
      .catch(siguiente);
  });

  rutas.get("/:id", validar({ params: parametrosId }), (req, res, siguiente) => {
    obtenerPunto(publico, (req.params as z.infer<typeof parametrosId>).id)
      .then((punto) => res.json(punto))
      .catch(siguiente);
  });

  return rutas;
}
