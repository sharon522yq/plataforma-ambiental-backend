import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { crearApp } from "../../src/app.js";
import type { Perfil } from "../../src/compartido/perfiles.js";
import { crearVerificadorJwt } from "../../src/config/jwt.js";
import { clienteFalso } from "../ayudas/cliente-falso.js";
import { entornoDePrueba } from "../ayudas/entorno.js";
import { perfilesFalsos } from "../ayudas/perfiles-falsos.js";
import { ok, rpcFalso } from "../ayudas/rpc-falso.js";
import { EMISOR_PRUEBA, SECRETO_PRUEBA, tokenDePrueba } from "../ayudas/tokens.js";

const CIUDADANO = randomUUID();
const MODERADOR = randomUUID();
const APORTE = randomUUID();
const PUNTO = randomUUID();
const tabla: Record<string, Perfil> = {
  [CIUDADANO]: { rol: "ciudadano", activo: true },
  [MODERADOR]: { rol: "moderador", activo: true },
};

const aporte = {
  id: APORTE, punto_id: null, tipo: "residuos", gravedad_sugerida: 3, descripcion: "Basura acumulada",
  lat: 20.66, lng: -103.35, estado: "pendiente", motivo_revision: null,
  creado_en: "2026-10-22T18:00:00+00:00", actualizado_en: "2026-10-22T18:00:00+00:00",
};
const punto = {
  id: PUNTO, titulo: "Basura", tipo: "residuos", gravedad: 3, descripcion: "x", lat: 20.66, lng: -103.35,
  estado: "en_revision", creado_en: "2026-10-22T18:00:00+00:00", actualizado_en: "2026-10-22T18:00:00+00:00",
};

/** App con un cliente por usuario falso: guarda el token con el que se creó cada cliente. */
function app(respuestas: Parameters<typeof rpcFalso>[0]) {
  const falso = rpcFalso(respuestas);
  const tokens: string[] = [];
  const a = crearApp(entornoDePrueba(), {
    publico: clienteFalso({ error: null }),
    verificador: crearVerificadorJwt({ secreto: SECRETO_PRUEBA, emisor: EMISOR_PRUEBA }),
    perfiles: perfilesFalsos(tabla),
    clienteUsuario: (token) => {
      tokens.push(token);
      return falso.cliente;
    },
  });
  return { app: a, llamadas: falso.llamadas, tokens };
}

const token = (sub: string) => tokenDePrueba({ sub });
const bearer = async (sub: string) => `Bearer ${await token(sub)}`;

const nuevo = { tipo: "residuos", descripcion: "Basura acumulada, llamar al 33 1234 5678", ubicacion: { lat: 20.66, lng: -103.35 } };

describe("permisos de las rutas de aportes y moderación", () => {
  const rutas: [string, string][] = [
    ["post", "/api/v1/aportes"],
    ["get", "/api/v1/aportes/mis"],
    ["get", "/api/v1/admin/aportes"],
    ["patch", `/api/v1/admin/aportes/${APORTE}/revision`],
    ["post", "/api/v1/admin/puntos"],
    ["patch", `/api/v1/admin/puntos/${PUNTO}/estado`],
  ];

  it.each(rutas)("%s %s responde 401 sin sesión, sin llamar a la base", async (metodo, ruta) => {
    const { app: a, llamadas } = app({});
    const r = await request(a)[metodo as "get"](ruta);
    expect(r.status).toBe(401);
    expect(llamadas).toHaveLength(0);
  });

  it.each(rutas.filter(([, ruta]) => ruta.includes("/admin/")))("un ciudadano recibe 403 en %s %s", async (metodo, ruta) => {
    const { app: a, llamadas } = app({});
    const r = await request(a)[metodo as "get"](ruta).set("Authorization", await bearer(CIUDADANO));
    expect(r.status).toBe(403);
    expect(llamadas).toHaveLength(0);
  });

  it("las respuestas con sesión no se guardan en caché", async () => {
    const { app: a } = app({ mis_aportes: ok({ total: 0, datos: [] }) });
    const r = await request(a).get("/api/v1/aportes/mis").set("Authorization", await bearer(CIUDADANO));
    expect(r.headers["cache-control"]).toBe("no-store");
  });
});

