import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { sinCache } from "../../compartido/cache.js";
import { llamarFuncion } from "../../compartido/consultas.js";
import { cuerpoEnlace } from "../../compartido/enlaces.js";
import type { Autorizar } from "../../middleware/autorizar.js";
import { validar } from "../../middleware/validar.js";
import { accionAdmin, parametrosAccion } from "../administracion/esquemas.js";
import type { ClientePorUsuario } from "../aportes/rutas.js";

const parametrosPunto = z.object({ id: z.uuid() });
const cuerpoPropuesta = cuerpoEnlace.extend({ descripcion: z.string().trim().min(1).max(500).optional() }).strict();

/**
 * Enlaces de la comunidad para ayudar (D-40, migración 012).
 * POST /puntos/:id/acciones: cualquier cuenta activa agrega un enlace a un punto publicado; sale al momento.
 * DELETE /admin/acciones/:id: moderador, editor o administrador lo retira (queda inactivo y auditado).
 * Corre con la sesión del usuario; las funciones de la base repiten las comprobaciones de rol.
 */
export function crearRutasComunidad(autenticar: RequestHandler, autorizar: Autorizar, clienteUsuario: ClientePorUsuario): Router {
  const rutas = Router();
  const cliente = (token: string | undefined) => clienteUsuario(token ?? "");

  rutas.post(
    "/puntos/:id/acciones",
    sinCache, autenticar, autorizar(),
    validar({ params: parametrosPunto, body: cuerpoPropuesta }),
    (req, res, siguiente) => {
      const { id } = req.params as z.infer<typeof parametrosPunto>;
      const c = req.body as z.infer<typeof cuerpoPropuesta>;
      llamarFuncion(cliente(req.usuario?.token), "proponer_accion", {
        punto_id: id,
        tipo: c.tipo,
        nombre: c.nombre,
        enlace: c.enlace,
        descripcion: c.descripcion ?? null,
      })
        .then((r) => res.status(201).json(accionAdmin.parse(r)))
        .catch(siguiente);
    },
  );

  rutas.delete(
    "/admin/acciones/:id",
    sinCache, autenticar, autorizar("moderador", "editor", "administrador"),
    validar({ params: parametrosAccion }),
    (req, res, siguiente) => {
      const { id } = req.params as z.infer<typeof parametrosAccion>;
      llamarFuncion(cliente(req.usuario?.token), "retirar_accion", { accion_id: id })
        .then((r) => res.json(accionAdmin.parse(r)))
        .catch(siguiente);
    },
  );

  return rutas;
}
