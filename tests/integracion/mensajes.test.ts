import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { crearApp } from "../../src/app.js";
import type { Perfil } from "../../src/compartido/perfiles.js";
import { crearVerificadorJwt } from "../../src/config/jwt.js";
import type { AvisosMensajes } from "../../src/modulos/mensajes/avisos.js";
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
const F = "2026-11-10T18:00:00+00:00";
const PUNTO = randomUUID();
const HILO = randomUUID();
const MENSAJE = randomUUID();
const hilo = { id: HILO, punto: { id: PUNTO, titulo: "Basura en el río" }, con: "Quien reportó el punto", soy_quien_reporto: false, estado: "abierto", cerrado_por_mi: false, no_leidos: 0, creado_en: F, ultimo_mensaje_en: F };
const mensaje = { id: MENSAJE, mio: true, texto: "Hola", creado_en: F, leido_en: null };

function app(respuestas: Parameters<typeof rpcFalso>[0]) {
  const falso = rpcFalso(respuestas);
  const avisos: string[] = [];
  const registro: AvisosMensajes = { avisar: (id) => { avisos.push(id); return Promise.resolve(); } };
  const a = crearApp(entornoDePrueba(), {
    publico: clienteFalso({ error: null }),
    verificador: crearVerificadorJwt({ secreto: SECRETO_PRUEBA, emisor: EMISOR_PRUEBA }),
    perfiles: perfilesFalsos(tabla),
    clienteUsuario: () => falso.cliente,
    almacen: almacenFalso().almacen,
    avisosMensajes: registro,
  });
  return { app: a, llamadas: falso.llamadas, avisos };
}
const bearer = async (sub: string) => `Bearer ${await tokenDePrueba({ sub })}`;

describe("mensajes: permisos", () => {
  const deCuenta: [string, string][] = [
    ["post", `/api/v1/puntos/${PUNTO}/mensajes`],
    ["get", "/api/v1/mensajes"],
    ["get", `/api/v1/mensajes/${HILO}`],
    ["post", `/api/v1/mensajes/${HILO}`],
    ["post", `/api/v1/mensajes/${HILO}/cerrar`],
    ["post", `/api/v1/mensajes/${HILO}/reabrir`],
    ["post", `/api/v1/mensajes/${HILO}/denunciar`],
  ];
  const deModeracion: [string, string][] = [
    ["get", "/api/v1/admin/denuncias-mensajes"],
    ["patch", `/api/v1/admin/denuncias-mensajes/${HILO}`],
  ];

  it.each([...deCuenta, ...deModeracion])("%s %s responde 401 sin sesión", async (metodo, ruta) => {
    const { app: a, llamadas } = app({});
    expect((await request(a)[metodo as "get"](ruta)).status).toBe(401);
    expect(llamadas).toHaveLength(0);
  });

  it.each(deCuenta)("%s %s responde 403 a una cuenta desactivada", async (metodo, ruta) => {
    const { app: a, llamadas } = app({});
    expect((await request(a)[metodo as "get"](ruta).set("Authorization", await bearer(INACTIVO)).send({ texto: "hola", motivo: "x".repeat(12) })).status).toBe(403);
    expect(llamadas).toHaveLength(0);
  });

  for (const [metodo, ruta] of deModeracion) {
    for (const id of [CIUDADANO, EDITOR]) {
      it(`${tabla[id]?.rol ?? ""} recibe 403 en ${metodo} ${ruta}`, async () => {
        const { app: a, llamadas } = app({});
        expect((await request(a)[metodo as "get"](ruta).set("Authorization", await bearer(id)).send({})).status).toBe(403);
        expect(llamadas).toHaveLength(0);
      });
    }
  }

  it("el mensaje privado sobre un punto no lleva la caché pública de /puntos", async () => {
    const { app: a } = app({ escribir_sobre_punto: ok({ hilo, mensaje }) });
    const r = await request(a).post(`/api/v1/puntos/${PUNTO}/mensajes`).set("Authorization", await bearer(CIUDADANO)).send({ texto: "Hola" });
    expect(r.status).toBe(201);
    expect(r.headers["cache-control"]).toBe("no-store");
  });
});

