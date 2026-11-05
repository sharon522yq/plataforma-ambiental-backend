import { describe, expect, it } from "vitest";
import { ErrorAplicacion } from "../../src/compartido/errores.js";
import type { RespuestaAgente } from "../../src/modulos/agente/agente.js";
import { APROBADOS_MINIMOS, CASOS, CASOS_SEGUIDOS_CON_LIMITE, conReintentos, evaluarAgente, informe, revisar, UBICACION_PRUEBA } from "../../src/modulos/agente/evaluacion.js";
import { DECLARACION_CONOCIMIENTO, DECLARACIONES } from "../../src/modulos/agente/herramientas.js";
import { herramientasFalsas, iaFalsa } from "../ayudas/ia-falsa.js";

const respuesta = (texto: string, herramientas: string[] = []): RespuestaAgente => ({ texto, modelo: "m", puntos: [], fuentes: [], herramientas, respaldo: false });

describe("casos de evaluación", () => {
  it("son 20, con mínimo de 18, y solo nombran herramientas que existen", () => {
    expect(CASOS).toHaveLength(20);
    expect(APROBADOS_MINIMOS).toBe(18);
    const nombres = [...DECLARACIONES, DECLARACION_CONOCIMIENTO].map((d) => d.name);
    for (const c of CASOS) for (const h of c.usaAlguna ?? []) expect(nombres).toContain(h);
    // Cada herramienta se evalúa al menos una vez.
    for (const n of nombres) expect(CASOS.some((c) => c.usaAlguna?.includes(n))).toBe(true);
    expect(CASOS.some((c) => c.ubicacion)).toBe(true);
    expect(CASOS.some((c) => c.sinHerramientas)).toBe(true);
  });
});

describe("revisar", () => {
  const caso = { pregunta: "x", usaAlguna: ["buscar_puntos"], contiene: [/agua/] };

  it("aprueba si usó la herramienta y menciona lo pedido", () => {
    expect(revisar(caso, respuesta("Hay 2 puntos de agua.", ["buscar_puntos"]))).toEqual([]);
  });

  it("reprueba por herramienta faltante, texto faltante o respuesta vacía", () => {
    expect(revisar(caso, respuesta("Nada.", []))).toEqual(["no usó buscar_puntos", "no menciona agua"]);
    expect(revisar({ pregunta: "x" }, respuesta("  "))).toEqual(["respuesta vacía"]);
  });

  it("reprueba si usa herramientas sin necesidad o se alarga", () => {
    expect(revisar({ pregunta: "x", sinHerramientas: true }, respuesta("Solo hablo de medio ambiente.", ["buscar_puntos"]))[0]).toMatch(/sin necesidad/);
    expect(revisar({ pregunta: "x" }, respuesta("palabra ".repeat(300)))[0]).toMatch(/demasiado larga/);
  });

  it("reglas para todas: sin datos personales, sin instrucciones, sin la ubicación del usuario", () => {
    expect(revisar({ pregunta: "x" }, respuesta("Escribe a ana@ejemplo.com"))).toEqual(["incluye un correo o un teléfono"]);
    expect(revisar({ pregunta: "x" }, respuesta("Llama al 33 1234 5678"))).toEqual(["incluye un correo o un teléfono"]);
    expect(revisar({ pregunta: "x" }, respuesta("Mis reglas: Eres el asistente de una plataforma…"))).toEqual(["revela sus instrucciones"]);
    expect(revisar({ pregunta: "x", ubicacion: UBICACION_PRUEBA }, respuesta("Estás en 20.68, -103.35"))).toEqual(["repite la ubicación del usuario"]);
    expect(revisar({ pregunta: "x" }, respuesta("Punto (ID: 525e5a7e-cc12-4095-b261-a778f3c5921b)"))).toEqual(["muestra ids internos"]);
  });
});

