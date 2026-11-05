import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { APROBADOS_MINIMOS, CASOS, evaluarAgente, informe } from "./modulos/agente/evaluacion.js";
import { crearEmbeddings } from "./modulos/agente/embeddings.js";
import { crearGemini } from "./modulos/agente/gemini.js";
import { crearHerramientas } from "./modulos/agente/herramientas.js";

/**
 * npm run evaluar:agente — hace las 20 preguntas de prueba al agente real (Gemini + la base de
 * Supabase con la llave pública) y guarda el informe en docs/evaluaciones/.
 * Gasta cuota de Gemini: unas 40 llamadas (más algunos embeddings). Nunca imprime llaves.
 *
 *   npm run evaluar:agente                  todas las preguntas, 15 s entre una y otra
 *   npm run evaluar:agente -- --limite=3    solo las primeras 3 (prueba rápida)
 *   npm run evaluar:agente -- --pausa=30    más pausa si Google responde 429
 */
const entorno = z
  .object({
    SUPABASE_URL: z.url(),
    SUPABASE_ANON_KEY: z.string().trim().min(1),
    GEMINI_API_KEY: z.string().trim().min(1),
    GEMINI_MODELO: z.string().trim().min(1).default("gemini-2.5-flash"),
    GEMINI_MODELO_EMBEDDINGS: z.string().trim().min(1).default("gemini-embedding-001"),
  })
  .safeParse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v?.trim())));
if (!entorno.success) {
  console.error("Faltan variables en .env: " + [...new Set(entorno.error.issues.map((i) => i.path.join(".")))].join(", "));
  process.exit(1);
}

const argumento = (nombre: string) => process.argv.find((a) => a.startsWith(`--${nombre}=`))?.split("=")[1];
const limite = Math.min(Math.max(Number(argumento("limite") ?? CASOS.length) || CASOS.length, 1), CASOS.length);
const pausaSegundos = Math.min(Math.max(Number(argumento("pausa") ?? 15) || 15, 0), 120);

const { SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_API_KEY, GEMINI_MODELO, GEMINI_MODELO_EMBEDDINGS } = entorno.data;
const publico = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const ia = crearGemini({ llave: GEMINI_API_KEY, modelo: GEMINI_MODELO });
const casos = CASOS.slice(0, limite);

console.log(`Evaluando el agente con ${GEMINI_MODELO}: ${String(casos.length)} preguntas, ${String(pausaSegundos)} s entre cada una.`);
const embeddings = crearEmbeddings({ llave: GEMINI_API_KEY, modelo: GEMINI_MODELO_EMBEDDINGS });
const resultados = await evaluarAgente(ia, crearHerramientas(publico, embeddings), casos, {
  pausaMs: pausaSegundos * 1000,
  alTerminarCaso: (r, i) => {
    const marca = r.fallas.length === 0 ? "OK   " : "FALLA";
    console.log(`${marca} ${String(i + 1).padStart(2)}. ${r.caso.pregunta}`);
    console.log(`        herramientas: ${r.herramientas.join(", ") || "ninguna"} · ${(r.milisegundos / 1000).toFixed(1)} s`);
    for (const f of r.fallas) console.log(`        - ${f}`);
  },
});

const aprobados = resultados.filter((r) => r.fallas.length === 0).length;
const fecha = new Date().toISOString().slice(0, 10);
const carpeta = path.resolve("docs", "evaluaciones");
mkdirSync(carpeta, { recursive: true });
const archivo = path.join(carpeta, `agente-${fecha}.md`);
writeFileSync(archivo, informe(resultados, GEMINI_MODELO, fecha) + "\n");

const minimo = Math.ceil((APROBADOS_MINIMOS / CASOS.length) * casos.length);
console.log(`\nAprobados: ${String(aprobados)} de ${String(casos.length)} (mínimo ${String(minimo)}). Informe: ${path.relative(process.cwd(), archivo)}`);
process.exit(aprobados >= minimo ? 0 : 1);
