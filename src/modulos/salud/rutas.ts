import { Router } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { comprobarBase } from "./servicio.js";

/**
 * GET /salud responde 200 aunque la base falle: el servicio está vivo.
 * El campo `base` indica el estado de la base (decisión D-07).
 */
export function crearRutasSalud(cliente: SupabaseClient): Router {
  const rutas = Router();
  rutas.get("/", (_req, res, siguiente) => {
    comprobarBase(cliente)
      .then((base) => {
        res.json({ estado: base === "ok" ? "ok" : "degradado", base });
      })
      .catch(siguiente);
  });
  return rutas;
}
