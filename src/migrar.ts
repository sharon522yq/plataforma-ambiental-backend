import "dotenv/config";
import path from "node:path";
import { aplicarMigraciones, estadoMigraciones } from "./config/migraciones.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL en .env (ver .env.example).");
  process.exit(1);
}

const carpeta = path.resolve("migrations");
const soloEstado = process.argv.includes("--estado");

try {
  if (soloEstado) {
    // Solo lectura: no aplica nada (npm run migrar -- --estado).
    const e = await estadoMigraciones(url, carpeta);
    console.log(`Aplicadas: ${e.aplicadas.length.toString()}${e.aplicadas.length ? ` (última: ${e.aplicadas.at(-1) ?? ""})` : ""}`);
    console.log(`Pendientes: ${e.pendientes.length.toString()} ${e.pendientes.join(", ")}`.trimEnd());
    if (e.desconocidas.length) {
      console.log(`En la base pero no en esta carpeta: ${e.desconocidas.join(", ")} (¿copia vieja del código?)`);
    }
  } else {
    const r = await aplicarMigraciones(url, carpeta);
    console.log(`Aplicadas: ${r.aplicadas.length.toString()} ${r.aplicadas.join(", ")}`.trimEnd());
    console.log(`Ya estaban aplicadas: ${r.omitidas.length.toString()}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Error desconocido al migrar.");
  process.exit(1);
}
