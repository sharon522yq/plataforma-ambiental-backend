import express from "express";
import helmet from "helmet";
import cors from "cors";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Entorno } from "./config/env.js";
import { crearVerificadorSupabase, type VerificadorJwt } from "./config/jwt.js";
import { crearClienteAnon, crearClienteServicio, crearClienteUsuario } from "./config/supabase.js";
import { crearAlmacenSupabase, type AlmacenEvidencias } from "./compartido/evidencias.js";
import { crearLectorPerfiles, type LectorPerfiles } from "./compartido/perfiles.js";
import { crearAutenticar } from "./middleware/autenticar.js";
import { crearAutenticarOpcional } from "./middleware/autenticar-opcional.js";
import { crearAutorizar } from "./middleware/autorizar.js";
import { crearLimitador } from "./middleware/limitador.js";
import { crearRegistroSolicitudes } from "./middleware/registro-solicitudes.js";
import { manejadorErrores } from "./middleware/manejador-errores.js";
import { crearRutasAcciones } from "./modulos/acciones/rutas.js";
import { crearRutasAdministracion } from "./modulos/administracion/rutas.js";
import { crearRegistroConversaciones, type RegistroConversaciones } from "./modulos/agente/conversaciones.js";
import { crearGemini, type ModeloIA } from "./modulos/agente/gemini.js";
import { crearRutasAgente } from "./modulos/agente/rutas.js";
import { crearRutasConfiguracion } from "./modulos/configuracion/rutas.js";
import { crearRutasAportes, type ClientePorUsuario } from "./modulos/aportes/rutas.js";
import { crearRutasModeracion } from "./modulos/moderacion/rutas.js";
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
  /** Cliente con la sesión del usuario, para escrituras con RLS. */
  clienteUsuario?: ClientePorUsuario;
  /** Fotos de evidencia. Por defecto, el bucket privado de Storage con el cliente de servicio. */
  almacen?: AlmacenEvidencias;
  /** Gemini. Las pruebas usan uno simulado: nunca llaman a la API real. */
  ia?: ModeloIA;
  /** Dónde se guardan las conversaciones del agente. */
  conversaciones?: RegistroConversaciones;
}

export function crearApp(entorno: Entorno, dependencias?: Dependencias) {
  const app = express();
  const publico = dependencias?.publico ?? crearClienteAnon(entorno);
  const verificador = dependencias?.verificador ?? crearVerificadorSupabase(entorno);
  // Un solo cliente de servicio, y solo si hace falta (las pruebas inyectan sus dobles).
  let servicio: SupabaseClient | undefined;
  const clienteServicio = () => (servicio ??= crearClienteServicio(entorno));
  const perfiles = dependencias?.perfiles ?? crearLectorPerfiles(clienteServicio());
  const almacen = dependencias?.almacen ?? crearAlmacenSupabase(clienteServicio());
  const clienteUsuario = dependencias?.clienteUsuario ?? ((token: string) => crearClienteUsuario(entorno, token));
  const ia = dependencias?.ia ?? crearGemini({ llave: entorno.GEMINI_API_KEY, modelo: entorno.GEMINI_MODELO });
  const conversaciones = dependencias?.conversaciones ?? crearRegistroConversaciones(clienteServicio());
  const autenticar = crearAutenticar(verificador);
  const autorizar = crearAutorizar(perfiles);

  app.disable("x-powered-by");
  // Detrás de un proxy (Render) hay que confiar en él para leer la IP real del cliente;
  // si no, el límite del agente sería uno solo para todos (D-32).
  app.set("trust proxy", entorno.PROXIES_DE_CONFIANZA);
  app.use(crearRegistroSolicitudes(entorno.NODE_ENV !== "test"));
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
  api.use(
    "/salud",
    crearRutasSalud(publico, { ia, modelo: entorno.GEMINI_MODELO, soloAdministrador: [autenticar, autorizar("administrador")] }),
  );
  api.use(
    "/configuracion-publica",
    crearRutasConfiguracion({ supabaseUrl: entorno.SUPABASE_URL, supabaseAnonKey: entorno.SUPABASE_ANON_KEY }),
  );
  api.use("/sesion", crearRutasSesion(autenticar, autorizar));
  api.use("/puntos", crearRutasPuntos(publico));
  api.use("/acciones", crearRutasAcciones(publico));
  api.use("/organizaciones", crearRutasOrganizaciones(publico));
  api.use("/aportes", crearRutasAportes(autenticar, autorizar, clienteUsuario, almacen));
  api.use("/admin", crearRutasModeracion(autenticar, autorizar, clienteUsuario, almacen));
  api.use("/admin", crearRutasAdministracion(autenticar, autorizar, clienteUsuario));
  api.use(
    "/agente",
    crearRutasAgente({
      ia,
      conversaciones,
      limitePorMinuto: entorno.LIMITE_AGENTE_POR_MINUTO,
      autenticarOpcional: crearAutenticarOpcional(autenticar),
    }),
  );

  // Límite general por IP (D-34). /salud no cuenta: Render la consulta seguido.
  const limiteGeneral = crearLimitador({
    porMinuto: entorno.LIMITE_SOLICITUDES_POR_MINUTO,
    mensaje: "Demasiadas solicitudes, intenta en un minuto",
    omitir: (req) => req.path === "/salud" || req.path === "/salud/",
  });
  app.use("/api/v1", limiteGeneral, api);
  app.use((_req, res) => {
    res.status(404).json({ error: { codigo: "NO_ENCONTRADO", mensaje: "Ruta no encontrada", detalles: [] } });
  });
  app.use(manejadorErrores);
  return app;
}
