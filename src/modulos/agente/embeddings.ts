import { z } from "zod";
import { ErrorAplicacion } from "../../compartido/errores.js";
import { registrar } from "../../compartido/registro.js";

const API = "https://generativelanguage.googleapis.com/v1beta";
const TIEMPO_MAXIMO_MS = 30_000;
/** Dimensión de fragmentos.embedding (D-01, migración 013). */
export const DIMENSIONES = 768;
/** Máximo de textos por llamada a batchEmbedContents. */
const POR_LOTE = 100;

export type TareaEmbedding = "documento" | "consulta";

export interface ModeloEmbeddings {
  readonly modelo: string;
  /**
   * Calcula un vector normalizado de 768 dimensiones por texto, en el mismo orden.
   * "documento" para lo que se guarda y "consulta" para lo que se busca.
   * Lanza ErrorAplicacion 503 si Gemini falla.
   */
  embeber(textos: string[], tarea: TareaEmbedding): Promise<number[][]>;
}

const respuestaLote = z.object({ embeddings: z.array(z.object({ values: z.array(z.number()) })) });

/** Escala el vector a longitud 1. Con menos de 3072 dimensiones Gemini no lo normaliza. */
export function normalizar(v: number[]): number[] {
  const largo = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (!Number.isFinite(largo) || largo === 0) throw new Error("vector vacío");
  return v.map((x) => x / largo);
}

const noDisponible = () => new ErrorAplicacion(503, "IA_NO_DISPONIBLE", "El servicio de IA no está disponible, intenta más tarde");

/**
 * Embeddings de Gemini por REST (gemini-embedding-001 por defecto). La llave va en la cabecera,
 * nunca en la URL; los errores se registran solo con el código HTTP.
 */
export function crearEmbeddings({ llave, modelo, fetch: pedir = fetch }: { llave: string; modelo: string; fetch?: typeof fetch }): ModeloEmbeddings {
  const nombre = `models/${modelo}`;
  const url = `${API}/${nombre.split("/").map(encodeURIComponent).join("/")}:batchEmbedContents`;

  async function lote(textos: string[], tarea: TareaEmbedding): Promise<number[][]> {
    let r: Response;
    try {
      r = await pedir(url, {
        method: "POST",
        headers: { "x-goog-api-key": llave, "content-type": "application/json" },
        signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
        body: JSON.stringify({
          requests: textos.map((text) => ({
            model: nombre,
            content: { parts: [{ text }] },
            taskType: tarea === "documento" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY",
            outputDimensionality: DIMENSIONES,
          })),
        }),
      });
    } catch {
      registrar("error", "embeddings_sin_respuesta", {});
      throw noDisponible();
    }
    if (!r.ok) {
      registrar("error", "embeddings_error", { estado: r.status });
      throw noDisponible();
    }
    const datos = respuestaLote.safeParse(await r.json().catch(() => null));
    if (!datos.success || datos.data.embeddings.length !== textos.length || datos.data.embeddings.some((e) => e.values.length !== DIMENSIONES)) {
      registrar("error", "embeddings_respuesta_inesperada", {});
      throw noDisponible();
    }
    try {
      return datos.data.embeddings.map((e) => normalizar(e.values));
    } catch {
      registrar("error", "embeddings_respuesta_inesperada", {});
      throw noDisponible();
    }
  }

  return {
    modelo,
    async embeber(textos, tarea) {
      const vectores: number[][] = [];
      for (let i = 0; i < textos.length; i += POR_LOTE) vectores.push(...(await lote(textos.slice(i, i + POR_LOTE), tarea)));
      return vectores;
    },
  };
}
