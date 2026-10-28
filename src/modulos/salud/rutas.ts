import { Router, type RequestHandler } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sinCache } from "../../compartido/cache.js";
import type { ModeloIA } from "../agente/gemini.js";
import { comprobarBase } from "./servicio.js";

interface SaludIA {
  ia: ModeloIA;
  modelo: string;
  /** autenticar + autorizar("administrador"). */
  soloAdministrador: RequestHandler[];
}

/**
 * GET /salud responde 200 aunque la base falle: el servicio está vivo.
 * El campo `base` indica el estado de la base (decisión D-07).
 * GET /salud/ia (solo administrador) comprueba Gemini sin generar texto, así no gasta cuota.
 */
export function crearRutasSalud(cliente: SupabaseClient, saludIA?: SaludIA): Router {
  const rutas = Router();
  rutas.get("/", (_req, res, siguiente) => {
    comprobarBase(cliente)
      .then((base) => {
        res.json({ estado: base === "ok" ? "ok" : "degradado", base });
      })
      .catch(siguiente);
  });

  if (saludIA) {
    rutas.get("/ia", sinCache, ...saludIA.soloAdministrador, (_req, res, siguiente) => {
      saludIA.ia
        .comprobar()
        .then((ia) => res.json({ ia, modelo: saludIA.modelo }))
        .catch(siguiente);
    });
  }
  return rutas;
}
