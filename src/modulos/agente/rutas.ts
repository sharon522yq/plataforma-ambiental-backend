import { Router, type RequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { sinCache } from "../../compartido/cache.js";
import { quitarDatosPersonales } from "../../compartido/privacidad.js";
import { validar } from "../../middleware/validar.js";
import type { RegistroConversaciones } from "./conversaciones.js";
import type { ModeloIA } from "./gemini.js";

export const cuerpoConsulta = z.object({
  pregunta: z.string().trim().min(3).max(1000),
}).strict();

export const AVISO_IA =
  "Respuesta generada por inteligencia artificial. Puede contener errores: verifica con fuentes oficiales.";

interface DependenciasAgente {
  ia: ModeloIA;
  conversaciones: RegistroConversaciones;
  /** Consultas por minuto por IP (LIMITE_AGENTE_POR_MINUTO). */
  limitePorMinuto: number;
  /** Lee la sesión si viene, sin exigirla. */
  autenticarOpcional: RequestHandler;
}

/**
 * POST /agente/consulta: público. La pregunta se limpia de correos y teléfonos antes de
 * enviarla a Gemini y de guardarla (D-24). Sin RAG todavía (fase posterior).
 */
export function crearRutasAgente({ ia, conversaciones, limitePorMinuto, autenticarOpcional }: DependenciasAgente): Router {
  const rutas = Router();
  const limitador = rateLimit({
    windowMs: 60_000,
    limit: limitePorMinuto,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: { codigo: "LIMITE_EXCEDIDO", mensaje: "Hiciste muchas preguntas seguidas. Espera un minuto.", detalles: [] },
      });
    },
  });

  rutas.post("/consulta", sinCache, limitador, autenticarOpcional, validar({ body: cuerpoConsulta }), (req, res, siguiente) => {
    const { pregunta } = req.body as z.infer<typeof cuerpoConsulta>;
    const limpia = quitarDatosPersonales(pregunta);
    ia.generar(limpia)
      .then(async ({ texto, modelo }) => {
        const respuesta = quitarDatosPersonales(texto);
        await conversaciones.guardar({ usuario_id: req.usuario?.id ?? null, pregunta: limpia, respuesta, modelo });
        res.json({ respuesta, modelo, aviso: AVISO_IA });
      })
      .catch(siguiente);
  });

  return rutas;
}
