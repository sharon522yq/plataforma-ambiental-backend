import type { SupabaseClient } from "@supabase/supabase-js";

export interface LlamadaRpc {
  nombre: string;
  parametros: Record<string, unknown>;
}

type Respuesta = { data: unknown; error: { code: string; message: string; hint?: string } | null };

/**
 * Cliente falso que solo implementa rpc(). `respuestas` asigna una respuesta por función;
 * también registra cada llamada para revisar los parámetros enviados.
 */
export function rpcFalso(respuestas: Record<string, Respuesta>) {
  const llamadas: LlamadaRpc[] = [];
  const cliente = {
    rpc: (nombre: string, parametros: Record<string, unknown>) => {
      llamadas.push({ nombre, parametros });
      return Promise.resolve(respuestas[nombre] ?? { data: null, error: { code: "42883", message: "función inexistente" } });
    },
  };
  return { cliente: cliente as unknown as SupabaseClient, llamadas };
}

export const ok = (data: unknown): Respuesta => ({ data, error: null });
