import { Router, type RequestHandler } from "express";
import multer from "multer";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { sinCache } from "../../compartido/cache.js";
import { armarPagina, desplazamiento, llamarFuncion } from "../../compartido/consultas.js";
import { ErrorAplicacion, Conflicto, SolicitudInvalida } from "../../compartido/errores.js";
import {
  conEnlace,
  paginaConEnlaces,
  prepararEvidencia,
  TAMANO_MAXIMO_SUBIDA,
  type AlmacenEvidencias,
} from "../../compartido/evidencias.js";
import { quitarDatosPersonales } from "../../compartido/privacidad.js";
import type { Autorizar } from "../../middleware/autorizar.js";
import { validar } from "../../middleware/validar.js";
import { aportePropio, consultaMisAportes, cuerpoNuevoAporte, parametrosAporte } from "./esquemas.js";

export type ClientePorUsuario = (token: string) => SupabaseClient;

const CAMPO_FOTO = "foto";

/** Recibe una sola foto en memoria (multipart, campo `foto`) y traduce los errores de multer. */
function recibirFoto(): RequestHandler {
  const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: TAMANO_MAXIMO_SUBIDA, files: 1, fields: 0 } }).single(CAMPO_FOTO);
  return (req, res, siguiente) => {
    subida(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          siguiente(new ErrorAplicacion(413, "ARCHIVO_DEMASIADO_GRANDE", "La foto pesa más de 8 MB"));
          return;
        }
        siguiente(new SolicitudInvalida(`Envía una sola foto en el campo "${CAMPO_FOTO}"`));
        return;
      }
      if (err) {
        siguiente(new SolicitudInvalida("No se pudo leer el archivo enviado"));
        return;
      }
      siguiente();
    });
  };
}

/**
 * Aportes ciudadanos. Cualquier cuenta activa puede enviar y ver los suyos.
 * Todo corre con la sesión del usuario: RLS impide ver o crear aportes ajenos.
 * Las fotos de evidencia se guardan con el almacén (Storage privado, D-27).
 */
export function crearRutasAportes(
  autenticar: RequestHandler,
  autorizar: Autorizar,
  clienteUsuario: ClientePorUsuario,
  almacen: AlmacenEvidencias,
): Router {
  const rutas = Router();
  rutas.use(sinCache, autenticar, autorizar());

  rutas.post("/", validar({ body: cuerpoNuevoAporte }), (req, res, siguiente) => {
    const cuerpo = req.body as z.infer<typeof cuerpoNuevoAporte>;
    llamarFuncion(clienteUsuario(req.usuario?.token ?? ""), "crear_aporte", {
      tipo: cuerpo.tipo,
      descripcion: quitarDatosPersonales(cuerpo.descripcion),
      lat: cuerpo.ubicacion.lat,
      lng: cuerpo.ubicacion.lng,
      gravedad_sugerida: cuerpo.gravedad_sugerida ?? null,
      punto_id: cuerpo.punto_id ?? null,
    })
      .then((r) => conEnlace(almacen, aportePropio.parse(r)))
      .then((r) => res.status(201).json(r))
      .catch(siguiente);
  });

  rutas.get("/mis", validar({ query: consultaMisAportes }), (req, res, siguiente) => {
    const q = req.query as unknown as z.infer<typeof consultaMisAportes>;
    llamarFuncion(clienteUsuario(req.usuario?.token ?? ""), "mis_aportes", { limite: q.limite, desplazamiento: desplazamiento(q) })
      .then((r) => paginaConEnlaces(almacen, armarPagina(r, aportePropio, q)))
      .then((r) => res.json(r))
      .catch(siguiente);
  });

  /**
   * Adjunta una foto a un aporte propio y pendiente, una sola vez. Orden: validar y limpiar
   * la foto, subirla a la carpeta del usuario y luego registrarla en la base. Si la base la
   * rechaza (aporte ajeno, ya revisado o con foto), se borra lo subido para no dejar basura.
   */
  rutas.post("/:id/evidencia", validar({ params: parametrosAporte }), recibirFoto(), (req, res, siguiente) => {
    const { id } = req.params as z.infer<typeof parametrosAporte>;
    const usuario = req.usuario;
    const archivo = req.file;
    if (!usuario) {
      siguiente(new Error("Ruta sin autenticar"));
      return;
    }
    if (!archivo) {
      siguiente(new SolicitudInvalida(`Falta la foto en el campo "${CAMPO_FOTO}"`));
      return;
    }
    const ruta = `${usuario.id}/${id}.jpg`;

    const adjuntar = async () => {
      const foto = await prepararEvidencia(archivo.buffer);
      if ((await almacen.subir(ruta, foto)) === "existe") throw new Conflicto("El aporte ya tiene evidencia");
      try {
        const r = await llamarFuncion(clienteUsuario(usuario.token), "adjuntar_evidencia", { aporte_id: id, ruta });
        return await conEnlace(almacen, aportePropio.parse(r));
      } catch (err) {
        await almacen.borrar(ruta);
        throw err;
      }
    };
    adjuntar()
      .then((r) => res.status(201).json(r))
      .catch(siguiente);
  });

  return rutas;
}
