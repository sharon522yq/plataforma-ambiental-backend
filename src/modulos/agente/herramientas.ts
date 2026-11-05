import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { armarPagina, llamarFuncion } from "../../compartido/consultas.js";
import { ErrorAplicacion } from "../../compartido/errores.js";
import { registrar } from "../../compartido/registro.js";
import { accion, TIPOS_ACCION } from "../acciones/rutas.js";
import { organizacion } from "../organizaciones/rutas.js";
import { TIPOS_PUNTO } from "../puntos/esquemas.js";
import { listarPuntos, obtenerPunto, puntosCercanos } from "../puntos/servicio.js";
import type { ModeloEmbeddings } from "./embeddings.js";
import type { DeclaracionHerramienta } from "./gemini.js";

/**
 * Herramientas del agente (F13). Todas son de solo lectura y usan el cliente público (anon):
 * ven exactamente lo mismo que un visitante del mapa, por RLS. Ninguna puede leer aportes
 * pendientes, autores ni contactos internos.
 */

export interface Ubicacion {
  lat: number;
  lng: number;
}

/** Lo que el mapa necesita para mostrar un punto que encontró el agente. */
export interface PuntoEnMapa {
  id: string;
  titulo: string;
  tipo: string;
  gravedad: number;
  ubicacion: Ubicacion;
}

/** Documento de la base de conocimiento que respaldó una respuesta (F14). */
export interface FuenteConocimiento {
  titulo: string;
  fuente: string;
  enlace: string | null;
  fecha_fuente: string | null;
}

export interface ResultadoHerramienta {
  /** Lo que se le devuelve al modelo. */
  respuesta: Record<string, unknown>;
  /** Puntos que el mapa puede resaltar. */
  puntos: PuntoEnMapa[];
  /** Documentos consultados, para citarlos al usuario. */
  fuentes?: FuenteConocimiento[];
}

export interface ContextoHerramientas {
  /**
   * Ubicación que el usuario compartió («Usar mi ubicación»). Se usa dentro del servidor y
   * nunca se manda al modelo: él solo pide `cerca_de_mi`.
   */
  ubicacion: Ubicacion | null;
}

export interface Herramientas {
  declaraciones: DeclaracionHerramienta[];
  ejecutar(nombre: string, argumentos: Record<string, unknown>, contexto: ContextoHerramientas): Promise<ResultadoHerramienta>;
}

const MAXIMO_RESULTADOS = 10;
const RADIO_KM_POR_DEFECTO = 10;
const RADIO_KM_MAXIMO = 50;
const LARGO_DESCRIPCION = 240;

const recortar = (texto: string) => (texto.length > LARGO_DESCRIPCION ? texto.slice(0, LARGO_DESCRIPCION - 1) + "…" : texto);

// Argumentos que puede mandar el modelo. Las llaves de más se ignoran; los valores fuera de
// rango se rechazan con un mensaje que el modelo puede leer y corregir.
const argsBuscarPuntos = z.object({
  tipo: z.enum(TIPOS_PUNTO).optional(),
  gravedad_minima: z.number().int().min(1).max(5).optional(),
  cerca_de_mi: z.boolean().optional(),
  lat: z.number().min(14).max(33).optional(),
  lng: z.number().min(-119).max(-86).optional(),
  radio_km: z.number().min(1).max(RADIO_KM_MAXIMO).optional(),
});
const argsDetallePunto = z.object({ id: z.uuid() });
const argsBuscarAcciones = z.object({ tipo: z.enum(TIPOS_ACCION).optional(), punto_id: z.uuid().optional() });
const argsBuscarOrganizaciones = z.object({ zona: z.string().trim().min(1).max(80).optional() });
const argsBuscarConocimiento = z.object({ consulta: z.string().trim().min(3).max(300) });

/** Fragmentos que se le dan al modelo y distancia coseno máxima para considerarlos útiles. */
const FRAGMENTOS_POR_CONSULTA = 4;
export const DISTANCIA_MAXIMA = 0.5;
export const fragmentoEncontrado = z.object({
  texto: z.string(),
  titulo: z.string(),
  fuente: z.string(),
  enlace: z.string().nullable(),
  fecha_fuente: z.string().nullable(),
  distancia: z.number(),
});

