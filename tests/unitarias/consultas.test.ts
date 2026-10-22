import { describe, expect, it } from "vitest";
import { llamarFuncion } from "../../src/compartido/consultas.js";
import { rpcFalso } from "../ayudas/rpc-falso.js";

const conError = (code: string, message: string, hint?: string) =>
  rpcFalso({ f: { data: null, error: { code, message, ...(hint ? { hint } : {}) } } }).cliente;

describe("llamarFuncion: traducción de errores de la base", () => {
  it.each([
    ["22023", 400],
    ["23514", 400],
    ["42501", 403],
    ["P0002", 404],
    ["55000", 409],
  ])("código %s responde %i", async (codigo, estado) => {
    await expect(llamarFuncion(conError(codigo, "x"), "f", {})).rejects.toMatchObject({ estado });
  });

  it("muestra el mensaje de la base solo si la función lo marcó como público", async () => {
    await expect(llamarFuncion(conError("42501", "No puedes revisar tu propio aporte", "publico"), "f", {})).rejects.toThrow(
      "No puedes revisar tu propio aporte",
    );
    await expect(
      llamarFuncion(conError("42501", 'new row violates row-level security policy for table "puntos"'), "f", {}),
    ).rejects.toThrow("No tienes permiso para esta acción");
  });

  it("un código desconocido es un error interno sin detalles", async () => {
    const error = await llamarFuncion(conError("XX000", "detalle interno 10.0.0.1"), "f", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toHaveProperty("estado");
    expect(String(error)).not.toContain("10.0.0.1");
  });
});
