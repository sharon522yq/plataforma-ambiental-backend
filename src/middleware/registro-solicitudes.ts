import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import { registrar } from "../compartido/registro.js";

/**
 * Da a cada solicitud un identificador (cabecera X-Id-Solicitud) y, al terminar, registra
 * método, ruta, código y duración (sección 5 del prompt). La ruta va sin la query, que puede
 * traer textos de búsqueda; nunca se registran cuerpos, tokens ni cabeceras.
 */
export function crearRegistroSolicitudes(activo: boolean): RequestHandler {
  return (req, res, siguiente) => {
    const id = randomUUID();
    res.locals.idSolicitud = id;
    res.setHeader("X-Id-Solicitud", id);
    if (activo) {
      const inicio = process.hrtime.bigint();
      res.on("finish", () => {
        registrar(res.statusCode >= 500 ? "error" : "info", "solicitud", {
          id,
          metodo: req.method,
          ruta: req.originalUrl.split("?")[0] ?? "",
          estado: res.statusCode,
          ms: Math.round(Number(process.hrtime.bigint() - inicio) / 1e6),
        });
      });
    }
    siguiente();
  };
}