export const DECLARACIONES: DeclaracionHerramienta[] = [
  {
    name: "buscar_puntos",
    description:
      "Busca problemas ambientales publicados en el mapa. Filtra por tipo, gravedad mínima y cercanía. " +
      "Usa cerca_de_mi=true si el usuario habla de su zona; usa lat y lng si nombra un lugar de México.",
    parameters: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: [...TIPOS_PUNTO], description: "Tipo de problema." },
        gravedad_minima: { type: "integer", description: "Gravedad mínima, de 1 (muy baja) a 5 (muy alta)." },
        cerca_de_mi: { type: "boolean", description: "Buscar cerca de la ubicación que compartió el usuario." },
        lat: { type: "number", description: "Latitud del lugar que nombró el usuario (México)." },
        lng: { type: "number", description: "Longitud del lugar que nombró el usuario (México)." },
        radio_km: { type: "number", description: `Radio de búsqueda en kilómetros (1 a ${String(RADIO_KM_MAXIMO)}, por defecto ${String(RADIO_KM_POR_DEFECTO)}).` },
      },
    },
  },
  {
    name: "detalle_punto",
    description: "Devuelve la descripción completa de un punto y sus acciones para ayudar (firmas, eventos, donaciones, voluntariado, denuncias).",
    parameters: { type: "object", properties: { id: { type: "string", description: "Id del punto (de buscar_puntos)." } }, required: ["id"] },
  },
  {
    name: "buscar_acciones",
    description: "Lista acciones activas para ayudar: denuncia, firma, donación, voluntariado o evento. Puede filtrar por tipo o por punto.",
    parameters: {
      type: "object",
      properties: {
        tipo: { type: "string", enum: [...TIPOS_ACCION], description: "Tipo de acción." },
        punto_id: { type: "string", description: "Id de un punto, para ver solo sus acciones." },
      },
    },
  },
  {
    name: "buscar_organizaciones",
    description: "Lista organizaciones aliadas activas, opcionalmente por zona (por ejemplo, el nombre de un municipio).",
    parameters: { type: "object", properties: { zona: { type: "string", description: "Zona o municipio." } } },
  },
];

/** Se declara solo si hay embeddings (F14): busca en los documentos que cargaron los editores. */
export const DECLARACION_CONOCIMIENTO: DeclaracionHerramienta = {
  name: "buscar_conocimiento",
  description:
    "Busca en documentos de fuentes confiables que cargó el equipo (cómo denunciar, leyes y trámites, residuos, agua, aire, " +
    "bosques). Devuelve fragmentos con su título y fuente. Úsala para preguntas generales o de procedimientos.",
  parameters: {
    type: "object",
    properties: { consulta: { type: "string", description: "Lo que se busca, en pocas palabras y en español." } },
    required: ["consulta"],
  },
};

const sinPuntos = (respuesta: Record<string, unknown>): ResultadoHerramienta => ({ respuesta, puntos: [] });

