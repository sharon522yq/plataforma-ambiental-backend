import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { crearApp } from "../../src/app.js";
import { ErrorAplicacion } from "../../src/compartido/errores.js";
import type { Perfil } from "../../src/compartido/perfiles.js";
import { crearVerificadorJwt } from "../../src/config/jwt.js";
import { PREGUNTA_DE_PRUEBA } from "../../src/modulos/salud/rutas.js";
import { almacenFalso } from "../ayudas/almacen-falso.js";
import { clienteFalso } from "../ayudas/cliente-falso.js";
import { entornoDePrueba } from "../ayudas/entorno.js";
import { conversacionesFalsas, iaFalsa } from "../ayudas/ia-falsa.js";
import { perfilesFalsos } from "../ayudas/perfiles-falsos.js";
import { rpcFalso } from "../ayudas/rpc-falso.js";
import { EMISOR_PRUEBA, SECRETO_PRUEBA, tokenDePrueba } from "../ayudas/tokens.js";

const CIUDADANO = randomUUID();
const MODERADOR = randomUUID();
const ADMIN = randomUUID();
const tabla: Record<string, Perfil> = {
  [CIUDADANO]: { rol: "ciudadano", activo: true },
  [MODERADOR]: { rol: "moderador", activo: true },
  [ADMIN]: { rol: "administrador", activo: true },
};

function app(opciones: Parameters<typeof iaFalsa>[0] = {}, entorno: Record<string, string> = {}) {
  const falsa = iaFalsa(opciones);
  const registro = conversacionesFalsas();
  const a = crearApp(entornoDePrueba(entorno), {
    publico: clienteFalso({ error: null }),
    verificador: crearVerificadorJwt({ secreto: SECRETO_PRUEBA, emisor: EMISOR_PRUEBA }),
    perfiles: perfilesFalsos(tabla),
    clienteUsuario: () => rpcFalso({}).cliente,
    almacen: almacenFalso().almacen,
    ia: falsa.ia,
    conversaciones: registro.conversaciones,
  });
  return { app: a, preguntas: falsa.preguntas, guardadas: registro.guardadas };
}
const bearer = async (sub: string) => `Bearer ${await tokenDePrueba({ sub })}`;
const RUTA = "/api/v1/agente/consulta";

describe("POST /api/v1/agente/consulta", () => {
  it("responde sin sesión, con aviso de IA, y guarda la conversación como visitante", async () => {
    const { app: a, guardadas } = app({ texto: "Separa orgánicos e inorgánicos." });
    const r = await request(a).post(RUTA).send({ pregunta: "¿Cómo separo la basura?" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ respuesta: "Separa orgánicos e inorgánicos.", modelo: "modelo-prueba", aviso: expect.stringContaining("inteligencia artificial") as unknown });
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(guardadas).toEqual([{ usuario_id: null, pregunta: "¿Cómo separo la basura?", respuesta: "Separa orgánicos e inorgánicos.", modelo: "modelo-prueba" }]);
  });

  it("quita correos y teléfonos antes de enviar a Gemini y de guardar, también de la respuesta", async () => {
    const { app: a, preguntas, guardadas } = app({ texto: "Escribe a quejas@municipio.mx o llama al 33 1234 5678" });
    await request(a).post(RUTA).send({ pregunta: "Soy ana@correo.com, mi cel es 3312345678, ¿a quién denuncio?" });
    expect(preguntas[0]).not.toMatch(/ana@correo\.com|3312345678/);
    expect(JSON.stringify(guardadas)).not.toMatch(/ana@correo\.com|3312345678|quejas@municipio\.mx|1234 5678/);
  });

  it("con sesión guarda el id del usuario; un token inválido es 401", async () => {
    const { app: a, guardadas } = app();
    await request(a).post(RUTA).set("Authorization", await bearer(CIUDADANO)).send({ pregunta: "¿Qué es la composta?" });
    expect(guardadas[0]?.usuario_id).toBe(CIUDADANO);
    expect((await request(a).post(RUTA).set("Authorization", "Bearer basura").send({ pregunta: "¿Qué es la composta?" })).status).toBe(401);
  });

  it.each([
    ["sin pregunta", {}],
    ["con una pregunta muy corta", { pregunta: "a" }],
    ["con una pregunta de más de 1000 caracteres", { pregunta: "a".repeat(1001) }],
    ["con campos de más", { pregunta: "¿Qué es la composta?", modelo: "otro" }],
  ])("400 %s, sin llamar a Gemini", async (_caso, cuerpo) => {
    const { app: a, preguntas } = app();
    expect((await request(a).post(RUTA).send(cuerpo)).status).toBe(400);
    expect(preguntas).toHaveLength(0);
  });

  it("503 si Gemini falla, sin guardar nada ni mostrar la llave", async () => {
    const { app: a, guardadas } = app({ error: new ErrorAplicacion(503, "AGENTE_NO_DISPONIBLE", "El asistente no está disponible, intenta más tarde") });
    const r = await request(a).post(RUTA).send({ pregunta: "¿Qué es la composta?" });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain("llave-gemini-falsa");
    expect(guardadas).toHaveLength(0);
  });

  it("429 al pasar el límite por minuto, sin llamar más a Gemini", async () => {
    const { app: a, preguntas } = app({}, { LIMITE_AGENTE_POR_MINUTO: "2" });
    for (let i = 0; i < 2; i++) expect((await request(a).post(RUTA).send({ pregunta: "¿Qué es la composta?" })).status).toBe(200);
    const r = await request(a).post(RUTA).send({ pregunta: "¿Qué es la composta?" });
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: { codigo: "LIMITE_EXCEDIDO" } });
    expect(preguntas).toHaveLength(2);
  });

  it("el límite cuenta aunque las preguntas sean inválidas (no se puede saturar con basura)", async () => {
    const { app: a } = app({}, { LIMITE_AGENTE_POR_MINUTO: "1" });
    expect((await request(a).post(RUTA).send({})).status).toBe(400);
    expect((await request(a).post(RUTA).send({ pregunta: "¿Qué es la composta?" })).status).toBe(429);
  });
});

