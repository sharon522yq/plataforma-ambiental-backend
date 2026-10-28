import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { armarPagina, desplazamiento, esquemaPaginacion } from "../../src/compartido/consultas.js";
import { cuerpoNuevoAporte, esquemaUbicacion } from "../../src/modulos/aportes/esquemas.js";
import { consultaCercanos } from "../../src/modulos/puntos/esquemas.js";

/** Categoría 7 de la sección 8: validación y cálculo de paginación, sin HTTP ni base. */
describe("paginación", () => {
  it("usa página 1 y límite 20 si no vienen, y convierte los textos de la URL", () => {
    expect(esquemaPaginacion.parse({})).toEqual({ pagina: 1, limite: 20 });
    expect(esquemaPaginacion.parse({ pagina: "3", limite: "50" })).toEqual({ pagina: 3, limite: 50 });
  });

  it.each([
    [{ pagina: "0" }],
    [{ pagina: "-1" }],
    [{ pagina: "1.5" }],
    [{ pagina: "10001" }],
    [{ limite: "0" }],
    [{ limite: "101" }],
    [{ limite: "abc" }],
  ])("rechaza %o", (consulta) => {
    expect(esquemaPaginacion.safeParse(consulta).success).toBe(false);
  });

  it.each([
    [1, 20, 0],
    [2, 20, 20],
    [5, 7, 28],
    [10000, 100, 999_900],
  ])("página %i con límite %i empieza en %i", (pagina, limite, esperado) => {
    expect(desplazamiento({ pagina, limite })).toBe(esperado);
  });

  it.each([
    [0, 20, 0],
    [1, 20, 1],
    [20, 20, 1],
    [21, 20, 2],
    [101, 100, 2],
  ])("con %i resultados y límite %i hay %i páginas", (total, limite, paginas) => {
    const pagina = armarPagina({ total, datos: [] }, z.string(), { pagina: 1, limite });
    expect(pagina.paginacion).toEqual({ pagina: 1, limite, total, paginas });
  });

  it("valida cada elemento y rechaza una respuesta mal formada de la base", () => {
    expect(armarPagina({ total: 2, datos: ["a", "b"] }, z.string(), { pagina: 1, limite: 20 }).datos).toEqual(["a", "b"]);
    expect(() => armarPagina({ total: -1, datos: [] }, z.string(), { pagina: 1, limite: 20 })).toThrow();
    expect(() => armarPagina({ total: 1, datos: [1] }, z.string(), { pagina: 1, limite: 20 })).toThrow();
    expect(() => armarPagina(null, z.string(), { pagina: 1, limite: 20 })).toThrow();
  });
});

describe("validación de coordenadas", () => {
  it.each([
    [{ lat: 90, lng: 180 }],
    [{ lat: -90, lng: -180 }],
    [{ lat: 20.6767, lng: -103.3475 }],
  ])("acepta %o", (ubicacion) => {
    expect(esquemaUbicacion.safeParse(ubicacion).success).toBe(true);
  });

  it.each([
    [{ lat: 90.0001, lng: 0 }],
    [{ lat: -91, lng: 0 }],
    [{ lat: 0, lng: 180.5 }],
    [{ lat: 0, lng: -181 }],
    [{ lat: "20", lng: "-103" }],
    [{ lat: 20 }],
    [{ lat: 20, lng: -103, alt: 1500 }],
  ])("rechaza %o", (ubicacion) => {
    expect(esquemaUbicacion.safeParse(ubicacion).success).toBe(false);
  });

  it("cercanos: lat y lng son obligatorias y el radio va de 1 a 50 km", () => {
    expect(consultaCercanos.parse({ lat: "20.67", lng: "-103.35" })).toMatchObject({ lat: 20.67, lng: -103.35, radio: 5000 });
    expect(consultaCercanos.safeParse({ lat: "20.67" }).success).toBe(false);
    expect(consultaCercanos.safeParse({ lat: "20.67", lng: "-103.35", radio: "50001" }).success).toBe(false);
    expect(consultaCercanos.safeParse({ lat: "20.67", lng: "-103.35", radio: "0" }).success).toBe(false);
  });
});

describe("validación de un aporte", () => {
  const valido = { tipo: "residuos", descripcion: "Basura tirada junto al canal", ubicacion: { lat: 20.6, lng: -103.3 } };

  it("acepta un aporte completo y recorta espacios", () => {
    const r = cuerpoNuevoAporte.parse({ ...valido, descripcion: "  Basura tirada junto al canal  ", gravedad_sugerida: 3, punto_id: randomUUID() });
    expect(r.descripcion).toBe("Basura tirada junto al canal");
  });

  it.each([
    ["tipo desconocido", { ...valido, tipo: "ruido" }],
    ["descripción corta", { ...valido, descripcion: "corta" }],
    ["descripción de solo espacios", { ...valido, descripcion: "            " }],
    ["descripción de más de 2000", { ...valido, descripcion: "x".repeat(2001) }],
    ["gravedad 6", { ...valido, gravedad_sugerida: 6 }],
    ["gravedad decimal", { ...valido, gravedad_sugerida: 2.5 }],
    ["punto_id que no es uuid", { ...valido, punto_id: "123" }],
    ["sin ubicación", { tipo: valido.tipo, descripcion: valido.descripcion }],
    ["campo de más (estado)", { ...valido, estado: "aprobado" }],
    ["campo de más (autor_id)", { ...valido, autor_id: randomUUID() }],
  ])("rechaza: %s", (_caso, cuerpo) => {
    expect(cuerpoNuevoAporte.safeParse(cuerpo).success).toBe(false);
  });
});
