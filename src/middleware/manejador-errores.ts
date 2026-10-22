import type { ErrorRequestHandler } from "express";
import { ErrorAplicacion } from "../compartido/errores.js";
import { registrar } from "../compartido/registro.js";

/** Respuesta de error uniforme. Nunca expone stack traces ni detalles técnicos en 500. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const manejadorErrores: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ErrorAplicacion) {
    res.status(err.estado).json({
      error: { codigo: err.codigo, mensaje: err.message, detalles: err.detalles },
    });
    return;
  }
  const esJsonInvalido = err instanceof SyntaxError && "body" in err;
  if (esJsonInvalido) {
    res.status(400).json({
      error: { codigo: "SOLICITUD_INVALIDA", mensaje: "El cuerpo JSON no es válido", detalles: [] },
    });
    return;
  }
  registrar("error", "error_no_controlado", { ruta: req.path, metodo: req.method });
  res.status(500).json({
    error: { codigo: "ERROR_INTERNO", mensaje: "Ocurrió un error interno", detalles: [] },
  });
};
