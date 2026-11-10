import { z } from "zod";

export const parametrosPunto = z.object({ id: z.uuid() });
export const parametrosHilo = z.object({ id: z.uuid() });
export const parametrosDenuncia = z.object({ id: z.uuid() });

/** Mismos límites que la migración 016; la base también los revisa. */
export const cuerpoMensaje = z.object({ texto: z.string().trim().min(1).max(2000) }).strict();
export const cuerpoDenuncia = z.object({ motivo: z.string().trim().min(10).max(500) }).strict();
export const cuerpoRevisarDenuncia = z.object({ nota: z.string().trim().min(1).max(500).optional() }).strict();

/** La otra persona se nombra con `con`: nunca un id ni un correo. */
export const hilo = z.object({
  id: z.uuid(),
  punto: z.object({ id: z.uuid(), titulo: z.string() }),
  con: z.string(),
  soy_quien_reporto: z.boolean(),
  estado: z.enum(["abierto", "cerrado"]),
  cerrado_por_mi: z.boolean(),
  no_leidos: z.number().int().nonnegative(),
  creado_en: z.string(),
  ultimo_mensaje_en: z.string(),
});

export const mensaje = z.object({
  id: z.uuid(),
  mio: z.boolean(),
  texto: z.string(),
  creado_en: z.string(),
  leido_en: z.string().nullable(),
});

export const escrito = z.object({ hilo, mensaje });
export const conversacion = z.object({ hilo, mensajes: z.array(mensaje) });

const persona = z.object({ id: z.uuid(), nombre: z.string().nullable() });

/** Para moderación: solo conversaciones denunciadas. */
export const denunciaHilo = z.object({
  id: z.uuid(),
  motivo: z.string(),
  estado: z.enum(["pendiente", "revisada"]),
  nota: z.string().nullable(),
  creado_en: z.string(),
  revisada_en: z.string().nullable(),
  denunciante: persona,
  hilo: z.object({
    id: z.uuid(),
    punto: z.object({ id: z.uuid(), titulo: z.string() }),
    mensajes: z.array(z.object({ id: z.uuid(), texto: z.string(), creado_en: z.string(), autor: persona })),
  }),
});

export const denunciaRevisada = z.object({
  id: z.uuid(),
  estado: z.literal("revisada"),
  nota: z.string().nullable(),
  revisada_en: z.string(),
});
