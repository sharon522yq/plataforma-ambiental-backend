import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { crearApp } from "../../src/app.js";
import { crearLectorPerfiles } from "../../src/compartido/perfiles.js";
import { crearClienteAnon, crearClienteServicio } from "../../src/config/supabase.js";
import { cargarEntorno, type Entorno } from "../../src/config/env.js";

/**
 * Prueba contra el proyecto de Supabase de PRUEBAS (nunca producción).
 * Se ejecuta solo con PRUEBAS_SUPABASE=1 y las variables SUPABASE_* del proyecto de pruebas.
 * Ver README, sección "Pruebas contra Supabase".
 */
describe.skipIf(process.env.PRUEBAS_SUPABASE !== "1")("salud contra Supabase real", () => {
  let entorno: Entorno;
  let app: Express;

  beforeAll(() => {
    entorno = cargarEntorno(process.env);
    app = crearApp(entorno, { publico: crearClienteAnon(entorno) });
  });

  it("GET /salud reporta base ok con las migraciones aplicadas", async () => {
    const r = await request(app).get("/api/v1/salud");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ estado: "ok", base: "ok" });
  });

  it("la respuesta no contiene ninguna llave del proyecto", async () => {
    const r = await request(app).get("/api/v1/salud");
    const texto = JSON.stringify(r.body);
    for (const valor of [entorno.SUPABASE_ANON_KEY, entorno.SUPABASE_SERVICE_ROLE_KEY, entorno.SUPABASE_JWT_SECRET]) {
      expect(texto).not.toContain(valor);
    }
  });

  it("el backend puede leer perfiles con la llave de servicio (permisos de la migración 006)", async () => {
    await expect(crearLectorPerfiles(crearClienteServicio(entorno)).obtener(randomUUID())).resolves.toBeNull();
  });

  it("GET /puntos, /puntos/cercanos y /puntos/:id responden con datos publicados (migración 007)", async () => {
    const lista = await request(app).get("/api/v1/puntos?limite=5");
    expect(lista.status).toBe(200);
    expect(lista.body).toMatchObject({ paginacion: { pagina: 1, limite: 5 } });
    const cuerpo = lista.body as { datos: { id: string }[] };
    expect(cuerpo.datos.length).toBeGreaterThan(0);

    const cercanos = await request(app).get("/api/v1/puntos/cercanos?lat=20.6597&lng=-103.3496&radio=50000");
    expect(cercanos.status).toBe(200);

    const detalle = await request(app).get(`/api/v1/puntos/${cuerpo.datos[0]?.id ?? ""}`);
    expect(detalle.status).toBe(200);
    expect(JSON.stringify(detalle.body)).not.toMatch(/autor_id|aprobado_por/);
  });

  it("GET /acciones y /organizaciones responden sin datos internos", async () => {
    const acciones = await request(app).get("/api/v1/acciones");
    expect(acciones.status).toBe(200);
    const organizaciones = await request(app).get("/api/v1/organizaciones");
    expect(organizaciones.status).toBe(200);
    expect(JSON.stringify(organizaciones.body)).not.toMatch(/contacto/);
  });

  it("GET /sesion responde 401 sin token y con la llave anon usada como token", async () => {
    expect((await request(app).get("/api/v1/sesion")).status).toBe(401);
    const r = await request(app).get("/api/v1/sesion").set("Authorization", `Bearer ${entorno.SUPABASE_ANON_KEY}`);
    expect(r.status).toBe(401);
  });
});

/**
 * Inicio de sesión real (confirma D-16). Requiere un usuario de prueba creado en
 * Authentication → Users, y sus datos en PRUEBAS_SUPABASE_EMAIL y PRUEBAS_SUPABASE_CLAVE.
 */
const conUsuario = process.env.PRUEBAS_SUPABASE === "1" && !!process.env.PRUEBAS_SUPABASE_EMAIL && !!process.env.PRUEBAS_SUPABASE_CLAVE;
describe.skipIf(!conUsuario)("sesión real contra Supabase", () => {
  it("un usuario que inicia sesión obtiene 200 en /sesion con su rol de perfiles", async () => {
    const entorno = cargarEntorno(process.env);
    const app = crearApp(entorno, { publico: crearClienteAnon(entorno) });
    const { data, error } = await crearClienteAnon(entorno).auth.signInWithPassword({
      email: process.env.PRUEBAS_SUPABASE_EMAIL ?? "",
      password: process.env.PRUEBAS_SUPABASE_CLAVE ?? "",
    });
    expect(error).toBeNull();
    const token = data.session?.access_token ?? "";
    const r = await request(app).get("/api/v1/sesion").set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: data.user?.id, rol: "ciudadano" });
  });
});
