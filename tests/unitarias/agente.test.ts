import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorAplicacion } from "../../src/compartido/errores.js";
import { MAXIMO_PASOS, MODELO_RESPALDO, responder, responderConHerramientas, responderSinIA, tipoPorPalabras } from "../../src/modulos/agente/agente.js";
import type { PuntoEnMapa } from "../../src/modulos/agente/herramientas.js";
import { herramientasFalsas, iaFalsa } from "../ayudas/ia-falsa.js";

const SIN_UBICACION = { ubicacion: null };
const CASA = { ubicacion: { lat: 20.67, lng: -103.34 } };
const punto = (n: number): PuntoEnMapa => ({ id: `p${String(n)}`, titulo: `Punto ${String(n)}`, tipo: "residuos", gravedad: 3, ubicacion: { lat: 20, lng: -103 } });
const conPuntos = (lista: PuntoEnMapa[]) => ({ respuesta: { total: lista.length }, puntos: lista });
const noDisponible = () => new ErrorAplicacion(503, "AGENTE_NO_DISPONIBLE", "x");

describe("responderConHerramientas", () => {
  it("sin herramientas responde en un paso", async () => {
    const { ia, pasos } = iaFalsa({ guion: [{ texto: "Separa tus residuos." }] });
    const { herramientas, llamadas } = herramientasFalsas();
    const r = await responderConHerramientas(ia, herramientas, "¿Cómo separo?", SIN_UBICACION);
    expect(r).toEqual({ texto: "Separa tus residuos.", modelo: "modelo-prueba", puntos: [], fuentes: [], herramientas: [], respaldo: false });
    expect(pasos).toHaveLength(1);
    expect(llamadas).toHaveLength(0);
  });

  it("ejecuta lo que pide el modelo y le devuelve su turno (con firma) y los resultados", async () => {
    const { ia, pasos } = iaFalsa({
      guion: [{ llamadas: [{ nombre: "buscar_puntos", argumentos: { cerca_de_mi: true } }] }, { texto: "Encontré el Punto 1." }],
    });
    const { herramientas, llamadas } = herramientasFalsas({ buscar_puntos: conPuntos([punto(1)]) });
    const r = await responderConHerramientas(ia, herramientas, "¿Qué hay cerca?", CASA);
    expect(r).toMatchObject({ texto: "Encontré el Punto 1.", puntos: [punto(1)], herramientas: ["buscar_puntos"] });
    expect(llamadas).toEqual([{ nombre: "buscar_puntos", argumentos: { cerca_de_mi: true }, contexto: CASA }]);
    const segundo = pasos[1]?.contenidos ?? [];
    expect(segundo).toHaveLength(3);
    expect(segundo[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "buscar_puntos", args: { cerca_de_mi: true } }, thoughtSignature: "firma-buscar_puntos" }] });
    expect(segundo[2]).toEqual({ role: "user", parts: [{ functionResponse: { name: "buscar_puntos", response: { total: 1 } } }] });
    // La ubicación nunca llega al modelo.
    expect(JSON.stringify(pasos)).not.toContain("103.34");
  });

  it("no repite puntos y muestra 20 como máximo", async () => {
    const muchos = Array.from({ length: 15 }, (_, i) => punto(i));
    const otros = Array.from({ length: 15 }, (_, i) => punto(i + 10));
    const { ia } = iaFalsa({
      guion: [
        { llamadas: [{ nombre: "buscar_puntos", argumentos: {} }, { nombre: "detalle_punto", argumentos: { id: "p1" } }] },
        { texto: "Listo." },
      ],
    });
    const { herramientas } = herramientasFalsas({ buscar_puntos: conPuntos(muchos), detalle_punto: conPuntos(otros) });
    const r = await responderConHerramientas(ia, herramientas, "x", SIN_UBICACION);
    expect(r.puntos).toHaveLength(20);
    expect(new Set(r.puntos.map((p) => p.id)).size).toBe(20);
    expect(r.herramientas).toEqual(["buscar_puntos", "detalle_punto"]);
  });

  it("junta las fuentes consultadas sin repetirlas", async () => {
    const fuente = { titulo: "Cómo denunciar", fuente: "PROFEPA", enlace: null, fecha_fuente: null };
    const { ia } = iaFalsa({
      guion: [
        { llamadas: [{ nombre: "buscar_conocimiento", argumentos: { consulta: "a" } }, { nombre: "buscar_conocimiento", argumentos: { consulta: "b" } }] },
        { texto: "Fuente: Cómo denunciar (PROFEPA)." },
      ],
    });
    const { herramientas } = herramientasFalsas({ buscar_conocimiento: { respuesta: { total: 1 }, puntos: [], fuentes: [fuente] } });
    expect((await responderConHerramientas(ia, herramientas, "x", SIN_UBICACION)).fuentes).toEqual([fuente]);
  });

  it("ejecuta como máximo 5 herramientas por paso", async () => {
    const siete = Array.from({ length: 7 }, () => ({ nombre: "buscar_acciones", argumentos: {} }));
    const { ia } = iaFalsa({ guion: [{ llamadas: siete }, { texto: "Listo." }] });
    const { herramientas, llamadas } = herramientasFalsas();
    await responderConHerramientas(ia, herramientas, "x", SIN_UBICACION);
    expect(llamadas).toHaveLength(5);
  });

  it(`en el paso ${String(MAXIMO_PASOS)} obliga a responder sin herramientas`, async () => {
    const pide = { llamadas: [{ nombre: "buscar_puntos", argumentos: {} }] };
    const { ia, pasos } = iaFalsa({ guion: [pide, pide, pide, { texto: "Con lo que tengo: nada." }] });
    const { herramientas, llamadas } = herramientasFalsas();
    const r = await responderConHerramientas(ia, herramientas, "x", SIN_UBICACION);
    expect(r.texto).toBe("Con lo que tengo: nada.");
    expect(pasos.map((p) => p.sinHerramientas)).toEqual([false, false, false, true]);
    expect(llamadas).toHaveLength(3);
  });

  it("503 si en el último paso el modelo insiste en herramientas sin texto", async () => {
    const pide = { llamadas: [{ nombre: "buscar_puntos", argumentos: {} }] };
    const { ia } = iaFalsa({ guion: [pide, pide, pide, pide] });
    const { herramientas } = herramientasFalsas();
    await expect(responderConHerramientas(ia, herramientas, "x", SIN_UBICACION)).rejects.toMatchObject({ estado: 503 });
  });
});

