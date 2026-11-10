import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Correo, EnviadorCorreo } from "../../src/compartido/correo.js";
import { correoDesactivado } from "../../src/compartido/correo.js";
import { crearAvisosPeticionRol, sinAvisos } from "../../src/modulos/cuenta/avisos.js";
import { ok, rpcFalso } from "../ayudas/rpc-falso.js";

const ID = randomUUID();
const SITIO = "https://plataforma.ejemplo.mx";

function correoFalso(resultado = true): EnviadorCorreo & { enviados: Correo[] } {
  const enviados: Correo[] = [];
  return { activo: true, enviados, enviar: (c) => { enviados.push(c); return Promise.resolve(resultado); } };
}
const destinos = (peticion: Record<string, unknown>, destinatarios: { email: string; nombre: string | null }[]) =>
  ok({ peticion: { id: ID, rol_pedido: "editor", estado: "pendiente", respuesta: null, nombre: "Ana", ...peticion }, destinatarios });

afterEach(() => vi.restoreAllMocks());

describe("avisos de peticiones de rol", () => {
  it("una petición nueva avisa a cada administrador por separado, sin el motivo", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const correo = correoFalso();
    const rpc = rpcFalso({ destinatarios_peticion_rol: destinos({}, [{ email: "a1@x.mx", nombre: "Uno" }, { email: "a2@x.mx", nombre: null }]) });
    await crearAvisosPeticionRol({ correo, servicio: () => rpc.cliente, sitioUrl: SITIO }).avisar(ID, "nueva");
    expect(rpc.llamadas).toEqual([{ nombre: "destinatarios_peticion_rol", parametros: { peticion_id: ID, evento: "nueva" } }]);
    expect(correo.enviados.map((c) => c.para)).toEqual([{ email: "a1@x.mx", nombre: "Uno" }, { email: "a2@x.mx" }]);
    const [primero] = correo.enviados;
    expect(primero?.asunto).toBe("Nueva petición de rol: Ana pide edición");
    expect(primero?.texto).toContain("Hola Uno:");
    expect(primero?.texto).toContain(SITIO);
    expect(primero?.html).toContain(`<a href="${SITIO}#administracion">`);
  });

  it("el nombre de la persona va escapado en el HTML y en una sola línea en el asunto", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const correo = correoFalso();
    const rpc = rpcFalso({ destinatarios_peticion_rol: destinos({ nombre: "<b>Ana</b>\r\nBcc: x@y.mx" }, [{ email: "a1@x.mx", nombre: "Uno" }]) });
    await crearAvisosPeticionRol({ correo, servicio: () => rpc.cliente }).avisar(ID, "nueva");
    const [c] = correo.enviados;
    expect(c?.asunto).not.toMatch(/[\r\n]/);
    expect(c?.html).not.toContain("<b>");
    expect(c?.html).toContain("&lt;b&gt;Ana&lt;/b&gt;");
    expect(c?.texto).not.toContain("http");
  });

  it("al resolverse avisa a la persona, con la respuesta del equipo", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const correo = correoFalso();
    const aprobada = rpcFalso({ destinatarios_peticion_rol: destinos({ estado: "aprobada", respuesta: "Bienvenida" }, [{ email: "ana@x.mx", nombre: "Ana" }]) });
    await crearAvisosPeticionRol({ correo, servicio: () => aprobada.cliente }).avisar(ID, "resuelta");
    expect(correo.enviados[0]).toMatchObject({ para: { email: "ana@x.mx" }, asunto: "Tu petición del rol de edición fue aprobada" });
    expect(correo.enviados[0]?.texto).toContain("Respuesta del equipo: Bienvenida");

    const rechazada = rpcFalso({ destinatarios_peticion_rol: destinos({ estado: "rechazada", rol_pedido: "moderador" }, [{ email: "ana@x.mx", nombre: "Ana" }]) });
    await crearAvisosPeticionRol({ correo, servicio: () => rechazada.cliente }).avisar(ID, "resuelta");
    expect(correo.enviados[1]?.asunto).toBe("Tu petición del rol de moderación fue revisada");
    expect(correo.enviados[1]?.texto).toContain("7 días");
  });

  it("nunca lanza: si la base falla o la petición no existe, solo registra sin datos personales", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const correo = correoFalso();
    const falla = rpcFalso({ destinatarios_peticion_rol: { data: null, error: { code: "XX000", message: "fallo" } } });
    await expect(crearAvisosPeticionRol({ correo, servicio: () => falla.cliente }).avisar(ID, "nueva")).resolves.toBeUndefined();
    const vacia = rpcFalso({ destinatarios_peticion_rol: ok(null) });
    await crearAvisosPeticionRol({ correo, servicio: () => vacia.cliente }).avisar(ID, "nueva");
    expect(correo.enviados).toHaveLength(0);
    expect(error.mock.calls.map((c) => String(c[0])).join("")).toContain("aviso_peticion_rol_fallo");
  });

  it("registra cuántos fallaron, sin direcciones", async () => {
    const aviso = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const correo = correoFalso(false);
    const rpc = rpcFalso({ destinatarios_peticion_rol: destinos({}, [{ email: "a1@x.mx", nombre: "Uno" }]) });
    await crearAvisosPeticionRol({ correo, servicio: () => rpc.cliente }).avisar(ID, "nueva");
    const registro = aviso.mock.calls.map((c) => String(c[0])).join("");
    expect(registro).toContain('"fallidos":1');
    expect(registro).not.toContain("a1@x.mx");
  });

  it("sin correo configurado no consulta la base", () => {
    const servicio = vi.fn();
    expect(crearAvisosPeticionRol({ correo: correoDesactivado, servicio })).toBe(sinAvisos);
    expect(servicio).not.toHaveBeenCalled();
  });
});
