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

  it("una variable obligatoria vacía cuenta como faltante", () => {
    expect(() => cargarEntorno({ ...base, GEMINI_API_KEY: "" })).toThrow(/GEMINI_API_KEY/);
  });

  it("falla con mensaje claro si falta una variable obligatoria", () => {
    const sinLlave: Record<string, string> = { ...base };
    delete sinLlave.GEMINI_API_KEY;
    expect(() => cargarEntorno(sinLlave)).toThrow(/GEMINI_API_KEY/);
  });
});
