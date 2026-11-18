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

/** Rutas de edición de casos (migración 019), con la base simulada. */
const CIUDADANO = randomUUID();
const MODERADOR = randomUUID();
const APORTE = randomUUID();
const PUNTO = randomUUID();
const tabla: Record<string, Perfil> = {
  [CIUDADANO]: { rol: "ciudadano", activo: true },
  [MODERADOR]: { rol: "moderador", activo: true },
};

const aporte = {
  id: APORTE, punto_id: null, titulo: "Basura en el canal", tipo: "residuos", gravedad_sugerida: 3,
  descripcion: "Basura acumulada junto al canal", lat: 20.66, lng: -103.35, estado: "pendiente", motivo_revision: null,
  creado_en: "2026-11-18T18:00:00+00:00", actualizado_en: "2026-11-18T18:00:00+00:00",
};
const punto = {
  id: PUNTO, titulo: "Basura en el canal", tipo: "residuos", gravedad: 3, descripcion: "Basura acumulada junto al canal",
  lat: 20.66, lng: -103.35, estado: "en_revision", creado_en: "2026-11-18T18:00:00+00:00", actualizado_en: "2026-11-18T18:00:00+00:00",
};

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
    almacen: almacenFalso().almacen,
  });
  return { app: a, llamadas: falso.llamadas, tokens };
}
const bearer = async (sub: string) => `Bearer ${await tokenDePrueba({ sub })}`;

describe("PATCH /api/v1/aportes/:id (reporte pendiente)", () => {
  it("envía solo lo que cambia, sin datos personales, con la sesión del usuario", async () => {
    const { app: a, llamadas } = app({ editar_aporte: ok(aporte) });
    const r = await request(a).patch(`/api/v1/aportes/${APORTE}`).set("Authorization", await bearer(CIUDADANO))
      .send({ descripcion: "  Basura acumulada, llamar al 33 1234 5678  " });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: APORTE, titulo: "Basura en el canal", ubicacion: { lat: 20.66, lng: -103.35 } });
    expect(llamadas[0]).toEqual({
      nombre: "editar_aporte",
      parametros: { aporte_id: APORTE, titulo: null, descripcion: "Basura acumulada, llamar al [teléfono eliminado]", fuentes: null },
    });
  });

  it.each([
    ["vacío", {}],
    ["con título corto", { titulo: "ab" }],
    ["con descripción corta", { descripcion: "corta" }],
    ["con un campo no permitido", { titulo: "Título válido", estado: "aprobado" }],
  ])("400 %s, sin llamar a la base", async (_caso, cuerpo) => {
    const { app: a, llamadas } = app({});
    const r = await request(a).patch(`/api/v1/aportes/${APORTE}`).set("Authorization", await bearer(CIUDADANO)).send(cuerpo);
    expect(r.status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });

  it("409 con el mensaje de la base si el reporte ya se revisó", async () => {
    const { app: a } = app({ editar_aporte: { data: null, error: { code: "55000", message: "Solo puedes editar un reporte pendiente", hint: "publico" } } });
    const r = await request(a).patch(`/api/v1/aportes/${APORTE}`).set("Authorization", await bearer(CIUDADANO)).send({ titulo: "Nuevo título" });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: { mensaje: "Solo puedes editar un reporte pendiente" } });
  });
});

describe("mis casos", () => {
  it("GET /aportes/mis-casos pagina los casos propios", async () => {
    const { app: a, llamadas } = app({ mis_puntos: ok({ total: 1, datos: [punto] }) });
    const r = await request(a).get("/api/v1/aportes/mis-casos?limite=10").set("Authorization", await bearer(CIUDADANO));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ datos: [{ id: PUNTO, estado: "en_revision", ubicacion: { lat: 20.66 } }], paginacion: { total: 1 } });
    expect(llamadas[0]).toEqual({ nombre: "mis_puntos", parametros: { limite: 10, desplazamiento: 0 } });
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("PATCH /aportes/mis-casos/:id recorta el título a 120 después de quitar un correo", async () => {
    const { app: a, llamadas } = app({ editar_mi_punto: ok(punto) });
    const titulo = "x".repeat(113) + " a@b.co";
    const r = await request(a).patch(`/api/v1/aportes/mis-casos/${PUNTO}`).set("Authorization", await bearer(CIUDADANO)).send({ titulo });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: "en_revision" });
    const enviado = llamadas[0]?.parametros.titulo as string;
    expect(Array.from(enviado).length).toBeLessThanOrEqual(120);
    expect(enviado).not.toContain("a@b.co");
    expect(llamadas[0]?.parametros).toMatchObject({ punto_id: PUNTO, descripcion: null });
  });

  it("404 si el caso no es suyo", async () => {
    const { app: a } = app({ editar_mi_punto: { data: null, error: { code: "P0002", message: "El caso no existe", hint: "publico" } } });
    const r = await request(a).patch(`/api/v1/aportes/mis-casos/${PUNTO}`).set("Authorization", await bearer(CIUDADANO)).send({ titulo: "Otro título" });
    expect(r.status).toBe(404);
  });
});

describe("moderación de casos", () => {
  it("GET /admin/puntos lista los casos en revisión por defecto", async () => {
    const { app: a, llamadas } = app({ cola_puntos: ok({ total: 1, datos: [punto] }) });
    const r = await request(a).get("/api/v1/admin/puntos").set("Authorization", await bearer(MODERADOR));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ datos: [{ id: PUNTO }] });
    expect(llamadas[0]).toEqual({ nombre: "cola_puntos", parametros: { estado_filtro: "en_revision", limite: 20, desplazamiento: 0 } });
  });

  it("PATCH /admin/puntos/:id/titulo envía el título limpio", async () => {
    const { app: a, llamadas } = app({ editar_titulo_punto: ok({ ...punto, estado: "publicado" }) });
    const r = await request(a).patch(`/api/v1/admin/puntos/${PUNTO}/titulo`).set("Authorization", await bearer(MODERADOR))
      .send({ titulo: "  Basura en el canal norte  " });
    expect(r.status).toBe(200);
    expect(llamadas[0]).toEqual({ nombre: "editar_titulo_punto", parametros: { punto_id: PUNTO, titulo: "Basura en el canal norte" } });
  });

  it.each([
    ["sin título", {}],
    ["con título corto", { titulo: "ab" }],
    ["con otro campo", { titulo: "Título válido", estado: "publicado" }],
  ])("PATCH /admin/puntos/:id/titulo: 400 %s", async (_caso, cuerpo) => {
    const { app: a, llamadas } = app({});
    const r = await request(a).patch(`/api/v1/admin/puntos/${PUNTO}/titulo`).set("Authorization", await bearer(MODERADOR)).send(cuerpo);
    expect(r.status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });

  it("un ciudadano recibe 403 en las rutas de moderación", async () => {
    const { app: a, llamadas } = app({});
    const t = await bearer(CIUDADANO);
    expect((await request(a).get("/api/v1/admin/puntos").set("Authorization", t)).status).toBe(403);
    expect((await request(a).patch(`/api/v1/admin/puntos/${PUNTO}/titulo`).set("Authorization", t).send({ titulo: "Intento" })).status).toBe(403);
    expect(llamadas).toHaveLength(0);
  });
});
