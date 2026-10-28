import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { crearRegistroConversaciones } from "../../src/modulos/agente/conversaciones.js";

function servicioFalso(opciones: { errorInsert?: boolean; lanza?: boolean } = {}) {
  const insert = vi.fn(() =>
    opciones.lanza ? Promise.reject(new Error("red")) : Promise.resolve({ error: opciones.errorInsert ? { message: "x" } : null }),
  );
  const rpc = vi.fn(() => Promise.resolve({ error: null }));
  const from = vi.fn(() => ({ insert }));
  return { cliente: { from, rpc } as unknown as SupabaseClient, insert, rpc, from };
}
const conversacion = { usuario_id: null, pregunta: "p", respuesta: "r", modelo: "m" };

describe("crearRegistroConversaciones", () => {
  it("guarda pregunta, respuesta y modelo en conversaciones_agente", async () => {
    const s = servicioFalso();
    await crearRegistroConversaciones(s.cliente).guardar(conversacion);
    expect(s.from).toHaveBeenCalledWith("conversaciones_agente");
    expect(s.insert).toHaveBeenCalledWith({ usuario_id: null, pregunta: "p", respuesta: "r", fuentes: { modelo: "m" } });
  });

  it("purga las vencidas como máximo una vez por hora", async () => {
    const s = servicioFalso();
    let ahora = 10 * 60 * 60 * 1000;
    const registro = crearRegistroConversaciones(s.cliente, () => ahora);
    await registro.guardar(conversacion);
    await registro.guardar(conversacion);
    expect(s.rpc).toHaveBeenCalledTimes(1);
    expect(s.rpc).toHaveBeenCalledWith("purgar_conversaciones_agente");
    ahora += 60 * 60 * 1000;
    await registro.guardar(conversacion);
    expect(s.rpc).toHaveBeenCalledTimes(2);
  });

  it("nunca lanza: si la base falla solo lo registra", async () => {
    const espia = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(crearRegistroConversaciones(servicioFalso({ errorInsert: true }).cliente).guardar(conversacion)).resolves.toBeUndefined();
    await expect(crearRegistroConversaciones(servicioFalso({ lanza: true }).cliente).guardar(conversacion)).resolves.toBeUndefined();
    expect(espia).toHaveBeenCalledWith(expect.stringContaining("conversacion_no_guardada"));
    espia.mockRestore();
  });
});
