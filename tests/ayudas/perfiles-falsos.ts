import type { LectorPerfiles, Perfil } from "../../src/compartido/perfiles.js";

/** Lector en memoria: id de usuario → perfil. Un Error simula que la base falla. */
export function perfilesFalsos(tabla: Record<string, Perfil> | Error): LectorPerfiles {
  return {
    obtener: (id) => (tabla instanceof Error ? Promise.reject(tabla) : Promise.resolve(tabla[id] ?? null)),
  };
}
