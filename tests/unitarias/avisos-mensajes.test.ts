import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Correo, EnviadorCorreo } from "../../src/compartido/correo.js";
import { correoDesactivado } from "../../src/compartido/correo.js";
import { crearAvisosMensajes, sinAvisosMensajes } from "../../src/modulos/mensajes/avisos.js";
import { ok, rpcFalso } from "../ayudas/rpc-falso.js";

const ID = randomUUID();
function correoFalso(): EnviadorCorreo & { enviados: Correo[] } {
  const enviados: Correo[] = [];
  return { activo: true, enviados, enviar: (c) => { enviados.push(c); return Promise.resolve(true); } };
}
afterEach(() => vi.restoreAllMocks());

describe("aviso de mensaje nuevo", () => {
  it("avisa a quien recibe sin incluir el texto ni quién escribió, con enlace a Mensajes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const correo = correoFalso();
    const rpc = rpcFalso({ destinatario_mensaje: ok({ punto: { titulo: "Basura <en> el río" }, destinatario: { email: "ana@x.mx", nombre: "Ana" } }) });
    await crearAvisosMensajes({ correo, servicio: () => rpc.cliente, sitioUrl: "https://sitio.mx" }).avisar(ID);
    expect(rpc.llamadas).toEqual([{ nombre: "destinatario_mensaje", parametros: { mensaje_id: ID } }]);
    const [c] = correo.enviados;
    expect(c?.para).toEqual({ email: "ana@x.mx", nombre: "Ana" });
    expect(c?.asunto).toBe("Mensaje nuevo sobre «Basura <en> el río»");
    expect(c?.html).toContain("Basura &lt;en&gt; el río");
    expect(c?.html).toContain('href="https://sitio.mx#mensajes"');
    expect(c?.texto).toContain("el mensaje no viene en este correo");
  });

  it("si la base dice que no toca avisar (null), no envía", async () => {
    const correo = correoFalso();
    const rpc = rpcFalso({ destinatario_mensaje: ok(null) });
    await crearAvisosMensajes({ correo, servicio: () => rpc.cliente }).avisar(ID);
    expect(correo.enviados).toHaveLength(0);
  });

  it("nunca lanza y registra sin datos personales", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rpc = rpcFalso({ destinatario_mensaje: ok({ punto: {}, destinatario: { email: "ana@x.mx" } }) });
    await expect(crearAvisosMensajes({ correo: correoFalso(), servicio: () => rpc.cliente }).avisar(ID)).resolves.toBeUndefined();
    const registro = error.mock.calls.map((x) => String(x[0])).join("");
    expect(registro).toContain("aviso_mensaje_fallo");
    expect(registro).not.toContain("ana@x.mx");
  });

  it("sin correo configurado no consulta la base", () => {
    const servicio = vi.fn();
    expect(crearAvisosMensajes({ correo: correoDesactivado, servicio })).toBe(sinAvisosMensajes);
    expect(servicio).not.toHaveBeenCalled();
  });
});
