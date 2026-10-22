import type { SupabaseClient } from "@supabase/supabase-js";

export type EstadoBase = "ok" | "no_disponible";

const TIEMPO_MAXIMO_MS = 3000;

/**
 * Comprueba que la base responde y que las tablas del modelo existen.
 * Nunca lanza: cualquier fallo se reporta como "no_disponible".
 * Usa una consulta mínima (una fila, sin columnas sensibles).
 */
export async function comprobarBase(cliente: SupabaseClient): Promise<EstadoBase> {
  try {
    const { error } = await cliente
      .from("puntos")
      .select("id")
      .limit(1)
      .abortSignal(AbortSignal.timeout(TIEMPO_MAXIMO_MS));
    return error ? "no_disponible" : "ok";
  } catch {
    return "no_disponible";
  }
}
