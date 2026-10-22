import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default [
  { ignores: ["dist", "node_modules", "coverage"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        // Un solo proyecto cubre src y pruebas (ver tsconfig.pruebas.json).
        project: ["./tsconfig.pruebas.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Archivos de configuración fuera del proyecto TypeScript: sin revisión de tipos.
    files: ["**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
];
