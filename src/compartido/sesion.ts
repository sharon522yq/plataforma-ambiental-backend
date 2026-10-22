/** Roles de la plataforma. Deben coincidir con el check de perfiles.rol (migración 002). */
export const ROLES = ["ciudadano", "moderador", "editor", "administrador"] as const;
export type Rol = (typeof ROLES)[number];

/** Usuario de la solicitud. `rol` solo existe después de autorizar, porque se lee de la base. */
export interface UsuarioSesion {
  id: string;
  token: string;
  rol?: Rol;
}
