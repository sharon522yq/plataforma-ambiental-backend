import type { Conversacion, RegistroConversaciones } from "../../src/modulos/agente/conversaciones.js";
import type { ContenidoGemini, LlamadaHerramienta, ModeloIA, PasoIA } from "../../src/modulos/agente/gemini.js";
import type { ContextoHerramientas, Herramientas, ResultadoHerramienta } from "../../src/modulos/agente/herramientas.js";
import { DECLARACIONES } from "../../src/modulos/agente/herramientas.js";

/** Un paso guionado: pide herramientas, responde con texto o falla. */
export type PasoGuion = { llamadas: LlamadaHerramienta[] } | { texto: string } | { error: Error };

/**
 * Gemini simulado.
 * - `generar` (salud/ia) responde `texto` o lanza `error`.
 * - `paso` (agente) sigue `guion` paso por paso; sin guion, responde `texto` de inmediato.
 * Guarda las preguntas, los contenidos recibidos y si se pidió responder sin herramientas.
 */
export function iaFalsa(opciones: { texto?: string; error?: Error; estado?: "ok" | "no_disponible"; guion?: PasoGuion[] } = {}) {
  const preguntas: string[] = [];
  const pasos: { contenidos: ContenidoGemini[]; sinHerramientas: boolean }[] = [];
  let i = 0;
  const ia: ModeloIA = {
    modelo: "modelo-prueba",
    generar(pregunta) {
      preguntas.push(pregunta);
      if (opciones.error) return Promise.reject(opciones.error);
      return Promise.resolve({ texto: opciones.texto ?? "Separa tus residuos.", modelo: "modelo-prueba" });
    },
    paso(contenidos, _herramientas, op = {}) {
      // Copia: el agente sigue agregando turnos al mismo arreglo.
      pasos.push({ contenidos: structuredClone(contenidos), sinHerramientas: op.sinHerramientas ?? false });
      // Una conversación nueva empieza con un solo turno: la pregunta.
      if (contenidos.length === 1) {
        const primera = contenidos[0]?.parts[0];
        preguntas.push(typeof primera?.text === "string" ? primera.text : "");
      }
      if (opciones.error) return Promise.reject(opciones.error);
      const guion = opciones.guion?.[i++];
      if (!guion) {
        return Promise.resolve<PasoIA>({ texto: opciones.texto ?? "Separa tus residuos.", llamadas: [], contenido: { role: "model", parts: [{ text: opciones.texto ?? "Separa tus residuos." }] } });
      }
      if ("error" in guion) return Promise.reject(guion.error);
      if ("texto" in guion) return Promise.resolve<PasoIA>({ texto: guion.texto, llamadas: [], contenido: { role: "model", parts: [{ text: guion.texto }] } });
      return Promise.resolve<PasoIA>({
        texto: "",
        llamadas: guion.llamadas,
        contenido: { role: "model", parts: guion.llamadas.map((l) => ({ functionCall: { name: l.nombre, args: l.argumentos }, thoughtSignature: "firma-" + l.nombre })) },
      });
    },
    comprobar: () => Promise.resolve(opciones.estado ?? "ok"),
  };
  return { ia, preguntas, pasos };
}

/** Herramientas simuladas: responden lo que diga `resultados` por nombre y guardan cada llamada. */
export function herramientasFalsas(resultados: Record<string, ResultadoHerramienta> = {}) {
  const llamadas: { nombre: string; argumentos: Record<string, unknown>; contexto: ContextoHerramientas }[] = [];
  const herramientas: Herramientas = {
    declaraciones: DECLARACIONES,
    ejecutar(nombre, argumentos, contexto) {
      llamadas.push({ nombre, argumentos, contexto });
      return Promise.resolve(resultados[nombre] ?? { respuesta: { total: 0, puntos: [] }, puntos: [] });
    },
  };
  return { herramientas, llamadas };
}

export function conversacionesFalsas() {
  const guardadas: Conversacion[] = [];
  const conversaciones: RegistroConversaciones = {
    guardar(c) {
      guardadas.push(c);
      return Promise.resolve();
    },
  };
  return { conversaciones, guardadas };
}
