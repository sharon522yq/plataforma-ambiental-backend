import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Imita la cadena de consulta de supabase-js:
 * from().select().limit().abortSignal() y luego await.
 * Si `resultado` es un Error, la consulta falla lanzando ese error.
 */
export function clienteFalso(resultado: { error: { message: string } | null } | Error): SupabaseClient {
  const consulta: Record<string, unknown> = {};
  for (const metodo of ["select", "limit", "abortSignal"]) {
    consulta[metodo] = () => consulta;
  }
  consulta.then = (ok: (v: unknown) => unknown, fallo: (e: unknown) => unknown) =>
    (resultado instanceof Error ? Promise.reject(resultado) : Promise.resolve(resultado)).then(ok, fallo);

  const cliente = { from: () => consulta };
  return cliente as unknown as SupabaseClient;
}
