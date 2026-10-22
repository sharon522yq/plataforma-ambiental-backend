import { cargarEntorno, type Entorno } from "../../src/config/env.js";

/** Entorno de prueba con valores ficticios. Nunca apunta a un proyecto real. */
export function entornoDePrueba(sobrescribe: Partial<Record<string, string>> = {}): Entorno {
  return cargarEntorno({
    NODE_ENV: "test",
    SUPABASE_URL: "https://proyecto-falso.supabase.co",
    SUPABASE_ANON_KEY: "llave-anon-falsa",
    SUPABASE_SERVICE_ROLE_KEY: "llave-servicio-falsa",
    SUPABASE_JWT_SECRET: "secreto-falso",
    GEMINI_API_KEY: "llave-gemini-falsa",
    CORS_ORIGENES: "http://localhost:5173",
    ...sobrescribe,
  });
}
