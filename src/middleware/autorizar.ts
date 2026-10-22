import type { RequestHandler } from "express";
import { NoAutenticado, Prohibido } from "../compartido/errores.js";
import type { LectorPerfiles } from "../compartido/perfiles.js";
import type { Rol } from "../compartido/sesion.js";

export type Autorizar = (...permitidos: Rol[]) => RequestHandler;

/**
 * autorizar() exige una cuenta activa; autorizar("moderador", "administrador") además exige uno de
 * esos roles. Va después de autenticar. El rol se lee de perfiles en cada solicitud.
 */
export function crearAutorizar(perfiles: LectorPerfiles): Autorizar {
  return (...permitidos) =>
    (req, _res, siguiente) => {
      const usuario = req.usuario;
      if (!usuario) {
        siguiente(new NoAutenticado());
        return;
      }
      perfiles
        .obtener(usuario.id)
        .then((perfil) => {
          if (!perfil?.activo) throw new Prohibido("Tu cuenta no está activa");
          usuario.rol = perfil.rol;
          if (permitidos.length > 0 && !permitidos.includes(perfil.rol)) throw new Prohibido();
          siguiente();
        })
        .catch(siguiente);
    };
}
