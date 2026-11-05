import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BaseDePruebas, crearBaseDePruebas } from "../ayudas/base-de-pruebas.js";

type Json = Record<string, unknown>;

/** Vector unitario de 768 dimensiones con un 1 en la posición i (cosenos fáciles de prever). */
const eje = (i: number, dims = 768) => Array.from({ length: dims }, (_, j) => (j === i ? 1 : 0));
const vectorTexto = (v: number[]) => `[${v.join(",")}]`;
const fragmento = (texto: string, i: number) => ({ texto, embedding: eje(i) });

/** Funciones de la migración 013 (base de conocimiento) con la sesión de cada rol. */
describe.skipIf(!process.env.TEST_DATABASE_URL)("base de conocimiento en la base (migración 013)", () => {
  let base: BaseDePruebas | undefined;
  let c: pg.Client | undefined;
  const cliente = (): pg.Client => {
    if (!c) throw new Error("Sin conexión de pruebas");
    return c;
  };
  const u = { ciudadana: randomUUID(), moderador: randomUUID(), editora: randomUUID(), admin: randomUUID() };

  async function como<T = Json>(uid: string | null, expresion: string, valores: unknown[] = []): Promise<T> {
    await cliente().query("begin");
    try {
      if (uid) await cliente().query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
      await cliente().query(`set local role ${uid ? "authenticated" : "anon"}`);
      const { rows } = await cliente().query(`select ${expresion} as r`, valores);
      await cliente().query("commit");
      const fila = rows[0] as { r: T } | undefined;
      if (!fila) throw new Error("Sin resultado");
      return fila.r;
    } catch (error) {
      await cliente().query("rollback");
      throw error;
    }
  }
  const guardar = (uid: string | null, titulo: string, fragmentos: unknown, extra = "null, null") =>
    como(uid, `guardar_documento_conocimiento($1, 'PROFEPA', $2::jsonb, 'gemini-embedding-001', ${extra})`, [titulo, JSON.stringify(fragmentos)]);
  const buscar = (uid: string | null, v: number[], cantidad = 4) => como<Json[]>(uid, `buscar_conocimiento_publico($1::vector, ${String(cantidad)})`, [vectorTexto(v)]);

  beforeAll(async () => {
    base = await crearBaseDePruebas();
    c = new pg.Client({ connectionString: base.url });
    await cliente().connect();
    for (const [nombre, id] of Object.entries(u)) {
      await cliente().query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, `${nombre}@prueba.local`, { nombre }]);
    }
    await cliente().query("update perfiles set rol = 'moderador' where id = $1", [u.moderador]);
    await cliente().query("update perfiles set rol = 'editor' where id = $1", [u.editora]);
    await cliente().query("update perfiles set rol = 'administrador' where id = $1", [u.admin]);
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await base?.limpiar();
  });

  it("la editora guarda un documento con sus fragmentos en orden y queda auditado", async () => {
    const d = await guardar(u.editora, "  Cómo denunciar ante PROFEPA ", [fragmento("Primero, documenta.", 0), fragmento("Después, presenta la denuncia.", 1)],
      "'https://www.gob.mx/profepa', '2025-03-01'");
    expect(d).toMatchObject({
      titulo: "Cómo denunciar ante PROFEPA", fuente: "PROFEPA", enlace: "https://www.gob.mx/profepa", fecha_fuente: "2025-03-01",
      activo: true, fragmentos: 2, modelo: "gemini-embedding-001",
    });
    const { rows } = await cliente().query<{ posicion: number; texto: string; dims: number; creado_por: string }>(
      "select f.posicion, f.texto, vector_dims(f.embedding) as dims, d.creado_por from fragmentos f join documentos_conocimiento d on d.id = f.documento_id where d.id = $1 order by f.posicion",
      [d.id],
    );
    expect(rows).toEqual([
      { posicion: 0, texto: "Primero, documenta.", dims: 768, creado_por: u.editora },
      { posicion: 1, texto: "Después, presenta la denuncia.", dims: 768, creado_por: u.editora },
    ]);
    const aud = await cliente().query<{ accion: string; usuario_id: string; detalle: Json }>("select accion, usuario_id, detalle from auditoria where registro_id = $1", [d.id]);
    expect(aud.rows).toEqual([{ accion: "documento_creado", usuario_id: u.editora, detalle: { titulo: "Cómo denunciar ante PROFEPA", fuente: "PROFEPA" } }]);
  });

  it("ciudadana, moderador y anónimo no pueden cargar ni listar documentos", async () => {
    for (const uid of [u.ciudadana, u.moderador]) {
      await expect(guardar(uid, "Documento", [fragmento("x", 0)])).rejects.toMatchObject({ code: "42501" });
      await expect(como(uid, "listar_documentos_conocimiento()")).rejects.toMatchObject({ code: "42501" });
    }
    await expect(guardar(null, "Documento", [fragmento("x", 0)])).rejects.toMatchObject({ code: "42501" });
    await expect(como(null, "listar_documentos_conocimiento()")).rejects.toMatchObject({ code: "42501" });
    // Directo en la tabla de fragmentos: sin políticas, nadie fuera del backend.
    await expect(como(u.editora, "(select count(*) from fragmentos)")).rejects.toMatchObject({ code: "42501" });
  });

  it.each([
    ["sin fragmentos", "Documento", []],
    ["un embedding de otra dimensión", "Documento", [{ texto: "x", embedding: eje(0, 3072) }]],
    ["un fragmento vacío", "Documento", [{ texto: "  ", embedding: eje(0) }]],
    ["un fragmento sin embedding", "Documento", [{ texto: "x" }]],
    ["un título corto", "x", [fragmento("x", 0)]],
  ])("rechaza %s sin guardar nada", async (_caso, titulo, fragmentos) => {
    const antes = await cliente().query<{ n: string }>("select count(*) as n from documentos_conocimiento");
    await expect(guardar(u.admin, titulo, fragmentos)).rejects.toMatchObject({ code: "22023" });
    const despues = await cliente().query<{ n: string }>("select count(*) as n from documentos_conocimiento");
    expect(despues.rows[0]?.n).toBe(antes.rows[0]?.n);
  });

  it("rechaza un enlace que no es https, también directo en la tabla", async () => {
    await expect(guardar(u.admin, "Documento", [fragmento("x", 0)], "'http://ejemplo.org', null")).rejects.toMatchObject({ code: "22023" });
    await expect(cliente().query("insert into documentos_conocimiento (titulo, fuente, enlace) values ('t', 'f', 'javascript:alert(1)')"))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("el anónimo busca solo en documentos activos, ordenado por parecido, sin ver quién los cargó", async () => {
    const a = await guardar(u.admin, "Separación de residuos", [fragmento("Orgánicos aparte.", 10), fragmento("Reciclables limpios.", 11)]);
    await guardar(u.admin, "Quemas agrícolas", [fragmento("No quemes rastrojo.", 20)]);
    const consulta = eje(10).map((x, i) => (i === 11 ? 0.5 : x));
    const r = await buscar(null, consulta, 2);
    expect(r.map((x) => x.texto)).toEqual(["Orgánicos aparte.", "Reciclables limpios."]);
    expect(r[0]).toMatchObject({ titulo: "Separación de residuos", fuente: "PROFEPA", enlace: null, fecha_fuente: null });
    expect(Object.keys(r[0] ?? {}).sort()).toEqual(["distancia", "enlace", "fecha_fuente", "fuente", "texto", "titulo"]);
    expect(Number(r[0]?.distancia)).toBeLessThan(Number(r[1]?.distancia));

    const inactivo = await como(u.editora, "cambiar_estado_documento($1, false)", [a.id]);
    expect(inactivo).toMatchObject({ activo: false, fragmentos: 2 });
    expect((await buscar(null, consulta, 8)).map((x) => x.titulo)).not.toContain("Separación de residuos");
    const aud = await cliente().query<{ accion: string; detalle: Json }>("select accion, detalle from auditoria where registro_id = $1 order by creado_en", [a.id]);
    expect(aud.rows.at(-1)).toEqual({ accion: "documento_actualizado", detalle: { columnas: ["activo"] } });
    await como(u.editora, "cambiar_estado_documento($1, true)", [a.id]);
    expect((await buscar(null, consulta, 1))[0]?.titulo).toBe("Separación de residuos");
  });

  it("la búsqueda valida la dimensión y la cantidad", async () => {
    await expect(como(null, "buscar_conocimiento_publico('[1,0,0]'::vector, 4)")).rejects.toMatchObject({ code: "22023" });
    await expect(buscar(null, eje(0), 9)).rejects.toMatchObject({ code: "22023" });
    await expect(buscar(null, eje(0), 0)).rejects.toMatchObject({ code: "22023" });
  });

  it("cambiar el estado: 404 si no existe y 403 para ciudadanos", async () => {
    await expect(como(u.admin, "cambiar_estado_documento($1, false)", [randomUUID()])).rejects.toMatchObject({ code: "P0002" });
    await expect(como(u.ciudadana, "cambiar_estado_documento($1, false)", [randomUUID()])).rejects.toMatchObject({ code: "42501" });
  });

  it("el listado pagina, cuenta fragmentos y muestra los inactivos", async () => {
    const r = await como<{ total: number; datos: Json[] }>(u.editora, "listar_documentos_conocimiento(2, 0)");
    expect(r.total).toBe(3);
    expect(r.datos).toHaveLength(2);
    expect(r.datos[0]).toMatchObject({ titulo: "Quemas agrícolas", fragmentos: 1 });
    const todos = await como<{ datos: Json[] }>(u.admin, "listar_documentos_conocimiento(100, 0)");
    expect(todos.datos.map((d) => d.titulo)).toEqual(["Quemas agrícolas", "Separación de residuos", "Cómo denunciar ante PROFEPA"]);
    await expect(como(u.admin, "listar_documentos_conocimiento(0, 0)")).rejects.toMatchObject({ code: "22023" });
  });

  it("permisos de ejecución: el anónimo solo puede buscar", async () => {
    const puede = async (rol: string, firma: string) =>
      (await cliente().query<{ p: boolean }>("select has_function_privilege($1, $2, 'execute') as p", [rol, firma])).rows[0]?.p;
    expect(await puede("anon", "buscar_conocimiento_publico(vector, integer)")).toBe(true);
    for (const firma of [
      "documento_json(documentos_conocimiento)",
      "guardar_documento_conocimiento(text, text, jsonb, text, text, date)",
      "listar_documentos_conocimiento(integer, integer)",
      "cambiar_estado_documento(uuid, boolean)",
      "auditar_documentos()",
    ]) expect(await puede("anon", firma), firma).toBe(false);
    expect(await puede("authenticated", "documento_json(documentos_conocimiento)")).toBe(false);
    expect(await puede("authenticated", "guardar_documento_conocimiento(text, text, jsonb, text, text, date)")).toBe(true);
  });
});

