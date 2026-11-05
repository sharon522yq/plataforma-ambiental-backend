import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { crearApp } from "../../src/app.js";
import type { Perfil } from "../../src/compartido/perfiles.js";
import { crearVerificadorJwt } from "../../src/config/jwt.js";
import { almacenFalso } from "../ayudas/almacen-falso.js";
import { clienteFalso } from "../ayudas/cliente-falso.js";
import { entornoDePrueba } from "../ayudas/entorno.js";
import { perfilesFalsos } from "../ayudas/perfiles-falsos.js";
import { ok, rpcFalso } from "../ayudas/rpc-falso.js";
import { EMISOR_PRUEBA, SECRETO_PRUEBA, tokenDePrueba } from "../ayudas/tokens.js";

const CIUDADANO = randomUUID();
const MODERADOR = randomUUID();
const EDITOR = randomUUID();
const ADMIN = randomUUID();
const OTRO = randomUUID();
const tabla: Record<string, Perfil> = {
  [CIUDADANO]: { rol: "ciudadano", activo: true },
  [MODERADOR]: { rol: "moderador", activo: true },
  [EDITOR]: { rol: "editor", activo: true },
  [ADMIN]: { rol: "administrador", activo: true },
};
const FECHA = "2026-10-22T18:00:00+00:00";

function app(respuestas: Parameters<typeof rpcFalso>[0]) {
  const falso = rpcFalso(respuestas);
  const a = crearApp(entornoDePrueba(), {
    publico: clienteFalso({ error: null }),
    verificador: crearVerificadorJwt({ secreto: SECRETO_PRUEBA, emisor: EMISOR_PRUEBA }),
    perfiles: perfilesFalsos(tabla),
    clienteUsuario: () => falso.cliente,
    almacen: almacenFalso().almacen,
  });
  return { app: a, llamadas: falso.llamadas };
}
const bearer = async (sub: string) => `Bearer ${await tokenDePrueba({ sub })}`;

const accion = {
  id: randomUUID(), tipo: "firma", nombre: "Firma por el río", descripcion: null, enlace: "https://ejemplo.org/f",
  organizacion_id: null, punto_id: null, activa: true, creado_en: FECHA, actualizado_en: FECHA,
};
const organizacion = {
  id: randomUUID(), nombre: "Colectivo", contacto: "interno", zona: "Zapopan", activa: true,
  creado_por: EDITOR, creado_en: FECHA, actualizado_en: FECHA,
};
const usuario = { id: OTRO, nombre: "Ana", email: "ana@correo.mx", rol: "ciudadano", activo: true, creado_en: FECHA, telefono: "3312345678" };