describe("POST /api/v1/aportes", () => {
  it("201, quita el teléfono y llama a la base con la sesión del usuario", async () => {
    const { app: a, llamadas, tokens } = app({ crear_aporte: ok(aporte) });
    const t = await token(CIUDADANO);
    const r = await request(a).post("/api/v1/aportes").set("Authorization", `Bearer ${t}`).send({ ...nuevo, gravedad_sugerida: 3 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: APORTE, estado: "pendiente", ubicacion: { lat: 20.66, lng: -103.35 } });
    expect(tokens).toEqual([t]);
    expect(llamadas[0]).toEqual({
      nombre: "crear_aporte",
      parametros: {
        tipo: "residuos", descripcion: "Basura acumulada, llamar al [teléfono eliminado]",
        lat: 20.66, lng: -103.35, gravedad_sugerida: 3, punto_id: null,
      },
    });
  });

  it.each([
    ["con estado (campo no permitido)", { ...nuevo, estado: "aprobado" }],
    ["con autor_id (campo no permitido)", { ...nuevo, autor_id: MODERADOR }],
    ["con descripción muy corta", { ...nuevo, descripcion: "corta" }],
    ["sin ubicación", { tipo: "residuos", descripcion: "Basura acumulada en la esquina" }],
    ["con latitud fuera de rango", { ...nuevo, ubicacion: { lat: 95, lng: 0 } }],
    ["con tipo inexistente", { ...nuevo, tipo: "ruido" }],
  ])("400 %s", async (_caso, cuerpo) => {
    const { app: a, llamadas } = app({});
    const r = await request(a).post("/api/v1/aportes").set("Authorization", await bearer(CIUDADANO)).send(cuerpo);
    expect(r.status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });

  it("400 con el mensaje de la base si el punto indicado no existe", async () => {
    const { app: a } = app({ crear_aporte: { data: null, error: { code: "22023", message: "El punto indicado no existe", hint: "publico" } } });
    const r = await request(a).post("/api/v1/aportes").set("Authorization", await bearer(CIUDADANO)).send({ ...nuevo, punto_id: PUNTO });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { mensaje: "El punto indicado no existe" } });
  });
});

describe("GET /api/v1/aportes/mis", () => {
  it("pagina los aportes propios y no expone quién los revisó", async () => {
    const { app: a, llamadas } = app({ mis_aportes: ok({ total: 1, datos: [{ ...aporte, autor_id: CIUDADANO, revisor_id: MODERADOR }] }) });
    const r = await request(a).get("/api/v1/aportes/mis?limite=5").set("Authorization", await bearer(CIUDADANO));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ paginacion: { pagina: 1, limite: 5, total: 1, paginas: 1 } });
    expect(JSON.stringify(r.body)).not.toMatch(/autor_id|revisor_id/);
    expect(llamadas[0]).toEqual({ nombre: "mis_aportes", parametros: { limite: 5, desplazamiento: 0 } });
  });
});

