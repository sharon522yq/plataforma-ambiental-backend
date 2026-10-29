import { Router } from "express";
import { cachePublica } from "../../compartido/cache.js";

/**
 * GET /configuracion-publica: lo que el navegador necesita para iniciar sesión con Supabase Auth (D-39).
 * La llave anon es pública por diseño: solo permite lo que dejan las políticas RLS. Nunca se agregan
 * aquí la llave de servicio, el secreto JWT ni la llave de Gemini.
 */
export function crearRutasConfiguracion(publica: { supabaseUrl: string; supabaseAnonKey: string }): Router {
  const rutas = Router();
  rutas.get("/", cachePublica, (_req, res) => {
    res.json({ supabase_url: publica.supabaseUrl, supabase_anon_key: publica.supabaseAnonKey });
  });
  return rutas;
}
