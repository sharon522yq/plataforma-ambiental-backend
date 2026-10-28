import { describe, expect, it } from "vitest";
import { cargarEntorno } from "../../src/config/env.js";

const base = {
  NODE_ENV: "test",
  SUPABASE_URL: "https://ejemplo.supabase.co",
  SUPABASE_ANON_KEY: "x",
  SUPABASE_SERVICE_ROLE_KEY: "x",
  SUPABASE_JWT_SECRET: "x",
  GEMINI_API_KEY: "x",
  CORS_ORIGENES: "http://localhost:5173, https://ejemplo.org",
};

describe("cargarEntorno", () => {
  it("aplica valores por defecto y separa CORS_ORIGENES", () => {
    const e = cargarEntorno(base);
    expect(e.PORT).toBe(3000);
    expect(e.GEMINI_MODELO).toBe("gemini-2.5-flash");
    expect(e.PROXIES_DE_CONFIANZA).toBe(0);
    expect(e.CORS_ORIGENES).toEqual(["http://localhost:5173", "https://ejemplo.org"]);
  });

  it("trata las variables vacías como ausentes y aplica sus valores por defecto", () => {
    const e = cargarEntorno({
      ...base,
      PORT: "",
      GEMINI_MODELO: "  ",
      LIMITE_SOLICITUDES_POR_MINUTO: "",
      LIMITE_AGENTE_POR_MINUTO: "",
    });
    expect(e.PORT).toBe(3000);
    expect(e.GEMINI_MODELO).toBe("gemini-2.5-flash");
    expect(e.LIMITE_SOLICITUDES_POR_MINUTO).toBe(60);
    expect(e.LIMITE_AGENTE_POR_MINUTO).toBe(10);
  });

  it("quita espacios y saltos de línea al inicio y al final de cada valor", () => {
    const e = cargarEntorno({
      ...base,
      SUPABASE_URL: "https://ejemplo.supabase.co ",
      SUPABASE_JWT_SECRET: " secreto\r\n",
      GEMINI_API_KEY: "\tllave ",
      PORT: " 8080 ",
    });
    expect(e.SUPABASE_URL).toBe("https://ejemplo.supabase.co");
    expect(e.SUPABASE_JWT_SECRET).toBe("secreto");
    expect(e.GEMINI_API_KEY).toBe("llave");
    expect(e.PORT).toBe(8080);
  });

  it("con un espacio al final de SUPABASE_URL el verificador de tokens arranca", async () => {
    const { crearVerificadorSupabase } = await import("../../src/config/jwt.js");
    expect(() => crearVerificadorSupabase(cargarEntorno({ ...base, SUPABASE_URL: "https://ejemplo.supabase.co " }))).not.toThrow();
  });

  it("PROXIES_DE_CONFIANZA acepta de 0 a 3", () => {
    expect(cargarEntorno({ ...base, PROXIES_DE_CONFIANZA: "1" }).PROXIES_DE_CONFIANZA).toBe(1);
    expect(() => cargarEntorno({ ...base, PROXIES_DE_CONFIANZA: "9" })).toThrow(/PROXIES_DE_CONFIANZA/);
  });

  it("una variable obligatoria vacía cuenta como faltante", () => {
    expect(() => cargarEntorno({ ...base, GEMINI_API_KEY: "" })).toThrow(/GEMINI_API_KEY/);
  });

  it("falla con mensaje claro si falta una variable obligatoria", () => {
    const sinLlave: Record<string, string> = { ...base };
    delete sinLlave.GEMINI_API_KEY;
    expect(() => cargarEntorno(sinLlave)).toThrow(/GEMINI_API_KEY/);
  });
});
