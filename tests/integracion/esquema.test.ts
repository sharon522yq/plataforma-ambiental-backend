import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aplicarMigraciones } from "../../src/config/migraciones.js";
import { type BaseDePruebas, crearBaseDePruebas } from "../ayudas/base-de-pruebas.js";

const TABLAS_ESPERADAS = [
  "acciones",
  "aportes",
  "auditoria",
  "conversaciones_agente",
  "documentos_conocimiento",
  "fragmentos",
  "organizaciones",
  "perfiles",
  "puntos",
];

describe.skipIf(!process.env.TEST_DATABASE_URL)("esquema de base de datos", () => {
  let base: BaseDePruebas | undefined;
  let c: pg.Client | undefined;
  const baseDePruebas = (): BaseDePruebas => {
    if (!base) throw new Error("Sin base de pruebas");
    return base;
  };
  const cliente = (): pg.Client => {
    if (!c) throw new Error("Sin conexión de pruebas");
    return c;
  };

  beforeAll(async () => {
    base = await crearBaseDePruebas();
    c = new pg.Client({ connectionString: baseDePruebas().url });
    await cliente().connect();
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await base?.limpiar();
  });

  it("crea exactamente las tablas del modelo", async () => {
    const { rows } = await cliente().query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> 'spatial_ref_sys'
       order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(TABLAS_ESPERADAS);
  });

  it("activa RLS en todas las tablas del modelo", async () => {
    const { rows } = await cliente().query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = any($1)`,
      [TABLAS_ESPERADAS],
    );
    expect(rows).toHaveLength(TABLAS_ESPERADAS.length);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
  });

  it("instala las extensiones postgis, vector y pgcrypto", async () => {
    const { rows } = await cliente().query<{ extname: string }>(
      "select extname from pg_extension where extname in ('postgis', 'vector', 'pgcrypto') order by extname",
    );
    expect(rows.map((r) => r.extname)).toEqual(["pgcrypto", "postgis", "vector"]);
  });

  it("crea los índices espacial, de estado y vectorial", async () => {
    const { rows } = await cliente().query<{ indexname: string }>(
      "select indexname from pg_indexes where schemaname = 'public'",
    );
    const nombres = rows.map((r) => r.indexname);
    expect(nombres).toEqual(
      expect.arrayContaining(["puntos_ubicacion_idx", "aportes_ubicacion_idx", "fragmentos_embedding_hnsw_idx"]),
    );
  });

  it("registra las políticas con nombres descriptivos", async () => {
    const { rows } = await cliente().query<{ policyname: string }>(
      "select policyname from pg_policies where schemaname = 'public'",
    );
    expect(rows.map((r) => r.policyname)).toEqual(
      expect.arrayContaining(["puntos_publico_lectura_publicados", "auditoria_administrador_lectura"]),
    );
  });

  it("carga 3 puntos, 2 organizaciones y 3 acciones de prueba", async () => {
    const conteo = async (sql: string) => Number((await cliente().query<{ n: string }>(sql)).rows[0]?.n);
    expect(await conteo("select count(*) n from puntos where titulo like '[PRUEBA]%' and estado = 'publicado'")).toBe(3);
    expect(await conteo("select count(*) n from organizaciones where nombre like '[PRUEBA]%'")).toBe(2);
    expect(await conteo("select count(*) n from acciones where nombre like '[PRUEBA]%'")).toBe(3);
  });

  it("no vuelve a aplicar migraciones ya registradas", async () => {
    const r = await aplicarMigraciones(baseDePruebas().url, path.resolve("migrations"));
    expect(r.aplicadas).toEqual([]);
    expect(r.omitidas).toHaveLength(6);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("aplicación atómica de migraciones", () => {
  let carpeta: string;
  let base: BaseDePruebas | undefined;
  const baseDePruebas = (): BaseDePruebas => {
    if (!base) throw new Error("Sin base de pruebas");
    return base;
  };

  beforeAll(async () => {
    carpeta = await mkdtemp(path.join(os.tmpdir(), "migraciones-prueba-"));
    base = await crearBaseDePruebas({ migrar: false });
  }, 120_000);

  afterAll(async () => {
    await base?.limpiar();
    await rm(carpeta, { recursive: true, force: true });
  });

  it("revierte la migración que falla y no la registra", async () => {
    await writeFile(path.join(carpeta, "001_correcta.sql"), "create table t_correcta (id int);");
    await writeFile(path.join(carpeta, "002_con_error.sql"), "create table t_rota (id int); esto no es sql;");

    await expect(aplicarMigraciones(baseDePruebas().url, carpeta)).rejects.toThrow(/002_con_error\.sql/);

    const local = new pg.Client({ connectionString: baseDePruebas().url });
    await local.connect();
    try {
      const tablas = await local.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public' and table_name in ('t_correcta','t_rota') order by 1",
      );
      expect(tablas.rows.map((r) => r.table_name)).toEqual(["t_correcta"]);

      const registro = await local.query<{ nombre: string }>("select nombre from esquema_migraciones.aplicadas order by nombre");
      expect(registro.rows.map((r) => r.nombre)).toEqual(["001_correcta.sql"]);
    } finally {
      await local.end();
    }
  });
});
