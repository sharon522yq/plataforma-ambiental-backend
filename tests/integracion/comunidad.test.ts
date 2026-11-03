import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { crearApp } from "../../src/app.js";
import type { Perfil } from "../../src/compartido/perfiles.js";
import { crearVerificadorJwt } from "../../src/config/jwt.js";
import { almacenFalso } from "../ayudas/almacen-falso.js";
import { clienteFalso } from "../ayudas/cliente-falso.js";
import { entornoDePrueba } from "../ayudas/entorno.js";
import { perfilesFalsos } from "../ayudas/perfiles-falsos.js";
import { ok, rpcFalso } from "../ayudas/rpc-falso.js";
import { EMISOR_PRUEBA, SECRETO_PRUEBA, tokenDePrueba } from "../ayudas/tokens.js";

const CIUDADANO = randomUUID();
const MODERADOR = randomUUID();
const PUNTO = randomUUID();
const ACCION = randomUUID();
const tabla: Record<string, Perfil> = {
  [CIUDADANO]: { rol: "ciudadano", activo: true },
  [MODERADOR]: { rol: "moderador", activo: true },
};

/** Misma forma que accion_json de la migración 012. */
const accion = {
  id: ACCION, tipo: "evento", nombre: "Jornada de limpieza", descripcion: null, enlace: "https://ejemplo.org/evento",
  organizacion_id: null, punto_id: PUNTO, activa: true, de_la_comunidad: true,
  creado_en: "2026-11-03T18:00:00+00:00", actualizado_en: "2026-11-03T18:00:00+00:00",
};
const aporte = {
  id: randomUUID(), punto_id: null, tipo: "residuos", gravedad_sugerida: null, descripcion: "Basura acumulada",
  lat: 20.66, lng: -103.35, estado: "pendiente", motivo_revision: null, evidencia_ruta: null,
  enlaces: [{ tipo: "firma", nombre: "Firma por el parque", enlace: "https://ejemplo.org/firma" }],
  creado_en: "2026-11-03T18:00:00+00:00", actualizado_en: "2026-11-03T18:00:00+00:00",
};

function app(respuestas: Parameters<typeof rpcFalso>[0]) {
  const falso = rpcFalso(respuestas);
  const a = crearApp(entornoDePrueba(), {
    publico: clienteFalso({ error: null }),
    verificador: crearVerificadorJwt({ secreto: SECRETO_PRUEBA, emisor: EMISOR_PRUEBA }),
    perfiles: perfilesFalsos(tabla),
    clienteUsuario: () => falso.cliente,
    almacen: almacenFalso().almacen,
  });
  return { app: a, llamadas: falso.llamadas };
}
const bearer = async (sub: string) => `Bearer ${await tokenDePrueba({ sub })}`;
const enlace = { tipo: "evento", nombre: "Jornada de limpieza", enlace: "https://ejemplo.org/evento" };

