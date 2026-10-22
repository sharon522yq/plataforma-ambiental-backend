import type { RequestHandler } from "express";
import { NoAutenticado } from "../compartido/errores.js";
import type { VerificadorJwt } from "../config/jwt.js";

const BEARER = /^Bearer\s+(\S+)$/i;

/** Exige `Authorization: Bearer <token>` válido. Si falta o no es válido, responde 401. */
export function crearAutenticar(verificador: VerificadorJwt): RequestHandler {
  return (req, _res, siguiente) => {
    const token = BEARER.exec(req.get("authorization") ?? "")?.[1];
    if (!token) {
      siguiente(new NoAutenticado());
      return;
    }
    verificador
      .verificar(token)
      .then(({ id }) => {
        req.usuario = { id, token };
        siguiente();
      })
      .catch(siguiente);
  };
}
