import type { RequestHandler } from "express";

/**
 * Para rutas públicas que aprovechan la sesión si existe: sin cabecera Authorization sigue
 * como visitante; con cabecera, la valida igual que autenticar (un token inválido es 401).
 */
export function crearAutenticarOpcional(autenticar: RequestHandler): RequestHandler {
  return (req, res, siguiente) => {
    if (!req.get("authorization")) {
      siguiente();
      return;
    }
    autenticar(req, res, siguiente);
  };
}
