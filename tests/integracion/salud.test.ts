import request from "supertest";
import { describe, expect, it } from "vitest";
import { crearApp } from "../../src/app.js";
import { clienteFalso } from "../ayudas/cliente-falso.js";
import { entornoDePrueba } from "../ayudas/entorno.js";

const app = crearApp(entornoDePrueba(), { publico: clienteFalso({ error: null }) });
const appBaseCaida = crearApp(entornoDePrueba(), { publico: clienteFalso(new Error("ECONNREFUSED")) });

describe("GET /api/v1/salud", () => {
  it("responde 200 con estado ok y base ok", async () => {
    const r = await request(app).get("/api/v1/salud");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ estado: "ok", base: "ok" });
  });

  it("responde 200 con estado degradado cuando la base no responde", async () => {
    const r = await request(appBaseCaida).get("/api/v1/salud");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ estado: "degradado", base: "no_disponible" });
  });

  it("nunca incluye llaves ni detalles técnicos en la respuesta", async () => {
    const r = await request(appBaseCaida).get("/api/v1/salud");
    const texto = JSON.stringify(r.body);
    expect(texto).not.toMatch(/llave|secreto|ECONNREFUSED|supabase\.co/i);
  });

  it("incluye cabeceras de helmet", async () => {
    const r = await request(app).get("/api/v1/salud");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-powered-by"]).toBeUndefined();
  });

  it("rechaza orígenes no permitidos en CORS", async () => {
    const r = await request(app).get("/api/v1/salud").set("Origin", "https://malo.example");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("responde 404 con formato uniforme en rutas inexistentes", async () => {
    const r = await request(app).get("/no-existe");
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: { codigo: "NO_ENCONTRADO" } });
  });
});