describe("respaldo sin IA", () => {
  it.each([
    ["¿Hay contaminación en el río?", "contaminacion_agua"],
    ["Mucho HUMO en la colonia", "contaminacion_aire"],
    ["tiradero de basura", "residuos"],
    ["están talando con motosierra", "tala_ilegal"],
    ["perdimos el bosque", "deforestacion"],
    ["¿Qué es la composta?", undefined],
  ])("tipoPorPalabras(%j) = %s", (pregunta, tipo) => {
    expect(tipoPorPalabras(pregunta)).toBe(tipo);
  });

  it("busca por tipo y cercanía y arma una lista de 5 como máximo", async () => {
    const lista = Array.from({ length: 7 }, (_, i) => punto(i));
    const { herramientas, llamadas } = herramientasFalsas({ buscar_puntos: conPuntos(lista) });
    const r = await responderSinIA(herramientas, "basura cerca de mi casa", CASA);
    expect(llamadas[0]?.argumentos).toEqual({ tipo: "residuos", cerca_de_mi: true });
    expect(r).toMatchObject({ modelo: MODELO_RESPALDO, respaldo: true, herramientas: ["buscar_puntos"] });
    expect(r.puntos).toHaveLength(7);
    expect(r.texto).toContain("no está disponible en este momento");
    expect(r.texto).toContain("Encontré 7 puntos de residuos cerca de tu ubicación:");
    expect(r.texto.match(/^- \*\*/gm)).toHaveLength(5);
  });

  it("sin ubicación no busca «cerca», y sin resultados sugiere reportar", async () => {
    const { herramientas, llamadas } = herramientasFalsas();
    const r = await responderSinIA(herramientas, "¿Qué hay cerca?", SIN_UBICACION);
    expect(llamadas[0]?.argumentos).toEqual({});
    expect(r.texto).toContain("No encontré puntos publicados. Puedes reportar");
  });

  it("un solo punto se dice en singular", async () => {
    const { herramientas } = herramientasFalsas({ buscar_puntos: conPuntos([punto(1)]) });
    expect((await responderSinIA(herramientas, "río", SIN_UBICACION)).texto).toContain("Encontré 1 punto de contaminación del agua:");
  });
});

describe("responder", () => {
  const espia = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const espiaW = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  afterEach(() => {
    espia.mockClear();
    espiaW.mockClear();
  });

  it("pasa al respaldo si Gemini no está disponible", async () => {
    const { ia } = iaFalsa({ error: noDisponible() });
    const { herramientas } = herramientasFalsas();
    expect((await responder(ia, herramientas, "basura", SIN_UBICACION)).respaldo).toBe(true);
  });

  it("respeta el bloqueo por seguridad y otros errores", async () => {
    const { herramientas, llamadas } = herramientasFalsas();
    const bloqueo = new ErrorAplicacion(422, "CONSULTA_NO_PERMITIDA", "x");
    await expect(responder(iaFalsa({ error: bloqueo }).ia, herramientas, "x", SIN_UBICACION)).rejects.toBe(bloqueo);
    const raro = new Error("raro");
    await expect(responder(iaFalsa({ error: raro }).ia, herramientas, "x", SIN_UBICACION)).rejects.toBe(raro);
    expect(llamadas).toHaveLength(0);
  });
});
