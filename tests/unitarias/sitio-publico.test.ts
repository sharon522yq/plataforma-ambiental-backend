import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * F12: el sitio público es `prototipo/index.html` servido por Render como sitio estático.
 * Estas pruebas cuidan que `render.yaml` y la página no se desalineen: si la página empieza a
 * usar un origen nuevo, la política de contenido lo bloquearía en producción sin aviso.
 */
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const render = readFileSync(path.join(RAIZ, "render.yaml"), "utf8");
const pagina = readFileSync(path.join(RAIZ, "prototipo/index.html"), "utf8");

/** El bloque YAML del servicio estático (desde su `- type:` hasta el siguiente servicio o el final). */
const bloqueEstatico = (() => {
  const servicios = render.split(/\n(?= {2}- type:)/);
  const estatico = servicios.find((s) => /runtime: static/.test(s));
  if (!estatico) throw new Error("render.yaml no tiene un servicio estático");
  return estatico;
})();

function cabecera(nombre: string): string {
  const m = new RegExp(`name: ${nombre}\\n\\s+value: "?([^\\n"]+)"?`).exec(bloqueEstatico);
  if (!m?.[1]) throw new Error(`falta la cabecera ${nombre}`);
  return m[1];
}

function directiva(csp: string, nombre: string): string[] {
  const parte = csp.split(";").map((p) => p.trim()).find((p) => p.startsWith(nombre + " "));
  return parte ? parte.split(/\s+/).slice(1) : [];
}

function permitido(fuentes: string[], url: string): boolean {
  const u = new URL(url);
  return fuentes.some((f) => {
    if (f === u.origin) return true;
    const comodin = /^(https|wss):\/\/\*\.(.+)$/.exec(f);
    if (!comodin) return false;
    const [, protocolo = "", dominio = ""] = comodin;
    return u.protocol === `${protocolo}:` && u.hostname.endsWith("." + dominio);
  });
}

describe("sitio público en Render", () => {
  it("publica la carpeta del prototipo desde main, sin compilar y solo cuando cambia", () => {
    expect(bloqueEstatico).toMatch(/staticPublishPath: \.\/prototipo/);
    expect(bloqueEstatico).toMatch(/branch: main/);
    expect(bloqueEstatico).toMatch(/- prototipo\/\*\*/);
    expect(bloqueEstatico).not.toMatch(/envVars/);
  });

  it("envía cabeceras de seguridad", () => {
    expect(cabecera("X-Content-Type-Options")).toBe("nosniff");
    expect(cabecera("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    const csp = cabecera("Content-Security-Policy");
    expect(directiva(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(directiva(csp, "object-src")).toEqual(["'none'"]);
    expect(directiva(csp, "default-src")).toEqual(["'self'"]);
  });

  it("la política de contenido deja pasar cada script externo de la página", () => {
    const csp = cabecera("Content-Security-Policy");
    const scripts = [...pagina.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) expect(permitido(directiva(csp, "script-src"), src), src).toBe(true);
    const estilos = [...pagina.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1] ?? "");
    for (const href of estilos) expect(permitido(directiva(csp, "style-src"), href), href).toBe(true);
  });

  it("la política de contenido deja llamar a la API, a Supabase y a Nominatim", () => {
    const csp = cabecera("Content-Security-Policy");
    const api = /const API_POR_DEFECTO = "([^"]+)"/.exec(pagina)?.[1] ?? "";
    expect(api).toMatch(/^https:\/\//);
    const conexiones = directiva(csp, "connect-src");
    expect(permitido(conexiones, api)).toBe(true);
    expect(permitido(conexiones, "https://proyecto.supabase.co/auth/v1/token")).toBe(true);
    const nominatim = /"(https:\/\/nominatim\.openstreetmap\.org)\/search/.exec(pagina)?.[1] ?? "";
    expect(permitido(conexiones, nominatim + "/search")).toBe(true);
    expect(permitido(directiva(csp, "img-src"), "https://a.tile.openstreetmap.org/12/1/1.png")).toBe(true);
  });

  it("la página declara su codificación y se adapta al teléfono", () => {
    expect(pagina).toMatch(/<meta charset="utf-8">/);
    expect(pagina).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1">/);
  });
});

describe("aviso de privacidad (F12)", () => {
  it("existe, tiene versión y se pide al registrarse y al reportar", () => {
    expect(pagina).toMatch(/const VERSION_AVISO = "\d{4}-\d{2}-\d{2}"/);
    expect(pagina).toContain("function vistaPrivacidad(");
    expect(pagina).toContain('id: "c-aviso"');
    expect(pagina).toContain('id: "r-aviso"');
    expect(pagina).toContain("aviso_privacidad: VERSION_AVISO");
  });

  it("no inventa un correo de contacto", () => {
    const contacto = /const CONTACTO_PRIVACIDAD = "([^"]*)"/.exec(pagina)?.[1];
    expect(contacto === "" || /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(contacto ?? "")).toBe(true);
  });
});
