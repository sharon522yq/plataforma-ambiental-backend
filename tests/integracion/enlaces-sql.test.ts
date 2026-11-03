import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BaseDePruebas, crearBaseDePruebas } from "../ayudas/base-de-pruebas.js";

const CENTRO = { lat: 20.6597, lng: -103.3496 };
type Json = Record<string, unknown>;

/** Migración 012: enlaces de la comunidad (D-40), con la sesión de cada rol. */
describe.skipIf(!process.env.TEST_DATABASE_URL)("enlaces de la comunidad en la base (migración 012)", () => {
  let base: BaseDePruebas | undefined;
  let c: pg.Client | undefined;
  const cliente = (): pg.Client => {
    if (!c) throw new Error("Sin conexión de pruebas");
    return c;
  };
  const u = {
    ciudadana: randomUUID(),
    vecino: randomUUID(),
    inactivo: randomUUID(),
    moderadora: randomUUID(),
    editora: randomUUID(),
    admin: randomUUID(),
  };

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
    return (rows[0] as { r: T }).r;
  }

  const firma = { tipo: "firma", nombre: "Firma por el río limpio", enlace: "https://ejemplo.org/firma" };
  const evento = { tipo: "evento", nombre: "Jornada de limpieza", enlace: "https://ejemplo.org/evento" };
  const aporte = (uid: string, enlaces: unknown[] = []) =>
    como(uid, "crear_aporte('contaminacion_agua', 'Descarga al río desde un tubo', $1, $2, 3, null, $3::jsonb)",
      [CENTRO.lat, CENTRO.lng, JSON.stringify(enlaces)]);
  const aprobar = (aporteId: unknown) =>
    como(u.moderadora, "revisar_aporte($1, 'aprobado', null, 'Descarga al río', 3, true)", [aporteId]);
  const proponer = (uid: string | null, punto: unknown, tipo = "evento", enlace = "https://ejemplo.org/otro", nombre = "Reunión vecinal") =>
    como(uid, "proponer_accion($1, $2, $3, $4)", [punto, tipo, nombre, enlace]);
  const accionesDe = async (punto: unknown) =>
    (await cliente().query<{ tipo: string; nombre: string; activa: boolean; autor_id: string | null; aporte_id: string | null; de_la_comunidad: boolean }>(
      "select tipo, nombre, activa, autor_id, aporte_id, de_la_comunidad from acciones where punto_id = $1 order by nombre", [punto],
    )).rows;

  let puntoPublicado = "";

  beforeAll(async () => {
    base = await crearBaseDePruebas();
    c = new pg.Client({ connectionString: base.url });
    await cliente().connect();
    for (const id of Object.values(u)) {
      await cliente().query("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@prueba.local`]);
    }
    await cliente().query("update perfiles set rol = 'moderador' where id = $1", [u.moderadora]);
    await cliente().query("update perfiles set rol = 'editor' where id = $1", [u.editora]);
    await cliente().query("update perfiles set rol = 'administrador' where id = $1", [u.admin]);
    await cliente().query("update perfiles set activo = false where id = $1", [u.inactivo]);
    const a = await aporte(u.vecino);
    puntoPublicado = (await aprobar(a.id)).punto_id as string;
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await base?.limpiar();
  });

  describe("enlaces en el reporte", () => {
    it("crear_aporte guarda hasta 3 enlaces validados y los devuelve", async () => {
      const a = await aporte(u.ciudadana, [{ ...firma, nombre: "  Firma por el río limpio  ", extra: "se descarta" }, evento]);
      expect(a.enlaces).toEqual([firma, evento]);
    });

    it.each([
      ["más de 3", [firma, evento, firma, evento], "hasta 3"],
      ["un enlace sin https", [{ ...firma, enlace: "http://ejemplo.org" }], "https://"],
      ["un tipo inexistente", [{ ...firma, tipo: "rifa" }], "Tipo de enlace"],
      ["un nombre muy corto", [{ ...firma, nombre: "x" }], "entre 3 y 120"],
    ])("rechaza %s", async (_caso, enlaces, mensaje) => {
      const error = await aporte(u.ciudadana, enlaces).catch((e: unknown) => e as { code: string; message: string });
      expect(error).toMatchObject({ code: "22023" });
      expect((error as { message: string }).message).toContain(mensaje);
    });

    it("la llamada anterior, sin enlaces, sigue funcionando (backend sin actualizar)", async () => {
      const a = await como(u.ciudadana, "crear_aporte('residuos', 'Basura acumulada en la esquina', $1, $2, 2, null)", [CENTRO.lat, CENTRO.lng]);
      expect(a.enlaces).toEqual([]);
    });

    it("al aprobar se publican en el punto nuevo, a nombre de quien reportó, una sola vez", async () => {
      const a = await aporte(u.ciudadana, [firma, evento]);
      const r = await aprobar(a.id);
      expect(await accionesDe(r.punto_id)).toEqual([
        { tipo: "firma", nombre: firma.nombre, activa: true, autor_id: u.ciudadana, aporte_id: a.id, de_la_comunidad: true },
        { tipo: "evento", nombre: evento.nombre, activa: true, autor_id: u.ciudadana, aporte_id: a.id, de_la_comunidad: true },
      ].sort((x, y) => x.nombre.localeCompare(y.nombre)));
      expect(await como(u.moderadora, "publicar_enlaces_aporte($1)", [a.id])).toBe(0);
      const publico = await como<{ acciones: Json[] }>(null, "obtener_punto_publico($1)", [r.punto_id]);
      expect(publico.acciones).toHaveLength(2);
      expect(publico.acciones[0]).toMatchObject({ de_la_comunidad: true });
      expect(publico.acciones[0]).not.toHaveProperty("autor_id");
    });

    it("al marcar duplicado se publican en el punto original; al rechazar, no", async () => {
      const dup = await aporte(u.ciudadana, [{ ...firma, enlace: "https://ejemplo.org/firma-2" }]);
      await como(u.moderadora, "revisar_aporte($1, 'duplicado', null, null, null, false, $2)", [dup.id, puntoPublicado]);
      expect((await accionesDe(puntoPublicado)).map((x) => x.aporte_id)).toContain(dup.id);

      const rech = await aporte(u.ciudadana, [{ ...firma, enlace: "https://ejemplo.org/firma-3" }]);
      await como(u.moderadora, "revisar_aporte($1, 'rechazado', 'No es ambiental')", [rech.id]);
      const { rows } = await cliente().query("select 1 from acciones where aporte_id = $1", [rech.id]);
      expect(rows).toHaveLength(0);
    });

    it("publicar_enlaces_aporte no sirve para un aporte pendiente ni para quien no lo revisó", async () => {
      const a = await aporte(u.ciudadana, [{ ...firma, enlace: "https://ejemplo.org/firma-4" }]);
      await expect(como(u.moderadora, "publicar_enlaces_aporte($1)", [a.id])).rejects.toMatchObject({ code: "55000" });
      await expect(como(u.ciudadana, "publicar_enlaces_aporte($1)", [a.id])).rejects.toMatchObject({ code: "42501" });
      await aprobar(a.id);
      await expect(como(u.admin, "publicar_enlaces_aporte($1)", [a.id])).rejects.toMatchObject({ code: "55000" });
    });
  });

  describe("proponer_accion: cualquier cuenta activa", () => {
    it("una ciudadana agrega un evento a un punto publicado y sale al momento en las consultas públicas", async () => {
      const r = await proponer(u.ciudadana, puntoPublicado, "evento", "https://ejemplo.org/reunion");
      expect(r).toMatchObject({ tipo: "evento", activa: true, de_la_comunidad: true, punto_id: puntoPublicado });
      const lista = await como<{ datos: Json[] }>(null, "listar_acciones_publicas(null, $1)", [puntoPublicado]);
      expect(lista.datos.find((x) => x.id === r.id)).toMatchObject({ de_la_comunidad: true });
      const { rows } = await cliente().query<{ autor_id: string }>("select autor_id from acciones where id = $1", [r.id]);
      expect(rows[0]?.autor_id).toBe(u.ciudadana);
      const auditoria = await cliente().query<{ accion: string; usuario_id: string }>("select accion, usuario_id from auditoria where registro_id = $1", [r.id]);
      expect(auditoria.rows).toEqual([{ accion: "accion_creada", usuario_id: u.ciudadana }]);
    });

    it("sin sesión, con cuenta inactiva o en un punto no publicado, no", async () => {
      await expect(proponer(null, puntoPublicado)).rejects.toMatchObject({ code: "42501" });
      await expect(proponer(u.inactivo, puntoPublicado)).rejects.toMatchObject({ code: "42501" });
      const enRevision = await como(u.admin, "crear_punto('Punto oculto', 'residuos', 2, 'x', $1, $2, 'en_revision')", [CENTRO.lat, CENTRO.lng]);
      await expect(proponer(u.ciudadana, enRevision.id)).rejects.toMatchObject({ code: "P0002" });
      await expect(proponer(u.ciudadana, randomUUID())).rejects.toMatchObject({ code: "P0002" });
    });

    it("valida el enlace, no repite uno activo en el mismo punto y limita a 10 por día", async () => {
      await expect(proponer(u.vecino, puntoPublicado, "evento", "javascript:alert(1)")).rejects.toMatchObject({ code: "22023" });
      await proponer(u.vecino, puntoPublicado, "firma", "https://ejemplo.org/unica");
      await expect(proponer(u.vecino, puntoPublicado, "firma", "https://ejemplo.org/unica")).rejects.toMatchObject({ code: "55000" });
      const hoy = (await cliente().query<{ n: string }>("select count(*) n from acciones where autor_id = $1", [u.vecino])).rows[0]?.n;
      for (let i = Number(hoy); i < 10; i++) await proponer(u.vecino, puntoPublicado, "evento", `https://ejemplo.org/e${String(i)}`);
      const error = await proponer(u.vecino, puntoPublicado, "evento", "https://ejemplo.org/once").catch((e: unknown) => e as { code: string; message: string });
      expect(error).toMatchObject({ code: "55000" });
      expect((error as { message: string }).message).toContain("10 enlaces");
    });

    it("un ciudadano no puede insertar en acciones directamente ni cambiar autor", async () => {
      await expect(sentenciaComo(u.ciudadana, "insert into acciones (tipo, nombre, enlace, punto_id) values ('firma', 'x', 'https://a.b', $1)", [puntoPublicado]))
        .rejects.toMatchObject({ code: "42501" });
    });
  });

  describe("retirar_accion", () => {
    it.each([["moderadora", "moderadora"], ["editora", "editora"], ["administradora", "admin"]] as const)(
      "la %s puede retirar un enlace y queda auditado", async (_n, quien) => {
        const r = await proponer(u.ciudadana, puntoPublicado, "evento", `https://ejemplo.org/retirar-${quien}`);
        const retirado = await como(u[quien], "retirar_accion($1)", [r.id]);
        expect(retirado).toMatchObject({ id: r.id, activa: false });
        const publico = await como<{ acciones: Json[] }>(null, "obtener_punto_publico($1)", [puntoPublicado]);
        expect(publico.acciones.map((x) => x.id)).not.toContain(r.id);
        const auditoria = await cliente().query<{ accion: string; usuario_id: string }>(
          "select accion, usuario_id from auditoria where registro_id = $1 order by creado_en, accion", [r.id]);
        expect(auditoria.rows.at(-1)).toEqual({ accion: "accion_actualizada", usuario_id: u[quien] });
        await expect(como(u[quien], "retirar_accion($1)", [r.id])).rejects.toMatchObject({ code: "P0002" });
      });

    it("un ciudadano, aunque sea el autor, no puede retirar", async () => {
      const r = await proponer(u.ciudadana, puntoPublicado, "evento", "https://ejemplo.org/no-retirar");
      await expect(como(u.ciudadana, "retirar_accion($1)", [r.id])).rejects.toMatchObject({ code: "42501" });
    });
  });

  describe("permisos", () => {
    it("anon no ejecuta las funciones nuevas ni ve autor_id o aporte_id de acciones", async () => {
      const funciones = [
        "validar_enlace(text,text,text,text)",
        "crear_aporte(text,text,double precision,double precision,integer,uuid,jsonb)",
        "publicar_enlaces_aporte(uuid)",
        "proponer_accion(uuid,text,text,text,text)",
        "retirar_accion(uuid)",
      ];
      const { rows } = await cliente().query<{ f: string; anon: boolean; autenticado: boolean }>(
        `select f, has_function_privilege('anon', f, 'execute') anon, has_function_privilege('authenticated', f, 'execute') autenticado
         from unnest($1::text[]) f`, [funciones],
      );
      for (const r of rows) expect(r, r.f).toMatchObject({ anon: false, autenticado: true });
      await expect(sentenciaComo(null, "select autor_id from acciones")).rejects.toMatchObject({ code: "42501" });
      await expect(sentenciaComo(null, "select aporte_id from acciones")).rejects.toMatchObject({ code: "42501" });
      const visibles = await sentenciaComo(null, "select id, de_la_comunidad from acciones");
      expect(visibles.rows.length).toBeGreaterThan(0);
    });

    it("el tipo evento queda permitido en acciones", async () => {
      const r = await como(u.editora, "crear_accion('evento', 'Feria ambiental', null, 'https://ejemplo.org/feria', null, $1)", [puntoPublicado]);
      expect(r).toMatchObject({ tipo: "evento", de_la_comunidad: false });
    });
  });
});
