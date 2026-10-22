import { cargarEntorno } from "./config/env.js";
import { crearApp } from "./app.js";
import { registrar } from "./compartido/registro.js";

const entorno = cargarEntorno();
const app = crearApp(entorno);

app.listen(entorno.PORT, () => {
  registrar("info", "servidor_iniciado", { puerto: entorno.PORT });
});
