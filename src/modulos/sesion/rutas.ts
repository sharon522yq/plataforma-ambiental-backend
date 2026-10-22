import { Router, type RequestHandler } from "express";
import type { Autorizar } from "../../middleware/autorizar.js";

/** GET /sesion: quién soy y con qué rol (D-19). Útil para que el frontend ajuste lo que muestra. */
export function crearRutasSesion(autenticar: RequestHandler, autorizar: Autorizar): Router {
  const rutas = Router();
  rutas.get("/", autenticar, autorizar(), (req, res) => {
    res.json({ id: req.usuario?.id, rol: req.usuario?.rol });
  });
  return rutas;
}
