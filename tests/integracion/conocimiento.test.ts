import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { crearApp } from "../../src/app.js";
import { ErrorAplicacion } from "../../src/compartido/errores.js";
import type { Perfil } from "../../src/compartido/perfiles.js";
import { crearVerificadorJwt } from "../../src/config/jwt.js";
import type { ModeloEmbeddings } from "../../src/modulos/agente/embeddings.js";
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
const tabla: Record<string, Perfil> = {
  [CIUDADANO]: { rol: "ciudadano", activo: true },
  [MODERADOR]: { rol: "moderador", activo: true },
  [EDITOR]: { rol: "editor", activo: true },
  [ADMIN]: { rol: "administrador", activo: true },
};
const FECHA = "2026-11-05T18:00:00+00:00";
const DOC = randomUUID();
const documento = {
  id: DOC, titulo: "Cómo denunciar ante PROFEPA", fuente: "PROFEPA", enlace: "https://www.gob.mx/profepa", fecha_fuente: "2025-03-01",
  activo: true, fragmentos: 2, modelo: "emb-prueba", creado_en: FECHA, actualizado_en: FECHA,
};
const TEXTO = "Para denunciar una descarga, documenta el lugar con fotos y la hora. ".repeat(3);

function app(respuestas: Parameters<typeof rpcFalso>[0], falla?: Error) {
  const falso = rpcFalso(respuestas);
  const pedidos: { textos: string[]; tarea: string }[] = [];
  const embeddings: ModeloEmbeddings = {
    modelo: "emb-prueba",
    embeber(textos, tarea) {
      pedidos.push({ textos, tarea });
      return falla ? Promise.reject(falla) : Promise.resolve(textos.map((_, i) => [i, 1]));
    },
  };
  const a = crearApp(entornoDePrueba(), {
    publico: clienteFalso({ error: null }),
    verificador: crearVerificadorJwt({ secreto: SECRETO_PRUEBA, emisor: EMISOR_PRUEBA }),
    perfiles: perfilesFalsos(tabla),
    clienteUsuario: () => falso.cliente,
    almacen: almacenFalso().almacen,
    embeddings,
  });
  return { app: a, llamadas: falso.llamadas, pedidos };
}
const bearer = async (sub: string) => `Bearer ${await tokenDePrueba({ sub })}`;
const RUTA = "/api/v1/admin/conocimiento";

describe("permisos de la base de conocimiento", () => {
  const rutas: [string, string][] = [["get", RUTA], ["post", RUTA], ["patch", `${RUTA}/${DOC}`]];

  it.each(rutas)("%s %s: 401 sin sesión y 403 para ciudadano y moderador", async (metodo, ruta) => {
    const { app: a, llamadas, pedidos } = app({});
    const pedir = (m: string) => (request(a) as unknown as Record<string, (r: string) => request.Test>)[m]?.(ruta) ?? request(a).get(ruta);
    expect((await pedir(metodo)).status).toBe(401);
    for (const id of [CIUDADANO, MODERADOR]) expect((await pedir(metodo).set("Authorization", await bearer(id))).status).toBe(403);
    expect(llamadas).toHaveLength(0);
    expect(pedidos).toHaveLength(0);
  });
});

