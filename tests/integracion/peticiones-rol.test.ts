import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { crearApp } from "../../src/app.js";
import type { Perfil } from "../../src/compartido/perfiles.js";
import { crearVerificadorJwt } from "../../src/config/jwt.js";
import type { AvisosPeticionRol, EventoPeticion } from "../../src/modulos/cuenta/avisos.js";
import { almacenFalso } from "../ayudas/almacen-falso.js";
import { clienteFalso } from "../ayudas/cliente-falso.js";
import { entornoDePrueba } from "../ayudas/entorno.js";
import { perfilesFalsos } from "../ayudas/perfiles-falsos.js";
import { ok, rpcFalso } from "../ayudas/rpc-falso.js";
import { EMISOR_PRUEBA, SECRETO_PRUEBA, tokenDePrueba } from "../ayudas/tokens.js";

const CIUDADANO = randomUUID();
const MODERADOR = randomUUID();
const EDITOR = randomUUID();
const ADMIN = randomUUID();
const INACTIVO = randomUUID();
const tabla: Record<string, Perfil> = {
  [CIUDADANO]: { rol: "ciudadano", activo: true },
  [MODERADOR]: { rol: "moderador", activo: true },
  [EDITOR]: { rol: "editor", activo: true },
  [ADMIN]: { rol: "administrador", activo: true },
  [INACTIVO]: { rol: "ciudadano", activo: false },
};
const FECHA = "2026-11-10T18:00:00+00:00";
const ID = randomUUID();
const MOTIVO = "Coordino las brigadas de limpieza del río en mi colonia";
const propia = { id: ID, rol_actual: "ciudadano", rol_pedido: "editor", motivo: MOTIVO, zona: null, estado: "pendiente", respuesta: null, creado_en: FECHA, resuelto_en: null };
const admin = { ...propia, usuario: { id: CIUDADANO, nombre: "Ana", email: "ana@correo.mx" }, resuelto_por: null };

function app(respuestas: Parameters<typeof rpcFalso>[0]) {
  const falso = rpcFalso(respuestas);
  const avisos: { id: string; evento: EventoPeticion }[] = [];
  const registroAvisos: AvisosPeticionRol = { avisar: (id, evento) => { avisos.push({ id, evento }); return Promise.resolve(); } };
  const a = crearApp(entornoDePrueba(), {
    publico: clienteFalso({ error: null }),
    verificador: crearVerificadorJwt({ secreto: SECRETO_PRUEBA, emisor: EMISOR_PRUEBA }),
    perfiles: perfilesFalsos(tabla),
    clienteUsuario: () => falso.cliente,
    almacen: almacenFalso().almacen,
    avisos: registroAvisos,
  });
  return { app: a, llamadas: falso.llamadas, avisos };
}
const bearer = async (sub: string) => `Bearer ${await tokenDePrueba({ sub })}`;

describe("peticiones de rol: permisos", () => {
  const deCuenta: [string, string][] = [
    ["get", "/api/v1/cuenta/peticiones-rol"],
    ["post", "/api/v1/cuenta/peticiones-rol"],
    ["post", `/api/v1/cuenta/peticiones-rol/${ID}/cancelar`],
  ];
  const deAdmin: [string, string][] = [
    ["get", "/api/v1/admin/peticiones-rol"],
    ["patch", `/api/v1/admin/peticiones-rol/${ID}`],
  ];

  it.each([...deCuenta, ...deAdmin])("%s %s responde 401 sin sesión", async (metodo, ruta) => {
    const { app: a, llamadas } = app({});
    expect((await request(a)[metodo as "get"](ruta)).status).toBe(401);
    expect(llamadas).toHaveLength(0);
  });

  it.each(deCuenta)("%s %s responde 403 a una cuenta desactivada", async (metodo, ruta) => {
    const { app: a, llamadas } = app({});
    expect((await request(a)[metodo as "get"](ruta).set("Authorization", await bearer(INACTIVO)).send({})).status).toBe(403);
    expect(llamadas).toHaveLength(0);
  });

  for (const [metodo, ruta] of deAdmin) {
    for (const id of [CIUDADANO, MODERADOR, EDITOR]) {
      it(`${tabla[id]?.rol ?? ""} recibe 403 en ${metodo} ${ruta}`, async () => {
        const { app: a, llamadas } = app({});
        expect((await request(a)[metodo as "get"](ruta).set("Authorization", await bearer(id)).send({ aprobar: true })).status).toBe(403);
        expect(llamadas).toHaveLength(0);
      });
    }
  }
});

