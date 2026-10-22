import express from "express";
import helmet from "helmet";
import cors from "cors";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Entorno } from "./config/env.js";
import { crearVerificadorSupabase, type VerificadorJwt } from "./config/jwt.js";
import { crearClienteAnon, crearClienteServicio } from "./config/supabase.js";
import { crearLectorPerfiles, type LectorPerfiles } from "./compartido/perfiles.js";
import { crearAutenticar } from "./middleware/autenticar.js";
import { crearAutorizar } from "./middleware/autorizar.js";
import { manejadorErrores } from "./middleware/manejador-errores.js";
import { crearRutasAcciones } from "./modulos/acciones/rutas.js";
import { crearRutasOrganizaciones } from "./modulos/organizaciones/rutas.js";
import { crearRutasPuntos } from "./modulos/puntos/rutas.js";
import { crearRutasSalud } from "./modulos/salud/rutas.js";
import { crearRutasSesion } from "./modulos/sesion/rutas.js";

export interface Dependencias {
  /** Cliente público (anon). Las pruebas lo sustituyen por uno falso. */
  publico: SupabaseClient;
  /** Verificación de tokens. Por defecto, la del proyecto de Supabase del entorno. */
  verificador?: VerificadorJwt;
  /** Lectura de roles. Por defecto, perfiles con el cliente de servicio. */
  perfiles?: LectorPerfiles;
}

export function crearApp(entorno: Entorno, dependencias?: Dependencias) {
  const app = express();
  const publico = dependencias?.publico ?? crearClienteAnon(entorno);
  const verificador = dependencias?.verificador ?? crearVerificadorSupabase(entorno);
  const perfiles = dependencias?.perfiles ?? crearLectorPerfiles(crearClienteServicio(entorno));
  const autenticar = crearAutenticar(verificador);
  const autorizar = crearAutorizar(perfiles);

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
  api.use("/salud", crearRutasSalud(publico));
  api.use("/sesion", crearRutasSesion(autenticar, autorizar));
  api.use("/puntos", crearRutasPuntos(publico));
  api.use("/acciones", crearRutasAcciones(publico));
  api.use("/organizaciones", crearRutasOrganizaciones(publico));

  app.use("/api/v1", api);
  app.use((_req, res) => {
    res.status(404).json({ error: { codigo: "NO_ENCONTRADO", mensaje: "Ruta no encontrada", detalles: [] } });
  });
  app.use(manejadorErrores);
  return app;
}
