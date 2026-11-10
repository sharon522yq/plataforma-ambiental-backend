import { Router, type RequestHandler } from "express";
import type { z } from "zod";
import { sinCache } from "../../compartido/cache.js";
import { llamarFuncion } from "../../compartido/consultas.js";
import type { Autorizar } from "../../middleware/autorizar.js";
import { validar } from "../../middleware/validar.js";
import type { ClientePorUsuario } from "../aportes/rutas.js";
import type { AvisosPeticionRol } from "./avisos.js";
import { cuerpoPedirRol, cuerpoResolverPeticion, parametrosPeticion, peticionAdmin, peticionPropia } from "./esquemas.js";

/**
 * Peticiones de rol (migración 015, D-45). Cualquier cuenta activa pide moderación o edición;
 * un administrador la aprueba o la rechaza. Todo corre con la sesión del usuario: las funciones
 * de la base deciden quién puede qué. Los avisos por correo salen sin hacer esperar la respuesta.
 */
export function crearRutasCuenta(autenticar: RequestHandler, autorizar: Autorizar, clienteUsuario: ClientePorUsuario, avisos: AvisosPeticionRol): Router {
  const rutas = Router();
  const cliente = (token: string | undefined) => clienteUsuario(token ?? "");
  const conSesion = [sinCache, autenticar, autorizar()];
  const soloAdministrador = [sinCache, autenticar, autorizar("administrador")];

  rutas.get("/cuenta/peticiones-rol", ...conSesion, (req, res, siguiente) => {
    llamarFuncion(cliente(req.usuario?.token), "mis_peticiones_rol", {})
      .then((r) => res.json({ datos: peticionPropia.array().parse(r) }))
      .catch(siguiente);
  });

  rutas.post("/cuenta/peticiones-rol", ...conSesion, validar({ body: cuerpoPedirRol }), (req, res, siguiente) => {
    const c = req.body as z.infer<typeof cuerpoPedirRol>;
    llamarFuncion(cliente(req.usuario?.token), "pedir_rol", { rol: c.rol, motivo: c.motivo, zona: c.zona ?? null })
      .then((r) => {
        const peticion = peticionPropia.parse(r);
        res.status(201).json(peticion);
        void avisos.avisar(peticion.id, "nueva");
      })
      .catch(siguiente);
  });

  rutas.post("/cuenta/peticiones-rol/:id/cancelar", ...conSesion, validar({ params: parametrosPeticion }), (req, res, siguiente) => {
    const { id } = req.params as z.infer<typeof parametrosPeticion>;
    llamarFuncion(cliente(req.usuario?.token), "cancelar_peticion_rol", { peticion_id: id })
      .then((r) => res.json(peticionPropia.parse(r)))
      .catch(siguiente);
  });

  rutas.get("/admin/peticiones-rol", ...soloAdministrador, (req, res, siguiente) => {
    llamarFuncion(cliente(req.usuario?.token), "listar_peticiones_rol", {})
      .then((r) => res.json({ datos: peticionAdmin.array().parse(r) }))
      .catch(siguiente);
  });

  rutas.patch("/admin/peticiones-rol/:id", ...soloAdministrador, validar({ params: parametrosPeticion, body: cuerpoResolverPeticion }), (req, res, siguiente) => {
    const { id } = req.params as z.infer<typeof parametrosPeticion>;
    const c = req.body as z.infer<typeof cuerpoResolverPeticion>;
    llamarFuncion(cliente(req.usuario?.token), "resolver_peticion_rol", { peticion_id: id, aprobar: c.aprobar, respuesta: c.respuesta ?? null })
      .then((r) => {
        const peticion = peticionAdmin.parse(r);
        res.json(peticion);
        void avisos.avisar(peticion.id, "resuelta");
      })
      .catch(siguiente);
  });

  return rutas;
}
