import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { crearApp } from "../../src/app.js";
import { crearClienteAnon } from "../../src/config/supabase.js";
import { cargarEntorno, type Entorno } from "../../src/config/env.js";

/**
 * Prueba contra el proyecto de Supabase de PRUEBAS (nunca producción).
 * Se ejecuta solo con PRUEBAS_SUPABASE=1 y las variables SUPABASE_* del proyecto de pruebas.
 * Ver README, sección "Pruebas contra Supabase".
 */
describe.skipIf(process.env.PRUEBAS_SUPABASE !== "1")("salud contra Supabase real", () => {
  let entorno: Entorno;
  let app: Express;

  beforeAll(() => {
    entorno = cargarEntorno(process.env);
    app = crearApp(entorno, { publico: crearClienteAnon(entorno) });
  });

  it("GET /salud reporta base ok con las migraciones aplicadas", async () => {
    const r = await request(app).get("/api/v1/salud");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ estado: "ok", base: "ok" });
  });

  it("la respuesta no contiene ninguna llave del proyecto", async () => {
    const r = await request(app).get("/api/v1/salud");
    const texto = JSON.stringify(r.body);
    for (const valor of [entorno.SUPABASE_ANON_KEY, entorno.SUPABASE_SERVICE_ROLE_KEY, entorno.SUPABASE_JWT_SECRET]) {
      expect(texto).not.toContain(valor);
    }
  });
});
