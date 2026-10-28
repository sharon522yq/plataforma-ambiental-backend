import type { Conversacion, RegistroConversaciones } from "../../src/modulos/agente/conversaciones.js";
import type { ModeloIA } from "../../src/modulos/agente/gemini.js";

/** Gemini simulado: responde `texto` (o lanza `error`) y guarda las preguntas recibidas. */
export function iaFalsa(opciones: { texto?: string; error?: Error; estado?: "ok" | "no_disponible" } = {}) {
  const preguntas: string[] = [];
  const ia: ModeloIA = {
    generar(pregunta) {
      preguntas.push(pregunta);
      if (opciones.error) return Promise.reject(opciones.error);
      return Promise.resolve({ texto: opciones.texto ?? "Separa tus residuos.", modelo: "modelo-prueba" });
    },
    comprobar: () => Promise.resolve(opciones.estado ?? "ok"),
  };
  return { ia, preguntas };
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
