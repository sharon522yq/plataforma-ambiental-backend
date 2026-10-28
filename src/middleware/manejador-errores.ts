import type { ErrorRequestHandler } from "express";
import { ErrorAplicacion } from "../compartido/errores.js";
import { registrar } from "../compartido/registro.js";

/** Errores del lector de JSON (body-parser) que son culpa del cliente, por su `type`. */
const ERRORES_DEL_CUERPO: Record<string, { estado: number; codigo: string; mensaje: string }> = {
  "entity.parse.failed": { estado: 400, codigo: "SOLICITUD_INVALIDA", mensaje: "El cuerpo JSON no es válido" },
  "entity.too.large": { estado: 413, codigo: "SOLICITUD_DEMASIADO_GRANDE", mensaje: "El cuerpo de la solicitud supera 100 KB" },
  "charset.unsupported": { estado: 415, codigo: "FORMATO_NO_SOPORTADO", mensaje: "Usa JSON en UTF-8" },
  "encoding.unsupported": { estado: 415, codigo: "FORMATO_NO_SOPORTADO", mensaje: "Codificación de contenido no soportada" },
  "request.aborted": { estado: 400, codigo: "SOLICITUD_INVALIDA", mensaje: "La solicitud se interrumpió" },
};

const tipoDe = (err: unknown) =>
  typeof err === "object" && err !== null && "type" in err && typeof err.type === "string" ? err.type : undefined;

/** Respuesta de error uniforme. Nunca expone stack traces ni detalles técnicos en 500. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const manejadorErrores: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ErrorAplicacion) {
    res.status(err.estado).json({
      error: { codigo: err.codigo, mensaje: err.message, detalles: err.detalles },
    });
    return;
  }
  const delCuerpo = ERRORES_DEL_CUERPO[tipoDe(err) ?? ""];
  if (delCuerpo) {
    res.status(delCuerpo.estado).json({ error: { codigo: delCuerpo.codigo, mensaje: delCuerpo.mensaje, detalles: [] } });
    return;
  }
  const id = typeof res.locals.idSolicitud === "string" ? res.locals.idSolicitud : "";
  registrar("error", "error_no_controlado", { ruta: req.path, metodo: req.method, id });
  res.status(500).json({
    error: { codigo: "ERROR_INTERNO", mensaje: "Ocurrió un error interno", detalles: [] },
  });
};
