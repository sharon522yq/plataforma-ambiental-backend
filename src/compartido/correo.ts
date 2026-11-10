import { registrar } from "./registro.js";

const API_BREVO = "https://api.brevo.com/v3/smtp/email";
const TIEMPO_MAXIMO_MS = 10_000;

export interface Destinatario {
  email: string;
  nombre?: string;
}

export interface Correo {
  para: Destinatario;
  asunto: string;
  texto: string;
  html: string;
}

export interface EnviadorCorreo {
  /** false si falta configuración: quien avisa puede saltarse el trabajo. */
  readonly activo: boolean;
  /** true si el proveedor lo aceptó. Nunca lanza: un correo fallido no rompe la operación. */
  enviar(correo: Correo): Promise<boolean>;
}

export interface OpcionesBrevo {
  llave: string;
  remitente: string;
  nombreRemitente: string;
  fetch?: typeof fetch;
}

/** Sin llave o sin remitente: no envía nada. */
export const correoDesactivado: EnviadorCorreo = { activo: false, enviar: () => Promise.resolve(false) };

/**
 * Envío por la API HTTP de Brevo (D-45). Render gratis bloquea SMTP saliente, así que no se usa SMTP.
 * Un correo por destinatario: nadie ve la dirección de otra persona.
 * El registro lleva solo el código HTTP: nunca la llave, la dirección ni el contenido.
 */
export function crearCorreoBrevo({ llave, remitente, nombreRemitente, fetch: pedir = fetch }: OpcionesBrevo): EnviadorCorreo {
  return {
    activo: true,
    async enviar(correo) {
      try {
        const r = await pedir(API_BREVO, {
          method: "POST",
          headers: { "api-key": llave, "content-type": "application/json", accept: "application/json" },
          signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
          body: JSON.stringify({
            sender: { email: remitente, name: nombreRemitente },
            to: [correo.para.nombre ? { email: correo.para.email, name: correo.para.nombre } : { email: correo.para.email }],
            subject: correo.asunto,
            textContent: correo.texto,
            htmlContent: correo.html,
          }),
        });
        if (!r.ok) {
          registrar("error", "correo_rechazado", { estado: r.status });
          return false;
        }
        return true;
      } catch {
        registrar("error", "correo_sin_respuesta", {});
        return false;
      }
    },
  };
}

export function crearCorreo(entorno: {
  BREVO_API_KEY?: string | undefined;
  CORREO_REMITENTE?: string | undefined;
  CORREO_REMITENTE_NOMBRE: string;
}): EnviadorCorreo {
  if (!entorno.BREVO_API_KEY || !entorno.CORREO_REMITENTE) return correoDesactivado;
  return crearCorreoBrevo({ llave: entorno.BREVO_API_KEY, remitente: entorno.CORREO_REMITENTE, nombreRemitente: entorno.CORREO_REMITENTE_NOMBRE });
}

/** Para meter texto escrito por personas dentro del HTML de un correo. */
export function escaparHtml(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
