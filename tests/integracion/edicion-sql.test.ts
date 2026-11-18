import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BaseDePruebas, crearBaseDePruebas } from "../ayudas/base-de-pruebas.js";

const CENTRO = { lat: 20.6597, lng: -103.3496 };
type Json = Record<string, unknown>;

/** Funciones de la migración 019 con la sesión de cada rol, como las llama la API. */
describe.skipIf(!process.env.TEST_DATABASE_URL)("editar casos (migración 019)", () => {
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

  const nuevoAporte = (uid: string, titulo: string | null = "Basura junto al canal", punto: string | null = null) =>
    como(uid, "crear_aporte('residuos', 'Bolsas de basura acumuladas junto al canal', $1, $2, 3, $3, '[]'::jsonb, $4)",
      [CENTRO.lat, CENTRO.lng, punto, titulo]);

  /** Un caso publicado de la ciudadana, como queda al aprobar su reporte. */
  async function casoPublicado(): Promise<string> {
    const a = await nuevoAporte(u.ciudadana);
    const r = await como(u.moderadora, "revisar_aporte($1, 'aprobado')", [a.id]);
    return r.punto_id as string;
  }

  const estadoDe = async (punto: string) =>
    (await cliente().query<{ estado: string; titulo: string; descripcion: string }>(
      "select estado, titulo, descripcion from puntos where id = $1", [punto])).rows[0];

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

  describe("editar_aporte", () => {
    it("quien reporta corrige título y descripción de su reporte pendiente, y queda auditado sin el texto", async () => {
      const a = await nuevoAporte(u.ciudadana);
      const r = await como(u.ciudadana, "editar_aporte($1, $2, $3)", [a.id, " Basura en el canal norte ", "Bolsas y escombro en el canal norte"]);
      expect(r).toMatchObject({ titulo: "Basura en el canal norte", descripcion: "Bolsas y escombro en el canal norte", estado: "pendiente" });
      const solo = await como(u.ciudadana, "editar_aporte($1, descripcion => $2)", [a.id, "Solo cambia la descripción esta vez"]);
      expect(solo).toMatchObject({ titulo: "Basura en el canal norte", descripcion: "Solo cambia la descripción esta vez" });
      const reg = await auditoria(a.id as string, "aporte_editado");
      expect(reg[0]).toMatchObject({ usuario_id: u.ciudadana, detalle: { campos: ["titulo", "descripcion"] } });
      expect(reg[1]).toMatchObject({ detalle: { campos: ["descripcion"] } });
      expect(JSON.stringify(reg)).not.toContain("escombro");
    });

    it("no deja editar un reporte ajeno, ya revisado, sin cambios o con datos fuera de rango", async () => {
      const a = await nuevoAporte(u.ciudadana);
      await expect(como(u.otro, "editar_aporte($1, 'Título ajeno')", [a.id])).rejects.toMatchObject({ code: "P0002" });
      await expect(como(null, "editar_aporte($1, 'Sin sesión')", [a.id])).rejects.toMatchObject({ code: "42501" });
      await expect(como(u.ciudadana, "editar_aporte($1)", [a.id])).rejects.toMatchObject({ code: "22023" });
      await expect(como(u.ciudadana, "editar_aporte($1, 'ab')", [a.id])).rejects.toMatchObject({ code: "22023" });
      await expect(como(u.ciudadana, "editar_aporte($1, descripcion => 'corta')", [a.id])).rejects.toMatchObject({ code: "22023" });
      await como(u.moderadora, "revisar_aporte($1, 'rechazado', 'No es ambiental')", [a.id]);
      await expect(como(u.ciudadana, "editar_aporte($1, 'Ya revisado')", [a.id])).rejects.toMatchObject({ code: "55000" });
    });

    it("si el autor edita mientras moderación aprueba, el caso sale con el texto editado", async () => {
      const a = await nuevoAporte(u.ciudadana);
      if (!base) throw new Error("Sin base");
      const editor = new pg.Client({ connectionString: base.url });
      await editor.connect();
      try {
        await editor.query("begin");
        await editor.query("select set_config('request.jwt.claim.sub', $1, true)", [u.ciudadana]);
        await editor.query("set local role authenticated");
        await editor.query("select editar_aporte($1, 'Título corregido a tiempo')", [a.id]);
        // La edición sigue abierta: la aprobación tiene que esperarla.
        const aprobacion = como(u.moderadora, "revisar_aporte($1, 'aprobado')", [a.id]);
        await new Promise((listo) => setTimeout(listo, 300));
        await editor.query("commit");
        const r = await aprobacion;
        expect(await como(null, "obtener_punto_publico($1)", [r.punto_id])).toMatchObject({ titulo: "Título corregido a tiempo" });
      } finally {
        await editor.end();
      }
    });

    it("un aporte sobre un punto existente no acepta título, pero sí descripción", async () => {
      const punto = await casoPublicado();
      const a = await nuevoAporte(u.otro, null, punto);
      await expect(como(u.otro, "editar_aporte($1, 'Un título')", [a.id])).rejects.toMatchObject({ code: "22023" });
      expect(await como(u.otro, "editar_aporte($1, descripcion => $2)", [a.id, "Sigue habiendo basura hoy"])).toMatchObject({ descripcion: "Sigue habiendo basura hoy" });
    });
  });

  describe("mis_puntos y editar_mi_punto", () => {
    it("lista los casos propios en cualquier estado y nada ajeno", async () => {
      const punto = await casoPublicado();
      const mios = await como<{ total: number; datos: Json[] }>(u.ciudadana, "mis_puntos(100, 0)");
      expect(mios.datos.map((x) => x.id)).toContain(punto);
      const ajenos = await como<{ total: number; datos: Json[] }>(u.otro, "mis_puntos(100, 0)");
      expect(ajenos.datos.map((x) => x.id)).not.toContain(punto);
      await expect(como(null, "mis_puntos(10, 0)")).rejects.toMatchObject({ code: "42501" });
    });

    it("editar un caso publicado lo saca del mapa y lo devuelve a revisión", async () => {
      const punto = await casoPublicado();
      expect(await como(null, "obtener_punto_publico($1)", [punto])).not.toBeNull();
      const r = await como(u.ciudadana, "editar_mi_punto($1, $2)", [punto, "Basura en el canal, ya con fotos"]);
      expect(r).toMatchObject({ estado: "en_revision", titulo: "Basura en el canal, ya con fotos" });
      expect(await como(null, "obtener_punto_publico($1)", [punto])).toBeNull();
      expect(await auditoria(punto, "punto_editado")).toEqual([expect.objectContaining({ usuario_id: u.ciudadana, detalle: { campos: ["titulo"] } })]);
      const estados = await auditoria(punto, "punto_estado_cambiado");
      expect(estados.at(-1)).toMatchObject({ usuario_id: u.ciudadana, detalle: { estado_anterior: "publicado", estado_nuevo: "en_revision" } });

      const cola = await como<{ datos: Json[] }>(u.moderadora, "cola_puntos('en_revision', 100, 0)");
      expect(cola.datos.map((x) => x.id)).toContain(punto);
      await como(u.moderadora, "cambiar_estado_punto($1, 'publicado')", [punto]);
      expect(await como(null, "obtener_punto_publico($1)", [punto])).toMatchObject({ titulo: "Basura en el canal, ya con fotos" });
    });

    it("sin cambios reales no toca el estado", async () => {
      const punto = await casoPublicado();
      const titulo = (await estadoDe(punto))?.titulo ?? "";
      expect(await como(u.ciudadana, "editar_mi_punto($1, $2)", [punto, ` ${titulo} `])).toMatchObject({ estado: "publicado" });
    });

    it("no deja editar un caso ajeno, archivado o con datos fuera de rango", async () => {
      const punto = await casoPublicado();
      await expect(como(u.otro, "editar_mi_punto($1, 'Título ajeno')", [punto])).rejects.toMatchObject({ code: "P0002" });
      await expect(como(u.moderadora, "editar_mi_punto($1, 'No es suyo')", [punto])).rejects.toMatchObject({ code: "P0002" });
      await expect(como(u.ciudadana, "editar_mi_punto($1, descripcion => 'corta')", [punto])).rejects.toMatchObject({ code: "22023" });
      await como(u.moderadora, "cambiar_estado_punto($1, 'archivado')", [punto]);
      await expect(como(u.ciudadana, "editar_mi_punto($1, 'Archivado')", [punto])).rejects.toMatchObject({ code: "55000" });
      expect((await estadoDe(punto))?.estado).toBe("archivado");
    });

    it("un UPDATE directo del ciudadano sobre puntos no cambia nada (RLS)", async () => {
      const punto = await casoPublicado();
      const r = await sentenciaComo(u.ciudadana, "update puntos set titulo = 'Cambiado a mano' where id = $1", [punto]);
      expect(r.rowCount).toBe(0);
    });
  });

  describe("editar_titulo_punto y cola_puntos", () => {
    it("moderación corrige el título sin cambiar el estado, y queda auditado", async () => {
      const punto = await casoPublicado();
      const r = await como(u.moderadora, "editar_titulo_punto($1, $2)", [punto, "Título corregido por moderación"]);
      expect(r).toMatchObject({ titulo: "Título corregido por moderación", estado: "publicado" });
      expect(await auditoria(punto, "punto_editado")).toEqual([expect.objectContaining({ usuario_id: u.moderadora, detalle: { campos: ["titulo"] } })]);
    });

    it("el ciudadano no puede; el moderador no toca archivados y el administrador sí", async () => {
      const punto = await casoPublicado();
      await expect(como(u.ciudadana, "editar_titulo_punto($1, 'Intento')", [punto])).rejects.toMatchObject({ code: "42501" });
      await expect(como(u.moderadora, "editar_titulo_punto($1, 'ab')", [punto])).rejects.toMatchObject({ code: "22023" });
      await expect(como(u.moderadora, "editar_titulo_punto($1, 'No existe')", [randomUUID()])).rejects.toMatchObject({ code: "P0002" });
      await como(u.moderadora, "cambiar_estado_punto($1, 'archivado')", [punto]);
      await expect(como(u.moderadora, "editar_titulo_punto($1, 'Archivado')", [punto])).rejects.toMatchObject({ code: "42501" });
      expect(await como(u.admin, "editar_titulo_punto($1, 'Corregido por administración')", [punto])).toMatchObject({ estado: "archivado" });
    });

    it("cola_puntos es solo para moderación y valida el estado", async () => {
      await expect(como(u.ciudadana, "cola_puntos('en_revision', 10, 0)")).rejects.toMatchObject({ code: "42501" });
      await expect(como(u.moderadora, "cola_puntos('borrado', 10, 0)")).rejects.toMatchObject({ code: "22023" });
      await expect(como(u.moderadora, "cola_puntos('en_revision', 0, 0)")).rejects.toMatchObject({ code: "22023" });
    });
  });

  it("permisos: anon no ejecuta nada nuevo y nadie llama el trigger", async () => {
    const funciones = [
      "editar_aporte(uuid,text,text,jsonb)",
      "mis_puntos(integer,integer)",
      "editar_mi_punto(uuid,text,text,jsonb)",
      "editar_titulo_punto(uuid,text)",
      "cola_puntos(text,integer,integer)",
    ];
    const { rows } = await cliente().query<{ f: string; anon: boolean; autenticado: boolean; servicio: boolean }>(
      `select f, has_function_privilege('anon', f, 'execute') anon,
              has_function_privilege('authenticated', f, 'execute') autenticado,
              has_function_privilege('service_role', f, 'execute') servicio
       from unnest($1::text[]) f`,
      [funciones],
    );
    for (const r of rows) expect(r, r.f).toMatchObject({ anon: false, autenticado: true, servicio: true });
    const t = await cliente().query<{ x: boolean }>(
      "select has_function_privilege('authenticated', 'auditar_edicion_texto()', 'execute') or has_function_privilege('anon', 'auditar_edicion_texto()', 'execute') as x",
    );
    expect(t.rows[0]?.x).toBe(false);
  });
});
