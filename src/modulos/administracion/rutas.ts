import { Router, type RequestHandler } from "express";
import type { z } from "zod";
import { sinCache } from "../../compartido/cache.js";
import { armarPagina, desplazamiento, llamarFuncion } from "../../compartido/consultas.js";
import { Prohibido } from "../../compartido/errores.js";
import type { Autorizar } from "../../middleware/autorizar.js";
import { validar } from "../../middleware/validar.js";
import type { ClientePorUsuario } from "../aportes/rutas.js";
import {
  accionAdmin,
  consultaAuditoria,
  consultaUsuarios,
  cuerpoNuevaAccion,
  cuerpoNuevaOrganizacion,
  cuerpoRol,
  organizacionAdmin,
  parametrosUsuario,
  registroAuditoria,
  usuarioAdmin,
  usuarioRolCambiado,
} from "./esquemas.js";

/**
 * Administración (fase 7). Catálogo: editor y administrador. Usuarios, roles y auditoría:
 * solo administrador. Corre con la sesión del usuario (RLS) y la auditoría la registran
 * los triggers de la migración 010.
 */
export function crearRutasAdministracion(autenticar: RequestHandler, autorizar: Autorizar, clienteUsuario: ClientePorUsuario): Router {
  const rutas = Router();
  const cliente = (token: string | undefined) => clienteUsuario(token ?? "");
  const catalogo = [sinCache, autenticar, autorizar("editor", "administrador")];
  const soloAdministrador = [sinCache, autenticar, autorizar("administrador")];

  rutas.post("/acciones", ...catalogo, validar({ body: cuerpoNuevaAccion }), (req, res, siguiente) => {
    const c = req.body as z.infer<typeof cuerpoNuevaAccion>;
    llamarFuncion(cliente(req.usuario?.token), "crear_accion", {
      tipo: c.tipo,
      nombre: c.nombre,
      descripcion: c.descripcion ?? null,
      enlace: c.enlace ?? null,
      organizacion_id: c.organizacion_id ?? null,
      punto_id: c.punto_id ?? null,
    })
      .then((r) => res.status(201).json(accionAdmin.parse(r)))
      .catch(siguiente);
  });

  rutas.post("/organizaciones", ...catalogo, validar({ body: cuerpoNuevaOrganizacion }), (req, res, siguiente) => {
    const c = req.body as z.infer<typeof cuerpoNuevaOrganizacion>;
    llamarFuncion(cliente(req.usuario?.token), "crear_organizacion", {
      nombre: c.nombre,
      contacto: c.contacto ?? null,
      zona: c.zona ?? null,
    })
      .then((r) => res.status(201).json(organizacionAdmin.parse(r)))
      .catch(siguiente);
  });

  rutas.get("/usuarios", ...soloAdministrador, validar({ query: consultaUsuarios }), (req, res, siguiente) => {
    const q = req.query as unknown as z.infer<typeof consultaUsuarios>;
    llamarFuncion(cliente(req.usuario?.token), "listar_usuarios", {
      rol_filtro: q.rol ?? null,
      busqueda: q.busqueda ?? null,
      limite: q.limite,
      desplazamiento: desplazamiento(q),
    })
      .then((r) => res.json(armarPagina(r, usuarioAdmin, { pagina: q.pagina, limite: q.limite })))
      .catch(siguiente);
  });

  rutas.patch("/usuarios/:id/rol", ...soloAdministrador, validar({ params: parametrosUsuario, body: cuerpoRol }), (req, res, siguiente) => {
    const { id } = req.params as z.infer<typeof parametrosUsuario>;
    const { rol } = req.body as z.infer<typeof cuerpoRol>;
    // La base también lo impide (trigger de la 010); aquí se responde sin llegar a ella.
    if (id === req.usuario?.id) {
      siguiente(new Prohibido("No puedes cambiar tu propio rol"));
      return;
    }
    llamarFuncion(cliente(req.usuario?.token), "cambiar_rol", { usuario_id: id, rol })
      .then((r) => res.json(usuarioRolCambiado.parse(r)))
      .catch(siguiente);
  });

  rutas.get("/auditoria", ...soloAdministrador, validar({ query: consultaAuditoria }), (req, res, siguiente) => {
    const q = req.query as unknown as z.infer<typeof consultaAuditoria>;
    llamarFuncion(cliente(req.usuario?.token), "listar_auditoria", {
      tabla_filtro: q.tabla ?? null,
      accion_filtro: q.accion ?? null,
      usuario_filtro: q.usuario_id ?? null,
      registro_filtro: q.registro_id ?? null,
      desde: q.desde ?? null,
      hasta: q.hasta ?? null,
      limite: q.limite,
      desplazamiento: desplazamiento(q),
    })
      .then((r) => res.json(armarPagina(r, registroAuditoria, { pagina: q.pagina, limite: q.limite })))
      .catch(siguiente);
  });

  return rutas;
}
