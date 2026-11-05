import { ErrorAplicacion } from "../../compartido/errores.js";
import { registrar } from "../../compartido/registro.js";
import { MAXIMO_LLAMADAS_POR_PASO, type ContenidoGemini, type ModeloIA } from "./gemini.js";
import type { ContextoHerramientas, FuenteConocimiento, Herramientas, PuntoEnMapa } from "./herramientas.js";

/** Pasos del modelo como máximo por pregunta: evita ciclos y gasto de cuota. */
export const MAXIMO_PASOS = 4;
const MAXIMO_PUNTOS_EN_MAPA = 20;

export interface RespuestaAgente {
  texto: string;
  modelo: string;
  /** Puntos que el mapa puede mostrar como resultado de la pregunta. */
  puntos: PuntoEnMapa[];
  /** Documentos de la base de conocimiento que consultó (F14), para citarlos. */
  fuentes: FuenteConocimiento[];
  /** Herramientas que usó, en orden (para evaluar y auditar). */
  herramientas: string[];
  /** true si respondió el respaldo sin IA porque Gemini no estaba disponible. */
  respaldo: boolean;
}

function acumularPuntos(destino: Map<string, PuntoEnMapa>, nuevos: PuntoEnMapa[]) {
  for (const p of nuevos) if (!destino.has(p.id) && destino.size < MAXIMO_PUNTOS_EN_MAPA) destino.set(p.id, p);
}

/**
 * Ciclo del agente (F13): Gemini decide si necesita datos, el servidor ejecuta las
 * herramientas pedidas y le devuelve los resultados, hasta que responde con texto o se
 * acaban los pasos (entonces se le pide responder con lo que ya tiene).
 */
export async function responderConHerramientas(
  ia: ModeloIA,
  herramientas: Herramientas,
  pregunta: string,
  contexto: ContextoHerramientas,
): Promise<RespuestaAgente> {
  const contenidos: ContenidoGemini[] = [{ role: "user", parts: [{ text: pregunta }] }];
  const puntos = new Map<string, PuntoEnMapa>();
  const fuentes = new Map<string, FuenteConocimiento>();
  const usadas: string[] = [];

  for (let paso = 0; paso < MAXIMO_PASOS; paso++) {
    const ultimo = paso === MAXIMO_PASOS - 1;
    const r = await ia.paso(contenidos, herramientas.declaraciones, { sinHerramientas: ultimo });
    if (r.llamadas.length === 0 || ultimo) {
      if (!r.texto) throw new ErrorAplicacion(503, "AGENTE_NO_DISPONIBLE", "El asistente no está disponible, intenta más tarde");
      return { texto: r.texto, modelo: ia.modelo, puntos: [...puntos.values()], fuentes: [...fuentes.values()], herramientas: usadas, respaldo: false };
    }
    contenidos.push(r.contenido);
    const llamadas = r.llamadas.slice(0, MAXIMO_LLAMADAS_POR_PASO);
    const resultados = await Promise.all(llamadas.map((l) => herramientas.ejecutar(l.nombre, l.argumentos, contexto)));
    const partes = llamadas.map((l, i) => {
      usadas.push(l.nombre);
      const resultado = resultados[i];
      if (resultado) acumularPuntos(puntos, resultado.puntos);
      for (const f of resultado?.fuentes ?? []) fuentes.set(`${f.titulo}|${f.fuente}`, f);
      return { functionResponse: { name: l.nombre, response: resultado?.respuesta ?? { error: "sin resultado" } } };
    });
    contenidos.push({ role: "user", parts: partes });
  }
  /* v8 ignore next */
  throw new ErrorAplicacion(503, "AGENTE_NO_DISPONIBLE", "El asistente no está disponible, intenta más tarde");
}

// ---------------------------------------------------------------------------
// Respaldo sin IA (B-11): si Gemini no responde (cuota agotada, caída o error), el asistente
// no deja al usuario sin nada: busca por palabras clave en el mapa y arma una respuesta fija.

