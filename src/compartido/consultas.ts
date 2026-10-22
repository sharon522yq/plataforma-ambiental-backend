import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { Conflicto, NoEncontrado, Prohibido, SolicitudInvalida, type ErrorAplicacion } from "./errores.js";

/** Código de PostgreSQL que usan nuestras funciones para parámetros fuera de rango. */
const PARAMETRO_INVALIDO = "22023";

/** Las funciones marcan con este hint los mensajes que se pueden mostrar al usuario. */
const MENSAJE_PUBLICO = "publico";

/** Códigos de PostgreSQL que tienen respuesta HTTP propia. El resto es un 500. */
const ERRORES: Record<string, (mensaje?: string) => ErrorAplicacion> = {
  [PARAMETRO_INVALIDO]: (m) => new SolicitudInvalida(m),
  "23514": () => new SolicitudInvalida(), // violación de un check (p. ej. tipo o gravedad)
  "42501": (m) => new Prohibido(m), // sin permiso o bloqueado por RLS
  P0002: (m) => new NoEncontrado(m),
  "55000": (m) => new Conflicto(m), // estado que no permite la operación
};

/**
 * Llama una función de la base (RPC) y devuelve su resultado JSON.
 * Los errores conocidos se traducen a 400, 403, 404 o 409. El mensaje de la base solo se
 * muestra si la función lo marcó como público (o es un 22023 de nuestras funciones);
 * si no, se usa el mensaje genérico. Cualquier otro fallo se lanza sin detalles (500).
 */
export async function llamarFuncion(cliente: SupabaseClient, nombre: string, parametros: Record<string, unknown>): Promise<unknown> {
  const respuesta = await cliente.rpc(nombre, parametros);
  const { error } = respuesta;
  const datos: unknown = respuesta.data;
  if (error) {
    const traducir = ERRORES[error.code];
    if (!traducir) throw new Error(`Falló la consulta ${nombre}`);
    const publico = error.hint === MENSAJE_PUBLICO || error.code === PARAMETRO_INVALIDO;
    throw traducir(publico ? error.message : undefined);
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
