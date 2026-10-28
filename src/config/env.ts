import "dotenv/config";
import { z } from "zod";

const esquema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().positive().default(3000),
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1),
  DATABASE_URL: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODELO: z.string().default("gemini-2.5-flash"),
  CORS_ORIGENES: z
    .string()
    .transform((v) => v.split(",").map((o) => o.trim()).filter(Boolean)),
  LIMITE_SOLICITUDES_POR_MINUTO: z.coerce.number().int().positive().default(60),
  LIMITE_AGENTE_POR_MINUTO: z.coerce.number().int().positive().default(10),
  /** Cuántos proxies hay delante del servidor (Render: 1). En la PC, 0. */
  PROXIES_DE_CONFIANZA: z.coerce.number().int().min(0).max(3).default(0),
});

export type Entorno = z.infer<typeof esquema>;

/** Valida el entorno. Si falta una variable obligatoria, lanza un error que indica cuál. */
export function cargarEntorno(fuente: NodeJS.ProcessEnv = process.env): Entorno {
  // Una línea como `PORT=` en .env llega como "". Se trata igual que una variable ausente,
  // para que aplique su valor por defecto en lugar de convertirse en 0.
  const sinVacias = Object.fromEntries(
    Object.entries(fuente).filter(([, valor]) => valor !== undefined && valor.trim() !== ""),
  );
  const resultado = esquema.safeParse(sinVacias);
  if (!resultado.success) {
    const faltantes = resultado.error.issues.map(
      (i) => `${i.path.join(".")} (${i.message})`,
    );
    throw new Error(`Configuración inválida. Revisa: ${faltantes.join(", ")}`);
  }
  return resultado.data;
}
