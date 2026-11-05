import { afterEach, describe, expect, it, vi } from "vitest";
import { crearGemini, INSTRUCCIONES_HERRAMIENTAS, INSTRUCCIONES_SISTEMA } from "../../src/modulos/agente/gemini.js";
import { DECLARACIONES } from "../../src/modulos/agente/herramientas.js";

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

describe("crearGemini().paso", () => {
  const espia = vi.spyOn(console, "error").mockImplementation(() => undefined);
  afterEach(() => espia.mockClear());
  const pregunta = [{ role: "user" as const, parts: [{ text: "¿Qué hay cerca?" }] }];
  const cuerpoDe = (init: RequestInit | undefined) => JSON.parse(typeof init?.body === "string" ? init.body : "") as Record<string, unknown>;

  it("envía herramientas en modo AUTO y devuelve las llamadas con el turno intacto (firmas incluidas)", async () => {
    const partes = [
      { text: "pensando", thought: true },
      { functionCall: { name: "buscar_puntos", args: { cerca_de_mi: true }, id: "c1" }, thoughtSignature: "firma" },
      { functionCall: { name: "buscar_acciones" } },
    ];
    const { f, llamadas } = fetchFalso(json({ candidates: [{ content: { role: "model", parts: partes }, finishReason: "STOP" }] }));
    const r = await crearGemini({ llave: LLAVE, modelo: "m", fetch: f }).paso(pregunta, DECLARACIONES);
    expect(r.llamadas).toEqual([
      { nombre: "buscar_puntos", argumentos: { cerca_de_mi: true } },
      { nombre: "buscar_acciones", argumentos: {} },
    ]);
    expect(r.texto).toBe("");
    expect(r.contenido).toEqual({ role: "model", parts: partes });
    const cuerpo = cuerpoDe(llamadas[0]?.init);
    expect(cuerpo).toMatchObject({
      systemInstruction: { parts: [{ text: `${INSTRUCCIONES_SISTEMA} ${INSTRUCCIONES_HERRAMIENTAS}` }] },
      contents: pregunta,
      tools: [{ functionDeclarations: DECLARACIONES }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    });
  });

  it("con sinHerramientas pide modo NONE y devuelve el texto sin el razonamiento", async () => {
    const { f, llamadas } = fetchFalso(json({ candidates: [{ content: { parts: [{ text: "oculto", thought: true }, { text: " Hay 2 puntos. " }] } }] }));
    const r = await crearGemini({ llave: LLAVE, modelo: "m", fetch: f }).paso(pregunta, DECLARACIONES, { sinHerramientas: true });
    expect(r).toMatchObject({ texto: "Hay 2 puntos.", llamadas: [] });
    expect(cuerpoDe(llamadas[0]?.init)).toMatchObject({ toolConfig: { functionCallingConfig: { mode: "NONE" } } });
  });

  it("503 si no hay texto ni llamadas, 422 si se cortó por seguridad", async () => {
    const vacio = json({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] });
    await expect(crearGemini({ llave: LLAVE, modelo: "m", fetch: fetchFalso(vacio).f }).paso(pregunta, [])).rejects.toMatchObject({ estado: 503 });
    const seguridad = json({ candidates: [{ finishReason: "SAFETY" }] });
    await expect(crearGemini({ llave: LLAVE, modelo: "m", fetch: fetchFalso(seguridad).f }).paso(pregunta, [])).rejects.toMatchObject({ estado: 422 });
  });

  it("503 si Google no devuelve candidatos", async () => {
    await expect(crearGemini({ llave: LLAVE, modelo: "m", fetch: fetchFalso(json({})).f }).paso(pregunta, [])).rejects.toMatchObject({ estado: 503 });
  });

  it("expone el nombre del modelo", () => {
    expect(crearGemini({ llave: LLAVE, modelo: "gemini-x" }).modelo).toBe("gemini-x");
  });
});
