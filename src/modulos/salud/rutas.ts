import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sinCache } from "../../compartido/cache.js";
import { ErrorAplicacion } from "../../compartido/errores.js";
import { validar } from "../../middleware/validar.js";
import type { ModeloIA } from "../agente/gemini.js";
import { comprobarBase } from "./servicio.js";

/** Pregunta fija y del tema del asistente, para que la prueba real use poca cuota (D-38). */
export const PREGUNTA_DE_PRUEBA = "En una frase corta, ¿por qué conviene separar la basura?";
const consultaSaludIA = z.object({ generar: z.literal("1").optional() }).strict();

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
 * Con ?generar=1 además pide una respuesta corta real (gasta un poco de cuota); si falla,
 * responde 200 con `ia: "no_disponible"` y el código del error, nunca detalles de Google.
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
    rutas.get("/ia", sinCache, ...saludIA.soloAdministrador, validar({ query: consultaSaludIA }), (req, res, siguiente) => {
      if (req.query.generar !== "1") {
        saludIA.ia
          .comprobar()
          .then((ia) => res.json({ ia, modelo: saludIA.modelo }))
          .catch(siguiente);
        return;
      }
      saludIA.ia
        .generar(PREGUNTA_DE_PRUEBA)
        .then(({ texto, modelo }) => res.json({ ia: "ok", modelo, prueba: texto.slice(0, 300) }))
        .catch((error: unknown) => {
          if (!(error instanceof ErrorAplicacion)) throw error;
          res.json({ ia: "no_disponible", modelo: saludIA.modelo, prueba: null, motivo: error.codigo });
        })
        .catch(siguiente);
    });
  }
  return rutas;
}
