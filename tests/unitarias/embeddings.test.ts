import { afterEach, describe, expect, it, vi } from "vitest";
import { crearEmbeddings, DIMENSIONES, normalizar } from "../../src/modulos/agente/embeddings.js";

const LLAVE = "llave-secreta-de-prueba";
const json = (cuerpo: unknown, estado = 200) => new Response(JSON.stringify(cuerpo), { status: estado, headers: { "content-type": "application/json" } });
const vector = (x: number) => Array.from({ length: DIMENSIONES }, () => x);

/** Responde un embedding por cada texto pedido y guarda los cuerpos enviados. */
function googleFalso(respuesta?: (n: number) => Response | Error) {
  const cuerpos: { url: string; cuerpo: { requests: Record<string, unknown>[] }; cabeceras: Record<string, string> }[] = [];
  const f = vi.fn((url: string | URL, init?: RequestInit) => {
    const cuerpo = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { requests: Record<string, unknown>[] };
    cuerpos.push({ url: url.toString(), cuerpo, cabeceras: init?.headers as Record<string, string> });
    const r = respuesta ? respuesta(cuerpo.requests.length) : json({ embeddings: cuerpo.requests.map(() => ({ values: vector(2) })) });
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  });
  return { f: f as unknown as typeof fetch, cuerpos };
}

describe("normalizar", () => {
  it("deja el vector con longitud 1", () => {
    expect(normalizar([3, 4])).toEqual([0.6, 0.8]);
    expect(() => normalizar([0, 0])).toThrow();
  });
});

describe("crearEmbeddings", () => {
  const espia = vi.spyOn(console, "error").mockImplementation(() => undefined);
  afterEach(() => espia.mockClear());

  it("pide 768 dimensiones con la tarea correcta, la llave en la cabecera, y normaliza", async () => {
    const { f, cuerpos } = googleFalso();
    const e = crearEmbeddings({ llave: LLAVE, modelo: "gemini-embedding-001", fetch: f });
    const [v] = await e.embeber(["hola"], "consulta");
    expect(cuerpos[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents");
    expect(cuerpos[0]?.url).not.toContain(LLAVE);
    expect(cuerpos[0]?.cabeceras["x-goog-api-key"]).toBe(LLAVE);
    expect(cuerpos[0]?.cuerpo.requests[0]).toEqual({
      model: "models/gemini-embedding-001", content: { parts: [{ text: "hola" }] }, taskType: "RETRIEVAL_QUERY", outputDimensionality: 768,
    });
    expect(v).toHaveLength(768);
    expect(Math.hypot(...(v ?? []))).toBeCloseTo(1, 10);
    await e.embeber(["doc"], "documento");
    expect(cuerpos[1]?.cuerpo.requests[0]?.taskType).toBe("RETRIEVAL_DOCUMENT");
    expect(e.modelo).toBe("gemini-embedding-001");
  });

  it("parte en lotes de 100 y conserva el orden", async () => {
    const { f, cuerpos } = googleFalso();
    const textos = Array.from({ length: 230 }, (_, i) => `t${String(i)}`);
    const r = await crearEmbeddings({ llave: LLAVE, modelo: "m", fetch: f }).embeber(textos, "documento");
    expect(cuerpos.map((c) => c.cuerpo.requests.length)).toEqual([100, 100, 30]);
    expect((cuerpos[2]?.cuerpo.requests[29]?.content as { parts: { text: string }[] }).parts[0]?.text).toBe("t229");
    expect(r).toHaveLength(230);
  });

  it.each([
    ["Google responde 429", () => json({ error: { message: `cuota ${LLAVE}` } }, 429)],
    ["no hay conexión", () => new Error(`fetch failed ${LLAVE}`)],
    ["la respuesta no es JSON", () => new Response("<html>")],
    ["faltan embeddings", () => json({ embeddings: [] })],
    ["la dimensión no es 768", (n: number) => json({ embeddings: Array.from({ length: n }, () => ({ values: [1, 2, 3] })) })],
    ["un vector viene en ceros", (n: number) => json({ embeddings: Array.from({ length: n }, () => ({ values: vector(0) })) })],
  ])("503 sin detalles si %s", async (_caso, respuesta) => {
    const { f } = googleFalso(respuesta);
    const promesa = crearEmbeddings({ llave: LLAVE, modelo: "m", fetch: f }).embeber(["x"], "consulta");
    await expect(promesa).rejects.toMatchObject({ estado: 503, codigo: "IA_NO_DISPONIBLE" });
    expect(espia.mock.calls.flat().join(" ")).not.toContain(LLAVE);
  });
});
