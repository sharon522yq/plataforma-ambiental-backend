import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { SolicitudInvalida } from "./errores.js";

/** Código de PostgreSQL que usan nuestras funciones para parámetros fuera de rango. */
const PARAMETRO_INVALIDO = "22023";

/**
 * Llama una función de consulta de la base (RPC) y devuelve su resultado JSON.
 * Un parámetro rechazado por la función se responde como 400; cualquier otro fallo
 * se lanza sin detalles para que el manejador responda 500.
 */
export async function llamarFuncion(cliente: SupabaseClient, nombre: string, parametros: Record<string, unknown>): Promise<unknown> {
  const respuesta = await cliente.rpc(nombre, parametros);
  const { error } = respuesta;
  const datos: unknown = respuesta.data;
  if (error) {
    if (error.code === PARAMETRO_INVALIDO) throw new SolicitudInvalida(error.message);
    throw new Error(`Falló la consulta ${nombre}`);
  }
  return datos;
}

// ---------------------------------------------------------------------------
// Paginación: ?pagina&limite, con límite máximo de 100.
// ---------------------------------------------------------------------------
export const esquemaPaginacion = z.object({
  pagina: z.coerce.number().int().min(1).max(10000).default(1),
  limite: z.coerce.number().int().min(1).max(100).default(20),
});
export type Paginacion = z.infer<typeof esquemaPaginacion>;

export interface Pagina<T> {
  datos: T[];
  paginacion: { pagina: number; limite: number; total: number; paginas: number };
}

export function desplazamiento({ pagina, limite }: Paginacion): number {
  return (pagina - 1) * limite;
}

/** Valida la respuesta { total, datos } de una función de listado y arma la página. */
export function armarPagina<T>(respuesta: unknown, elemento: z.ZodType<T, z.ZodTypeDef, unknown>, paginacion: Paginacion): Pagina<T> {
  const { total, datos } = z.object({ total: z.number().int().min(0), datos: z.array(elemento) }).parse(respuesta);
  return {
    datos,
    paginacion: { ...paginacion, total, paginas: Math.ceil(total / paginacion.limite) },
  };
}
