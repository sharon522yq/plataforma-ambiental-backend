import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { sinCache } from "../../compartido/cache.js";
import { quitarDatosPersonales } from "../../compartido/privacidad.js";
import { crearLimitador } from "../../middleware/limitador.js";
import { validar } from "../../middleware/validar.js";
import { responder } from "./agente.js";
import type { RegistroConversaciones } from "./conversaciones.js";
import type { ModeloIA } from "./gemini.js";
import type { Herramientas } from "./herramientas.js";

export const cuerpoConsulta = z.object({
  pregunta: z.string().trim().min(3).max(1000),
  /**
   * Ubicación que el usuario decidió compartir («Usar mi ubicación»), para «cerca de mí».
   * Se queda en el servidor: no se manda a Gemini ni se guarda en la conversación.
   */
  ubicacion: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).strict().optional(),
}).strict();

export const AVISO_IA =
  "Respuesta generada por inteligencia artificial. Puede contener errores: verifica con fuentes oficiales.";

interface DependenciasAgente {
  ia: ModeloIA;
  herramientas: Herramientas;
  conversaciones: RegistroConversaciones;
  /** Consultas por minuto por IP (LIMITE_AGENTE_POR_MINUTO). */
  limitePorMinuto: number;
  /** Lee la sesión si viene, sin exigirla. */
  autenticarOpcional: RequestHandler;
}

/**
 * POST /agente/consulta: público. La pregunta se limpia de correos y teléfonos antes de
 * enviarla a Gemini y de guardarla (D-24). Gemini usa herramientas de solo lectura sobre el
 * mapa (F13); si no está disponible, responde el respaldo sin IA.
 */
export function crearRutasAgente({ ia, herramientas, conversaciones, limitePorMinuto, autenticarOpcional }: DependenciasAgente): Router {
  const rutas = Router();
  const limitador = crearLimitador({ porMinuto: limitePorMinuto, mensaje: "Hiciste muchas preguntas seguidas. Espera un minuto." });

  rutas.post("/consulta", sinCache, limitador, autenticarOpcional, validar({ body: cuerpoConsulta }), (req, res, siguiente) => {
    const { pregunta, ubicacion } = req.body as z.infer<typeof cuerpoConsulta>;
    const limpia = quitarDatosPersonales(pregunta);
    responder(ia, herramientas, limpia, { ubicacion: ubicacion ?? null })
      .then(async (r) => {
        const respuesta = quitarDatosPersonales(r.texto);
        await conversaciones.guardar({
          usuario_id: req.usuario?.id ?? null,
          pregunta: limpia,
          respuesta,
          modelo: r.modelo,
          herramientas: r.herramientas,
        });
        res.json({ respuesta, modelo: r.modelo, aviso: AVISO_IA, puntos: r.puntos, respaldo: r.respaldo });
      })
      .catch(siguiente);
  });

  return rutas;
}
