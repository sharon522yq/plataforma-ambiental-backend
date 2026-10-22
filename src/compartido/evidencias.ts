import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import type { Pagina } from "./consultas.js";
import { ErrorAplicacion, SolicitudInvalida } from "./errores.js";
import { registrar } from "./registro.js";

export const BUCKET_EVIDENCIAS = "evidencias";
/** Los enlaces a las fotos caducan a los 10 minutos (D-27). */
export const DURACION_ENLACE_SEGUNDOS = 600;
/** Tamaño máximo del archivo que se recibe. La foto guardada queda mucho más chica. */
export const TAMANO_MAXIMO_SUBIDA = 8 * 1024 * 1024;
const TAMANO_MAXIMO_GUARDADO = 2 * 1024 * 1024; // límite del bucket (migración 009)
const LADO_MAXIMO = 1600;
const PIXELES_MAXIMOS = 50_000_000; // evita imágenes diseñadas para agotar la memoria
const FORMATOS_PERMITIDOS = new Set(["jpeg", "png", "webp"]);

export interface AlmacenEvidencias {
  /** Guarda la foto. Devuelve "existe" si ya hay un archivo en esa ruta (no lo reemplaza). */
  subir(ruta: string, contenido: Buffer): Promise<"ok" | "existe">;
  borrar(ruta: string): Promise<void>;
  /** Enlaces temporales por ruta. Las rutas que no se pudieron firmar no aparecen. */
  firmar(rutas: string[]): Promise<Map<string, string>>;
}

/**
 * Valida y limpia una foto: solo JPG, PNG o WebP; la gira según su orientación, la reduce
 * a 1600 px y la vuelve a codificar como JPEG. Al recodificar se pierden todos los
 * metadatos (ubicación GPS, modelo de cámara, fecha), que pueden ser datos personales.
 */
export async function prepararEvidencia(contenido: Buffer): Promise<Buffer> {
  let formato: string;
  let pixeles: number;
  try {
    const meta = await sharp(contenido, { limitInputPixels: PIXELES_MAXIMOS }).metadata();
    formato = meta.format;
    pixeles = meta.width * meta.height;
  } catch {
    throw new SolicitudInvalida("El archivo no es una imagen válida");
  }
  if (!FORMATOS_PERMITIDOS.has(formato)) {
    throw new SolicitudInvalida("Formato no permitido. Usa una foto JPG, PNG o WebP");
  }
  if (pixeles === 0 || pixeles > PIXELES_MAXIMOS) throw new SolicitudInvalida("La imagen es demasiado grande");

  const limpia = await sharp(contenido, { limitInputPixels: PIXELES_MAXIMOS })
    .rotate()
    .resize({ width: LADO_MAXIMO, height: LADO_MAXIMO, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  if (limpia.length > TAMANO_MAXIMO_GUARDADO) {
    throw new ErrorAplicacion(413, "ARCHIVO_DEMASIADO_GRANDE", "La foto es demasiado pesada, intenta con otra");
  }
  return limpia;
}

/** Almacén en Supabase Storage con la llave de servicio (tarea del sistema, D-27). */
export function crearAlmacenSupabase(servicio: SupabaseClient): AlmacenEvidencias {
  const bucket = () => servicio.storage.from(BUCKET_EVIDENCIAS);
  return {
    async subir(ruta, contenido) {
      const { error } = await bucket().upload(ruta, contenido, { contentType: "image/jpeg", upsert: false });
      if (!error) return "ok";
      const estado = "statusCode" in error ? String(error.statusCode) : "";
      if (estado === "409" || /exist|duplicate/i.test(error.message)) return "existe";
      throw new Error("No se pudo guardar la evidencia");
    },
    async borrar(ruta) {
      const { error } = await bucket().remove([ruta]);
      if (error) registrar("error", "evidencia_no_borrada", {});
    },
    async firmar(rutas) {
      const enlaces = new Map<string, string>();
      if (rutas.length === 0) return enlaces;
      const { data, error } = await bucket().createSignedUrls(rutas, DURACION_ENLACE_SEGUNDOS);
      if (error) {
        registrar("error", "evidencia_sin_enlace", {});
        return enlaces;
      }
      for (const fila of data) {
        if (fila.path && fila.signedUrl && !fila.error) enlaces.set(fila.path, fila.signedUrl);
      }
      return enlaces;
    },
  };
}

/**
 * Cambia `evidencia_ruta` (interna) por `evidencia`: null si no hay foto, o
 * { url, expira_en_segundos } con un enlace temporal. Si Storage no responde, url es null.
 */
export async function conEnlaces<T extends { evidencia_ruta: string | null }>(almacen: AlmacenEvidencias, elementos: T[]) {
  const rutas = elementos.flatMap((e) => (e.evidencia_ruta ? [e.evidencia_ruta] : []));
  const enlaces = await almacen.firmar(rutas);
  return elementos.map(({ evidencia_ruta, ...resto }) => ({
    ...resto,
    evidencia: evidencia_ruta
      ? { url: enlaces.get(evidencia_ruta) ?? null, expira_en_segundos: DURACION_ENLACE_SEGUNDOS }
      : null,
  }));
}

export async function conEnlace<T extends { evidencia_ruta: string | null }>(almacen: AlmacenEvidencias, elemento: T) {
  const [conFoto] = await conEnlaces(almacen, [elemento]);
  if (!conFoto) throw new Error("conEnlaces no devolvió el elemento");
  return conFoto;
}

export async function paginaConEnlaces<T extends { evidencia_ruta: string | null }>(almacen: AlmacenEvidencias, pagina: Pagina<T>) {
  return { ...pagina, datos: await conEnlaces(almacen, pagina.datos) };
}
