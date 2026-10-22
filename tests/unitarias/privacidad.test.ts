import { describe, expect, it } from "vitest";
import { quitarDatosPersonales } from "../../src/compartido/privacidad.js";

describe("quitarDatosPersonales", () => {
  it.each([
    ["Escríbeme a juan.perez@gmail.com", "Escríbeme a [correo eliminado]"],
    ["correo: MARÍA_1@dominio.org.mx.", "correo: [correo eliminado]."],
    ["Llama al 3312345678", "Llama al [teléfono eliminado]"],
    ["Tel. +52 (33) 1234-5678 por favor", "Tel. [teléfono eliminado] por favor"],
    ["mi cel 33 1234 5678", "mi cel [teléfono eliminado]"],
    ["33.1234.5678", "[teléfono eliminado]"],
  ])("limpia %j", (entrada, salida) => {
    expect(quitarDatosPersonales(entrada)).toBe(salida);
  });

  it.each([
    "Desde el 2026-10-22 hay espuma en el arroyo",
    "Pasa por la calle 5 de mayo 1234, a 200 metros",
    "Ubicación 20.659712, -103.349634 junto al puente",
    "Hay 15 árboles talados y 3 camiones",
  ])("no toca texto sin datos personales: %j", (texto) => {
    expect(quitarDatosPersonales(texto)).toBe(texto);
  });
});
