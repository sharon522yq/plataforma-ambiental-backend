import { cargarEntorno } from "./config/env.js";
import { crearApp } from "./app.js";
import { registrar } from "./compartido/registro.js";

const entorno = cargarEntorno();
const app = crearApp(entorno);

app.listen(entorno.PORT, () => {
  registrar("info", "servidor_iniciado", { puerto: entorno.PORT, correo: entorno.BREVO_API_KEY && entorno.CORREO_REMITENTE ? "activo" : "desactivado" });
  if (Boolean(entorno.BREVO_API_KEY) !== Boolean(entorno.CORREO_REMITENTE)) {
    registrar("warn", "correo_incompleto", { falta: entorno.BREVO_API_KEY ? "CORREO_REMITENTE" : "BREVO_API_KEY" });
  }
});
