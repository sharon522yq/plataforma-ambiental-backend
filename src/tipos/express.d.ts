import type { UsuarioSesion } from "../compartido/sesion.js";

declare global {
  namespace Express {
    interface Request {
      /** Lo llena autenticar.ts cuando el token es válido. */
      usuario?: UsuarioSesion;
    }
  }
}

export {};
