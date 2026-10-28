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

  it("las funciones de aportes y moderación existen y exigen sesión (migración 008)", async () => {
    // Sin usuario, crear_aporte se niega con 42501. Si la migración faltara, el error sería otro.
    const servicio = crearClienteServicio(entorno);
    const r = await servicio.rpc("crear_aporte", { tipo: "otro", descripcion: "prueba sin sesion", lat: 0, lng: 0 });
    expect(r.error?.code).toBe("42501");
    // Un visitante no tiene permiso de ejecutar la cola de moderación.
    const anon = await crearClienteAnon(entorno).rpc("cola_aportes", {});
    expect(anon.error).not.toBeNull();
    expect((await request(app).post("/api/v1/aportes").send({})).status).toBe(401);
    expect((await request(app).get("/api/v1/admin/aportes")).status).toBe(401);
  });

  it("el bucket de evidencias existe, es privado y solo acepta JPEG de hasta 2 MB (migración 009)", async () => {
    const servicio = crearClienteServicio(entorno);
    const { data, error } = await servicio.storage.getBucket("evidencias");
    expect(error).toBeNull();
    expect(data).toMatchObject({ public: false, file_size_limit: 2097152, allowed_mime_types: ["image/jpeg"] });
    // La función existe y exige sesión.
    const r = await servicio.rpc("adjuntar_evidencia", { aporte_id: "00000000-0000-0000-0000-000000000000", ruta: "x" });
    expect(r.error?.code).toBe("42501");
  });

  it("un visitante no puede subir ni listar fotos de evidencia", async () => {
    const ruta = `prueba-anon/${String(Date.now())}.jpg`;
    const bucketAnon = crearClienteAnon(entorno).storage.from("evidencias");
    const subida = await bucketAnon.upload(ruta, Buffer.from([0xff, 0xd8, 0xff]), { contentType: "image/jpeg" });
    if (!subida.error) await crearClienteServicio(entorno).storage.from("evidencias").remove([ruta]); // no dejar basura
    expect(subida.error).not.toBeNull();
    const lista = await bucketAnon.list();
    expect(lista.data ?? []).toHaveLength(0);
    expect((await request(app).post("/api/v1/aportes/00000000-0000-0000-0000-000000000000/evidencia")).status).toBe(401);
  });

  it("las funciones de administración existen y exigen un administrador (migración 010)", async () => {
    const servicio = crearClienteServicio(entorno);
    for (const [nombre, parametros] of [
      ["listar_usuarios", {}],
      ["listar_auditoria", {}],
      ["cambiar_rol", { usuario_id: "00000000-0000-0000-0000-000000000000", rol: "editor" }],
      ["crear_accion", { tipo: "firma", nombre: "prueba" }],
    ] as const) {
      const r = await servicio.rpc(nombre, parametros);
      expect(r.error?.code, nombre).toBe("42501");
    }
    // Un visitante no puede ejecutarlas.
    expect((await crearClienteAnon(entorno).rpc("listar_usuarios", {})).error).not.toBeNull();
    for (const ruta of ["/api/v1/admin/usuarios", "/api/v1/admin/auditoria"]) {
      expect((await request(app).get(ruta)).status).toBe(401);
    }
  });

  it("la purga de conversaciones del agente existe y solo la ejecuta el backend (migración 011)", async () => {
    const r = await crearClienteServicio(entorno).rpc("purgar_conversaciones_agente");
    expect(r.error).toBeNull();
    expect(typeof r.data).toBe("number");
    expect((await crearClienteAnon(entorno).rpc("purgar_conversaciones_agente")).error).not.toBeNull();
    expect((await request(app).get("/api/v1/salud/ia")).status).toBe(401);
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
