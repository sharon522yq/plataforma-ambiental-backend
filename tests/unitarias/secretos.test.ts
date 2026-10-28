import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Sección 13: ningún secreto en el código. Revisa todos los archivos del proyecto, salvo
 * .env (local y fuera de Git), node_modules y carpetas generadas.
 */
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OMITIR = new Set(["node_modules", "dist", "coverage", ".git", ".env"]);

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    if (OMITIR.has(nombre)) return [];
    const ruta = path.join(dir, nombre);
    return statSync(ruta).isDirectory() ? archivos(ruta) : [ruta];
  });
}

const PATRONES: [string, RegExp][] = [
  ["JWT (llave de Supabase o token)", /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}/],
  ["llave clásica de Google", /AIza[0-9A-Za-z_-]{35}/],
  ["llave nueva de Supabase", /sb_(secret|publishable)_[A-Za-z0-9_-]{10,}/],
  ["cadena de PostgreSQL con contraseña real", /postgres(?:ql)?:\/\/[^:\s/]+:(?!\.\.\.|\[|TU_CLAVE)[^@\s]{6,}@/],
  ["llave privada", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

describe("sin secretos en el proyecto", () => {
  const lista = archivos(RAIZ);

  it("revisa una cantidad razonable de archivos", () => {
    expect(lista.length).toBeGreaterThan(50);
  });

  it.each(PATRONES)("ningún archivo contiene un %s", (_nombre, patron) => {
    const hallados = lista.filter((f) => patron.test(readFileSync(f, "utf8")));
    expect(hallados.map((f) => path.relative(RAIZ, f))).toEqual([]);
  });

  it("los patrones sí detectan un secreto (la prueba no pasa por estar mal escrita)", () => {
    const falsos = [
      `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}`,
      `AIza${"x".repeat(35)}`,
      `sb_secret_${"y".repeat(12)}`,
      "postgresql://postgres:" + "ClaveReal123" + "@db.ejemplo.co:5432/postgres",
      "-----BEGIN " + "PRIVATE KEY-----",
    ];
    PATRONES.forEach(([, patron], i) => {
      expect(patron.test(falsos[i] ?? "")).toBe(true);
    });
  });
});