describe("matriz de permisos de administración", () => {
  const rutas: [string, string, string[]][] = [
    ["post", "/api/v1/admin/acciones", ["editor", "administrador"]],
    ["post", "/api/v1/admin/organizaciones", ["editor", "administrador"]],
    ["get", "/api/v1/admin/usuarios", ["administrador"]],
    ["patch", `/api/v1/admin/usuarios/${OTRO}/rol`, ["administrador"]],
    ["get", "/api/v1/admin/auditoria", ["administrador"]],
    ["get", "/api/v1/admin/solicitudes-rol", ["administrador"]],
    ["patch", `/api/v1/admin/solicitudes-rol/${OTRO}`, ["administrador"]],
    ["get", "/api/v1/admin/metricas", ["administrador"]],
  ];
  const quienes: [string, string][] = [["ciudadano", CIUDADANO], ["moderador", MODERADOR], ["editor", EDITOR], ["administrador", ADMIN]];

  it.each(rutas)("%s %s responde 401 sin sesión", async (metodo, ruta) => {
    const { app: a, llamadas } = app({});
    expect((await request(a)[metodo as "get"](ruta)).status).toBe(401);
    expect(llamadas).toHaveLength(0);
  });

  for (const [metodo, ruta, permitidos] of rutas) {
    for (const [rol, id] of quienes.filter(([r]) => !permitidos.includes(r))) {
      it(`${rol} recibe 403 en ${metodo} ${ruta} sin llegar a la base`, async () => {
        const { app: a, llamadas } = app({});
        const r = await request(a)[metodo as "get"](ruta).set("Authorization", await bearer(id)).send({});
        expect(r.status).toBe(403);
        expect(llamadas).toHaveLength(0);
      });
    }
  }

  it("el editor llega a /admin/acciones aunque /admin también tenga rutas de moderación", async () => {
    const { app: a } = app({ crear_accion: ok(accion) });
    const r = await request(a).post("/api/v1/admin/acciones").set("Authorization", await bearer(EDITOR)).send({ tipo: "firma", nombre: "Firma por el río" });
    expect(r.status).toBe(201);
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("el editor sigue sin acceso a la moderación", async () => {
    const { app: a } = app({});
    expect((await request(a).get("/api/v1/admin/aportes").set("Authorization", await bearer(EDITOR))).status).toBe(403);
  });
});

describe("POST /api/v1/admin/acciones", () => {
  it("201 y envía los campos, con null en los opcionales", async () => {
    const { app: a, llamadas } = app({ crear_accion: ok(accion) });
    const r = await request(a)
      .post("/api/v1/admin/acciones")
      .set("Authorization", await bearer(EDITOR))
      .send({ tipo: "firma", nombre: "  Firma por el río ", enlace: "https://ejemplo.org/f" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: accion.id, enlace: "https://ejemplo.org/f" });
    expect(llamadas[0]).toEqual({
      nombre: "crear_accion",
      parametros: { tipo: "firma", nombre: "Firma por el río", descripcion: null, enlace: "https://ejemplo.org/f", organizacion_id: null, punto_id: null },
    });
  });

  it.each([
    ["enlace http", { enlace: "http://ejemplo.org" }],
    ["enlace javascript:", { enlace: "javascript:alert(1)" }],
    ["enlace que no es URL", { enlace: "https://" }],
    ["tipo inexistente", { tipo: "rifa" }],
    ["nombre muy corto", { nombre: "x" }],
    ["campo no permitido", { activa: false }],
    ["organización que no es uuid", { organizacion_id: "abc" }],
  ])("400 con %s", async (_caso, cambio) => {
    const { app: a, llamadas } = app({});
    const r = await request(a)
      .post("/api/v1/admin/acciones")
      .set("Authorization", await bearer(EDITOR))
      .send({ tipo: "firma", nombre: "Firma por el río", ...cambio });
    expect(r.status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });

  it("400 con el mensaje de la base si el punto no está publicado", async () => {
    const { app: a } = app({ crear_accion: { data: null, error: { code: "22023", message: "El punto indicado no existe o no está publicado", hint: "publico" } } });
    const r = await request(a)
      .post("/api/v1/admin/acciones")
      .set("Authorization", await bearer(ADMIN))
      .send({ tipo: "firma", nombre: "Firma por el río", punto_id: randomUUID() });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: { mensaje: "El punto indicado no existe o no está publicado" } });
  });
});

describe("POST /api/v1/admin/organizaciones", () => {
  it("201 y devuelve el contacto solo al personal", async () => {
    const { app: a, llamadas } = app({ crear_organizacion: ok(organizacion) });
    const r = await request(a).post("/api/v1/admin/organizaciones").set("Authorization", await bearer(EDITOR)).send({ nombre: "Colectivo", contacto: "interno", zona: "Zapopan" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ contacto: "interno", creado_por: EDITOR });
    expect(llamadas[0]?.parametros).toEqual({ nombre: "Colectivo", contacto: "interno", zona: "Zapopan" });
  });

  it("400 sin nombre o con campos de más", async () => {
    const { app: a } = app({});
    const t = await bearer(EDITOR);
    expect((await request(a).post("/api/v1/admin/organizaciones").set("Authorization", t).send({ zona: "x" })).status).toBe(400);
    expect((await request(a).post("/api/v1/admin/organizaciones").set("Authorization", t).send({ nombre: "Colectivo", creado_por: ADMIN })).status).toBe(400);
  });
});

describe("usuarios y roles", () => {
  it("GET /admin/usuarios filtra, pagina y nunca devuelve el teléfono", async () => {
    const { app: a, llamadas } = app({ listar_usuarios: ok({ total: 1, datos: [usuario] }) });
    const r = await request(a).get("/api/v1/admin/usuarios?rol=ciudadano&busqueda=ana&limite=10").set("Authorization", await bearer(ADMIN));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ datos: [{ id: OTRO, email: "ana@correo.mx" }], paginacion: { total: 1, limite: 10 } });
    expect(JSON.stringify(r.body)).not.toMatch(/telefono|3312345678/);
    expect(llamadas[0]?.parametros).toEqual({ rol_filtro: "ciudadano", busqueda: "ana", limite: 10, desplazamiento: 0 });
  });

  it("400 con un rol de filtro inexistente", async () => {
    const { app: a } = app({});
    expect((await request(a).get("/api/v1/admin/usuarios?rol=jefe").set("Authorization", await bearer(ADMIN))).status).toBe(400);
  });

  it("PATCH /admin/usuarios/:id/rol cambia el rol", async () => {
    const { app: a, llamadas } = app({ cambiar_rol: ok({ id: OTRO, nombre: "Ana", rol: "moderador", activo: true, actualizado_en: FECHA }) });
    const r = await request(a).patch(`/api/v1/admin/usuarios/${OTRO}/rol`).set("Authorization", await bearer(ADMIN)).send({ rol: "moderador" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: OTRO, rol: "moderador" });
    expect(llamadas[0]).toEqual({ nombre: "cambiar_rol", parametros: { usuario_id: OTRO, rol: "moderador" } });
  });

  it("403 si el administrador intenta cambiar su propio rol, sin llegar a la base", async () => {
    const { app: a, llamadas } = app({});
    const r = await request(a).patch(`/api/v1/admin/usuarios/${ADMIN}/rol`).set("Authorization", await bearer(ADMIN)).send({ rol: "ciudadano" });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: { mensaje: "No puedes cambiar tu propio rol" } });
    expect(llamadas).toHaveLength(0);
  });

  it.each([
    ["un rol inexistente", `/api/v1/admin/usuarios/${OTRO}/rol`, { rol: "jefe" }],
    ["un id que no es uuid", "/api/v1/admin/usuarios/abc/rol", { rol: "editor" }],
    ["campos de más", `/api/v1/admin/usuarios/${OTRO}/rol`, { rol: "editor", activo: false }],
  ])("400 con %s", async (_caso, ruta, cuerpo) => {
    const { app: a, llamadas } = app({});
    expect((await request(a).patch(ruta).set("Authorization", await bearer(ADMIN)).send(cuerpo)).status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });

  it("404 si el usuario no existe", async () => {
    const { app: a } = app({ cambiar_rol: { data: null, error: { code: "P0002", message: "El usuario no existe", hint: "publico" } } });
    const r = await request(a).patch(`/api/v1/admin/usuarios/${OTRO}/rol`).set("Authorization", await bearer(ADMIN)).send({ rol: "editor" });
    expect(r.status).toBe(404);
  });
});

