import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BaseDePruebas, comoRol, crearBaseDePruebas } from "../ayudas/base-de-pruebas.js";

const CENTRO = { lat: 20.6597, lng: -103.3496 };

interface Pagina {
  total: number;
  datos: Record<string, unknown>[];
}

/**
 * Funciones de la migración 007, ejecutadas como anon: las mismas que llama la API.
 * La base trae los datos [PRUEBA] de la 005 (3 puntos publicados, 2 organizaciones, 3 acciones).
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("consultas públicas (migración 007)", () => {
  let base: BaseDePruebas | undefined;
  let c: pg.Client | undefined;
  const cliente = (): pg.Client => {
    if (!c) throw new Error("Sin conexión de pruebas");
    return c;
  };
  const ids: Record<string, string> = {};

  /** Ejecuta `select <expresion>` como anon y devuelve el JSON resultante. */
  async function comoAnon<T>(expresion: string, valores: unknown[] = []): Promise<T> {
    return comoRol(cliente(), "anon", null, async () => {
      const { rows } = await cliente().query<{ r: T }>(`select ${expresion} as r`, valores);
      if (!rows[0]) throw new Error("Sin resultado");
      return rows[0].r;
    });
  }

  beforeAll(async () => {
    base = await crearBaseDePruebas();
    c = new pg.Client({ connectionString: base.url });
    await cliente().connect();

    const insertar = async (clave: string, estado: string, tipo = "otro", gravedad = 1) => {
      const { rows } = await cliente().query<{ id: string }>(
        `insert into puntos (titulo, tipo, gravedad, descripcion, ubicacion, estado)
         values ($1, $2, $3, 'x', st_setsrid(st_makepoint($4, $5), 4326)::geography, $6) returning id`,
        [`[PRUEBA] ${clave}`, tipo, gravedad, CENTRO.lng, CENTRO.lat, estado],
      );
      ids[clave] = rows[0]?.id ?? "";
    };
    await insertar("en revisión", "en_revision", "residuos", 5);
    await insertar("archivado", "archivado", "residuos", 5);
    await insertar("publicado en el centro", "publicado", "residuos", 5);

    const { rows } = await cliente().query<{ id: string }>(
      `insert into organizaciones (nombre, contacto, zona, activa) values ('[PRUEBA] Inactiva', 'secreto', 'Zapopan', false) returning id`,
    );
    const inactiva = rows[0]?.id;
    await cliente().query(
      `insert into acciones (tipo, nombre, organizacion_id, activa, punto_id) values
         ('donacion', '[PRUEBA] Acción de org inactiva', $1, true, $2),
         ('donacion', '[PRUEBA] Acción inactiva', null, false, $2)`,
      [inactiva, ids["publicado en el centro"]],
    );
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await base?.limpiar();
  });

  describe("listar_puntos_publicos", () => {
    it("solo cuenta y devuelve puntos publicados", async () => {
      const r = await comoAnon<Pagina>("listar_puntos_publicos()");
      expect(r.total).toBe(4);
      const titulos = r.datos.map((p) => p.titulo);
      expect(titulos).not.toContain("[PRUEBA] en revisión");
      expect(titulos).not.toContain("[PRUEBA] archivado");
    });

    it("devuelve lat y lng y ningún campo interno", async () => {
      const r = await comoAnon<Pagina>("listar_puntos_publicos('residuos')");
      expect(r.datos).toHaveLength(1);
      expect(r.datos[0]).toMatchObject({ lat: CENTRO.lat, lng: CENTRO.lng, tipo: "residuos" });
      expect(Object.keys(r.datos[0] ?? {}).sort()).toEqual(
        ["actualizado_en", "creado_en", "descripcion", "gravedad", "id", "lat", "lng", "tipo", "titulo"],
      );
    });

    it("filtra por gravedad mínima", async () => {
      const r = await comoAnon<Pagina>("listar_puntos_publicos(null, 4)");
      expect(r.total).toBe(3);
      expect(r.datos.every((p) => (p.gravedad as number) >= 4)).toBe(true);
    });

    it("pagina sin repetir puntos y conserva el total fuera de rango", async () => {
      const p1 = await comoAnon<Pagina>("listar_puntos_publicos(null, null, 2, 0)");
      const p2 = await comoAnon<Pagina>("listar_puntos_publicos(null, null, 2, 2)");
      const p3 = await comoAnon<Pagina>("listar_puntos_publicos(null, null, 2, 4)");
      expect([p1.datos.length, p2.datos.length, p3.datos.length]).toEqual([2, 2, 0]);
      expect(p3.total).toBe(4);
      const todos = [...p1.datos, ...p2.datos].map((p) => p.id);
      expect(new Set(todos).size).toBe(4);
    });

    it.each(["listar_puntos_publicos(null, null, 101, 0)", "listar_puntos_publicos(null, null, 0, 0)", "listar_puntos_publicos(null, null, 10, -1)"])(
      "rechaza %s con código 22023",
      async (expresion) => {
        await expect(comoAnon(expresion)).rejects.toMatchObject({ code: "22023" });
      },
    );
  });

  describe("obtener_punto_publico", () => {
    it("devuelve un punto publicado con solo sus acciones activas", async () => {
      const r = await comoAnon<Record<string, unknown>>("obtener_punto_publico($1)", [ids["publicado en el centro"]]);
      expect(r).toMatchObject({ id: ids["publicado en el centro"], lat: CENTRO.lat, lng: CENTRO.lng });
      const acciones = r.acciones as { nombre: string }[];
      expect(acciones.map((a) => a.nombre)).toEqual(["[PRUEBA] Acción de org inactiva"]);
    });

    it("devuelve null para puntos en revisión, archivados o inexistentes", async () => {
      for (const id of [ids["en revisión"], ids.archivado, "00000000-0000-4000-8000-000000000000"]) {
        expect(await comoAnon("obtener_punto_publico($1)", [id])).toBeNull();
      }
    });
  });

  describe("puntos_cercanos_publicos", () => {
    it("devuelve publicados ordenados por distancia, con coordenadas", async () => {
      const r = await comoAnon<Record<string, number | string>[]>("puntos_cercanos_publicos($1, $2, 50000)", [CENTRO.lat, CENTRO.lng]);
      expect(r).toHaveLength(4);
      expect(r[0]).toMatchObject({ titulo: "[PRUEBA] publicado en el centro", distancia_metros: 0, lat: CENTRO.lat, lng: CENTRO.lng });
      const distancias = r.map((p) => p.distancia_metros as number);
      expect([...distancias].sort((a, b) => a - b)).toEqual(distancias);
    });

    it("respeta el límite", async () => {
      const r = await comoAnon<unknown[]>("puntos_cercanos_publicos($1, $2, 50000, null, 2)", [CENTRO.lat, CENTRO.lng]);
      expect(r).toHaveLength(2);
    });

    it("rechaza radio y límite fuera de rango con 22023", async () => {
      await expect(comoAnon("puntos_cercanos_publicos($1, $2, 50001)", [CENTRO.lat, CENTRO.lng])).rejects.toMatchObject({ code: "22023" });
      await expect(comoAnon("puntos_cercanos_publicos($1, $2, 1000, null, 101)", [CENTRO.lat, CENTRO.lng])).rejects.toMatchObject({ code: "22023" });
    });
  });

  describe("listar_acciones_publicas", () => {
    it("solo acciones activas; organización inactiva sale como null", async () => {
      const r = await comoAnon<Pagina>("listar_acciones_publicas()");
      expect(r.total).toBe(4);
      const nombres = r.datos.map((a) => a.nombre);
      expect(nombres).not.toContain("[PRUEBA] Acción inactiva");
      const deInactiva = r.datos.find((a) => a.nombre === "[PRUEBA] Acción de org inactiva");
      expect(deInactiva?.organizacion).toBeNull();
    });

    it("filtra por tipo y por punto", async () => {
      expect((await comoAnon<Pagina>("listar_acciones_publicas('firma')")).total).toBe(1);
      const delPunto = await comoAnon<Pagina>("listar_acciones_publicas(null, $1)", [ids["publicado en el centro"]]);
      expect(delPunto.datos.map((a) => a.nombre)).toEqual(["[PRUEBA] Acción de org inactiva"]);
    });
  });

  describe("listar_organizaciones_publicas", () => {
    it("solo activas y nunca con contacto", async () => {
      const r = await comoAnon<Pagina>("listar_organizaciones_publicas()");
      expect(r.total).toBe(2);
      expect(JSON.stringify(r)).not.toMatch(/contacto|secreto|Inactiva/);
    });

    it("filtra por zona sin distinguir mayúsculas", async () => {
      const r = await comoAnon<Pagina>("listar_organizaciones_publicas('tlaque')");
      expect(r.datos.map((o) => o.zona)).toEqual(["Tlaquepaque"]);
    });
  });

  describe("permisos de ejecución", () => {
    const FUNCIONES = [
      "listar_puntos_publicos(text,integer,integer,integer)",
      "obtener_punto_publico(uuid)",
      "puntos_cercanos(double precision,double precision,integer,text)",
      "puntos_cercanos_publicos(double precision,double precision,integer,text,integer)",
      "listar_acciones_publicas(text,uuid,integer,integer)",
      "listar_organizaciones_publicas(text,integer,integer)",
    ];

    it("anon, authenticated y service_role pueden ejecutarlas; PUBLIC no (D-17)", async () => {
      const { rows } = await cliente().query<{ funcion: string; anon: boolean; autenticado: boolean; servicio: boolean; publico: boolean }>(
        `select f as funcion,
                has_function_privilege('anon', f, 'execute') as anon,
                has_function_privilege('authenticated', f, 'execute') as autenticado,
                has_function_privilege('service_role', f, 'execute') as servicio,
                exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                        where p.oid = f::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE') as publico
         from unnest($1::text[]) as f`,
        [FUNCIONES],
      );
      expect(rows).toHaveLength(FUNCIONES.length);
      for (const r of rows) {
        expect(r, r.funcion).toMatchObject({ anon: true, autenticado: true, servicio: true, publico: false });
      }
    });
  });
});
