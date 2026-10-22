import request from "supertest";
import { describe, expect, it } from "vitest";
import { crearApp } from "../../src/app.js";
import { entornoDePrueba } from "../ayudas/entorno.js";
import { perfilesFalsos } from "../ayudas/perfiles-falsos.js";
import { ok, rpcFalso } from "../ayudas/rpc-falso.js";

const ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ORG = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

const punto = {
  id: ID,
  titulo: "Descarga en arroyo",
  tipo: "contaminacion_agua",
  gravedad: 3,
  descripcion: "Espuma en la orilla",
  lat: 20.64,
  lng: -103.29,
  creado_en: "2026-10-22T18:00:00+00:00",
  actualizado_en: "2026-10-22T18:00:00+00:00",
};

function app(respuestas: Parameters<typeof rpcFalso>[0]) {
  const { cliente, llamadas } = rpcFalso(respuestas);
  return { app: crearApp(entornoDePrueba(), { publico: cliente, perfiles: perfilesFalsos({}) }), llamadas };
}

describe("GET /api/v1/puntos", () => {
  it("devuelve la página con coordenadas agrupadas y datos de paginación", async () => {
    const { app: a, llamadas } = app({ listar_puntos_publicos: ok({ total: 21, datos: [punto] }) });
    const r = await request(a).get("/api/v1/puntos?pagina=2&limite=10&tipo=contaminacion_agua&gravedad_min=3");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      datos: [
        {
          id: ID, titulo: punto.titulo, tipo: punto.tipo, gravedad: 3, descripcion: punto.descripcion,
          ubicacion: { lat: 20.64, lng: -103.29 },
          creado_en: punto.creado_en, actualizado_en: punto.actualizado_en,
        },
      ],
      paginacion: { pagina: 2, limite: 10, total: 21, paginas: 3 },
    });
    expect(llamadas).toEqual([
      { nombre: "listar_puntos_publicos", parametros: { tipo_filtro: "contaminacion_agua", gravedad_minima: 3, limite: 10, desplazamiento: 10 } },
    ]);
  });

  it("usa pagina 1 y limite 20 por defecto, sin filtros", async () => {
    const { app: a, llamadas } = app({ listar_puntos_publicos: ok({ total: 0, datos: [] }) });
    const r = await request(a).get("/api/v1/puntos");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ datos: [], paginacion: { pagina: 1, limite: 20, total: 0, paginas: 0 } });
    expect(llamadas[0]?.parametros).toEqual({ tipo_filtro: null, gravedad_minima: null, limite: 20, desplazamiento: 0 });
  });

  it("descarta campos internos aunque la base los devuelva", async () => {
    const conInternos = { ...punto, autor_id: ORG, aprobado_por: ORG, estado: "publicado", contacto: "x" };
    const { app: a } = app({ listar_puntos_publicos: ok({ total: 1, datos: [conInternos] }) });
    const texto = JSON.stringify((await request(a).get("/api/v1/puntos")).body);
    expect(texto).not.toMatch(/autor_id|aprobado_por|estado|contacto/);
  });

  it.each([
    ["limite mayor a 100", "limite=101"],
    ["limite 0", "limite=0"],
    ["pagina 0", "pagina=0"],
    ["pagina con texto", "pagina=dos"],
    ["tipo inexistente", "tipo=ruido"],
    ["gravedad fuera de 1 a 5", "gravedad_min=6"],
  ])("400 con %s, sin llamar a la base", async (_caso, query) => {
    const { app: a, llamadas } = app({});
    const r = await request(a).get(`/api/v1/puntos?${query}`);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { codigo: "SOLICITUD_INVALIDA" } });
    expect(llamadas).toHaveLength(0);
  });

  it("marca la respuesta como cacheable un minuto", async () => {
    const { app: a } = app({ listar_puntos_publicos: ok({ total: 0, datos: [] }) });
    expect((await request(a).get("/api/v1/puntos")).headers["cache-control"]).toBe("public, max-age=60");
  });

  it("500 sin detalles si la base falla", async () => {
    const { app: a } = app({ listar_puntos_publicos: { data: null, error: { code: "57P01", message: "terminating connection 10.0.0.1" } } });
    const r = await request(a).get("/api/v1/puntos");
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/terminating|10\.0\.0\.1|listar_puntos/);
  });

  it("500 si la base devuelve algo con forma inesperada", async () => {
    const { app: a } = app({ listar_puntos_publicos: ok({ datos: "no es una lista" }) });
    expect((await request(a).get("/api/v1/puntos")).status).toBe(500);
  });
});

