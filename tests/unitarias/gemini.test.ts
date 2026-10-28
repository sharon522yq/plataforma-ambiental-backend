import { afterEach, describe, expect, it, vi } from "vitest";
import { crearGemini, INSTRUCCIONES_SISTEMA } from "../../src/modulos/agente/gemini.js";

const LLAVE = "llave-secreta-de-prueba";

function fetchFalso(respuesta: Response | Error) {
  const llamadas: { url: string; init: RequestInit | undefined }[] = [];
  const f = vi.fn((url: string | URL, init?: RequestInit) => {
    llamadas.push({ url: url.toString(), init });
    return respuesta instanceof Error ? Promise.reject(respuesta) : Promise.resolve(respuesta);
  });
  return { f: f as unknown as typeof fetch, llamadas };
}
const json = (cuerpo: unknown, estado = 200) => new Response(JSON.stringify(cuerpo), { status: estado, headers: { "content-type": "application/json" } });
const conTexto = (...partes: string[]) => json({ candidates: [{ content: { parts: partes.map((text) => ({ text })) }, finishReason: "STOP" }] });

describe("crearGemini().generar", () => {
  const espia = vi.spyOn(console, "error").mockImplementation(() => undefined);
  afterEach(() => espia.mockClear());

  it("envía la pregunta aparte de las instrucciones, con la llave en la cabecera y no en la URL", async () => {
    const { f, llamadas } = fetchFalso(conTexto("Hola, ", "separa tus residuos."));
    const r = await crearGemini({ llave: LLAVE, modelo: "gemini-x", fetch: f }).generar("¿Cómo reciclo?");
    expect(r).toEqual({ texto: "Hola, separa tus residuos.", modelo: "gemini-x" });
    const { url, init } = llamadas[0] ?? { url: "", init: undefined };
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent");
    expect(url).not.toContain(LLAVE);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe(LLAVE);
    const cuerpo = JSON.parse(typeof init?.body === "string" ? init.body : "") as Record<string, unknown>;
    expect(cuerpo).toMatchObject({
      systemInstruction: { parts: [{ text: INSTRUCCIONES_SISTEMA }] },
      contents: [{ role: "user", parts: [{ text: "¿Cómo reciclo?" }] }],
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["Google responde 429", json({ error: { message: `cuota ${LLAVE}` } }, 429)],
    ["Google responde 403 (llave inválida)", json({ error: { message: "API key not valid" } }, 403)],
    ["la respuesta no es JSON", new Response("<html>", { status: 200 })],
    ["la respuesta viene vacía", json({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] })],
    ["no hay conexión", new Error(`fetch failed ${LLAVE}`)],
  ])("503 sin detalles si %s, y el registro no incluye la llave", async (_caso, respuesta) => {
    const { f } = fetchFalso(respuesta);
    const promesa = crearGemini({ llave: LLAVE, modelo: "m", fetch: f }).generar("pregunta");
    await expect(promesa).rejects.toMatchObject({ estado: 503, codigo: "AGENTE_NO_DISPONIBLE" });
    const error: unknown = await promesa.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(LLAVE);
    expect(espia.mock.calls.flat().join(" ")).not.toContain(LLAVE);
    expect(espia.mock.calls.flat().join(" ")).not.toContain("pregunta");
  });

  it.each([
    ["la pregunta fue bloqueada", json({ promptFeedback: { blockReason: "SAFETY" } })],
    ["la respuesta se cortó por seguridad", json({ candidates: [{ finishReason: "SAFETY" }] })],
  ])("422 si %s", async (_caso, respuesta) => {
    const { f } = fetchFalso(respuesta);
    await expect(crearGemini({ llave: LLAVE, modelo: "m", fetch: f }).generar("x")).rejects.toMatchObject({ estado: 422 });
  });
});

describe("crearGemini().comprobar", () => {
  it("consulta el modelo con GET (no genera texto)", async () => {
    const { f, llamadas } = fetchFalso(json({ name: "models/m" }));
    expect(await crearGemini({ llave: LLAVE, modelo: "m", fetch: f }).comprobar()).toBe("ok");
    expect(llamadas[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/m");
    expect(llamadas[0]?.init?.method).toBeUndefined();
  });

  it("no_disponible si Google responde error o no hay conexión", async () => {
    const espia = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await crearGemini({ llave: LLAVE, modelo: "m", fetch: fetchFalso(json({}, 404)).f }).comprobar()).toBe("no_disponible");
    expect(await crearGemini({ llave: LLAVE, modelo: "m", fetch: fetchFalso(new Error("x")).f }).comprobar()).toBe("no_disponible");
    espia.mockRestore();
  });
});
