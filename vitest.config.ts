import { defineConfig } from "vitest/config";

// Meta de cobertura: 70 % (ver docs/decisiones-pendientes.md, D-11).
// El umbral se activa en la fase 11, cuando la cobertura lo permita.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: { provider: "v8" },
  },
});
