import { afterEach, describe, expect, it, vi } from "vitest";
import { crearHerramientas, DECLARACIONES } from "../../src/modulos/agente/herramientas.js";
import { ok, rpcFalso } from "../ayudas/rpc-falso.js";

const ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ID2 = "7a1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const ORG = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SIN_UBICACION = { ubicacion: null };
const CASA = { ubicacion: { lat: 20.6767, lng: -103.3475 } };

const resumen = {
  id: ID,
  titulo: "Descarga en arroyo",
  tipo: "contaminacion_agua",
  gravedad: 3,
  descripcion: "Espuma ".repeat(60),
  lat: 20.64,
  lng: -103.29,
  creado_en: "2026-10-22T18:00:00+00:00",
  actualizado_en: "2026-10-22T18:00:00+00:00",
};
const cercano = (id: string, gravedad: number, distancia: number) => ({ id, titulo: `Punto ${id.slice(0, 2)}`, tipo: "residuos", gravedad, lat: 20.7, lng: -103.3, distancia_metros: distancia });

describe("herramientas del agente", () => {
  const espia = vi.spyOn(console, "error").mockImplementation(() => undefined);
  afterEach(() => espia.mockClear());

  it("declara cuatro herramientas con nombre, descripción y parámetros", () => {
    expect(DECLARACIONES.map((d) => d.name)).toEqual(["buscar_puntos", "detalle_punto", "buscar_acciones", "buscar_organizaciones"]);
    for (const d of DECLARACIONES) {
      expect(d.description.length).toBeGreaterThan(20);
      expect(d.parameters).toMatchObject({ type: "object" });
    }
  });

  describe("buscar_puntos", () => {
    it("sin lugar lista los publicados con filtros y recorta la descripción", async () => {
      const { cliente, llamadas } = rpcFalso({ listar_puntos_publicos: ok({ total: 14, datos: [resumen] }) });
      const r = await crearHerramientas(cliente).ejecutar("buscar_puntos", { tipo: "contaminacion_agua", gravedad_minima: 3, otra: "x" }, SIN_UBICACION);
      expect(llamadas).toEqual([
        { nombre: "listar_puntos_publicos", parametros: { tipo_filtro: "contaminacion_agua", gravedad_minima: 3, limite: 10, desplazamiento: 0 } },
      ]);
      expect(r.respuesta).toMatchObject({ total: 14, mostrados: 1, puntos: [{ id: ID, titulo: "Descarga en arroyo", gravedad: 3 }] });
      const desc = (r.respuesta.puntos as { descripcion: string }[])[0]?.descripcion ?? "";
      expect(desc).toHaveLength(240);
      expect(desc.endsWith("…")).toBe(true);
      expect(r.puntos).toEqual([{ id: ID, titulo: "Descarga en arroyo", tipo: "contaminacion_agua", gravedad: 3, ubicacion: { lat: 20.64, lng: -103.29 } }]);
    });

    it("cerca_de_mi usa la ubicación del usuario sin devolvérsela al modelo, y filtra por gravedad", async () => {
      const { cliente, llamadas } = rpcFalso({
        puntos_cercanos_publicos: ok([cercano(ID, 2, 1234), cercano(ID2, 4, 5678)]),
      });
      const r = await crearHerramientas(cliente).ejecutar("buscar_puntos", { cerca_de_mi: true, gravedad_minima: 3, tipo: "residuos" }, CASA);
      expect(llamadas[0]).toEqual({
        nombre: "puntos_cercanos_publicos",
        parametros: { lat: 20.6767, lng: -103.3475, radio_metros: 10_000, tipo_filtro: "residuos", limite: 50 },
      });
      expect(r.respuesta).toEqual({ radio_km: 10, total: 1, puntos: [{ id: ID2, titulo: "Punto 7a", tipo: "residuos", gravedad: 4, distancia_km: 5.7 }] });
      expect(JSON.stringify(r.respuesta)).not.toMatch(/20\.67|103\.34/);
      expect(r.puntos).toHaveLength(1);
    });

    it("cerca_de_mi sin ubicación devuelve un error que el modelo puede explicar, sin consultar", async () => {
      const { cliente, llamadas } = rpcFalso({});
      const r = await crearHerramientas(cliente).ejecutar("buscar_puntos", { cerca_de_mi: true }, SIN_UBICACION);
      expect(r).toEqual({ respuesta: { error: expect.stringContaining("Usar mi ubicación") as unknown }, puntos: [] });
      expect(llamadas).toHaveLength(0);
    });

    it("lat y lng de un lugar nombrado buscan alrededor con el radio pedido", async () => {
      const { cliente, llamadas } = rpcFalso({ puntos_cercanos_publicos: ok([]) });
      const r = await crearHerramientas(cliente).ejecutar("buscar_puntos", { lat: 19.43, lng: -99.13, radio_km: 25 }, SIN_UBICACION);
      expect(llamadas[0]?.parametros).toMatchObject({ lat: 19.43, lng: -99.13, radio_metros: 25_000, tipo_filtro: null });
      expect(r.respuesta).toEqual({ radio_km: 25, total: 0, puntos: [] });
    });

    it.each([
      ["coordenadas fuera de México", { lat: 40.4, lng: -3.7 }],
      ["radio demasiado grande", { lat: 19.4, lng: -99.1, radio_km: 500 }],
      ["tipo inexistente", { tipo: "ruido" }],
      ["gravedad fuera de rango", { gravedad_minima: 9 }],
    ])("rechaza %s con un error legible, sin consultar", async (_caso, argumentos) => {
      const { cliente, llamadas } = rpcFalso({});
      const r = await crearHerramientas(cliente).ejecutar("buscar_puntos", argumentos, SIN_UBICACION);
      expect(String(r.respuesta.error)).toMatch(/^Argumentos inválidos: /);
      expect(r.puntos).toEqual([]);
      expect(llamadas).toHaveLength(0);
    });
  });

  it("detalle_punto devuelve descripción y acciones, y el punto para el mapa", async () => {
    const accion = { id: ORG, tipo: "firma", nombre: "Firmar", descripcion: null, enlace: "https://ejemplo.org", de_la_comunidad: true };
    const { cliente } = rpcFalso({ obtener_punto_publico: ok({ ...resumen, descripcion: "Espuma", acciones: [accion] }) });
    const r = await crearHerramientas(cliente).ejecutar("detalle_punto", { id: ID }, SIN_UBICACION);
    expect(r.respuesta).toEqual({
      id: ID, titulo: "Descarga en arroyo", tipo: "contaminacion_agua", gravedad: 3, descripcion: "Espuma",
      acciones: [{ tipo: "firma", nombre: "Firmar", enlace: "https://ejemplo.org", de_la_comunidad: true }],
    });
    expect(r.puntos).toHaveLength(1);
  });

  it("detalle_punto de un punto no publicado responde un error, no una excepción", async () => {
    const { cliente } = rpcFalso({ obtener_punto_publico: ok(null) });
    const r = await crearHerramientas(cliente).ejecutar("detalle_punto", { id: ID }, SIN_UBICACION);
    expect(r).toEqual({ respuesta: { error: "El punto no existe o no está publicado" }, puntos: [] });
    expect((await crearHerramientas(cliente).ejecutar("detalle_punto", { id: "abc" }, SIN_UBICACION)).respuesta.error).toMatch(/Argumentos inválidos/);
  });

  it("buscar_acciones envía los filtros y devuelve la organización por nombre", async () => {
    const accion = { id: ID, tipo: "voluntariado", nombre: "Limpieza", descripcion: "x", enlace: null, punto_id: ID2, organizacion: { id: ORG, nombre: "Colectivo" } };
    const { cliente, llamadas } = rpcFalso({ listar_acciones_publicas: ok({ total: 1, datos: [accion] }) });
    const r = await crearHerramientas(cliente).ejecutar("buscar_acciones", { tipo: "voluntariado", punto_id: ID2 }, SIN_UBICACION);
    expect(llamadas[0]?.parametros).toEqual({ tipo_filtro: "voluntariado", punto: ID2, limite: 10, desplazamiento: 0 });
    expect(r).toEqual({
      respuesta: { total: 1, acciones: [{ tipo: "voluntariado", nombre: "Limpieza", enlace: null, organizacion: "Colectivo", punto_id: ID2 }] },
      puntos: [],
    });
  });

  it("buscar_organizaciones no devuelve el contacto aunque la base lo traiga", async () => {
    const { cliente, llamadas } = rpcFalso({
      listar_organizaciones_publicas: ok({ total: 1, datos: [{ id: ORG, nombre: "Colectivo", zona: "Tlaquepaque", contacto: "55 1234" }] }),
    });
    const r = await crearHerramientas(cliente).ejecutar("buscar_organizaciones", { zona: " Tlaquepaque " }, SIN_UBICACION);
    expect(llamadas[0]?.parametros).toEqual({ zona_filtro: "Tlaquepaque", limite: 10, desplazamiento: 0 });
    expect(r.respuesta).toEqual({ total: 1, organizaciones: [{ nombre: "Colectivo", zona: "Tlaquepaque" }] });
    expect(JSON.stringify(r)).not.toContain("55 1234");
  });

  it("una herramienta inexistente responde un error", async () => {
    const { cliente } = rpcFalso({});
    expect((await crearHerramientas(cliente).ejecutar("borrar_todo", {}, SIN_UBICACION)).respuesta).toEqual({ error: "No existe la herramienta borrar_todo." });
  });

  it("si la base falla, responde un error genérico y lo registra sin detalles", async () => {
    const { cliente } = rpcFalso({ listar_organizaciones_publicas: { data: null, error: { code: "XX000", message: "detalle interno secreto" } } });
    const r = await crearHerramientas(cliente).ejecutar("buscar_organizaciones", {}, SIN_UBICACION);
    expect(r).toEqual({ respuesta: { error: "No se pudo consultar la base en este momento." }, puntos: [] });
    expect(JSON.stringify(r)).not.toContain("secreto");
    expect(espia.mock.calls.flat().join(" ")).toContain("herramienta_fallida");
  });
});
