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

/** Rutas de fuentes en reportes y casos (migración 020), con la base simulada. */
const CIUDADANO = randomUUID();
const MODERADOR = randomUUID();
const APORTE = randomUUID();
const PUNTO = randomUUID();
const tabla: Record<string, Perfil> = {
  [CIUDADANO]: { rol: "ciudadano", activo: true },
  [MODERADOR]: { rol: "moderador", activo: true },
};
const NOTA = "https://www.e-consulta.com/sociedad/nota";

const aporte = {
  id: APORTE, punto_id: null, titulo: "Basura en el canal", tipo: "residuos", gravedad_sugerida: 3,
  descripcion: "Basura acumulada junto al canal", lat: 20.66, lng: -103.35, estado: "pendiente", motivo_revision: null,
  creado_en: "2026-11-18T18:00:00+00:00", actualizado_en: "2026-11-18T18:00:00+00:00",
};
const punto = {
  id: PUNTO, titulo: "Basura en el canal", tipo: "residuos", gravedad: 3, descripcion: "Basura acumulada junto al canal",
  lat: 20.66, lng: -103.35, estado: "publicado", creado_en: "2026-11-18T18:00:00+00:00", actualizado_en: "2026-11-18T18:00:00+00:00",
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
const nuevo = { tipo: "residuos", titulo: "Basura en el canal", descripcion: "Basura acumulada junto al canal", ubicacion: { lat: 20.66, lng: -103.35 } };

describe("fuentes al reportar", () => {
  it("envía las fuentes con el nombre sin datos personales y las devuelve", async () => {
    const guardadas = [{ enlace: NOTA, nombre: "e-consulta" }];
    const { app: a, llamadas } = app({ crear_aporte: ok({ ...aporte, fuentes: guardadas }) });
    const r = await request(a).post("/api/v1/aportes").set("Authorization", await bearer(CIUDADANO))
      .send({ ...nuevo, fuentes: [{ enlace: NOTA, nombre: " e-consulta, tel 33 1234 5678 " }, { enlace: "https://www.gob.mx/profepa" }] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ fuentes: guardadas });
    expect(llamadas[0]?.parametros.fuentes).toEqual([
      { enlace: NOTA, nombre: "e-consulta, tel [teléfono eliminado]" },
      { enlace: "https://www.gob.mx/profepa" },
    ]);
  });

  it("sin fuentes no manda el parámetro y la respuesta trae una lista vacía", async () => {
    const { app: a, llamadas } = app({ crear_aporte: ok(aporte) });
    const r = await request(a).post("/api/v1/aportes").set("Authorization", await bearer(CIUDADANO)).send({ ...nuevo, fuentes: [] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ fuentes: [] });
    expect(llamadas[0]?.parametros).not.toHaveProperty("fuentes");
  });

  it.each([
    ["un enlace http", [{ enlace: "http://ejemplo.org" }]],
    ["una fuente sin enlace", [{ nombre: "Solo nombre" }]],
    ["un campo extra", [{ enlace: NOTA, tipo: "nota" }]],
    ["más de 5 fuentes", Array.from({ length: 6 }, (_v, i) => ({ enlace: `https://ejemplo.org/${String(i)}` }))],
  ])("400 con %s, sin llamar a la base", async (_caso, fuentes) => {
    const { app: a, llamadas } = app({});
    const r = await request(a).post("/api/v1/aportes").set("Authorization", await bearer(CIUDADANO)).send({ ...nuevo, fuentes });
    expect(r.status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });
});

describe("editar las fuentes", () => {
  it("solo fuentes en un reporte pendiente: lo demás va como null", async () => {
    const { app: a, llamadas } = app({ editar_aporte: ok({ ...aporte, fuentes: [{ enlace: NOTA }] }) });
    const r = await request(a).patch(`/api/v1/aportes/${APORTE}`).set("Authorization", await bearer(CIUDADANO)).send({ fuentes: [{ enlace: NOTA }] });
    expect(r.status).toBe(200);
    expect(llamadas[0]).toEqual({ nombre: "editar_aporte", parametros: { aporte_id: APORTE, titulo: null, descripcion: null, fuentes: [{ enlace: NOTA }] } });
  });

  it("una lista vacía en mi caso quita las fuentes", async () => {
    const { app: a, llamadas } = app({ editar_mi_punto: ok({ ...punto, estado: "en_revision", fuentes: [] }) });
    const r = await request(a).patch(`/api/v1/aportes/mis-casos/${PUNTO}`).set("Authorization", await bearer(CIUDADANO)).send({ fuentes: [] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: "en_revision", fuentes: [] });
    expect(llamadas[0]?.parametros).toEqual({ punto_id: PUNTO, titulo: null, descripcion: null, fuentes: [] });
  });

  it("moderación reemplaza las fuentes de un caso", async () => {
    const { app: a, llamadas } = app({ editar_fuentes_punto: ok({ ...punto, fuentes: [{ enlace: NOTA, nombre: "e-consulta" }] }) });
    const r = await request(a).patch(`/api/v1/admin/puntos/${PUNTO}/fuentes`).set("Authorization", await bearer(MODERADOR))
      .send({ fuentes: [{ enlace: NOTA, nombre: "e-consulta" }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: "publicado", fuentes: [{ enlace: NOTA, nombre: "e-consulta" }] });
    expect(llamadas[0]).toEqual({ nombre: "editar_fuentes_punto", parametros: { punto_id: PUNTO, fuentes: [{ enlace: NOTA, nombre: "e-consulta" }] } });
  });

  it.each([
    ["sin la lista", {}],
    ["con más de 10", { fuentes: Array.from({ length: 11 }, (_v, i) => ({ enlace: `https://ejemplo.org/${String(i)}` })) }],
    ["con un enlace javascript:", { fuentes: [{ enlace: "javascript:alert(1)" }] }],
  ])("moderación: 400 %s", async (_caso, cuerpo) => {
    const { app: a, llamadas } = app({});
    const r = await request(a).patch(`/api/v1/admin/puntos/${PUNTO}/fuentes`).set("Authorization", await bearer(MODERADOR)).send(cuerpo);
    expect(r.status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });

  it("un ciudadano recibe 403 al editar las fuentes de un caso", async () => {
    const { app: a, llamadas } = app({});
    const r = await request(a).patch(`/api/v1/admin/puntos/${PUNTO}/fuentes`).set("Authorization", await bearer(CIUDADANO)).send({ fuentes: [] });
    expect(r.status).toBe(403);
    expect(llamadas).toHaveLength(0);
  });

  it("403 con el mensaje de la base si el caso está archivado", async () => {
    const { app: a } = app({ editar_fuentes_punto: { data: null, error: { code: "42501", message: "No tienes permiso para editar este caso", hint: "publico" } } });
    const r = await request(a).patch(`/api/v1/admin/puntos/${PUNTO}/fuentes`).set("Authorization", await bearer(MODERADOR)).send({ fuentes: [] });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { mensaje: "No tienes permiso para editar este caso" } });
  });
});