describe("mensajes: flujo", () => {
  it("escribir sobre un punto manda el texto limpio y avisa por el mensaje creado", async () => {
    const { app: a, llamadas, avisos } = app({ escribir_sobre_punto: ok({ hilo, mensaje }) });
    const r = await request(a).post(`/api/v1/puntos/${PUNTO}/mensajes`).set("Authorization", await bearer(CIUDADANO)).send({ texto: "  Hola  " });
    expect(r.body).toEqual({ hilo, mensaje });
    expect(llamadas).toEqual([{ nombre: "escribir_sobre_punto", parametros: { punto_id: PUNTO, texto: "Hola" } }]);
    expect(avisos).toEqual([MENSAJE]);
  });

  it.each([[{}], [{ texto: "" }], [{ texto: "   " }], [{ texto: "x".repeat(2001) }], [{ texto: "hola", para: "otro@x.mx" }]])(
    "rechaza el mensaje %j con 400 sin llegar a la base", async (cuerpo) => {
      const { app: a, llamadas, avisos } = app({});
      const r = await request(a).post(`/api/v1/mensajes/${HILO}`).set("Authorization", await bearer(CIUDADANO)).send(cuerpo);
      expect(r.status).toBe(400);
      expect(llamadas).toHaveLength(0);
      expect(avisos).toHaveLength(0);
    },
  );

  it("la lista y la conversación no exponen ids de personas ni correos, aunque la base los enviara", async () => {
    const conDatos = { ...hilo, destinatario_id: randomUUID(), email: "x@correo.mx" };
    const { app: a } = app({ mis_hilos: ok([conDatos]), leer_hilo: ok({ hilo: conDatos, mensajes: [{ ...mensaje, autor_id: CIUDADANO }] }) });
    const lista = await request(a).get("/api/v1/mensajes").set("Authorization", await bearer(CIUDADANO));
    expect(lista.body).toEqual({ datos: [hilo] });
    const una = await request(a).get(`/api/v1/mensajes/${HILO}`).set("Authorization", await bearer(CIUDADANO));
    expect(una.body).toEqual({ hilo, mensajes: [mensaje] });
    expect(JSON.stringify(una.body)).not.toContain(CIUDADANO);
  });

  it("una conversación ajena es un 404 y no avisa", async () => {
    const { app: a, avisos } = app({ responder_hilo: { data: null, error: { code: "P0002", message: "No tienes una conversación con ese id", hint: "publico" } } });
    const r = await request(a).post(`/api/v1/mensajes/${HILO}`).set("Authorization", await bearer(CIUDADANO)).send({ texto: "hola" });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: { mensaje: "No tienes una conversación con ese id" } });
    expect(avisos).toHaveLength(0);
  });

  it("cerrar, reabrir y denunciar llaman a su función", async () => {
    const cerrado = { ...hilo, estado: "cerrado", cerrado_por_mi: true };
    const { app: a, llamadas } = app({ cerrar_hilo: ok(cerrado), reabrir_hilo: ok(hilo), denunciar_hilo: ok(cerrado) });
    const yo = await bearer(CIUDADANO);
    expect((await request(a).post(`/api/v1/mensajes/${HILO}/cerrar`).set("Authorization", yo)).body).toMatchObject({ estado: "cerrado" });
    expect((await request(a).post(`/api/v1/mensajes/${HILO}/reabrir`).set("Authorization", yo)).body).toMatchObject({ estado: "abierto" });
    expect((await request(a).post(`/api/v1/mensajes/${HILO}/denunciar`).set("Authorization", yo).send({ motivo: "corto" })).status).toBe(400);
    expect((await request(a).post(`/api/v1/mensajes/${HILO}/denunciar`).set("Authorization", yo).send({ motivo: " Me escribe cosas ofensivas " })).status).toBe(200);
    expect(llamadas.map((l) => l.nombre)).toEqual(["cerrar_hilo", "reabrir_hilo", "denunciar_hilo"]);
    expect(llamadas[2]?.parametros).toEqual({ hilo_id: HILO, motivo: "Me escribe cosas ofensivas" });
  });

  it("moderación lista denuncias sin correos y las revisa", async () => {
    const denuncia = {
      id: randomUUID(), motivo: "Ofensivo", estado: "pendiente", nota: null, creado_en: F, revisada_en: null,
      denunciante: { id: CIUDADANO, nombre: "Ana", email: "ana@x.mx" },
      hilo: { id: HILO, punto: { id: PUNTO, titulo: "Basura" }, mensajes: [{ id: MENSAJE, texto: "grosería", creado_en: F, autor: { id: EDITOR, nombre: "Beto", email: "beto@x.mx" } }] },
    };
    const { app: a, llamadas } = app({ listar_denuncias_hilos: ok([denuncia]), revisar_denuncia_hilo: ok({ id: denuncia.id, estado: "revisada", nota: "Hablado", revisada_en: F }) });
    const lista = await request(a).get("/api/v1/admin/denuncias-mensajes").set("Authorization", await bearer(MODERADOR));
    expect(lista.status).toBe(200);
    expect(JSON.stringify(lista.body)).not.toMatch(/@x\.mx/);
    const r = await request(a).patch(`/api/v1/admin/denuncias-mensajes/${denuncia.id}`).set("Authorization", await bearer(ADMIN)).send({ nota: " Hablado " });
    expect(r.body).toMatchObject({ estado: "revisada", nota: "Hablado" });
    expect(llamadas[1]?.parametros).toEqual({ denuncia_id: denuncia.id, nota: "Hablado" });
  });
});
