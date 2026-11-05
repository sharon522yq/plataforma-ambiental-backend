import { describe, expect, it } from "vitest";
import { fragmentar, MAXIMO_FRAGMENTO } from "../../src/modulos/conocimiento/fragmentar.js";

describe("fragmentar", () => {
  it("junta párrafos cortos y limpia espacios", () => {
    expect(fragmentar("Uno.  \r\n\r\n\r\n  Dos\t con  espacios.\n\nTres.")).toEqual(["Uno.\n\nDos con espacios.\n\nTres."]);
  });

  it("corta entre párrafos al llegar al máximo, sin partir uno que cabe", () => {
    const a = "a".repeat(700), b = "b".repeat(700);
    expect(fragmentar(`${a}\n\n${b}`)).toEqual([a, b]);
  });

  it("un párrafo largo se corta por oraciones", () => {
    const oracion = "Esta es una oración de prueba sobre residuos. ";
    const r = fragmentar(oracion.repeat(60));
    expect(r.length).toBeGreaterThan(1);
    for (const f of r) {
      expect(f.length).toBeLessThanOrEqual(MAXIMO_FRAGMENTO);
      expect(f.endsWith(".")).toBe(true);
    }
    expect(r.join(" ").replace(/\s+/g, " ")).toBe(oracion.repeat(60).trim());
  });

  it("una oración enorme se corta por palabras, y una palabra enorme a la fuerza", () => {
    const r = fragmentar(`${"palabra ".repeat(400)}${"x".repeat(3000)}`, 500);
    for (const f of r) expect(f.length).toBeLessThanOrEqual(500);
    expect(r.join("").replace(/\s+/g, "").length).toBe("palabra".length * 400 + 3000);
  });

  it("texto vacío no da fragmentos", () => {
    expect(fragmentar(" \n\n \n")).toEqual([]);
  });
});