describe("peticiones de rol: la persona", () => {
  it("pide un rol, recibe 201 sin caché y se avisa a administración", async () => {
    const { app: a, llamadas, avisos } = app({ pedir_rol: ok(propia) });
    const r = await request(a).post("/api/v1/cuenta/peticiones-rol").set("Authorization", await bearer(CIUDADANO))
      .send({ rol: "editor", motivo: `  ${MOTIVO}  `, zona: " Atlixco " });
    expect(r.status).toBe(201);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toEqual(propia);
    expect(llamadas).toEqual([{ nombre: "pedir_rol", parametros: { rol: "editor", motivo: MOTIVO, zona: "Atlixco" } }]);
    expect(avisos).toEqual([{ id: ID, evento: "nueva" }]);
  });

  it.each([
    [{ rol: "administrador", motivo: MOTIVO }],
    [{ rol: "ciudadano", motivo: MOTIVO }],
    [{ rol: "editor", motivo: "corto" }],
    [{ rol: "editor", motivo: "x".repeat(1001) }],
    [{ rol: "editor", motivo: MOTIVO, zona: "z" }],
    [{ rol: "editor", motivo: MOTIVO, email: "otro@x.mx" }],
  ])("rechaza %j con 400 sin llegar a la base", async (cuerpo) => {
    const { app: a, llamadas, avisos } = app({});
    const r = await request(a).post("/api/v1/cuenta/peticiones-rol").set("Authorization", await bearer(CIUDADANO)).send(cuerpo);
    expect(r.status).toBe(400);
    expect(llamadas).toHaveLength(0);
    expect(avisos).toHaveLength(0);
  });

  it("una segunda petición pendiente es un 409 con el mensaje de la base, y no avisa", async () => {
    const { app: a, avisos } = app({ pedir_rol: { data: null, error: { code: "55000", message: "Ya tienes una petición pendiente", hint: "publico" } } });
    const r = await request(a).post("/api/v1/cuenta/peticiones-rol").set("Authorization", await bearer(CIUDADANO)).send({ rol: "editor", motivo: MOTIVO });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: { mensaje: "Ya tienes una petición pendiente" } });
    expect(avisos).toHaveLength(0);
  });

  it("lista las suyas y cancela una", async () => {
    const { app: a, llamadas } = app({ mis_peticiones_rol: ok([propia]), cancelar_peticion_rol: ok({ ...propia, estado: "cancelada", resuelto_en: FECHA }) });
    const lista = await request(a).get("/api/v1/cuenta/peticiones-rol").set("Authorization", await bearer(MODERADOR));
    expect(lista.status).toBe(200);
    expect(lista.body).toEqual({ datos: [propia] });
    const cancelada = await request(a).post(`/api/v1/cuenta/peticiones-rol/${ID}/cancelar`).set("Authorization", await bearer(MODERADOR));
    expect(cancelada.status).toBe(200);
    expect(cancelada.body).toMatchObject({ estado: "cancelada" });
    expect(llamadas[1]).toEqual({ nombre: "cancelar_peticion_rol", parametros: { peticion_id: ID } });
  });

  it("cancelar con un id que no es uuid es 400", async () => {
    const { app: a, llamadas } = app({});
    const r = await request(a).post("/api/v1/cuenta/peticiones-rol/abc/cancelar").set("Authorization", await bearer(CIUDADANO));
    expect(r.status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });
});

describe("peticiones de rol: administración", () => {
  it("lista con el nombre pero nunca el correo, aunque la base lo enviara", async () => {
    const { app: a } = app({ listar_peticiones_rol: ok([admin]) });
    const r = await request(a).get("/api/v1/admin/peticiones-rol").set("Authorization", await bearer(ADMIN));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ datos: [{ ...admin, usuario: { id: CIUDADANO, nombre: "Ana" } }] });
    expect(JSON.stringify(r.body)).not.toContain("ana@correo.mx");
  });

  it("resuelve, pasa la respuesta limpia y avisa a la persona", async () => {
    const resuelta = { ...admin, estado: "aprobada", respuesta: "Bienvenida", resuelto_en: FECHA, resuelto_por: { id: ADMIN, nombre: "Admin" } };
    const { app: a, llamadas, avisos } = app({ resolver_peticion_rol: ok(resuelta) });
    const r = await request(a).patch(`/api/v1/admin/peticiones-rol/${ID}`).set("Authorization", await bearer(ADMIN)).send({ aprobar: true, respuesta: " Bienvenida " });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: "aprobada" });
    expect(llamadas).toEqual([{ nombre: "resolver_peticion_rol", parametros: { peticion_id: ID, aprobar: true, respuesta: "Bienvenida" } }]);
    expect(avisos).toEqual([{ id: ID, evento: "resuelta" }]);
  });

  it.each([[{}], [{ aprobar: "sí" }], [{ aprobar: false, respuesta: "r".repeat(501) }], [{ aprobar: true, rol: "administrador" }]])(
    "rechaza la decisión %j con 400", async (cuerpo) => {
      const { app: a, llamadas } = app({});
      const r = await request(a).patch(`/api/v1/admin/peticiones-rol/${ID}`).set("Authorization", await bearer(ADMIN)).send(cuerpo);
      expect(r.status).toBe(400);
      expect(llamadas).toHaveLength(0);
    },
  );

  it("si la base rechaza (p. ej. es su propia petición), no avisa", async () => {
    const { app: a, avisos } = app({ resolver_peticion_rol: { data: null, error: { code: "42501", message: "No puedes resolver tu propia petición", hint: "publico" } } });
    const r = await request(a).patch(`/api/v1/admin/peticiones-rol/${ID}`).set("Authorization", await bearer(ADMIN)).send({ aprobar: true });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { mensaje: "No puedes resolver tu propia petición" } });
    expect(avisos).toHaveLength(0);
  });
});
