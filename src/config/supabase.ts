import { createClient } from "@supabase/supabase-js";
import type { Entorno } from "./env.js";

const OPCIONES = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const;

/**
 * Cliente con la llave pública (anon). Respeta RLS.
 * Las lecturas públicas deben usar este cliente: así la base, no el código, decide qué se ve.
 */
export function crearClienteAnon(entorno: Entorno) {
  return createClient(entorno.SUPABASE_URL, entorno.SUPABASE_ANON_KEY, OPCIONES);
}

/**
 * Cliente con la llave de servicio. Omite RLS.
 * SOLO servidor: nunca se envía al cliente ni se registra. Úsalo únicamente
 * cuando la regla de negocio no pueda expresarse con RLS (p. ej. escribir en auditoria).
 */
export function crearClienteServicio(entorno: Entorno) {
  return createClient(entorno.SUPABASE_URL, entorno.SUPABASE_SERVICE_ROLE_KEY, OPCIONES);
}
