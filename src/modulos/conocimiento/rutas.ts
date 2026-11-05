import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { sinCache } from "../../compartido/cache.js";
import { armarPagina, desplazamiento, esquemaPaginacion, llamarFuncion } from "../../compartido/consultas.js";
import { enlaceSeguro } from "../../compartido/enlaces.js";
import type { Autorizar } from "../../middleware/autorizar.js";
import { validar } from "../../middleware/validar.js";
import type { ModeloEmbeddings } from "../agente/embeddings.js";
import type { ClientePorUsuario } from "../aportes/rutas.js";
import { fragmentar } from "./fragmentar.js";

export const cuerpoDocumento = z.object({
  titulo: z.string().trim().min(3).max(200),
  /** Quién publica la información: «PROFEPA», «SEMARNAT», «Gobierno de Jalisco»… */
  fuente: z.string().trim().min(2).max(200),
  enlace: enlaceSeguro.optional(),
  fecha_fuente: z.iso.date().optional(),
  /**
   * Texto del documento, copiado de la fuente. Con 40 000 caracteres salen a lo más unos 70
   * fragmentos; la base acepta hasta 200 (guardar_documento_conocimiento).
   */
  texto: z.string().trim().min(50).max(40_000),
}).strict();

const parametrosDocumento = z.object({ id: z.uuid() });
const cuerpoEstado = z.object({ activo: z.boolean() }).strict();

export const documento = z.object({
  id: z.uuid(),
  titulo: z.string(),
  fuente: z.string(),
  enlace: z.string().nullable(),
  fecha_fuente: z.string().nullable(),
  activo: z.boolean(),
  fragmentos: z.number().int(),
  modelo: z.string().nullable(),
  creado_en: z.string(),
  actualizado_en: z.string(),
});

/**
 * Base de conocimiento del asistente (F14). Editor y administrador cargan documentos: el
 * servidor los parte, calcula los embeddings con Gemini y los guarda con la sesión del usuario
 * (la base vuelve a revisar el rol). Un documento inactivo deja de usarse en las respuestas.
 */
export function crearRutasConocimiento(
  autenticar: RequestHandler,
  autorizar: Autorizar,
  clienteUsuario: ClientePorUsuario,
  embeddings: ModeloEmbeddings,
): Router {
  const rutas = Router();
  const cliente = (token: string | undefined) => clienteUsuario(token ?? "");
  const personal = [sinCache, autenticar, autorizar("editor", "administrador")];

  rutas.get("/conocimiento", ...personal, validar({ query: esquemaPaginacion }), (req, res, siguiente) => {
    const q = req.query as unknown as z.infer<typeof esquemaPaginacion>;
    llamarFuncion(cliente(req.usuario?.token), "listar_documentos_conocimiento", { limite: q.limite, desplazamiento: desplazamiento(q) })
      .then((r) => res.json(armarPagina(r, documento, q)))
      .catch(siguiente);
  });

  rutas.post("/conocimiento", ...personal, validar({ body: cuerpoDocumento }), (req, res, siguiente) => {
    const d = req.body as z.infer<typeof cuerpoDocumento>;
    const partes = fragmentar(d.texto);
    // El título va con cada fragmento al calcular el embedding: mejora la búsqueda.
    embeddings
      .embeber(partes.map((p) => `${d.titulo}\n\n${p}`), "documento")
      .then((vectores) =>
        llamarFuncion(cliente(req.usuario?.token), "guardar_documento_conocimiento", {
          titulo: d.titulo,
          fuente: d.fuente,
          enlace: d.enlace ?? null,
          fecha_fuente: d.fecha_fuente ?? null,
          modelo: embeddings.modelo,
          fragmentos: partes.map((texto, i) => ({ texto, embedding: vectores[i] })),
        }),
      )
      .then((r) => res.status(201).json(documento.parse(r)))
      .catch(siguiente);
  });

  rutas.patch("/conocimiento/:id", ...personal, validar({ params: parametrosDocumento, body: cuerpoEstado }), (req, res, siguiente) => {
    const { id } = req.params as z.infer<typeof parametrosDocumento>;
    const { activo } = req.body as z.infer<typeof cuerpoEstado>;
    llamarFuncion(cliente(req.usuario?.token), "cambiar_estado_documento", { documento_id: id, activo })
      .then((r) => res.json(documento.parse(r)))
      .catch(siguiente);
  });

  return rutas;
}
