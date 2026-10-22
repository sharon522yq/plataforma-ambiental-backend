import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ROLES, type Rol } from "./sesion.js";

export interface Perfil {
  rol: Rol;
  activo: boolean;
}

export interface LectorPerfiles {
  /** Devuelve el perfil del usuario o null si no existe. */
  obtener(id: string): Promise<Perfil | null>;
}

const esquemaPerfil = z.object({ rol: z.enum(ROLES), activo: z.boolean() }).nullable();

/**
 * Lee el rol desde perfiles con el cliente de servicio (D-18). El rol nunca se toma del token:
 * así un cambio de rol o una desactivación aplican en la siguiente solicitud.
 */
export function crearLectorPerfiles(servicio: SupabaseClient): LectorPerfiles {
  return {
    async obtener(id) {
      const { data, error } = await servicio.from("perfiles").select("rol, activo").eq("id", id).maybeSingle();
      if (error) throw new Error("No se pudo leer el perfil");
      return esquemaPerfil.parse(data);
    },
  };
}
