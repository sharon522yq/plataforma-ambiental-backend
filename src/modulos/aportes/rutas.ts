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
import { limpiarConLimite, quitarDatosPersonales } from "../../compartido/privacidad.js";
import type { Autorizar } from "../../middleware/autorizar.js";
import { validar } from "../../middleware/validar.js";
import { puntoModeracion } from "../moderacion/esquemas.js";
import { aportePropio, consultaMisAportes, cuerpoEditarCaso, cuerpoNuevoAporte, parametrosAporte } from "./esquemas.js";

export type ClientePorUsuario = (token: string) => SupabaseClient;

const CAMPO_FOTO = "foto";
const MAXIMO_TITULO = 120;
const MAXIMO_DESCRIPCION = 2000;

/** Título sin datos personales y dentro de los 120 caracteres que acepta la base. */
export function tituloLimpio(titulo: string): string {
  return limpiarConLimite(titulo, MAXIMO_TITULO);
}

/** Descripción sin datos personales y dentro de los 2000 caracteres de las ediciones (019). */
export function descripcionLimpia(descripcion: string): string {
  return limpiarConLimite(descripcion, MAXIMO_DESCRIPCION);
}

type Fuente = { enlace: string; nombre?: string | undefined };

/** Fuentes con el nombre sin datos personales. El enlace ya lo validó el esquema. */
export function fuentesLimpias(fuentes: Fuente[]): Fuente[] {
  return fuentes.map(({ enlace, nombre }) => (nombre ? { enlace, nombre: limpiarConLimite(nombre, 150) } : { enlace }));
}

/** Solo los campos que vienen: en la base, null significa «no cambiar». */
function camposEditados(cuerpo: { titulo?: string | undefined; descripcion?: string | undefined; fuentes?: Fuente[] | undefined }) {
  return {
    titulo: cuerpo.titulo ? tituloLimpio(cuerpo.titulo) : null,
    descripcion: cuerpo.descripcion ? descripcionLimpia(cuerpo.descripcion) : null,
    fuentes: cuerpo.fuentes ? fuentesLimpias(cuerpo.fuentes) : null,
  };
}

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
      // Solo si hay: así un reporte sin enlaces funciona aunque la base aún no tenga la 012.
      ...(cuerpo.enlaces?.length ? { enlaces: cuerpo.enlaces } : {}),
      // Igual que los enlaces: solo si hay, para no exigir la 018 a un reporte sin título.
      ...(cuerpo.titulo ? { titulo: tituloLimpio(cuerpo.titulo) } : {}),
      ...(cuerpo.fuentes?.length ? { fuentes: fuentesLimpias(cuerpo.fuentes) } : {}),
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

  /** Corrige título o descripción de un reporte propio mientras sigue pendiente (019). */
  rutas.patch("/:id", validar({ params: parametrosAporte, body: cuerpoEditarCaso }), (req, res, siguiente) => {
    const { id } = req.params as z.infer<typeof parametrosAporte>;
    const cuerpo = req.body as z.infer<typeof cuerpoEditarCaso>;
    llamarFuncion(clienteUsuario(req.usuario?.token ?? ""), "editar_aporte", { aporte_id: id, ...camposEditados(cuerpo) })
      .then((r) => conEnlace(almacen, aportePropio.parse(r)))
      .then((r) => res.json(r))
      .catch(siguiente);
  });

  /** Los casos en el mapa que nacieron de reportes propios, en cualquier estado (019). */
  rutas.get("/mis-casos", validar({ query: consultaMisAportes }), (req, res, siguiente) => {
    const q = req.query as unknown as z.infer<typeof consultaMisAportes>;
    llamarFuncion(clienteUsuario(req.usuario?.token ?? ""), "mis_puntos", { limite: q.limite, desplazamiento: desplazamiento(q) })
      .then((r) => res.json(armarPagina(r, puntoModeracion, q)))
      .catch(siguiente);
  });

  /** Corrige un caso propio. Si estaba publicado, vuelve a revisión y sale del mapa (019). */
  rutas.patch("/mis-casos/:id", validar({ params: parametrosAporte, body: cuerpoEditarCaso }), (req, res, siguiente) => {
    const { id } = req.params as z.infer<typeof parametrosAporte>;
    const cuerpo = req.body as z.infer<typeof cuerpoEditarCaso>;
    llamarFuncion(clienteUsuario(req.usuario?.token ?? ""), "editar_mi_punto", { punto_id: id, ...camposEditados(cuerpo) })
      .then((r) => res.json(puntoModeracion.parse(r)))
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