describe("POST /api/v1/admin/conocimiento", () => {
  it("parte el texto, embebe cada fragmento con el título y guarda con la sesión del editor", async () => {
    const { app: a, llamadas, pedidos } = app({ guardar_documento_conocimiento: ok(documento) });
    const parrafo = "Párrafo largo sobre cómo presentar una denuncia ante la autoridad ambiental. ".repeat(10);
    const r = await request(a).post(RUTA).set("Authorization", await bearer(EDITOR))
      .send({ titulo: " Cómo denunciar ante PROFEPA ", fuente: "PROFEPA", enlace: "https://www.gob.mx/profepa", fecha_fuente: "2025-03-01", texto: `${parrafo}\n\n${parrafo}` });
    expect(r.status).toBe(201);
    expect(r.body).toEqual(documento);
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]?.tarea).toBe("documento");
    expect(pedidos[0]?.textos).toHaveLength(2);
    for (const t of pedidos[0]?.textos ?? []) expect(t.startsWith("Cómo denunciar ante PROFEPA\n\nPárrafo largo")).toBe(true);
    expect(llamadas).toEqual([{
      nombre: "guardar_documento_conocimiento",
      parametros: {
        titulo: "Cómo denunciar ante PROFEPA", fuente: "PROFEPA", enlace: "https://www.gob.mx/profepa", fecha_fuente: "2025-03-01", modelo: "emb-prueba",
        fragmentos: [{ texto: parrafo.trim(), embedding: [0, 1] }, { texto: parrafo.trim(), embedding: [1, 1] }],
      },
    }]);
  });

  it("enlace y fecha son opcionales", async () => {
    const { app: a, llamadas } = app({ guardar_documento_conocimiento: ok({ ...documento, enlace: null, fecha_fuente: null }) });
    const r = await request(a).post(RUTA).set("Authorization", await bearer(ADMIN)).send({ titulo: "Separar residuos", fuente: "SEMARNAT", texto: TEXTO });
    expect(r.status).toBe(201);
    expect(llamadas[0]?.parametros).toMatchObject({ enlace: null, fecha_fuente: null });
  });

  it.each([
    ["texto muy corto", { titulo: "Título", fuente: "PROFEPA", texto: "corto" }],
    ["enlace http", { titulo: "Título", fuente: "PROFEPA", texto: TEXTO, enlace: "http://ejemplo.org" }],
    ["fecha inválida", { titulo: "Título", fuente: "PROFEPA", texto: TEXTO, fecha_fuente: "05/11/2026" }],
    ["campos de más", { titulo: "Título", fuente: "PROFEPA", texto: TEXTO, activo: false }],
    ["sin fuente", { titulo: "Título", texto: TEXTO }],
  ])("400 con %s, sin gastar embeddings", async (_caso, cuerpo) => {
    const { app: a, llamadas, pedidos } = app({});
    const r = await request(a).post(RUTA).set("Authorization", await bearer(EDITOR)).send(cuerpo);
    expect(r.status).toBe(400);
    expect(pedidos).toHaveLength(0);
    expect(llamadas).toHaveLength(0);
  });

  it("400 si el texto pasa de 40 000 caracteres, sin gastar embeddings", async () => {
    const { app: a, pedidos } = app({});
    const r = await request(a).post(RUTA).set("Authorization", await bearer(EDITOR)).send({ titulo: "Muy largo", fuente: "X", texto: "a ".repeat(20_001) });
    expect(r.status).toBe(400);
    expect(pedidos).toHaveLength(0);
  });

  it("503 si Gemini no calcula los embeddings, sin guardar nada", async () => {
    const { app: a, llamadas } = app({}, new ErrorAplicacion(503, "IA_NO_DISPONIBLE", "El servicio de IA no está disponible, intenta más tarde"));
    const r = await request(a).post(RUTA).set("Authorization", await bearer(EDITOR)).send({ titulo: "Título", fuente: "PROFEPA", texto: TEXTO });
    expect(r.status).toBe(503);
    expect(llamadas).toHaveLength(0);
  });

  it("si la base rechaza el rol, responde 403", async () => {
    const { app: a } = app({ guardar_documento_conocimiento: { data: null, error: { code: "42501", message: "Solo un editor o administrador puede cargar documentos", hint: "publico" } } });
    const r = await request(a).post(RUTA).set("Authorization", await bearer(EDITOR)).send({ titulo: "Título", fuente: "PROFEPA", texto: TEXTO });
    expect(r.status).toBe(403);
  });
});

describe("GET y PATCH /api/v1/admin/conocimiento", () => {
  it("lista con paginación", async () => {
    const { app: a, llamadas } = app({ listar_documentos_conocimiento: ok({ total: 21, datos: [documento] }) });
    const r = await request(a).get(`${RUTA}?pagina=2&limite=10`).set("Authorization", await bearer(EDITOR));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ datos: [documento], paginacion: { pagina: 2, limite: 10, total: 21, paginas: 3 } });
    expect(llamadas[0]?.parametros).toEqual({ limite: 10, desplazamiento: 10 });
    expect(r.headers["cache-control"]).toBe("no-store");
  });

  it("desactiva un documento", async () => {
    const { app: a, llamadas } = app({ cambiar_estado_documento: ok({ ...documento, activo: false }) });
    const r = await request(a).patch(`${RUTA}/${DOC}`).set("Authorization", await bearer(ADMIN)).send({ activo: false });
    expect(r.status).toBe(200);
    expect((r.body as { activo: boolean }).activo).toBe(false);
    expect(llamadas[0]).toEqual({ nombre: "cambiar_estado_documento", parametros: { documento_id: DOC, activo: false } });
  });

  it("400 con id inválido o cuerpo inválido, 404 si no existe", async () => {
    const { app: a } = app({ cambiar_estado_documento: { data: null, error: { code: "P0002", message: "El documento no existe", hint: "publico" } } });
    const t = await bearer(EDITOR);
    expect((await request(a).patch(`${RUTA}/abc`).set("Authorization", t).send({ activo: false })).status).toBe(400);
    expect((await request(a).patch(`${RUTA}/${DOC}`).set("Authorization", t).send({ activo: "no" })).status).toBe(400);
    const r = await request(a).patch(`${RUTA}/${DOC}`).set("Authorization", t).send({ activo: true });
    expect(r.status).toBe(404);
    expect((r.body as { error: { mensaje: string } }).error.mensaje).toBe("El documento no existe");
  });
});
