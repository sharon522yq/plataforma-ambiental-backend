import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { crearRegistroSolicitudes } from "../../src/middleware/registro-solicitudes.js";

function app(activo: boolean) {
  const a = express();
  a.use(crearRegistroSolicitudes(activo));
  a.get("/x/:id", (_req, res) => res.status(201).json({}));
  a.get("/falla", (_req, res) => res.status(503).json({}));
  return a;
}

describe("crearRegistroSolicitudes", () => {
  it("registra método, ruta sin query, código, duración e id; nunca la query ni cabeceras", async () => {
    const espia = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const r = await request(app(true)).get("/x/123?busqueda=ana@correo.com").set("Authorization", "Bearer secreto");
    const linea = JSON.parse(String(espia.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(linea).toMatchObject({ nivel: "info", evento: "solicitud", metodo: "GET", ruta: "/x/123", estado: 201, id: r.headers["x-id-solicitud"] });
    expect(typeof linea.ms).toBe("number");
    expect(JSON.stringify(espia.mock.calls)).not.toMatch(/ana@correo|busqueda|secreto|Bearer/);
    espia.mockRestore();
  });

  it("un 5xx se registra como error", async () => {
    const espia = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await request(app(true)).get("/falla");
    expect(String(espia.mock.calls[0]?.[0])).toContain('"estado":503');
    espia.mockRestore();
  });

  it("desactivado (pruebas) no registra, pero sigue dando el id", async () => {
    const espia = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const r = await request(app(false)).get("/x/1");
    expect(r.headers["x-id-solicitud"]).toBeDefined();
    expect(espia).not.toHaveBeenCalled();
    espia.mockRestore();
  });
});
