import type { SupabaseClient } from "@supabase/supabase-js";
import { registrar } from "../../compartido/registro.js";

const INTERVALO_PURGA_MS = 60 * 60 * 1000;

export interface Conversacion {
  usuario_id: string | null;
  /** Ya sin correos ni teléfonos (quitarDatosPersonales). */
  pregunta: string;
  respuesta: string;
  modelo: string;
}

export interface RegistroConversaciones {
  /** Guarda la conversación. Nunca lanza: si falla, se registra y la respuesta sigue. */
  guardar(conversacion: Conversacion): Promise<void>;
}

/**
 * Guarda con la llave de servicio (la tabla no tiene políticas para nadie más).
 * Las filas caducan a los 7 días; de paso se purgan las vencidas, a lo sumo una vez por hora.
 */
export function crearRegistroConversaciones(servicio: SupabaseClient, ahora: () => number = Date.now): RegistroConversaciones {
  let ultimaPurga = 0;
  return {
    async guardar({ usuario_id, pregunta, respuesta, modelo }) {
      try {
        const { error } = await servicio
          .from("conversaciones_agente")
          .insert({ usuario_id, pregunta, respuesta, fuentes: { modelo } });
        if (error) registrar("error", "conversacion_no_guardada", {});

        if (ahora() - ultimaPurga >= INTERVALO_PURGA_MS) {
          ultimaPurga = ahora();
          const purga = await servicio.rpc("purgar_conversaciones_agente");
          if (purga.error) registrar("warn", "purga_conversaciones_fallida", {});
        }
      } catch {
        registrar("error", "conversacion_no_guardada", {});
      }
    },
  };
}