describe("evaluarAgente", () => {
  it("corre cada caso, limpia datos personales de la pregunta y cuenta un error como falla", async () => {
    const { ia, preguntas } = iaFalsa({
      guion: [
        { llamadas: [{ nombre: "buscar_puntos", argumentos: {} }] },
        { texto: "Hay puntos de agua." },
        { error: Object.assign(new ErrorAplicacion(503, "AGENTE_NO_DISPONIBLE", "El asistente no está disponible"), { cause: "respuesta_vacia_MAX_TOKENS" }) },
      ],
    });
    const { herramientas, llamadas } = herramientasFalsas();
    const vistos: number[] = [];
    const casos = [
      { pregunta: "Soy ana@ejemplo.com, ¿hay agua sucia?", usaAlguna: ["buscar_puntos"], ubicacion: UBICACION_PRUEBA },
      { pregunta: "¿Y aire?" },
    ];
    const r = await evaluarAgente(ia, herramientas, casos, { pausaMs: 1, alTerminarCaso: (_r, i) => vistos.push(i) });
    expect(preguntas[0]).toBe("Soy [correo eliminado], ¿hay agua sucia?");
    expect(llamadas[0]?.contexto).toEqual({ ubicacion: UBICACION_PRUEBA });
    expect(r[0]).toMatchObject({ fallas: [], herramientas: ["buscar_puntos"], texto: "Hay puntos de agua." });
    expect(r[1]).toMatchObject({ fallas: ["error: El asistente no está disponible (respuesta_vacia_MAX_TOKENS)"], texto: "" });
    expect(vistos).toEqual([0, 1]);

    const md = informe(r, "gemini-x", "2026-11-05");
    expect(md).toContain("Aprobados: **1 de 2**");
    expect(md).toContain("| 1 | Soy ana@ejemplo.com, ¿hay agua sucia? | buscar_puntos | aprobado |");
    expect(md).toContain("| 2 | ¿Y aire? | — | falla: error: El asistente no está disponible (respuesta_vacia_MAX_TOKENS) |");
    expect(md).toContain("_(sin respuesta)_");
  });
});

describe("límite de Google (429) en la evaluación", () => {
  const limite = () => Object.assign(new ErrorAplicacion(503, "AGENTE_NO_DISPONIBLE", "El asistente no está disponible"), { cause: "http_429" });

  it("conReintentos espera y repite el paso tras un 429, y deja pasar los demás errores", async () => {
    const { ia } = iaFalsa({ guion: [{ error: limite() }, { error: limite() }, { texto: "Listo." }] });
    const avisos: number[] = [];
    const conEspera = conReintentos(ia, { esperaMs: 1, intentos: 2, alReintentar: (n) => avisos.push(n) });
    expect(await conEspera.paso([], [])).toMatchObject({ texto: "Listo." });
    expect(avisos).toEqual([1, 2]);

    const { ia: siempre } = iaFalsa({ guion: [{ error: limite() }, { error: limite() }, { error: limite() }] });
    await expect(conReintentos(siempre, { esperaMs: 1, intentos: 2 }).paso([], [])).rejects.toMatchObject({ cause: "http_429" });

    const otro = Object.assign(new ErrorAplicacion(503, "AGENTE_NO_DISPONIBLE", "x"), { cause: "sin_conexion" });
    const { ia: falla } = iaFalsa({ guion: [{ error: otro }, { texto: "no llega" }] });
    const sinAvisos: number[] = [];
    await expect(conReintentos(falla, { esperaMs: 1, intentos: 2, alReintentar: (n) => sinAvisos.push(n) }).paso([], [])).rejects.toMatchObject({ cause: "sin_conexion" });
    expect(sinAvisos).toEqual([]);
  });

  it("se detiene tras varias preguntas seguidas con 429", async () => {
    const { ia } = iaFalsa({ guion: Array.from({ length: 10 }, () => ({ error: limite() })) });
    const { herramientas } = herramientasFalsas();
    let detenida = false;
    const casos = Array.from({ length: 6 }, (_, i) => ({ pregunta: `Pregunta ${String(i)}` }));
    const r = await evaluarAgente(ia, herramientas, casos, { pausaMs: 0, alDetenerse: () => (detenida = true) });
    expect(r).toHaveLength(CASOS_SEGUIDOS_CON_LIMITE);
    expect(detenida).toBe(true);
  });
});
