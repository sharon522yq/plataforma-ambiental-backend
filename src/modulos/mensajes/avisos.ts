import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { escaparHtml, type EnviadorCorreo } from "../../compartido/correo.js";
import { llamarFuncion } from "../../compartido/consultas.js";
import { registrar } from "../../compartido/registro.js";

export interface AvisosMensajes {
  /** Nunca lanza ni hace esperar a la respuesta HTTP: se llama sin await. */
  avisar(mensajeId: string): Promise<void>;
}

export const sinAvisosMensajes: AvisosMensajes = { avisar: () => Promise.resolve() };

const destino = z.object({
  punto: z.object({ titulo: z.string() }),
  destinatario: z.object({ email: z.string().min(3), nombre: z.string().nullable() }),
});

const enLinea = (texto: string, maximo: number) => texto.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, maximo);

/**
 * Aviso de mensaje nuevo (D-46). La base decide si toca avisar (solo el primero sin leer de cada
 * conversación) y da el correo con la llave de servicio. El correo no lleva el texto del mensaje
 * ni quién lo escribió: solo invita a entrar a la plataforma.
 */
export function crearAvisosMensajes(opciones: {
  correo: EnviadorCorreo;
  servicio: () => SupabaseClient;
  sitioUrl?: string | undefined;
}): AvisosMensajes {
  const { correo, servicio, sitioUrl } = opciones;
  if (!correo.activo) return sinAvisosMensajes;
  return {
    async avisar(mensajeId) {
      try {
        const r = await llamarFuncion(servicio(), "destinatario_mensaje", { mensaje_id: mensajeId });
        if (r === null) return;
        const { punto, destinatario } = destino.parse(r);
        const titulo = enLinea(punto.titulo, 80);
        const saludo = `Hola${destinatario.nombre ? ` ${enLinea(destinatario.nombre, 70)}` : ""}:`;
        const cuerpo = `Tienes un mensaje nuevo en la plataforma sobre el punto «${titulo}».`;
        const privacidad = "Por privacidad, el mensaje no viene en este correo. Léelo en la sección «Mensajes».";
        const pie = "Recibes este aviso porque tienes una conversación abierta en la plataforma. Si no quieres recibir más mensajes de esa persona, cierra la conversación.";
        const enviado = await correo.enviar({
          para: destinatario.nombre ? { email: destinatario.email, nombre: enLinea(destinatario.nombre, 70) } : { email: destinatario.email },
          asunto: `Mensaje nuevo sobre «${titulo}»`,
          texto: [saludo, cuerpo, privacidad].join("\n\n") + (sitioUrl ? `\n\nEntra a la plataforma: ${sitioUrl}#mensajes` : "") + `\n\n${pie}`,
          html: [saludo, cuerpo, privacidad].map((p) => `<p>${escaparHtml(p)}</p>`).join("")
            + (sitioUrl ? `<p><a href="${escaparHtml(`${sitioUrl}#mensajes`)}">Ver mis mensajes</a></p>` : "")
            + `<p style="color:#666;font-size:12px">${escaparHtml(pie)}</p>`,
        });
        registrar(enviado ? "info" : "warn", "aviso_mensaje", { enviados: enviado ? 1 : 0 });
      } catch {
        registrar("error", "aviso_mensaje_fallo", {});
      }
    },
  };
}
