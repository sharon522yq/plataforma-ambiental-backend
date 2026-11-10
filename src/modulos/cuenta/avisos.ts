import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { escaparHtml, type Correo, type EnviadorCorreo } from "../../compartido/correo.js";
import { llamarFuncion } from "../../compartido/consultas.js";
import { registrar } from "../../compartido/registro.js";

export type EventoPeticion = "nueva" | "resuelta";

export interface AvisosPeticionRol {
  /** Nunca lanza ni hace esperar a la respuesta HTTP: se llama sin await. */
  avisar(peticionId: string, evento: EventoPeticion): Promise<void>;
}

/** No envía nada (sin correo configurado, o en pruebas). */
export const sinAvisos: AvisosPeticionRol = { avisar: () => Promise.resolve() };

const MAXIMO_DESTINATARIOS = 20;
const NOMBRE_ROL: Record<string, string> = { moderador: "moderación", editor: "edición" };

const destinos = z.object({
  peticion: z.object({
    id: z.uuid(),
    rol_pedido: z.string(),
    estado: z.string(),
    respuesta: z.string().nullable(),
    nombre: z.string().nullable(),
  }),
  destinatarios: z.array(z.object({ email: z.string().min(3), nombre: z.string().nullable() })),
});
type Destinos = z.infer<typeof destinos>;

/** Para el asunto: una línea, sin caracteres de control y corta. */
const enLinea = (texto: string, maximo: number) => texto.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, maximo);

function armarCorreo(evento: EventoPeticion, d: Destinos, para: Destinos["destinatarios"][number], sitio: string | undefined): Correo {
  const rol = NOMBRE_ROL[d.peticion.rol_pedido] ?? d.peticion.rol_pedido;
  const saludo = `Hola${para.nombre ? ` ${para.nombre}` : ""}:`;
  const destino = sitio ? `${sitio}#${evento === "nueva" ? "administracion" : "cuenta"}` : null;
  const enlaceTexto = destino ? `\n\nEntra a la plataforma: ${destino}` : "";
  const enlaceHtml = destino ? `<p><a href="${escaparHtml(destino)}">Entrar a la plataforma</a></p>` : "";
  let asunto: string;
  let parrafos: string[];
  let pie: string;

  if (evento === "nueva") {
    const quien = d.peticion.nombre ? enLinea(d.peticion.nombre, 60) : "Una persona";
    asunto = `Nueva petición de rol: ${quien} pide ${rol}`;
    parrafos = [`${quien} pidió el rol de ${rol}.`, "Revísala en Administración, sección «Peticiones de rol», donde verás su motivo."];
    pie = "Recibes este aviso porque eres administrador de la plataforma.";
  } else {
    const aprobada = d.peticion.estado === "aprobada";
    asunto = aprobada ? `Tu petición del rol de ${rol} fue aprobada` : `Tu petición del rol de ${rol} fue revisada`;
    parrafos = aprobada
      ? [`Tu petición del rol de ${rol} fue aprobada.`, "Recarga la página o vuelve a iniciar sesión para ver tus nuevas herramientas."]
      : [`Tu petición del rol de ${rol} no fue aprobada esta vez.`, "Puedes volver a pedirlo en 7 días desde «Mi cuenta»."];
    if (d.peticion.respuesta) parrafos.push(`Respuesta del equipo: ${d.peticion.respuesta}`);
    pie = "Recibes este aviso porque pediste un rol en la plataforma.";
  }

  return {
    para: para.nombre ? { email: para.email, nombre: enLinea(para.nombre, 70) } : { email: para.email },
    asunto,
    texto: [saludo, ...parrafos].join("\n\n") + enlaceTexto + `\n\n${pie}`,
    html: [
      `<p>${escaparHtml(saludo)}</p>`,
      ...parrafos.map((p) => `<p>${escaparHtml(p)}</p>`),
      enlaceHtml,
      `<p style="color:#666;font-size:12px">${escaparHtml(pie)}</p>`,
    ].join(""),
  };
}

/**
 * Avisos por correo de las peticiones de rol (D-45). Los correos los lee la llave de servicio con
 * destinatarios_peticion_rol: la API nunca los devuelve. El registro lleva solo conteos.
 */
export function crearAvisosPeticionRol(opciones: {
  correo: EnviadorCorreo;
  servicio: () => SupabaseClient;
  sitioUrl?: string | undefined;
}): AvisosPeticionRol {
  const { correo, servicio, sitioUrl } = opciones;
  if (!correo.activo) return sinAvisos;
  return {
    async avisar(peticionId, evento) {
      try {
        const r = await llamarFuncion(servicio(), "destinatarios_peticion_rol", { peticion_id: peticionId, evento });
        if (r === null) return;
        const d = destinos.parse(r);
        const lista = d.destinatarios.slice(0, MAXIMO_DESTINATARIOS);
        const resultados = await Promise.all(lista.map((para) => correo.enviar(armarCorreo(evento, d, para, sitioUrl))));
        const enviados = resultados.filter(Boolean).length;
        registrar(enviados === lista.length ? "info" : "warn", "aviso_peticion_rol", { tipo: evento, enviados, fallidos: lista.length - enviados });
      } catch {
        registrar("error", "aviso_peticion_rol_fallo", { tipo: evento });
      }
    },
  };
}
