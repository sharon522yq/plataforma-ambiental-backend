import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BaseDePruebas, crearBaseDePruebas } from "../ayudas/base-de-pruebas.js";

/** Migración 011: conversaciones del agente, solo para el backend, y su purga. */
describe.skipIf(!process.env.TEST_DATABASE_URL)("conversaciones del agente en la base (migración 011)", () => {
  let base: BaseDePruebas | undefined;
  let c: pg.Client | undefined;
  const cliente = (): pg.Client => {
    if (!c) throw new Error("Sin conexión de pruebas");
    return c;
  };
  async function como(rol: "anon" | "authenticated" | "service_role", sql: string) {
    await cliente().query("begin");
    try {
      await cliente().query(`set local role ${rol}`);
      return await cliente().query(sql);
    } finally {
      await cliente().query("rollback");
    }
  }

  beforeAll(async () => {
    base = await crearBaseDePruebas();
    c = new pg.Client({ connectionString: base.url });
    await cliente().connect();
  }, 120_000);
  afterAll(async () => {
    await c?.end();
    await base?.limpiar();
  });

  it("la purga borra solo las conversaciones vencidas", async () => {
    await cliente().query(`insert into conversaciones_agente (pregunta, respuesta, expira_en) values
      ('vieja', 'r', now() - interval '1 day'), ('nueva', 'r', default)`);
    await cliente().query("begin");
    await cliente().query("set local role service_role");
    const { rows } = await cliente().query<{ n: number }>("select purgar_conversaciones_agente() as n");
    await cliente().query("commit");
    expect(rows[0]?.n).toBe(1);
    const quedan = await cliente().query<{ pregunta: string }>("select pregunta from conversaciones_agente");
    expect(quedan.rows.map((r) => r.pregunta)).toEqual(["nueva"]);
  });

  it("las conversaciones caducan a los 7 días por defecto", async () => {
    const { rows } = await cliente().query<{ dias: number }>(
      "select round(extract(epoch from (expira_en - creado_en)) / 86400)::int as dias from conversaciones_agente limit 1",
    );
    expect(rows[0]?.dias).toBe(7);
  });

  it("solo service_role puede ejecutar la purga", async () => {
    const { rows } = await cliente().query<{ rol: string; puede: boolean }>(
      `select rol, has_function_privilege(rol, 'purgar_conversaciones_agente()', 'execute') as puede
       from unnest(array['anon', 'authenticated', 'service_role']) rol`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.rol, r.puede]))).toEqual({ anon: false, authenticated: false, service_role: true });
  });

  it("visitantes y usuarios no pueden leer, escribir ni purgar conversaciones", async () => {
    for (const rol of ["anon", "authenticated"] as const) {
      await expect(como(rol, "select * from conversaciones_agente")).rejects.toMatchObject({ code: "42501" });
      await expect(como(rol, "insert into conversaciones_agente (pregunta) values ('x')")).rejects.toMatchObject({ code: "42501" });
      await expect(como(rol, "select purgar_conversaciones_agente()")).rejects.toMatchObject({ code: "42501" });
    }
  });
});
