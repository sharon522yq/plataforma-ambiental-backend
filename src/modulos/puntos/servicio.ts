import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { armarPagina, desplazamiento, llamarFuncion } from "../../compartido/consultas.js";
import { NoEncontrado } from "../../compartido/errores.js";
import { puntoCercano, puntoDetalle, puntoResumen, type consultaCercanos, type consultaListado } from "./esquemas.js";

export async function listarPuntos(cliente: SupabaseClient, consulta: z.infer<typeof consultaListado>) {
  const respuesta = await llamarFuncion(cliente, "listar_puntos_publicos", {
    tipo_filtro: consulta.tipo ?? null,
    gravedad_minima: consulta.gravedad_min ?? null,
    limite: consulta.limite,
    desplazamiento: desplazamiento(consulta),
  });
  return armarPagina(respuesta, puntoResumen, { pagina: consulta.pagina, limite: consulta.limite });
}

export async function puntosCercanos(cliente: SupabaseClient, consulta: z.infer<typeof consultaCercanos>) {
  const respuesta = await llamarFuncion(cliente, "puntos_cercanos_publicos", {
    lat: consulta.lat,
    lng: consulta.lng,
    radio_metros: consulta.radio,
    tipo_filtro: consulta.tipo ?? null,
    limite: consulta.limite,
  });
  return { datos: z.array(puntoCercano).parse(respuesta) };
}

export async function obtenerPunto(cliente: SupabaseClient, id: string) {
  const respuesta = await llamarFuncion(cliente, "obtener_punto_publico", { punto_id: id });
  if (respuesta === null) throw new NoEncontrado("El punto no existe o no está publicado");
  return puntoDetalle.parse(respuesta);
}
