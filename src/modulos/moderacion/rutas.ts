import { Router, type RequestHandler } from "express";
import type { z } from "zod";
import { sinCache } from "../../compartido/cache.js";
import { armarPagina, desplazamiento, llamarFuncion } from "../../compartido/consultas.js";
import { quitarDatosPersonales } from "../../compartido/privacidad.js";
import type { Autorizar } from "../../middleware/autorizar.js";
import { validar } from "../../middleware/validar.js";
import { aporteModeracion } from "../aportes/esquemas.js";
import type { ClientePorUsuario } from "../aportes/rutas.js";
import { consultaCola, cuerpoEstadoPunto, cuerpoNuevoPunto, cuerpoRevision, parametrosId, puntoModeracion } from "./esquemas.js";

/**
 * Moderación: cola de aportes, revisión y gestión de puntos. Solo moderador y administrador.
 * Corre con la sesión del usuario, así que las políticas de la base aplican además del rol.
 * La auditoría la registran los triggers de la migración 008.
 */
export function crearRutasModeracion(autenticar: RequestHandler, autorizar: Autorizar, clienteUsuario: ClientePorUsuario): Router {
  const rutas = Router();
  rutas.use(sinCache, autenticar, autorizar("moderador", "administrador"));
  const cliente = (token: string | undefined) => clienteUsuario(token ?? "");

  rutas.get("/aportes", validar({ query: consultaCola }), (req, res, siguiente) => {
    const q = req.query as unknown as z.infer<typeof consultaCola>;
    llamarFuncion(cliente(req.usuario?.token), "cola_aportes", {
      estado_filtro: q.estado,
      limite: q.limite,
      desplazamiento: desplazamiento(q),
    })
      .then((r) => res.json(armarPagina(r, aporteModeracion, { pagina: q.pagina, limite: q.limite })))
      .catch(siguiente);
  });

  rutas.patch("/aportes/:id/revision", validar({ params: parametrosId, body: cuerpoRevision }), (req, res, siguiente) => {
    const { id } = req.params as z.infer<typeof parametrosId>;
    const cuerpo = req.body as z.infer<typeof cuerpoRevision>;
    llamarFuncion(cliente(req.usuario?.token), "revisar_aporte", {
      aporte_id: id,
      decision: cuerpo.decision,
      motivo: cuerpo.motivo ?? null,
      titulo: cuerpo.decision === "aprobado" ? (cuerpo.titulo ?? null) : null,
      gravedad: cuerpo.decision === "aprobado" ? (cuerpo.gravedad ?? null) : null,
      publicar: cuerpo.decision === "aprobado" ? cuerpo.publicar : false,
      duplicado_de: cuerpo.decision === "duplicado" ? cuerpo.duplicado_de : null,
    })
      .then((r) => res.json(aporteModeracion.parse(r)))
      .catch(siguiente);
  });

  rutas.post("/puntos", validar({ body: cuerpoNuevoPunto }), (req, res, siguiente) => {
    const cuerpo = req.body as z.infer<typeof cuerpoNuevoPunto>;
    llamarFuncion(cliente(req.usuario?.token), "crear_punto", {
      titulo: cuerpo.titulo,
      tipo: cuerpo.tipo,
      gravedad: cuerpo.gravedad,
      descripcion: quitarDatosPersonales(cuerpo.descripcion),
      lat: cuerpo.ubicacion.lat,
      lng: cuerpo.ubicacion.lng,
      estado: cuerpo.estado,
    })
      .then((r) => res.status(201).json(puntoModeracion.parse(r)))
      .catch(siguiente);
  });

  rutas.patch("/puntos/:id/estado", validar({ params: parametrosId, body: cuerpoEstadoPunto }), (req, res, siguiente) => {
    const { id } = req.params as z.infer<typeof parametrosId>;
    const { estado } = req.body as z.infer<typeof cuerpoEstadoPunto>;
    llamarFuncion(cliente(req.usuario?.token), "cambiar_estado_punto", { punto_id: id, estado })
      .then((r) => res.json(puntoModeracion.parse(r)))
      .catch(siguiente);
  });

  return rutas;
}
