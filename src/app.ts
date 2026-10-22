import express from "express";
import helmet from "helmet";
import cors from "cors";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Entorno } from "./config/env.js";
import { crearClienteAnon } from "./config/supabase.js";
import { manejadorErrores } from "./middleware/manejador-errores.js";
import { crearRutasSalud } from "./modulos/salud/rutas.js";

export interface Dependencias {
  /** Cliente público (anon). Las pruebas lo sustituyen por uno falso. */
  publico: SupabaseClient;
}

export function crearApp(entorno: Entorno, dependencias?: Dependencias) {
  const app = express();
  const deps: Dependencias = dependencias ?? { publico: crearClienteAnon(entorno) };

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    cors({
      origin: (origen, cb) => {
        // Solicitudes sin cabecera Origin (curl, Render health check) no son de navegador.
        const permitido = !origen || entorno.CORS_ORIGENES.includes(origen);
        cb(null, permitido);
      },
    }),
  );
  app.use(express.json({ limit: "100kb" }));

  const api = express.Router();
  api.use("/salud", crearRutasSalud(deps.publico));

  app.use("/api/v1", api);
  app.use((_req, res) => {
    res.status(404).json({ error: { codigo: "NO_ENCONTRADO", mensaje: "Ruta no encontrada", detalles: [] } });
  });
  app.use(manejadorErrores);
  return app;
}