/** Palabras clave por tipo de punto, sin acentos y en minúsculas. */
const PALABRAS: [string, string[]][] = [
  ["contaminacion_agua", ["agua", "rio", "lago", "laguna", "arroyo", "presa", "drenaje", "descarga", "canal"]],
  ["contaminacion_aire", ["aire", "humo", "smog", "emision", "quema", "olor"]],
  ["residuos", ["basura", "residuo", "desecho", "tiradero", "relleno", "plastico", "escombro"]],
  ["tala_ilegal", ["tala", "talan", "aserradero", "motosierra"]],
  ["deforestacion", ["deforestacion", "bosque", "arbol", "selva", "incendio forestal"]],
];
const NOMBRES_TIPO: Record<string, string> = {
  contaminacion_agua: "contaminación del agua",
  contaminacion_aire: "contaminación del aire",
  residuos: "residuos",
  tala_ilegal: "tala ilegal",
  deforestacion: "deforestación",
};
const CERCA = ["cerca", "mi zona", "mi colonia", "alrededor", "por aqui"];

const normalizar = (t: string) => t.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function tipoPorPalabras(pregunta: string): string | undefined {
  const t = normalizar(pregunta);
  return PALABRAS.find(([, palabras]) => palabras.some((p) => t.includes(p)))?.[0];
}

export const MODELO_RESPALDO = "respaldo-sin-ia";

export async function responderSinIA(herramientas: Herramientas, pregunta: string, contexto: ContextoHerramientas): Promise<RespuestaAgente> {
  const tipo = tipoPorPalabras(pregunta);
  const t = normalizar(pregunta);
  const cerca = contexto.ubicacion !== null && CERCA.some((c) => t.includes(c));
  const argumentos: Record<string, unknown> = {};
  if (tipo) argumentos.tipo = tipo;
  if (cerca) argumentos.cerca_de_mi = true;
  const r = await herramientas.ejecutar("buscar_puntos", argumentos, contexto);
  const lista = r.puntos.slice(0, 5);
  const tema = tipo ? `de ${NOMBRES_TIPO[tipo] ?? tipo}` : "publicados";
  const donde = cerca ? " cerca de tu ubicación" : "";
  const lineas = [
    "El asistente con inteligencia artificial no está disponible en este momento, así que busqué directamente en el mapa.",
    "",
  ];
  if (lista.length === 0) {
    lineas.push(`No encontré puntos ${tema}${donde}. Puedes reportar un problema en la sección **Reportar**.`);
  } else {
    lineas.push(`Encontré ${String(r.puntos.length)} punto${r.puntos.length === 1 ? "" : "s"} ${tema}${donde}:`, "");
    for (const p of lista) lineas.push(`- **${p.titulo}** (gravedad ${String(p.gravedad)} de 5)`);
    lineas.push("", "Abre cada punto en el mapa para ver los detalles y **cómo ayudar**.");
  }
  return { texto: lineas.join("\n"), modelo: MODELO_RESPALDO, puntos: r.puntos, fuentes: [], herramientas: ["buscar_puntos"], respaldo: true };
}

/**
 * Responde con el agente y, si Gemini no está disponible (503), con el respaldo sin IA.
 * Una pregunta bloqueada por seguridad (422) no pasa al respaldo: se respeta el bloqueo.
 */
export async function responder(ia: ModeloIA, herramientas: Herramientas, pregunta: string, contexto: ContextoHerramientas): Promise<RespuestaAgente> {
  try {
    return await responderConHerramientas(ia, herramientas, pregunta, contexto);
  } catch (e) {
    if (e instanceof ErrorAplicacion && e.estado === 503) {
      registrar("warn", "agente_respaldo_sin_ia", {});
      return responderSinIA(herramientas, pregunta, contexto);
    }
    throw e;
  }
}