/** Actualizar una base que ya tenía fragmentos (antes de la 013 no había posición). */
describe.skipIf(!process.env.TEST_DATABASE_URL)("migración 013 sobre fragmentos existentes", () => {
  let base: BaseDePruebas;
  let carpeta: string;

  beforeAll(async () => {
    const { mkdtemp, readdir, copyFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const migraciones = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");
    carpeta = await mkdtemp(path.join(tmpdir(), "migraciones-012-"));
    for (const archivo of await readdir(migraciones)) {
      if (archivo < "013") await copyFile(path.join(migraciones, archivo), path.join(carpeta, archivo));
    }
    base = await crearBaseDePruebas({ migrar: false });
    const { aplicarMigraciones } = await import("../../src/config/migraciones.js");
    await aplicarMigraciones(base.url, carpeta);
    const cliente = new pg.Client({ connectionString: base.url });
    await cliente.connect();
    try {
      const { rows } = await cliente.query<{ id: string }>(
        "insert into documentos_conocimiento (titulo, fuente) values ('Ley previa', 'Prueba') returning id",
      );
      const id = rows[0]?.id;
      for (const [texto, minutos] of [["primero", 3], ["segundo", 2], ["tercero", 1]] as const) {
        await cliente.query(
          "insert into fragmentos (documento_id, texto, creado_en) values ($1, $2, now() - make_interval(mins => $3))",
          [id, texto, minutos],
        );
      }
    } finally {
      await cliente.end();
    }
    await aplicarMigraciones(base.url, migraciones);
  }, 60_000);

  afterAll(async () => {
    await base.limpiar();
    const { rm } = await import("node:fs/promises");
    await rm(carpeta, { recursive: true, force: true });
  });

  it("numera los fragmentos que ya existían por orden de creación y crea el índice único", async () => {
    const cliente = new pg.Client({ connectionString: base.url });
    await cliente.connect();
    try {
      const { rows } = await cliente.query<{ texto: string; posicion: number }>(
        "select texto, posicion from fragmentos order by posicion",
      );
      expect(rows).toEqual([
        { texto: "primero", posicion: 0 },
        { texto: "segundo", posicion: 1 },
        { texto: "tercero", posicion: 2 },
      ]);
      const indice = await cliente.query("select 1 from pg_indexes where indexname = 'fragmentos_documento_posicion_idx'");
      expect(indice.rowCount).toBe(1);
    } finally {
      await cliente.end();
    }
  });
});