describe("GET /api/v1/salud/ia", () => {
  it("401 sin sesión y 403 si no es administrador", async () => {
    const { app: a } = app();
    expect((await request(a).get("/api/v1/salud/ia")).status).toBe(401);
    for (const id of [CIUDADANO, MODERADOR]) {
      expect((await request(a).get("/api/v1/salud/ia").set("Authorization", await bearer(id))).status).toBe(403);
    }
  });

  it("el administrador ve el estado y el modelo, sin la llave", async () => {
    const { app: a } = app({ estado: "no_disponible" }, { GEMINI_MODELO: "gemini-prueba" });
    const r = await request(a).get("/api/v1/salud/ia").set("Authorization", await bearer(ADMIN));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ia: "no_disponible", modelo: "gemini-prueba" });
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("con ?generar=1 pide una respuesta corta real y la muestra", async () => {
    const { app: a, preguntas, guardadas } = app({ texto: "Porque así se puede reciclar más." });
    const r = await request(a).get("/api/v1/salud/ia?generar=1").set("Authorization", await bearer(ADMIN));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ia: "ok", modelo: "modelo-prueba", prueba: "Porque así se puede reciclar más." });
    expect(preguntas).toEqual([PREGUNTA_DE_PRUEBA]);
    // Es una prueba del administrador, no una conversación: no se guarda.
    expect(guardadas).toEqual([]);
  });

  it("sin ?generar=1 no gasta cuota", async () => {
    const { app: a, preguntas } = app();
    await request(a).get("/api/v1/salud/ia").set("Authorization", await bearer(ADMIN));
    expect(preguntas).toEqual([]);
  });

  it("si la generación falla responde 200 con no_disponible y solo el código", async () => {
    const { app: a } = app({ error: new ErrorAplicacion(503, "AGENTE_NO_DISPONIBLE", "x") }, { GEMINI_MODELO: "gemini-prueba" });
    const r = await request(a).get("/api/v1/salud/ia?generar=1").set("Authorization", await bearer(ADMIN));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ia: "no_disponible", modelo: "gemini-prueba", prueba: null, motivo: "AGENTE_NO_DISPONIBLE" });
  });

  it("un error inesperado sigue siendo un 500 sin detalles", async () => {
    const { app: a } = app({ error: new TypeError("fallo interno con llave-secreta") });
    const r = await request(a).get("/api/v1/salud/ia?generar=1").set("Authorization", await bearer(ADMIN));
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("llave-secreta");
  });

  it.each(["generar=si", "generar=1&otro=2"])("400 con ?%s", async (consulta) => {
    const { app: a, preguntas } = app();
    expect((await request(a).get(`/api/v1/salud/ia?${consulta}`).set("Authorization", await bearer(ADMIN))).status).toBe(400);
    expect(preguntas).toEqual([]);
  });

  it("?generar=1 tampoco está abierto a otros roles", async () => {
    const { app: a, preguntas } = app();
    expect((await request(a).get("/api/v1/salud/ia?generar=1").set("Authorization", await bearer(MODERADOR))).status).toBe(403);
    expect(preguntas).toEqual([]);
  });

  it("GET /salud sigue siendo público", async () => {
    const { app: a } = app();
    expect((await request(a).get("/api/v1/salud")).status).toBe(200);
  });
});
