import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { crearLectorPerfiles } from "../../src/compartido/perfiles.js";

/** Imita from("perfiles").select().eq().maybeSingle() y guarda los argumentos usados. */
function servicioFalso(respuesta: { data: unknown; error: { message: string } | null }) {
  const llamadas: unknown[][] = [];
  const consulta = {
    select: (...a: unknown[]) => (llamadas.push(["select", ...a]), consulta),
    eq: (...a: unknown[]) => (llamadas.push(["eq", ...a]), consulta),
    maybeSingle: () => Promise.resolve(respuesta),
  };
  const cliente = { from: (tabla: string) => (llamadas.push(["from", tabla]), consulta) };
  return { cliente: cliente as unknown as SupabaseClient, llamadas };
}

describe("lector de perfiles", () => {
  it("consulta perfiles por id y devuelve rol y estado", async () => {
    const { cliente, llamadas } = servicioFalso({ data: { rol: "moderador", activo: true }, error: null });
    await expect(crearLectorPerfiles(cliente).obtener("u1")).resolves.toEqual({ rol: "moderador", activo: true });
    expect(llamadas).toEqual([["from", "perfiles"], ["select", "rol, activo"], ["eq", "id", "u1"]]);
  });

  it("devuelve null si el perfil no existe", async () => {
    const { cliente } = servicioFalso({ data: null, error: null });
    await expect(crearLectorPerfiles(cliente).obtener("u1")).resolves.toBeNull();
  });

  it("falla sin exponer el detalle si la base responde con error", async () => {
    const { cliente } = servicioFalso({ data: null, error: { message: "permission denied for table perfiles" } });
    await expect(crearLectorPerfiles(cliente).obtener("u1")).rejects.toThrow("No se pudo leer el perfil");
  });

  it("rechaza un rol que no existe en la plataforma", async () => {
    const { cliente } = servicioFalso({ data: { rol: "superusuario", activo: true }, error: null });
    await expect(crearLectorPerfiles(cliente).obtener("u1")).rejects.toThrow();
  });
});
