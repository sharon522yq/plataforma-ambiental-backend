import { z } from "zod";
import { TIPOS_ACCION } from "../modulos/acciones/rutas.js";

/** Solo https: un enlace http o javascript: en el catálogo público sería un riesgo para quien lo abre. */
export const enlaceSeguro = z
  .string()
  .trim()
  .max(500)
  .pipe(z.url())
  .refine((v) => /^https:\/\/\S+$/.test(v), { message: "El enlace debe empezar con https://" });

/** Un enlace para ayudar (firma, evento, donación…), como lo propone la comunidad (D-40). */
export const cuerpoEnlace = z.object({
  tipo: z.enum(TIPOS_ACCION),
  nombre: z.string().trim().min(3).max(120),
  enlace: enlaceSeguro,
}).strict();
