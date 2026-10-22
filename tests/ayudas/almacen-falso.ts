import type { AlmacenEvidencias } from "../../src/compartido/evidencias.js";

/** Almacén en memoria: guarda lo subido y firma con una URL falsa reconocible. */
export function almacenFalso(opciones: { existentes?: string[]; sinEnlaces?: boolean } = {}) {
  const archivos = new Map<string, Buffer>((opciones.existentes ?? []).map((r) => [r, Buffer.alloc(0)]));
  const borrados: string[] = [];
  const almacen: AlmacenEvidencias = {
    subir(ruta, contenido) {
      if (archivos.has(ruta)) return Promise.resolve("existe");
      archivos.set(ruta, contenido);
      return Promise.resolve("ok");
    },
    borrar(ruta) {
      archivos.delete(ruta);
      borrados.push(ruta);
      return Promise.resolve();
    },
    firmar(rutas) {
      if (opciones.sinEnlaces) return Promise.resolve(new Map<string, string>());
      return Promise.resolve(new Map(rutas.map((r) => [r, `https://firmado.prueba/${r}?token=t`])));
    },
  };
  return { almacen, archivos, borrados };
}
