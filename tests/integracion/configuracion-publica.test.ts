import request from "supertest";
import { describe, expect, it } from "vitest";
import { crearApp } from "../../src/app.js";
import { clienteFalso } from "../ayudas/cliente-falso.js";
import { entornoDePrueba } from "../ayudas/entorno.js";

/** D-39: el navegador recibe la URL y la llave anon de Supabase para iniciar sesión, y nada más. */
const app = crearApp(entornoDePrueba(), { publico: clienteFalso({ error: null }) });

describe("GET /api/v1/configuracion-publica", () => {
  it("devuelve solo la URL y la llave anon de Supabase", async () => {
    const r = await request(app).get("/api/v1/configuracion-publica");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ supabase_url: "https://proyecto-falso.supabase.co", supabase_anon_key: "llave-anon-falsa" });
  });

  it("nunca expone la llave de servicio, el secreto JWT ni la llave de Gemini", async () => {
    const r = await request(app).get("/api/v1/configuracion-publica");
    const texto = JSON.stringify(r.body) + JSON.stringify(r.headers);
    expect(texto).not.toContain("llave-servicio-falsa");
    expect(texto).not.toContain("secreto-falso");
    expect(texto).not.toContain("llave-gemini-falsa");
  });

  it("no pide sesión y se puede guardar en caché un minuto", async () => {
    const r = await request(app).get("/api/v1/configuracion-publica");
    expect(r.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("responde al origen permitido del frontend", async () => {
    const r = await request(app).get("/api/v1/configuracion-publica").set("Origin", "http://localhost:5173");
    expect(r.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });
});
