import "dotenv/config";
import { z } from "zod";

/**
 * npm run verificar:gemini — comprueba la llave de Gemini sin gastar cuota: solo pide la
 * lista de modelos. Nunca imprime la llave. Muestra si el modelo configurado existe y qué
 * modelos "flash" admiten generar texto, para elegir GEMINI_MODELO.
 */
const llave = process.env.GEMINI_API_KEY?.trim();
const modelo = process.env.GEMINI_MODELO?.trim() || "gemini-2.5-flash";
if (!llave) {
  console.error("Falta GEMINI_API_KEY en .env.");
  process.exit(1);
}

const lista = z.object({
  models: z.array(z.object({ name: z.string(), supportedGenerationMethods: z.array(z.string()).optional() })).optional(),
  nextPageToken: z.string().optional(),
});

try {
  const nombres: string[] = [];
  let pagina: string | undefined;
  do {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize", "1000");
    if (pagina) url.searchParams.set("pageToken", pagina);
    const r = await fetch(url, { headers: { "x-goog-api-key": llave }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) {
      console.error(`La llave no funciona con Gemini (respuesta ${r.status.toString()}).`);
      console.error(r.status === 400 || r.status === 401 || r.status === 403
        ? "Revisa que sea una llave de Google AI Studio (aistudio.google.com) y que esté completa."
        : "Google no respondió bien; intenta de nuevo en unos minutos.");
      process.exit(1);
    }
    const datos = lista.parse(await r.json());
    for (const m of datos.models ?? []) {
      if (m.supportedGenerationMethods?.includes("generateContent")) nombres.push(m.name.replace(/^models\//, ""));
    }
    pagina = datos.nextPageToken;
  } while (pagina);

  console.log("Llave válida: Google respondió con la lista de modelos.");
  console.log(`Modelo configurado (${modelo}): ${nombres.includes(modelo) ? "disponible" : "NO disponible"}`);
  const flash = nombres.filter((n) => n.includes("flash")).sort();
  console.log(`Modelos flash disponibles: ${flash.length > 0 ? flash.join(", ") : "ninguno"}`);
} catch {
  console.error("No se pudo contactar a Google. Revisa tu conexión a internet.");
  process.exit(1);
}
