import { Router, type RequestHandler } from "express";
import type { z } from "zod";
import { sinCache } from "../../compartido/cache.js";
import { llamarFuncion } from "../../compartido/consultas.js";
import type { Autorizar } from "../../middleware/autorizar.js";
import { validar } from "../../middleware/validar.js";
import type { ClientePorUsuario } from "../aportes/rutas.js";
import type { AvisosMensajes } from "./avisos.js";
import {
  conversacion,
  cuerpoDenuncia,
  cuerpoMensaje,
  cuerpoRevisarDenuncia,
  denunciaHilo,
  denunciaRevisada,
  escrito,
  hilo,
  parametrosDenuncia,
  parametrosHilo,
  parametrosPunto,
} from "./esquemas.js";

/**
 * Mensajes entre personas sobre un punto publicado (migración 016, D-46). Todo corre con la
 * sesión del usuario: las funciones de la base deciden quién lee y quién escribe. El aviso por
 * correo sale sin hacer esperar la respuesta.
 */
export function crearRutasMensajes(autenticar: RequestHandler, autorizar: Autorizar, clienteUsuario: ClientePorUsuario, avisos: AvisosMensajes): Router {
  const rutas = Router();
  const cliente = (token: string | undefined) => clienteUsuario(token ?? "");
  const conSesion = [sinCache, autenticar, autorizar()];
  const moderacion = [sinCache, autenticar, autorizar("moderador", "administrador")];

  rutas.post("/puntos/:id/mensajes", ...conSesion, validar({ params: parametrosPunto, body: cuerpoMensaje }), (req, res, siguiente) => {
    const { id } = req.params as z.infer<typeof parametrosPunto>;
    const { texto } = req.body as z.infer<typeof cuerpoMensaje>;
    llamarFuncion(cliente(req.usuario?.token), "escribir_sobre_punto", { punto_id: id, texto })
      .then((r) => {
        const e = escrito.parse(r);
        res.status(201).json(e);
        void avisos.avisar(e.mensaje.id);
      })
      .catch(siguiente);
  });

  rutas.get("/mensajes", ...conSesion, (req, res, siguiente) => {
    llamarFuncion(cliente(req.usuario?.token), "mis_hilos", {})
      .then((r) => res.json({ datos: hilo.array().parse(r) }))
      .catch(siguiente);
  });

  rutas.get("/mensajes/:id", ...conSesion, validar({ params: parametrosHilo }), (req, res, siguiente) => {
    const { id } = req.params as z.infer<typeof parametrosHilo>;
    llamarFuncion(cliente(req.usuario?.token), "leer_hilo", { hilo_id: id })
      .then((r) => res.json(conversacion.parse(r)))
      .catch(siguiente);
  });

  rutas.post("/mensajes/:id", ...conSesion, validar({ params: parametrosHilo, body: cuerpoMensaje }), (req, res, siguiente) => {
    const { id } = req.params as z.infer<typeof parametrosHilo>;
    const { texto } = req.body as z.infer<typeof cuerpoMensaje>;
    llamarFuncion(cliente(req.usuario?.token), "responder_hilo", { hilo_id: id, texto })
      .then((r) => {
        const e = escrito.parse(r);
        res.status(201).json(e);
        void avisos.avisar(e.mensaje.id);
      })
      .catch(siguiente);
  });

  for (const [accion, funcion] of [["cerrar", "cerrar_hilo"], ["reabrir", "reabrir_hilo"]] as const) {
    rutas.post(`/mensajes/:id/${accion}`, ...conSesion, validar({ params: parametrosHilo }), (req, res, siguiente) => {
      const { id } = req.params as z.infer<typeof parametrosHilo>;
      llamarFuncion(cliente(req.usuario?.token), funcion, { hilo_id: id })
        .then((r) => res.json(hilo.parse(r)))
        .catch(siguiente);
    });
  }

  rutas.post("/mensajes/:id/denunciar", ...conSesion, validar({ params: parametrosHilo, body: cuerpoDenuncia }), (req, res, siguiente) => {
    const { id } = req.params as z.infer<typeof parametrosHilo>;
    const { motivo } = req.body as z.infer<typeof cuerpoDenuncia>;
    llamarFuncion(cliente(req.usuario?.token), "denunciar_hilo", { hilo_id: id, motivo })
      .then((r) => res.json(hilo.parse(r)))
      .catch(siguiente);
  });

  rutas.get("/admin/denuncias-mensajes", ...moderacion, (req, res, siguiente) => {
    llamarFuncion(cliente(req.usuario?.token), "listar_denuncias_hilos", {})
      .then((r) => res.json({ datos: denunciaHilo.array().parse(r) }))
      .catch(siguiente);
  });

  rutas.patch("/admin/denuncias-mensajes/:id", ...moderacion, validar({ params: parametrosDenuncia, body: cuerpoRevisarDenuncia }), (req, res, siguiente) => {
    const { id } = req.params as z.infer<typeof parametrosDenuncia>;
    const { nota } = req.body as z.infer<typeof cuerpoRevisarDenuncia>;
    llamarFuncion(cliente(req.usuario?.token), "revisar_denuncia_hilo", { denuncia_id: id, nota: nota ?? null })
      .then((r) => res.json(denunciaRevisada.parse(r)))
      .catch(siguiente);
  });

  return rutas;
}
