import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
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

describe("rutas y accesibilidad (F16)", () => {
  /** Ejecuta `rutasA` tal como está en la página, sin navegador. */
  const rutasA = (() => {
    const fuente = /function rutasA\(u\) \{[\s\S]+?\n\}/.exec(pagina)?.[0];
    if (!fuente) throw new Error("falta rutasA en la página");
    return runInNewContext(`${fuente}; rutasA`) as (u: { lat: number; lng: number }) => { google: string; osm: string };
  })();

  it("«Cómo llegar» solo manda el destino, nunca el origen de la persona", () => {
    const r = rutasA({ lat: 20.6736, lng: -103.344 });
    const google = new URL(r.google), osm = new URL(r.osm);
    expect(google.origin).toBe("https://www.google.com");
    expect(google.searchParams.get("destination")).toBe("20.673600,-103.344000");
    expect(google.searchParams.has("origin")).toBe(false);
    expect(osm.origin).toBe("https://www.openstreetmap.org");
    expect(osm.searchParams.get("to")).toBe("20.673600,-103.344000");
    expect(osm.searchParams.has("from")).toBe(false);
  });

  it("los enlaces de ruta abren otra pestaña sin darle acceso a la página", () => {
    const enlaces = [...pagina.matchAll(/href: r\.(google|osm), ([^}]+)\}/g)].map((m) => m[2] ?? "");
    expect(enlaces).toHaveLength(2);
    for (const e of enlaces) expect(e).toContain('rel: "noopener noreferrer"');
  });

  it("toda tabla con desplazamiento se alcanza con el teclado", () => {
    expect(pagina).not.toMatch(/h\("div", \{ class: "tabla-wrap"/);
    expect(pagina).toMatch(/const TABLA_DESPLAZABLE = \{ class: "tabla-wrap", tabindex: "0", role: "region", "aria-label": "[^"]+" \}/);
  });

  it("el modo de alto contraste es un botón con estado y respeta la preferencia del sistema", () => {
    expect(pagina).toMatch(/<button type="button" class="[^"]*" id="contraste" aria-pressed="false">/);
    expect(pagina).toContain("prefers-contrast: more");
    expect(pagina).toContain(':root[data-contraste="alto"]');
  });

  it("el elemento elegido de la lista se anuncia con aria-current", () => {
    expect(pagina).toContain('.item[aria-current="true"]');
    expect(pagina).not.toMatch(/\.item\.sel\b/);
  });
});
