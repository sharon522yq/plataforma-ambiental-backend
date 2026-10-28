import type { Request } from "express";
import { rateLimit } from "express-rate-limit";

interface OpcionesLimitador {
  /** Solicitudes permitidas por minuto por IP. */
  porMinuto: number;
  mensaje: string;
  /** Solicitudes que no cuentan (p. ej. el health check de Render). */
  omitir?: (req: Request) => boolean;
}

/**
 * Límite por IP en una ventana de un minuto, con la respuesta de error uniforme (429).
 * La IP real detrás de un proxy depende de PROXIES_DE_CONFIANZA (D-32).
 * El conteo vive en memoria: alcanza para una sola instancia, como en el plan gratuito de Render.
 */
export function crearLimitador({ porMinuto, mensaje, omitir }: OpcionesLimitador) {
  return rateLimit({
    windowMs: 60_000,
    limit: porMinuto,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    ...(omitir ? { skip: omitir } : {}),
    handler: (_req, res) => {
      res.status(429).json({ error: { codigo: "LIMITE_EXCEDIDO", mensaje, detalles: [] } });
    },
  });
}