describe("GET /api/v1/puntos/cercanos", () => {
  const cercano = { id: ID, titulo: "x", tipo: "residuos", gravedad: 2, lat: 20.6, lng: -103.3, distancia_metros: 1234.5 };

  it("envía lat, lng, radio y límite a la base y agrupa coordenadas", async () => {
    const { app: a, llamadas } = app({ puntos_cercanos_publicos: ok([cercano]) });
    const r = await request(a).get("/api/v1/puntos/cercanos?lat=20.65&lng=-103.35&radio=10000&tipo=residuos&limite=5");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      datos: [{ id: ID, titulo: "x", tipo: "residuos", gravedad: 2, distancia_metros: 1234.5, ubicacion: { lat: 20.6, lng: -103.3 } }],
    });
    expect(llamadas[0]).toEqual({
      nombre: "puntos_cercanos_publicos",
      parametros: { lat: 20.65, lng: -103.35, radio_metros: 10000, tipo_filtro: "residuos", limite: 5 },
    });
  });

  it("usa radio de 5000 m y límite 20 por defecto", async () => {
    const { app: a, llamadas } = app({ puntos_cercanos_publicos: ok([]) });
    await request(a).get("/api/v1/puntos/cercanos?lat=20.65&lng=-103.35");
    expect(llamadas[0]?.parametros).toMatchObject({ radio_metros: 5000, limite: 20 });
  });

  it.each([
    ["sin lat", "lng=-103"],
    ["sin lng", "lat=20"],
    ["lat fuera de rango", "lat=91&lng=0"],
    ["lng fuera de rango", "lat=0&lng=181"],
    ["radio mayor a 50 km", "lat=0&lng=0&radio=50001"],
    ["coordenadas con texto", "lat=norte&lng=0"],
  ])("400 %s", async (_caso, query) => {
    const { app: a, llamadas } = app({});
    expect((await request(a).get(`/api/v1/puntos/cercanos?${query}`)).status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });

  it("400 si la base rechaza un parámetro (código 22023)", async () => {
    const { app: a } = app({ puntos_cercanos_publicos: { data: null, error: { code: "22023", message: "Coordenadas fuera de rango" } } });
    const r = await request(a).get("/api/v1/puntos/cercanos?lat=20&lng=-103");
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { codigo: "SOLICITUD_INVALIDA", mensaje: "Coordenadas fuera de rango" } });
  });
});

describe("GET /api/v1/puntos/:id", () => {
  it("devuelve el punto con sus acciones", async () => {
    const accion = { id: ORG, tipo: "denuncia", nombre: "Denunciar", descripcion: null, enlace: "https://ejemplo.org" };
    const { app: a, llamadas } = app({ obtener_punto_publico: ok({ ...punto, acciones: [accion] }) });
    const r = await request(a).get(`/api/v1/puntos/${ID}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ID, ubicacion: { lat: 20.64, lng: -103.29 }, acciones: [accion] });
    expect(llamadas[0]).toEqual({ nombre: "obtener_punto_publico", parametros: { punto_id: ID } });
  });

  it("404 si no existe o no está publicado", async () => {
    const { app: a } = app({ obtener_punto_publico: ok(null) });
    const r = await request(a).get(`/api/v1/puntos/${ID}`);
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: { codigo: "NO_ENCONTRADO" } });
  });

  it("400 si el id no es un uuid", async () => {
    const { app: a, llamadas } = app({});
    expect((await request(a).get("/api/v1/puntos/123")).status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });
});

describe("GET /api/v1/acciones", () => {
  const accion = { id: ID, tipo: "firma", nombre: "Firmar", descripcion: "x", enlace: null, punto_id: null, organizacion: { id: ORG, nombre: "Colectivo" } };

  it("devuelve la página y envía los filtros", async () => {
    const { app: a, llamadas } = app({ listar_acciones_publicas: ok({ total: 1, datos: [accion] }) });
    const r = await request(a).get(`/api/v1/acciones?tipo=firma&punto_id=${ID}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ datos: [accion], paginacion: { pagina: 1, limite: 20, total: 1, paginas: 1 } });
    expect(llamadas[0]?.parametros).toEqual({ tipo_filtro: "firma", punto: ID, limite: 20, desplazamiento: 0 });
  });

  it("400 con tipo inexistente o punto_id inválido", async () => {
    const { app: a } = app({});
    expect((await request(a).get("/api/v1/acciones?tipo=marcha")).status).toBe(400);
    expect((await request(a).get("/api/v1/acciones?punto_id=abc")).status).toBe(400);
  });
});

describe("GET /api/v1/organizaciones", () => {
  it("devuelve organizaciones sin contacto aunque la base lo incluya", async () => {
    const { app: a, llamadas } = app({
      listar_organizaciones_publicas: ok({ total: 1, datos: [{ id: ORG, nombre: "Colectivo", zona: "Tlaquepaque", contacto: "55 1234" }] }),
    });
    const r = await request(a).get("/api/v1/organizaciones?zona=tlaque");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      datos: [{ id: ORG, nombre: "Colectivo", zona: "Tlaquepaque" }],
      paginacion: { pagina: 1, limite: 20, total: 1, paginas: 1 },
    });
    expect(llamadas[0]?.parametros).toEqual({ zona_filtro: "tlaque", limite: 20, desplazamiento: 0 });
  });

  it("400 con zona demasiado larga", async () => {
    const { app: a } = app({});
    expect((await request(a).get(`/api/v1/organizaciones?zona=${"x".repeat(81)}`)).status).toBe(400);
  });
});
