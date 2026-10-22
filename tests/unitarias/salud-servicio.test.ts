import { describe, expect, it } from "vitest";
import { comprobarBase } from "../../src/modulos/salud/servicio.js";
import { clienteFalso } from "../ayudas/cliente-falso.js";

describe("comprobarBase", () => {
  it("devuelve ok cuando la consulta no tiene error", async () => {
    expect(await comprobarBase(clienteFalso({ error: null }))).toBe("ok");
  });

  it("devuelve no_disponible cuando la base responde con error (p. ej. tabla inexistente)", async () => {
    expect(
      await comprobarBase(clienteFalso({ error: { message: 'relation "puntos" does not exist' } })),
    ).toBe("no_disponible");
  });

  it("devuelve no_disponible cuando la conexión lanza una excepción", async () => {
    expect(await comprobarBase(clienteFalso(new Error("ECONNREFUSED")))).toBe("no_disponible");
  });

  it("no expone el mensaje del error en su resultado", async () => {
    const resultado = await comprobarBase(clienteFalso({ error: { message: "secreto-interno" } }));
    expect(resultado).not.toContain("secreto");
  });
});
