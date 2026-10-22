import "dotenv/config";
import path from "node:path";
import { aplicarMigraciones } from "./config/migraciones.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL en .env (ver .env.example).");
  process.exit(1);
}

try {
  const r = await aplicarMigraciones(url, path.resolve("migrations"));
  console.log(`Aplicadas: ${r.aplicadas.length.toString()} ${r.aplicadas.join(", ")}`.trimEnd());
  console.log(`Ya estaban aplicadas: ${r.omitidas.length.toString()}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Error desconocido al migrar.");
  process.exit(1);
}