describe("moderación de aportes", () => {
  it("GET /admin/aportes pide la cola de pendientes por defecto", async () => {
    const enCola = { ...aporte, autor_id: CIUDADANO, revisor_id: null };
    const { app: a, llamadas } = app({ cola_aportes: ok({ total: 1, datos: [enCola] }) });
    const r = await request(a).get("/api/v1/admin/aportes").set("Authorization", await bearer(MODERADOR));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ datos: [{ id: APORTE, autor_id: CIUDADANO }] });
    expect(llamadas[0]?.parametros).toEqual({ estado_filtro: "pendiente", limite: 20, desplazamiento: 0 });
  });

  it("aprobar envía título, gravedad y publicar", async () => {
    const { app: a, llamadas } = app({ revisar_aporte: ok({ ...aporte, estado: "aprobado", punto_id: PUNTO, autor_id: CIUDADANO, revisor_id: MODERADOR }) });
    const r = await request(a)
      .patch(`/api/v1/admin/aportes/${APORTE}/revision`)
      .set("Authorization", await bearer(MODERADOR))
      .send({ decision: "aprobado", titulo: "Basura en la esquina", gravedad: 4 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: "aprobado", punto_id: PUNTO, revisor_id: MODERADOR });
    expect(llamadas[0]?.parametros).toEqual({
      aporte_id: APORTE, decision: "aprobado", motivo: null, titulo: "Basura en la esquina",
      gravedad: 4, publicar: true, duplicado_de: null,
    });
  });

  it.each([
    ["rechazar sin motivo", { decision: "rechazado" }],
    ["duplicado sin el punto original", { decision: "duplicado" }],
    ["una decisión inexistente", { decision: "ignorar" }],
    ["campos de otra decisión", { decision: "rechazado", motivo: "No aplica", titulo: "x" }],
  ])("400 al %s", async (_caso, cuerpo) => {
    const { app: a, llamadas } = app({});
    const r = await request(a).patch(`/api/v1/admin/aportes/${APORTE}/revision`).set("Authorization", await bearer(MODERADOR)).send(cuerpo);
    expect(r.status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });

  it.each([
    ["55000", "El aporte ya fue revisado", 409],
    ["42501", "No puedes revisar tu propio aporte", 403],
    ["P0002", "El aporte no existe", 404],
  ])("traduce el error %s de la base a %i con su mensaje", async (code, message, estado) => {
    const { app: a } = app({ revisar_aporte: { data: null, error: { code, message, hint: "publico" } } });
    const r = await request(a)
      .patch(`/api/v1/admin/aportes/${APORTE}/revision`)
      .set("Authorization", await bearer(MODERADOR))
      .send({ decision: "rechazado", motivo: "No es ambiental" });
    expect(r.status).toBe(estado);
    expect(r.body).toMatchObject({ error: { mensaje: message } });
  });
});

describe("moderación de puntos", () => {
  it("POST /admin/puntos crea en revisión por defecto y limpia la descripción", async () => {
    const { app: a, llamadas } = app({ crear_punto: ok(punto) });
    const r = await request(a)
      .post("/api/v1/admin/puntos")
      .set("Authorization", await bearer(MODERADOR))
      .send({ titulo: "Basura", tipo: "residuos", gravedad: 3, descripcion: "Avisar a ana@correo.com", ubicacion: { lat: 20.66, lng: -103.35 } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: PUNTO, estado: "en_revision", ubicacion: { lat: 20.66, lng: -103.35 } });
    expect(llamadas[0]?.parametros).toMatchObject({ estado: "en_revision", descripcion: "Avisar a [correo eliminado]" });
  });

  it("PATCH /admin/puntos/:id/estado envía el estado y valida el cuerpo", async () => {
    const { app: a, llamadas } = app({ cambiar_estado_punto: ok({ ...punto, estado: "publicado" }) });
    const cabecera = await bearer(MODERADOR);
    const r = await request(a).patch(`/api/v1/admin/puntos/${PUNTO}/estado`).set("Authorization", cabecera).send({ estado: "publicado" });
    expect(r.status).toBe(200);
    expect(llamadas[0]).toEqual({ nombre: "cambiar_estado_punto", parametros: { punto_id: PUNTO, estado: "publicado" } });
    expect((await request(a).patch(`/api/v1/admin/puntos/${PUNTO}/estado`).set("Authorization", cabecera).send({ estado: "borrado" })).status).toBe(400);
    expect((await request(a).patch("/api/v1/admin/puntos/abc/estado").set("Authorization", cabecera).send({ estado: "publicado" })).status).toBe(400);
  });
});
