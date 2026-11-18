import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BaseDePruebas, crearBaseDePruebas } from "../ayudas/base-de-pruebas.js";

const CENTRO = { lat: 20.6597, lng: -103.3496 };
type Json = Record<string, unknown>;

/** Fuentes en reportes y casos (migración 020), con la sesión de cada rol. */
describe.skipIf(!process.env.TEST_DATABASE_URL)("fuentes de los casos (migración 020)", () => {
  let base: BaseDePruebas | undefined;
  let c: pg.Client | undefined;
  const cliente = (): pg.Client => {
    if (!c) throw new Error("Sin conexión de pruebas");
    return c;
  };
  const u = {
    ciudadana: randomUUID(),
    otro: randomUUID(),
    moderadora: randomUUID(),
    admin: randomUUID(),
  };
  const NOTA = "https://www.e-consulta.com/sociedad/nota";
  const OFICIAL = "https://www.gob.mx/profepa/prensa/comunicado";

  async function sentenciaComo(uid: string | null, sql: string, valores: unknown[] = []): Promise<pg.QueryResult> {
    await cliente().query("begin");
    try {
      if (uid) await cliente().query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
      await cliente().query(`set local role ${uid ? "authenticated" : "anon"}`);
      const resultado = await cliente().query(sql, valores);
      await cliente().query("commit");
      return resultado;
    } catch (error) {
      await cliente().query("rollback");
      throw error;
    }
  }

  async function como<T = Json>(uid: string | null, expresion: string, valores: unknown[] = []): Promise<T> {
    const { rows } = await sentenciaComo(uid, `select ${expresion} as r`, valores);
    const fila = rows[0] as { r: T } | undefined;
    if (!fila) throw new Error("Sin resultado");
    return fila.r;
  }

  const nuevoAporte = (uid: string, fuentes: unknown = [], punto: string | null = null, titulo: string | null = "Basura junto al canal") =>
    como(uid, "crear_aporte('residuos', 'Bolsas de basura acumuladas junto al canal', $1, $2, 3, $3, '[]'::jsonb, $4, $5::jsonb)",
      [CENTRO.lat, CENTRO.lng, punto, titulo, JSON.stringify(fuentes)]);

  /** Un caso publicado de la ciudadana, como queda al aprobar su reporte. */
  async function casoPublicado(fuentes: unknown = []): Promise<string> {
    const a = await nuevoAporte(u.ciudadana, fuentes);
    const r = await como(u.moderadora, "revisar_aporte($1, 'aprobado')", [a.id]);
    return r.punto_id as string;
  }

  const fuentesDe = async (punto: string) =>
    (await cliente().query<{ fuentes: Json[] }>("select fuentes from puntos where id = $1", [punto])).rows[0]?.fuentes;

  const auditoria = async (registro: string, accion: string) =>
    (await cliente().query<{ usuario_id: string | null; detalle: Json }>(
      "select usuario_id, detalle from auditoria where registro_id = $1 and accion = $2 order by creado_en", [registro, accion],
    )).rows;

  beforeAll(async () => {
    base = await crearBaseDePruebas();
    c = new pg.Client({ connectionString: base.url });
    await cliente().connect();
    for (const id of Object.values(u)) {
      await cliente().query("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@prueba.local`]);
    }
    await cliente().query("update perfiles set rol = 'moderador' where id = $1", [u.moderadora]);
    await cliente().query("update perfiles set rol = 'administrador' where id = $1", [u.admin]);
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await base?.limpiar();
  });

  describe("en el reporte", () => {
    it("guarda las fuentes limpias: enlace obligatorio, nombre opcional y sin repetidos", async () => {
      const a = await nuevoAporte(u.ciudadana, [
        { enlace: ` ${NOTA} `, nombre: "  e-consulta " },
        { enlace: OFICIAL },
        { enlace: NOTA, nombre: "Repetida" },
      ]);
      expect(a.fuentes).toEqual([{ enlace: NOTA, nombre: "e-consulta" }, { enlace: OFICIAL }]);
      const mios = await como<{ datos: Json[] }>(u.ciudadana, "mis_aportes(100, 0)");
      expect(mios.datos.find((x) => x.id === a.id)?.fuentes).toHaveLength(2);
    });

    it.each([
      ["un enlace http", [{ enlace: "http://ejemplo.org" }]],
      ["un enlace con espacios", [{ enlace: "https://ejemplo.org/una nota" }]],
      ["una fuente sin enlace", [{ nombre: "Solo nombre" }]],
      ["un nombre de una letra", [{ enlace: NOTA, nombre: "x" }]],
      ["más de 5 fuentes", Array.from({ length: 6 }, (_v, i) => ({ enlace: `https://ejemplo.org/${String(i)}` }))],
      ["algo que no es lista", { enlace: NOTA }],
    ])("rechaza %s con 22023", async (_caso, fuentes) => {
      await expect(nuevoAporte(u.ciudadana, fuentes)).rejects.toMatchObject({ code: "22023" });
    });

    it("un INSERT directo con fuentes inválidas lo rechaza la tabla", async () => {
      await expect(sentenciaComo(u.ciudadana,
        "insert into aportes (tipo, descripcion, ubicacion, autor_id, fuentes) values ('otro', 'Texto de prueba', st_setsrid(st_makepoint(0, 0), 4326)::geography, $1, $2::jsonb)",
        [u.ciudadana, JSON.stringify([{ enlace: "javascript:alert(1)" }])])).rejects.toMatchObject({ code: "22023" });
    });

    it("quien reporta cambia o quita las fuentes de su reporte pendiente", async () => {
      const a = await nuevoAporte(u.ciudadana, [{ enlace: NOTA }]);
      const r = await como(u.ciudadana, "editar_aporte($1, fuentes => $2::jsonb)", [a.id, JSON.stringify([{ enlace: OFICIAL, nombre: "Profepa" }])]);
      expect(r.fuentes).toEqual([{ enlace: OFICIAL, nombre: "Profepa" }]);
      expect((await como(u.ciudadana, "editar_aporte($1, fuentes => '[]'::jsonb)", [a.id])).fuentes).toEqual([]);
      const reg = await auditoria(a.id as string, "aporte_editado");
      expect(reg.at(-1)).toMatchObject({ detalle: { campos: ["fuentes"] } });
      expect(JSON.stringify(reg)).not.toContain("gob.mx");
    });
  });

  describe("en el caso", () => {
    it("el caso nace con las fuentes del reporte y son públicas", async () => {
      const punto = await casoPublicado([{ enlace: NOTA, nombre: "e-consulta" }]);
      expect(await como(null, "obtener_punto_publico($1)", [punto])).toMatchObject({ fuentes: [{ enlace: NOTA, nombre: "e-consulta" }] });
      const { rows } = await sentenciaComo(null, "select fuentes from puntos where id = $1", [punto]);
      expect(rows[0]).toMatchObject({ fuentes: [{ enlace: NOTA }] });
    });

    it("un aporte aprobado o duplicado suma sus fuentes al caso, sin repetir", async () => {
      const punto = await casoPublicado([{ enlace: NOTA }]);
      const aprobado = await nuevoAporte(u.otro, [{ enlace: NOTA }, { enlace: OFICIAL }], punto, null);
      await como(u.moderadora, "revisar_aporte($1, 'aprobado')", [aprobado.id]);
      expect(await fuentesDe(punto)).toEqual([{ enlace: NOTA }, { enlace: OFICIAL }]);

      const duplicado = await nuevoAporte(u.otro, [{ enlace: "https://ejemplo.org/otra-nota" }]);
      await como(u.moderadora, "revisar_aporte($1, 'duplicado', duplicado_de => $2)", [duplicado.id, punto]);
      expect(await fuentesDe(punto)).toHaveLength(3);
    });

    it("quien reportó cambia las fuentes de su caso y vuelve a revisión; sin cambios no", async () => {
      const punto = await casoPublicado([{ enlace: NOTA }]);
      const r = await como(u.ciudadana, "editar_mi_punto($1, fuentes => $2::jsonb)", [punto, JSON.stringify([{ enlace: NOTA }, { enlace: OFICIAL }])]);
      expect(r).toMatchObject({ estado: "en_revision", fuentes: [{ enlace: NOTA }, { enlace: OFICIAL }] });
      const otra = await casoPublicado([{ enlace: NOTA }]);
      expect(await como(u.ciudadana, "editar_mi_punto($1, fuentes => $2::jsonb)", [otra, JSON.stringify([{ enlace: ` ${NOTA}` }])])).toMatchObject({ estado: "publicado" });
    });

    it("moderación cambia las fuentes sin cambiar el estado; el ciudadano no puede", async () => {
      const punto = await casoPublicado();
      const r = await como(u.moderadora, "editar_fuentes_punto($1, $2::jsonb)", [punto, JSON.stringify([{ enlace: OFICIAL, nombre: "Profepa" }])]);
      expect(r).toMatchObject({ estado: "publicado", fuentes: [{ enlace: OFICIAL, nombre: "Profepa" }] });
      expect(await auditoria(punto, "punto_editado")).toEqual([expect.objectContaining({ usuario_id: u.moderadora, detalle: { campos: ["fuentes"] } })]);
      await expect(como(u.ciudadana, "editar_fuentes_punto($1, '[]'::jsonb)", [punto])).rejects.toMatchObject({ code: "42501" });
      await expect(como(u.moderadora, "editar_fuentes_punto($1, $2::jsonb)", [punto, JSON.stringify([{ enlace: "ftp://x" }])])).rejects.toMatchObject({ code: "22023" });
      await expect(como(u.moderadora, "editar_fuentes_punto($1, '[]'::jsonb)", [randomUUID()])).rejects.toMatchObject({ code: "P0002" });
      await como(u.moderadora, "cambiar_estado_punto($1, 'archivado')", [punto]);
      await expect(como(u.moderadora, "editar_fuentes_punto($1, '[]'::jsonb)", [punto])).rejects.toMatchObject({ code: "42501" });
      expect(await como(u.admin, "editar_fuentes_punto($1, '[]'::jsonb)", [punto])).toMatchObject({ fuentes: [] });
    });
  });

  it("permisos: anon no ejecuta las funciones nuevas", async () => {
    const funciones = [
      "crear_aporte(text,text,double precision,double precision,integer,uuid,jsonb,text,jsonb)",
      "editar_aporte(uuid,text,text,jsonb)",
      "editar_mi_punto(uuid,text,text,jsonb)",
      "editar_fuentes_punto(uuid,jsonb)",
    ];
    const { rows } = await cliente().query<{ f: string; anon: boolean; autenticado: boolean; servicio: boolean }>(
      `select f, has_function_privilege('anon', f, 'execute') anon,
              has_function_privilege('authenticated', f, 'execute') autenticado,
              has_function_privilege('service_role', f, 'execute') servicio
       from unnest($1::text[]) f`,
      [funciones],
    );
    for (const r of rows) expect(r, r.f).toMatchObject({ anon: false, autenticado: true, servicio: true });
  });
});