export function crearHerramientas(publico: SupabaseClient, embeddings?: ModeloEmbeddings): Herramientas {
  async function buscarPuntos(a: z.infer<typeof argsBuscarPuntos>, contexto: ContextoHerramientas): Promise<ResultadoHerramienta> {
    let centro: Ubicacion | null = null;
    if (a.cerca_de_mi) {
      if (!contexto.ubicacion) {
        return sinPuntos({ error: "El usuario no compartió su ubicación. Pídele que active «Usar mi ubicación» o que diga una ciudad." });
      }
      centro = contexto.ubicacion;
    } else if (a.lat !== undefined && a.lng !== undefined) {
      centro = { lat: a.lat, lng: a.lng };
    }

    if (centro) {
      const radioKm = a.radio_km ?? RADIO_KM_POR_DEFECTO;
      const { datos } = await puntosCercanos(publico, {
        lat: centro.lat,
        lng: centro.lng,
        radio_metros: Math.round(radioKm * 1000),
        tipo: a.tipo,
        limite: 50,
      });
      const filtrados = datos.filter((p) => a.gravedad_minima === undefined || p.gravedad >= a.gravedad_minima).slice(0, MAXIMO_RESULTADOS);
      return {
        // El modelo no recibe las coordenadas del centro cuando son del usuario.
        respuesta: {
          radio_km: radioKm,
          total: filtrados.length,
          puntos: filtrados.map((p) => ({ id: p.id, titulo: p.titulo, tipo: p.tipo, gravedad: p.gravedad, distancia_km: Math.round(p.distancia_metros / 100) / 10 })),
        },
        puntos: filtrados.map(({ id, titulo, tipo, gravedad, ubicacion }) => ({ id, titulo, tipo, gravedad, ubicacion })),
      };
    }

    const pagina = await listarPuntos(publico, { pagina: 1, limite: MAXIMO_RESULTADOS, tipo: a.tipo, gravedad_minima: a.gravedad_minima });
    return {
      respuesta: {
        total: pagina.paginacion.total,
        mostrados: pagina.datos.length,
        puntos: pagina.datos.map((p) => ({ id: p.id, titulo: p.titulo, tipo: p.tipo, gravedad: p.gravedad, descripcion: recortar(p.descripcion) })),
      },
      puntos: pagina.datos.map(({ id, titulo, tipo, gravedad, ubicacion }) => ({ id, titulo, tipo, gravedad, ubicacion })),
    };
  }

  async function detallePunto(a: z.infer<typeof argsDetallePunto>): Promise<ResultadoHerramienta> {
    const p = await obtenerPunto(publico, a.id);
    return {
      respuesta: {
        id: p.id,
        titulo: p.titulo,
        tipo: p.tipo,
        gravedad: p.gravedad,
        descripcion: p.descripcion,
        acciones: p.acciones.map((x) => ({ tipo: x.tipo, nombre: x.nombre, enlace: x.enlace, de_la_comunidad: x.de_la_comunidad })),
      },
      puntos: [{ id: p.id, titulo: p.titulo, tipo: p.tipo, gravedad: p.gravedad, ubicacion: p.ubicacion }],
    };
  }

  async function buscarAcciones(a: z.infer<typeof argsBuscarAcciones>): Promise<ResultadoHerramienta> {
    const r = await llamarFuncion(publico, "listar_acciones_publicas", {
      tipo_filtro: a.tipo ?? null,
      punto: a.punto_id ?? null,
      limite: MAXIMO_RESULTADOS,
      desplazamiento: 0,
    });
    const pagina = armarPagina(r, accion, { pagina: 1, limite: MAXIMO_RESULTADOS });
    return sinPuntos({
      total: pagina.paginacion.total,
      acciones: pagina.datos.map((x) => ({ tipo: x.tipo, nombre: x.nombre, enlace: x.enlace, organizacion: x.organizacion?.nombre ?? null, punto_id: x.punto_id })),
    });
  }

  async function buscarOrganizaciones(a: z.infer<typeof argsBuscarOrganizaciones>): Promise<ResultadoHerramienta> {
    const r = await llamarFuncion(publico, "listar_organizaciones_publicas", { zona_filtro: a.zona ?? null, limite: MAXIMO_RESULTADOS, desplazamiento: 0 });
    const pagina = armarPagina(r, organizacion, { pagina: 1, limite: MAXIMO_RESULTADOS });
    return sinPuntos({ total: pagina.paginacion.total, organizaciones: pagina.datos.map((o) => ({ nombre: o.nombre, zona: o.zona })) });
  }

  async function buscarConocimiento(a: z.infer<typeof argsBuscarConocimiento>, modelo: ModeloEmbeddings): Promise<ResultadoHerramienta> {
    const [vector] = await modelo.embeber([a.consulta], "consulta");
    const r = await llamarFuncion(publico, "buscar_conocimiento_publico", {
      consulta: JSON.stringify(vector),
      cantidad: FRAGMENTOS_POR_CONSULTA,
    });
    const utiles = z.array(fragmentoEncontrado).parse(r).filter((f) => f.distancia <= DISTANCIA_MAXIMA);
    const fuentes = new Map<string, FuenteConocimiento>();
    for (const { titulo, fuente, enlace, fecha_fuente } of utiles) fuentes.set(`${titulo}|${fuente}`, { titulo, fuente, enlace, fecha_fuente });
    return {
      respuesta: {
        total: utiles.length,
        fragmentos: utiles.map((f) => ({ texto: f.texto, titulo: f.titulo, fuente: f.fuente, fecha: f.fecha_fuente })),
      },
      puntos: [],
      fuentes: [...fuentes.values()],
    };
  }

  return {
    declaraciones: embeddings ? [...DECLARACIONES, DECLARACION_CONOCIMIENTO] : DECLARACIONES,
    async ejecutar(nombre, argumentos, contexto) {
      try {
        switch (nombre) {
          case "buscar_puntos":
            return await buscarPuntos(argsBuscarPuntos.parse(argumentos), contexto);
          case "detalle_punto":
            return await detallePunto(argsDetallePunto.parse(argumentos));
          case "buscar_acciones":
            return await buscarAcciones(argsBuscarAcciones.parse(argumentos));
          case "buscar_organizaciones":
            return await buscarOrganizaciones(argsBuscarOrganizaciones.parse(argumentos));
          case "buscar_conocimiento":
            if (embeddings) return await buscarConocimiento(argsBuscarConocimiento.parse(argumentos), embeddings);
            return sinPuntos({ error: "No existe la herramienta buscar_conocimiento." });
          default:
            return sinPuntos({ error: `No existe la herramienta ${nombre}.` });
        }
      } catch (e) {
        // El modelo recibe un error legible y puede corregir sus argumentos; nada se filtra.
        if (e instanceof z.ZodError) return sinPuntos({ error: "Argumentos inválidos: " + e.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") });
        if (e instanceof ErrorAplicacion && e.estado < 500) return sinPuntos({ error: e.message });
        // Solo el motivo técnico (código de la base, estado HTTP o tipo de error), sin datos.
        const causa = e instanceof Error && typeof e.cause === "string" ? e.cause : e instanceof ErrorAplicacion ? String(e.estado) : e instanceof Error ? e.name : "desconocida";
        registrar("error", "herramienta_fallida", { herramienta: nombre, causa });
        return sinPuntos({ error: "No se pudo consultar la base en este momento." });
      }
    },
  };
}
