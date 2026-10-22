import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { crearApp } from "../../src/app.js";
import type { Perfil } from "../../src/compartido/perfiles.js";
import type { Rol } from "../../src/compartido/sesion.js";
import { crearVerificadorJwt } from "../../src/config/jwt.js";
import { crearAutenticar } from "../../src/middleware/autenticar.js";
import { crearAutorizar } from "../../src/middleware/autorizar.js";
import { manejadorErrores } from "../../src/middleware/manejador-errores.js";
import { clienteFalso } from "../ayudas/cliente-falso.js";
import { entornoDePrueba } from "../ayudas/entorno.js";
import { perfilesFalsos } from "../ayudas/perfiles-falsos.js";
import { EMISOR_PRUEBA, SECRETO_PRUEBA, tokenDePrueba } from "../ayudas/tokens.js";

const usuarios: Record<Rol | "inactivo", string> = {
  ciudadano: randomUUID(),
  moderador: randomUUID(),
  editor: randomUUID(),
  administrador: randomUUID(),
  inactivo: randomUUID(),
};
const tabla: Record<string, Perfil> = {
  [usuarios.ciudadano]: { rol: "ciudadano", activo: true },
  [usuarios.moderador]: { rol: "moderador", activo: true },
  [usuarios.editor]: { rol: "editor", activo: true },
  [usuarios.administrador]: { rol: "administrador", activo: true },
  [usuarios.inactivo]: { rol: "administrador", activo: false },
};

const verificador = crearVerificadorJwt({ secreto: SECRETO_PRUEBA, emisor: EMISOR_PRUEBA });
const app = crearApp(entornoDePrueba(), {
  publico: clienteFalso({ error: null }),
  verificador,
  perfiles: perfilesFalsos(tabla),
});

/** App mínima con una ruta por nivel de permiso, para probar autorizar() con cada rol. */
function appConRutasProtegidas(perfiles = perfilesFalsos(tabla)) {
  const prueba = express();
  const autenticar = crearAutenticar(verificador);
  const autorizar = crearAutorizar(perfiles);
  const ok = (_req: express.Request, res: express.Response) => { res.json({ ok: true }); };
  prueba.get("/cuenta", autenticar, autorizar(), ok);
  prueba.get("/moderacion", autenticar, autorizar("moderador", "administrador"), ok);
  prueba.get("/admin", autenticar, autorizar("administrador"), ok);
  prueba.use(manejadorErrores);
  return prueba;
}

const bearer = async (sub: string, claims?: Record<string, unknown>) =>
  `Bearer ${await tokenDePrueba({ sub, claims })}`;

describe("autenticar: GET /api/v1/sesion", () => {
  it("401 sin cabecera Authorization, con formato de error uniforme", async () => {
    const r = await request(app).get("/api/v1/sesion");
    expect(r.status).toBe(401);
    expect(r.body).toEqual({ error: { codigo: "NO_AUTENTICADO", mensaje: "Debes iniciar sesión", detalles: [] } });
  });

  it.each([
    ["sin el prefijo Bearer", (t: string) => t],
    ["con otro esquema", (t: string) => `Basic ${t}`],
    ["con Bearer vacío", () => "Bearer "],
  ])("401 con la cabecera %s", async (_caso, formar) => {
    const token = await tokenDePrueba({ sub: usuarios.ciudadano });
    const r = await request(app).get("/api/v1/sesion").set("Authorization", formar(token));
    expect(r.status).toBe(401);
  });

  it("401 con token vencido, inválido o de otro proyecto", async () => {
    for (const token of [
      await tokenDePrueba({ sub: usuarios.ciudadano, expiraEn: -60 }),
      await tokenDePrueba({ sub: usuarios.ciudadano, secreto: "otro" }),
      await tokenDePrueba({ sub: usuarios.ciudadano, iss: "https://otro.supabase.co/auth/v1" }),
      "no.es.jwt",
    ]) {
      const r = await request(app).get("/api/v1/sesion").set("Authorization", `Bearer ${token}`);
      expect(r.status).toBe(401);
      expect(r.body).toMatchObject({ error: { codigo: "NO_AUTENTICADO" } });
    }
  });

  it("200 con el id y el rol leído de perfiles", async () => {
    const r = await request(app).get("/api/v1/sesion").set("Authorization", await bearer(usuarios.editor));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: usuarios.editor, rol: "editor" });
  });

  it("la respuesta nunca incluye el token", async () => {
    const cabecera = await bearer(usuarios.ciudadano);
    const r = await request(app).get("/api/v1/sesion").set("Authorization", cabecera);
    expect(JSON.stringify(r.body)).not.toContain(cabecera.slice(7));
  });

  it("403 si la cuenta está desactivada o no tiene perfil", async () => {
    for (const id of [usuarios.inactivo, randomUUID()]) {
      const r = await request(app).get("/api/v1/sesion").set("Authorization", await bearer(id));
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: { codigo: "PROHIBIDO" } });
    }
  });
});

describe("autorizar por rol", () => {
  const prueba = appConRutasProtegidas();
  const esperado: Record<Rol, { cuenta: number; moderacion: number; admin: number }> = {
    ciudadano: { cuenta: 200, moderacion: 403, admin: 403 },
    moderador: { cuenta: 200, moderacion: 200, admin: 403 },
    editor: { cuenta: 200, moderacion: 403, admin: 403 },
    administrador: { cuenta: 200, moderacion: 200, admin: 200 },
  };

  it.each(Object.entries(esperado) as [Rol, (typeof esperado)[Rol]][])("%s recibe los códigos esperados", async (rol, codigos) => {
    const cabecera = await bearer(usuarios[rol]);
    for (const [ruta, estado] of Object.entries(codigos)) {
      const r = await request(prueba).get(`/${ruta}`).set("Authorization", cabecera);
      expect(r.status, `${rol} en /${ruta}`).toBe(estado);
    }
  });

  it("un visitante sin sesión recibe 401 en todas las rutas protegidas", async () => {
    for (const ruta of ["cuenta", "moderacion", "admin"]) {
      expect((await request(prueba).get(`/${ruta}`)).status).toBe(401);
    }
  });

  it("ignora el rol que venga dentro del token", async () => {
    const cabecera = await bearer(usuarios.ciudadano, {
      rol: "administrador",
      user_metadata: { rol: "administrador" },
      app_metadata: { rol: "administrador" },
    });
    expect((await request(prueba).get("/admin").set("Authorization", cabecera)).status).toBe(403);
  });

  it("una cuenta desactivada no entra ni siendo administrador", async () => {
    const r = await request(prueba).get("/admin").set("Authorization", await bearer(usuarios.inactivo));
    expect(r.status).toBe(403);
  });

  it("500 sin detalles técnicos si no se puede leer el perfil", async () => {
    const caida = appConRutasProtegidas(perfilesFalsos(new Error("connection refused 10.0.0.1")));
    const r = await request(caida).get("/cuenta").set("Authorization", await bearer(usuarios.ciudadano));
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/connection|10\.0\.0\.1/);
  });
});
