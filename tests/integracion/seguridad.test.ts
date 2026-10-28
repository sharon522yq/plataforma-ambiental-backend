import request from "supertest";
import { describe, expect, it } from "vitest";
import { crearApp } from "../../src/app.js";
import { clienteFalso } from "../ayudas/cliente-falso.js";
import { entornoDePrueba } from "../ayudas/entorno.js";
import { conversacionesFalsas, iaFalsa } from "../ayudas/ia-falsa.js";

/** Categoría 5 de la sección 8: cabeceras, CORS, errores sin detalles y límites del cuerpo. */
function app(entorno: Record<string, string> = {}) {
  return crearApp(entornoDePrueba(entorno), {
    publico: clienteFalso({ error: null }),
    ia: iaFalsa().ia,
    conversaciones: conversacionesFalsas().conversaciones,
  });
}
const PERMITIDO = "http://localhost:5173";
const forma = { error: { codigo: expect.any(String) as unknown, mensaje: expect.any(String) as unknown, detalles: expect.any(Array) as unknown } };

describe("cabeceras de seguridad (helmet)", () => {
  it("están presentes y no se anuncia Express", async () => {
    const r = await request(app()).get("/api/v1/salud");
    expect(r.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "strict-transport-security": expect.stringContaining("max-age=") as unknown,
      "content-security-policy": expect.stringContaining("default-src 'self'") as unknown,
      "cross-origin-opener-policy": "same-origin",
      "referrer-policy": "no-referrer",
    });
    expect(r.headers["x-powered-by"]).toBeUndefined();
  });

  it("cada respuesta lleva un identificador de solicitud distinto", async () => {
    const a = app();
    const [uno, dos] = await Promise.all([request(a).get("/api/v1/salud"), request(a).get("/api/v1/salud")]);
    expect(uno.headers["x-id-solicitud"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(uno.headers["x-id-solicitud"]).not.toBe(dos.headers["x-id-solicitud"]);
  });
});

describe("CORS", () => {
  it("permite los orígenes de CORS_ORIGENES", async () => {
    const r = await request(app()).get("/api/v1/salud").set("Origin", PERMITIDO);
    expect(r.headers["access-control-allow-origin"]).toBe(PERMITIDO);
  });

  it.each(["https://sitio-malicioso.example", "http://localhost:5174", "null"])("no autoriza el origen %s", async (origen) => {
    const r = await request(app()).get("/api/v1/salud").set("Origin", origen);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    const previo = await request(app()).options("/api/v1/aportes").set("Origin", origen).set("Access-Control-Request-Method", "POST");
    expect(previo.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("la verificación previa de un origen permitido responde sin error", async () => {
    const r = await request(app())
      .options("/api/v1/aportes")
      .set("Origin", PERMITIDO)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,content-type");
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe(PERMITIDO);
  });
});

describe("errores sin detalles técnicos", () => {
  it("un 500 no trae stack, rutas de archivos ni el mensaje original", async () => {
    // El cliente falso no tiene rpc(): la consulta lanza un TypeError interno.
    const r = await request(app()).get("/api/v1/puntos");
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { codigo: "ERROR_INTERNO", mensaje: "Ocurrió un error interno", detalles: [] } });
    expect(r.text).not.toMatch(/at |\.ts|\.js|TypeError|rpc|stack/i);
  });

  it.each([
    ["JSON mal formado", "application/json", '{"pregunta": ', 400, "SOLICITUD_INVALIDA"],
    ["cuerpo de más de 100 KB", "application/json", JSON.stringify({ pregunta: "x".repeat(110_000) }), 413, "SOLICITUD_DEMASIADO_GRANDE"],
    ["un charset no soportado", "application/json; charset=latin9", '{"pregunta":"hola"}', 415, "FORMATO_NO_SOPORTADO"],
  ])("%s responde %i con la forma uniforme", async (_caso, tipo, cuerpo, estado, codigo) => {
    const r = await request(app()).post("/api/v1/agente/consulta").set("Content-Type", tipo).send(cuerpo);
    expect(r.status).toBe(estado);
    expect(r.body).toMatchObject({ error: { codigo } });
    expect(r.body).toMatchObject(forma);
  });

  it("una ruta inexistente es 404 con la forma uniforme", async () => {
    const r = await request(app()).get("/api/v1/no-existe");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { codigo: "NO_ENCONTRADO", mensaje: "Ruta no encontrada", detalles: [] } });
  });

  it("un token inválido es 401 sin explicar por qué", async () => {
    const r = await request(app()).get("/api/v1/sesion").set("Authorization", "Bearer eyJ.basura.firma");
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject(forma);
    expect(r.text).not.toMatch(/JWS|JWT|signature|firma inv/i);
  });
});

describe("límite general de solicitudes", () => {
  it("responde 429 al pasar LIMITE_SOLICITUDES_POR_MINUTO, con la forma uniforme", async () => {
    const a = app({ LIMITE_SOLICITUDES_POR_MINUTO: "3" });
    for (let i = 0; i < 3; i++) expect((await request(a).get("/api/v1/no-existe")).status).toBe(404);
    const r = await request(a).get("/api/v1/no-existe");
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: { codigo: "LIMITE_EXCEDIDO" } });
    expect(r.headers["ratelimit-policy"]).toBeDefined();
  });

  it("/salud no cuenta, para que el health check de Render nunca reciba 429", async () => {
    const a = app({ LIMITE_SOLICITUDES_POR_MINUTO: "2" });
    for (let i = 0; i < 5; i++) expect((await request(a).get("/api/v1/salud")).status).toBe(200);
    expect((await request(a).get("/api/v1/no-existe")).status).toBe(404);
  });
});