describe("POST /puntos/:id/acciones (enlaces de la comunidad)", () => {
  it("201 para cualquier cuenta activa, sin caché, con los datos limpios", async () => {
    const { app: a, llamadas } = app({ proponer_accion: ok(accion) });
    const r = await request(a).post(`/api/v1/puntos/${PUNTO}/acciones`).set("Authorization", await bearer(CIUDADANO))
      .send({ ...enlace, nombre: "  Jornada de limpieza  " });
    expect(r.status).toBe(201);
    expect(r.headers["cache-control"]).toContain("no-store");
    expect(r.body).toMatchObject({ id: ACCION, tipo: "evento", de_la_comunidad: true });
    expect(llamadas).toEqual([{ nombre: "proponer_accion", parametros: { punto_id: PUNTO, ...enlace, descripcion: null } }]);
  });

  it("401 sin sesión y sin llamar a la base", async () => {
    const { app: a, llamadas } = app({});
    const r = await request(a).post(`/api/v1/puntos/${PUNTO}/acciones`).send(enlace);
    expect(r.status).toBe(401);
    expect(llamadas).toHaveLength(0);
  });

  it.each([
    ["un enlace http", { ...enlace, enlace: "http://ejemplo.org" }],
    ["un enlace javascript:", { ...enlace, enlace: "javascript:alert(1)" }],
    ["un tipo inexistente", { ...enlace, tipo: "rifa" }],
    ["un nombre corto", { ...enlace, nombre: "x" }],
    ["un campo de más", { ...enlace, autor_id: CIUDADANO }],
  ])("400 con %s", async (_caso, cuerpo) => {
    const { app: a, llamadas } = app({});
    const r = await request(a).post(`/api/v1/puntos/${PUNTO}/acciones`).set("Authorization", await bearer(CIUDADANO)).send(cuerpo);
    expect(r.status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });

  it.each([
    ["P0002", "El punto no existe o no está publicado", 404],
    ["55000", "Ese enlace ya está en este punto", 409],
    ["55000", "Llegaste al límite de 10 enlaces por día", 409],
  ])("traduce el error %s de la base", async (code, message, estado) => {
    const { app: a } = app({ proponer_accion: { data: null, error: { code, message, hint: "publico" } } });
    const r = await request(a).post(`/api/v1/puntos/${PUNTO}/acciones`).set("Authorization", await bearer(CIUDADANO)).send(enlace);
    expect(r.status).toBe(estado);
    expect((r.body as { error: { mensaje: string } }).error.mensaje).toBe(message);
  });
});

describe("DELETE /admin/acciones/:id (retirar un enlace)", () => {
  it("un moderador lo retira", async () => {
    const { app: a, llamadas } = app({ retirar_accion: ok({ ...accion, activa: false }) });
    const r = await request(a).delete(`/api/v1/admin/acciones/${ACCION}`).set("Authorization", await bearer(MODERADOR));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ACCION, activa: false });
    expect(llamadas).toEqual([{ nombre: "retirar_accion", parametros: { accion_id: ACCION } }]);
  });

  it("un ciudadano recibe 403 y 400 con un id que no es uuid", async () => {
    const { app: a, llamadas } = app({});
    expect((await request(a).delete(`/api/v1/admin/acciones/${ACCION}`).set("Authorization", await bearer(CIUDADANO))).status).toBe(403);
    expect((await request(a).delete("/api/v1/admin/acciones/abc").set("Authorization", await bearer(MODERADOR))).status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });
});

describe("enlaces en POST /aportes", () => {
  it("envía los enlaces validados a crear_aporte y los devuelve", async () => {
    const { app: a, llamadas } = app({ crear_aporte: ok(aporte) });
    const r = await request(a).post("/api/v1/aportes").set("Authorization", await bearer(CIUDADANO)).send({
      tipo: "residuos", descripcion: "Basura acumulada", ubicacion: { lat: 20.66, lng: -103.35 }, enlaces: aporte.enlaces,
    });
    expect(r.status).toBe(201);
    expect((r.body as { enlaces: unknown }).enlaces).toEqual(aporte.enlaces);
    expect(llamadas[0]?.parametros.enlaces).toEqual(aporte.enlaces);
  });

  it("sin enlaces no manda el parámetro (funciona aunque la base no tenga la 012)", async () => {
    const { app: a, llamadas } = app({ crear_aporte: ok({ ...aporte, enlaces: undefined }) });
    const r = await request(a).post("/api/v1/aportes").set("Authorization", await bearer(CIUDADANO))
      .send({ tipo: "residuos", descripcion: "Basura acumulada", ubicacion: { lat: 20.66, lng: -103.35 } });
    expect(r.status).toBe(201);
    expect((r.body as { enlaces: unknown }).enlaces).toEqual([]);
    expect(llamadas[0]?.parametros).not.toHaveProperty("enlaces");
  });

  it("400 con más de 3 enlaces o uno sin https", async () => {
    const { app: a, llamadas } = app({});
    const base = { tipo: "residuos", descripcion: "Basura acumulada", ubicacion: { lat: 20.66, lng: -103.35 } };
    const e = aporte.enlaces[0];
    for (const enlaces of [[e, e, e, e], [{ ...e, enlace: "http://ejemplo.org" }]]) {
      const r = await request(a).post("/api/v1/aportes").set("Authorization", await bearer(CIUDADANO)).send({ ...base, enlaces });
      expect(r.status).toBe(400);
    }
    expect(llamadas).toHaveLength(0);
  });
});