describe("solicitudes de rol (dos administradores, migración 014)", () => {
  const SOLICITUD = randomUUID();
  const solicitud = {
    id: SOLICITUD, usuario: { id: OTRO, nombre: "Ana" }, rol_anterior: "ciudadano", rol_nuevo: "administrador",
    solicitado_por: { id: ADMIN, nombre: "Admin" }, estado: "pendiente", resuelto_por: null, creado_en: FECHA, resuelto_en: null,
  };

  it("PATCH /admin/usuarios/:id/rol responde 202 con la solicitud cuando falta otro administrador", async () => {
    const { app: a } = app({ cambiar_rol: ok({ id: OTRO, nombre: "Ana", rol: "ciudadano", activo: true, actualizado_en: FECHA, solicitud }) });
    const r = await request(a).patch(`/api/v1/admin/usuarios/${OTRO}/rol`).set("Authorization", await bearer(ADMIN)).send({ rol: "administrador" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ rol: "ciudadano", solicitud: { id: SOLICITUD, estado: "pendiente", rol_nuevo: "administrador" } });
  });

  it("PATCH /admin/usuarios/:id/rol responde 200 y solicitud null cuando el cambio es inmediato", async () => {
    const { app: a } = app({ cambiar_rol: ok({ id: OTRO, nombre: "Ana", rol: "editor", activo: true, actualizado_en: FECHA, solicitud: null }) });
    const r = await request(a).patch(`/api/v1/admin/usuarios/${OTRO}/rol`).set("Authorization", await bearer(ADMIN)).send({ rol: "editor" });
    expect(r.status).toBe(200);
    expect((r.body as { solicitud: unknown }).solicitud).toBeNull();
  });

  it("GET /admin/solicitudes-rol lista sin correos", async () => {
    const { app: a, llamadas } = app({ listar_solicitudes_rol: ok([{ ...solicitud, usuario: { ...solicitud.usuario, email: "ana@correo.mx" } }]) });
    const r = await request(a).get("/api/v1/admin/solicitudes-rol").set("Authorization", await bearer(ADMIN));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toEqual({ datos: [solicitud] });
    expect(llamadas[0]).toEqual({ nombre: "listar_solicitudes_rol", parametros: {} });
  });

  it("PATCH /admin/solicitudes-rol/:id envía la decisión", async () => {
    const aprobada = { ...solicitud, estado: "aprobada", resuelto_por: { id: OTRO, nombre: "Otra" }, resuelto_en: FECHA };
    const { app: a, llamadas } = app({ resolver_solicitud_rol: ok(aprobada) });
    const r = await request(a).patch(`/api/v1/admin/solicitudes-rol/${SOLICITUD}`).set("Authorization", await bearer(ADMIN)).send({ aprobar: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ estado: "aprobada" });
    expect(llamadas[0]).toEqual({ nombre: "resolver_solicitud_rol", parametros: { solicitud_id: SOLICITUD, aprobar: true } });
  });

  it.each([
    ["sin decisión", `/api/v1/admin/solicitudes-rol/${SOLICITUD}`, {}],
    ["decisión que no es booleana", `/api/v1/admin/solicitudes-rol/${SOLICITUD}`, { aprobar: "sí" }],
    ["campos de más", `/api/v1/admin/solicitudes-rol/${SOLICITUD}`, { aprobar: true, estado: "aprobada" }],
    ["id que no es uuid", "/api/v1/admin/solicitudes-rol/abc", { aprobar: true }],
  ])("400 con %s", async (_caso, ruta, cuerpo) => {
    const { app: a, llamadas } = app({});
    expect((await request(a).patch(ruta).set("Authorization", await bearer(ADMIN)).send(cuerpo)).status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });

  it.each([
    ["42501", 403, "Otro administrador debe confirmar el cambio"],
    ["55000", 409, "La solicitud ya fue resuelta"],
    ["P0002", 404, "La solicitud no existe"],
  ])("traduce el error %s de la base a %i con su mensaje", async (code, estado, message) => {
    const { app: a } = app({ resolver_solicitud_rol: { data: null, error: { code, message, hint: "publico" } } });
    const r = await request(a).patch(`/api/v1/admin/solicitudes-rol/${SOLICITUD}`).set("Authorization", await bearer(ADMIN)).send({ aprobar: true });
    expect(r.status).toBe(estado);
    expect(r.body).toMatchObject({ error: { mensaje: message } });
  });
});

describe("GET /api/v1/admin/metricas", () => {
  const datos = {
    generado_en: FECHA,
    puntos: { publicados: 3, en_revision: 1, archivados: 0, por_tipo: { residuos: 3 }, por_gravedad: { "4": 3 } },
    aportes: { pendientes: 1, aprobados: 2, rechazados: 0, duplicados: 0, ultimos_30_dias: 3, horas_revision_mediana: 4.5, por_semana: [{ semana: "2026-11-02", recibidos: 3 }] },
    usuarios: { total: 4, activos: 4, nuevos_30_dias: 1, por_rol: { administrador: 2, ciudadano: 2 } },
    catalogo: { acciones_activas: 5, organizaciones_activas: 2, documentos_activos: 1, fragmentos: 3 },
    asistente: { conversaciones_7_dias: 10, con_herramientas: 7, con_documentos: 2, sin_ia: 1 },
    pendientes_de_rol: 0,
  };

  it("200 con las métricas y sin caché", async () => {
    const { app: a, llamadas } = app({ metricas_plataforma: ok(datos) });
    const r = await request(a).get("/api/v1/admin/metricas").set("Authorization", await bearer(ADMIN));
    expect(r.status).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toEqual(datos);
    expect(llamadas[0]).toEqual({ nombre: "metricas_plataforma", parametros: {} });
  });

  it("500 sin detalles si la base responde algo inesperado", async () => {
    const { app: a } = app({ metricas_plataforma: ok({ puntos: "muchos" }) });
    const r = await request(a).get("/api/v1/admin/metricas").set("Authorization", await bearer(ADMIN));
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toMatch(/muchos/);
  });
});

describe("GET /api/v1/admin/auditoria", () => {
  const registro = { id: randomUUID(), usuario_id: ADMIN, accion: "rol_cambiado", tabla: "perfiles", registro_id: OTRO, detalle: { rol_anterior: "ciudadano", rol_nuevo: "editor" }, creado_en: FECHA };

  it("envía los filtros y pagina", async () => {
    const { app: a, llamadas } = app({ listar_auditoria: ok({ total: 1, datos: [registro] }) });
    const r = await request(a)
      .get(`/api/v1/admin/auditoria?tabla=perfiles&accion=rol_cambiado&usuario_id=${ADMIN}&desde=2026-10-01T00:00:00Z&hasta=2026-10-31T00:00:00Z`)
      .set("Authorization", await bearer(ADMIN));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ datos: [{ accion: "rol_cambiado" }], paginacion: { total: 1 } });
    expect(llamadas[0]?.parametros).toEqual({
      tabla_filtro: "perfiles", accion_filtro: "rol_cambiado", usuario_filtro: ADMIN, registro_filtro: null,
      desde: "2026-10-01T00:00:00Z", hasta: "2026-10-31T00:00:00Z", limite: 20, desplazamiento: 0,
    });
  });

  it.each([
    ["una tabla que no se audita", "tabla=fragmentos"],
    ["una acción con caracteres raros", "accion=rol;drop"],
    ["una fecha inválida", "desde=ayer"],
    ["desde posterior a hasta", "desde=2026-10-31T00:00:00Z&hasta=2026-10-01T00:00:00Z"],
  ])("400 con %s", async (_caso, consulta) => {
    const { app: a, llamadas } = app({});
    expect((await request(a).get(`/api/v1/admin/auditoria?${consulta}`).set("Authorization", await bearer(ADMIN))).status).toBe(400);
    expect(llamadas).toHaveLength(0);
  });
});
