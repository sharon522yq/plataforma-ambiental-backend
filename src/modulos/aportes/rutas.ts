import { Router, type RequestHandler } from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { sinCache } from "../../compartido/cache.js";
import { armarPagina, desplazamiento, llamarFuncion } from "../../compartido/consultas.js";
import { quitarDatosPersonales } from "../../compartido/privacidad.js";
import type { Autorizar } from "../../middleware/autorizar.js";
import { validar } from "../../middleware/validar.js";
import { aportePropio, consultaMisAportes, cuerpoNuevoAporte } from "./esquemas.js";

export type ClientePorUsuario = (token: string) => SupabaseClient;

/**
 * Aportes ciudadanos. Cualquier cuenta activa puede enviar y ver los suyos.
 * Todo corre con la sesión del usuario: RLS impide ver o crear aportes ajenos.
 */
export function crearRutasAportes(autenticar: RequestHandler, autorizar: Autorizar, clienteUsuario: ClientePorUsuario): Router {
  const rutas = Router();
  rutas.use(sinCache, autenticar, autorizar());

  rutas.post("/", validar({ body: cuerpoNuevoAporte }), (req, res, siguiente) => {
    const cuerpo = req.body as z.infer<typeof cuerpoNuevoAporte>;
    llamarFuncion(clienteUsuario(req.usuario?.token ?? ""), "crear_aporte", {
      tipo: cuerpo.tipo,
      descripcion: quitarDatosPersonales(cuerpo.descripcion),
      lat: cuerpo.ubicacion.lat,
      lng: cuerpo.ubicacion.lng,
      gravedad_sugerida: cuerpo.gravedad_sugerida ?? null,
      punto_id: cuerpo.punto_id ?? null,
    })
      .then((r) => res.status(201).json(aportePropio.parse(r)))
      .catch(siguiente);
  });

  rutas.get("/mis", validar({ query: consultaMisAportes }), (req, res, siguiente) => {
    const q = req.query as unknown as z.infer<typeof consultaMisAportes>;
    llamarFuncion(clienteUsuario(req.usuario?.token ?? ""), "mis_aportes", { limite: q.limite, desplazamiento: desplazamiento(q) })
      .then((r) => res.json(armarPagina(r, aportePropio, q)))
      .catch(siguiente);
  });

  return rutas;
}
