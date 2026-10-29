import { defineConfig } from "vitest/config";

// Meta de cobertura: 70 % (D-11). `npm run test:cobertura` falla si alguna métrica baja de ahí;
// el CI lo corre en cada push.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      thresholds: { lines: 70, statements: 70, functions: 70, branches: 70 },
    },
  },
});
