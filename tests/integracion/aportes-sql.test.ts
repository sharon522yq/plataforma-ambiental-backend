import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BaseDePruebas, crearBaseDePruebas } from "../ayudas/base-de-pruebas.js";

const CENTRO = { lat: 20.6597, lng: -103.3496 };
type Json = Record<string, unknown>;

/**
 * Funciones de la migración 008 con la sesión de cada rol, como las llama la API.
 * Cada llamada se confirma (commit), para que los pasos de un flujo se encadenen.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("aportes y moderación en la base (migración 008)", () => {
  let base: BaseDePruebas | undefined;
  let c: pg.Client | undefined;
  const cliente = (): pg.Client => {
    if (!c) throw new Error("Sin conexión de pruebas");
    return c;
  };
  const u = {
    ciudadanaA: randomUUID(),
    ciudadanoB: randomUUID(),
    moderadora: randomUUID(),
    moderadorAutor: randomUUID(),
    admin: randomUUID(),
  };

  /** Ejecuta una sentencia como el usuario uid (o anon si es null) y confirma. */
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

  /** Ejecuta `select <expresion>` como el usuario uid y devuelve el valor. */
  async function como<T = Json>(uid: string | null, expresion: string, valores: unknown[] = []): Promise<T> {
    const { rows } = await sentenciaComo(uid, `select ${expresion} as r`, valores);
    const fila = rows[0] as { r: T } | undefined;
    if (!fila) throw new Error("Sin resultado");
    return fila.r;
  }

  const nuevoAporte = (uid: string, descripcion = "Basura acumulada en la esquina", punto: string | null = null) =>
    como(uid, "crear_aporte('residuos', $1, $2, $3, 3, $4)", [descripcion, CENTRO.lat, CENTRO.lng, punto]);

  const auditoria = async (registro: string) =>
    (await cliente().query<{ accion: string; usuario_id: string | null; detalle: Json }>(
      "select accion, usuario_id, detalle from auditoria where registro_id = $1 order by creado_en, accion", [registro],
    )).rows;

  beforeAll(async () => {
    base = await crearBaseDePruebas();
    c = new pg.Client({ connectionString: base.url });
    await cliente().connect();
    for (const id of Object.values(u)) {
      await cliente().query("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@prueba.local`]);
    }
    await cliente().query("update perfiles set rol = 'moderador' where id = any($1)", [[u.moderadora, u.moderadorAutor]]);
    await cliente().query("update perfiles set rol = 'administrador' where id = $1", [u.admin]);
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await base?.limpiar();
  });

  describe("crear_aporte y mis_aportes", () => {
    it("crea el aporte pendiente a nombre de quien llama y lo audita", async () => {
      const a = await nuevoAporte(u.ciudadanaA);
      expect(a).toMatchObject({ estado: "pendiente", lat: CENTRO.lat, lng: CENTRO.lng, motivo_revision: null });
      const { rows } = await cliente().query<{ autor_id: string }>("select autor_id from aportes where id = $1", [a.id]);
      expect(rows[0]?.autor_id).toBe(u.ciudadanaA);
      expect(await auditoria(a.id as string)).toEqual([
        { accion: "aporte_creado", usuario_id: u.ciudadanaA, detalle: { estado: "pendiente", tipo: "residuos", punto_id: null } },
      ]);
    });

    it("un visitante sin sesión no puede ejecutar crear_aporte", async () => {
      await expect(nuevoAporte(null as unknown as string)).rejects.toMatchObject({ code: "42501" });
    });

    it("insertar directo en aportes con otro autor o ya aprobado lo bloquea RLS", async () => {
      for (const [autor, estado] of [[u.ciudadanoB, "pendiente"], [u.ciudadanaA, "aprobado"]] as const) {
        await expect(
          sentenciaComo(
            u.ciudadanaA,
            `insert into aportes (tipo, descripcion, ubicacion, autor_id, estado)
             values ('otro', 'x', st_setsrid(st_makepoint(0, 0), 4326)::geography, $1, $2)`,
            [autor, estado],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      }
    });

    it("cada ciudadano ve solo sus aportes", async () => {
      await nuevoAporte(u.ciudadanoB, "Aporte de B con más de diez letras");
      const deA = await como<{ total: number; datos: Json[] }>(u.ciudadanaA, "mis_aportes()");
      const deB = await como<{ total: number; datos: Json[] }>(u.ciudadanoB, "mis_aportes()");
      expect(deA.datos.every((x) => x.descripcion !== "Aporte de B con más de diez letras")).toBe(true);
      expect(deB.total).toBe(1);
      expect(Object.keys(deB.datos[0] ?? {})).not.toContain("autor_id");
    });
  });

  describe("cola y revisión", () => {
    it("un ciudadano no puede ver la cola ni revisar", async () => {
      await expect(como(u.ciudadanaA, "cola_aportes()")).rejects.toMatchObject({ code: "42501" });
      const a = await nuevoAporte(u.ciudadanoB);
      await expect(como(u.ciudadanaA, "revisar_aporte($1, 'rechazado', 'no')", [a.id])).rejects.toMatchObject({ code: "42501" });
    });

    it("la moderadora ve los pendientes con su autor", async () => {
      const cola = await como<{ total: number; datos: Json[] }>(u.moderadora, "cola_aportes()");
      expect(cola.total).toBeGreaterThanOrEqual(2);
      expect(cola.datos.every((x) => x.estado === "pendiente" && typeof x.autor_id === "string")).toBe(true);
    });

    it("rechazar exige motivo y no se puede revisar dos veces", async () => {
      const a = await nuevoAporte(u.ciudadanaA);
      await expect(como(u.moderadora, "revisar_aporte($1, 'rechazado')", [a.id])).rejects.toMatchObject({ code: "22023" });
      const r = await como(u.moderadora, "revisar_aporte($1, 'rechazado', 'No es un problema ambiental')", [a.id]);
      expect(r).toMatchObject({ estado: "rechazado", motivo_revision: "No es un problema ambiental", revisor_id: u.moderadora });
      await expect(como(u.moderadora, "revisar_aporte($1, 'rechazado', 'otra vez')", [a.id])).rejects.toMatchObject({ code: "55000" });
    });

    it("el autor no puede revisar su propio aporte, ni con la función ni con un UPDATE directo", async () => {
      const a = await nuevoAporte(u.moderadorAutor);
      await expect(como(u.moderadorAutor, "revisar_aporte($1, 'rechazado', 'mío')", [a.id])).rejects.toMatchObject({ code: "42501" });
      const r = await sentenciaComo(u.moderadorAutor, "update aportes set estado = 'aprobado' where id = $1", [a.id]);
      expect(r.rowCount).toBe(0);
    });

    it("aprobar un aporte nuevo crea el punto publicado y visible en el mapa", async () => {
      const a = await nuevoAporte(u.ciudadanaA, "Descarga de agua jabonosa en el canal");
      await expect(como(u.moderadora, "revisar_aporte($1, 'aprobado')", [a.id])).rejects.toMatchObject({ code: "22023" });
      const r = await como(u.moderadora, "revisar_aporte($1, 'aprobado', null, 'Descarga en el canal', 4)", [a.id]);
      expect(r).toMatchObject({ estado: "aprobado" });
      const publico = await como<Json | null>(null, "obtener_punto_publico($1)", [r.punto_id]);
      expect(publico).toMatchObject({ titulo: "Descarga en el canal", gravedad: 4, descripcion: "Descarga de agua jabonosa en el canal" });

      const { rows } = await cliente().query<{ autor_id: string; aprobado_por: string }>(
        "select autor_id, aprobado_por from puntos where id = $1", [r.punto_id],
      );
      expect(rows[0]).toEqual({ autor_id: u.ciudadanaA, aprobado_por: u.moderadora });

      expect((await auditoria(r.punto_id as string)).map((x) => x.accion)).toEqual(["punto_creado", "punto_estado_cambiado"]);
      const revision = (await auditoria(a.id as string)).find((x) => x.accion === "aporte_revisado");
      expect(revision).toMatchObject({ usuario_id: u.moderadora, detalle: { estado_anterior: "pendiente", estado_nuevo: "aprobado" } });
      expect(JSON.stringify(await auditoria(a.id as string))).not.toContain("jabonosa");
    });

    it("aprobar con publicar = false deja el punto en revisión, fuera del mapa", async () => {
      const a = await nuevoAporte(u.ciudadanaA);
      const r = await como(u.moderadora, "revisar_aporte($1, 'aprobado', null, 'Pendiente de verificar', null, false)", [a.id]);
      expect(await como(null, "obtener_punto_publico($1)", [r.punto_id])).toBeNull();
    });

    it("aprobar un aporte sobre un punto existente actualiza su gravedad sin crear otro", async () => {
      const { rows } = await cliente().query<{ id: string }>("select id from puntos where titulo like '[PRUEBA] Tala%'");
      const existente = rows[0]?.id ?? "";
      const antes = Number((await cliente().query<{ n: string }>("select count(*) n from puntos")).rows[0]?.n);
      const a = await nuevoAporte(u.ciudadanoB, "Siguen talando árboles en la zona", existente);
      const r = await como(u.moderadora, "revisar_aporte($1, 'aprobado', null, null, 5)", [a.id]);
      expect(r).toMatchObject({ estado: "aprobado", punto_id: existente });
      const despues = Number((await cliente().query<{ n: string }>("select count(*) n from puntos")).rows[0]?.n);
      expect(despues).toBe(antes);
      expect((await cliente().query<{ gravedad: number }>("select gravedad from puntos where id = $1", [existente])).rows[0]?.gravedad).toBe(5);
    });

    it("duplicado exige el punto original y lo enlaza", async () => {
      const { rows } = await cliente().query<{ id: string }>("select id from puntos where titulo like '[PRUEBA] Humo%'");
      const original = rows[0]?.id ?? "";
      const a = await nuevoAporte(u.ciudadanaA);
      await expect(como(u.moderadora, "revisar_aporte($1, 'duplicado')", [a.id])).rejects.toMatchObject({ code: "22023" });
      const r = await como(u.moderadora, "revisar_aporte($1, 'duplicado', null, null, null, false, $2)", [a.id, original]);
      expect(r).toMatchObject({ estado: "duplicado", punto_id: original });
    });

    it("un aporte que no existe responde P0002", async () => {
      await expect(como(u.moderadora, "revisar_aporte($1, 'rechazado', 'x')", [randomUUID()])).rejects.toMatchObject({ code: "P0002" });
    });
  });

  describe("crear_punto y cambiar_estado_punto", () => {
    const punto = (uid: string, estado: string) =>
      como(uid, "crear_punto('Quema de basura', 'residuos', 3, 'Humo negro', $1, $2, $3)", [CENTRO.lat, CENTRO.lng, estado]);

    it("la moderadora crea en revisión pero no publicado; el administrador sí", async () => {
      await expect(punto(u.moderadora, "en_revision")).resolves.toMatchObject({ estado: "en_revision" });
      await expect(punto(u.moderadora, "publicado")).rejects.toMatchObject({ code: "42501" });
      await expect(punto(u.admin, "publicado")).resolves.toMatchObject({ estado: "publicado" });
      await expect(punto(u.ciudadanaA, "en_revision")).rejects.toMatchObject({ code: "42501" });
    });

    it("la moderadora publica y archiva, pero no reabre un archivado; el administrador sí", async () => {
      const p = await punto(u.moderadora, "en_revision");
      await expect(como(u.moderadora, "cambiar_estado_punto($1, 'publicado')", [p.id])).resolves.toMatchObject({ estado: "publicado" });
      await expect(como(u.moderadora, "cambiar_estado_punto($1, 'archivado')", [p.id])).resolves.toMatchObject({ estado: "archivado" });
      await expect(como(u.moderadora, "cambiar_estado_punto($1, 'publicado')", [p.id])).rejects.toMatchObject({ code: "42501" });
      await expect(como(u.admin, "cambiar_estado_punto($1, 'publicado')", [p.id])).resolves.toMatchObject({ estado: "publicado" });
      expect((await auditoria(p.id as string)).map((x) => x.accion)).toEqual([
        "punto_creado", "punto_estado_cambiado", "punto_estado_cambiado", "punto_estado_cambiado",
      ]);
    });

    it("errores: punto inexistente, estado inválido y ciudadano sin permiso", async () => {
      await expect(como(u.moderadora, "cambiar_estado_punto($1, 'publicado')", [randomUUID()])).rejects.toMatchObject({ code: "P0002" });
      const p = await punto(u.moderadora, "en_revision");
      await expect(como(u.moderadora, "cambiar_estado_punto($1, 'borrado')", [p.id])).rejects.toMatchObject({ code: "22023" });
      await expect(como(u.ciudadanaA, "cambiar_estado_punto($1, 'publicado')", [p.id])).rejects.toMatchObject({ code: "42501" });
    });
  });

  describe("adjuntar_evidencia (migración 009)", () => {
    const rutaDe = (uid: string, aporte: unknown) => `${uid}/${String(aporte)}.jpg`;

    it("adjunta la foto al aporte propio y pendiente, una sola vez, y lo audita", async () => {
      const a = await nuevoAporte(u.ciudadanaA);
      expect(a.evidencia_ruta).toBeNull();
      const ruta = rutaDe(u.ciudadanaA, a.id);
      const r = await como(u.ciudadanaA, "adjuntar_evidencia($1, $2)", [a.id, ruta]);
      expect(r).toMatchObject({ id: a.id, evidencia_ruta: ruta, estado: "pendiente" });
      expect((await auditoria(a.id as string)).map((x) => x.accion)).toContain("evidencia_adjuntada");
      await expect(como(u.ciudadanaA, "adjuntar_evidencia($1, $2)", [a.id, ruta])).rejects.toMatchObject({
        code: "55000", message: "El aporte ya tiene evidencia",
      });
      const mis = await como<{ datos: Json[] }>(u.ciudadanaA, "mis_aportes()");
      expect(mis.datos.find((x) => x.id === a.id)?.evidencia_ruta).toBe(ruta);
    });

    it("rechaza una ruta fuera de la carpeta del usuario o de otro aporte", async () => {
      const a = await nuevoAporte(u.ciudadanaA);
      for (const ruta of [rutaDe(u.ciudadanoB, a.id), rutaDe(u.ciudadanaA, randomUUID()), `${u.ciudadanaA}/../${String(a.id)}.jpg`, ""]) {
        await expect(como(u.ciudadanaA, "adjuntar_evidencia($1, $2)", [a.id, ruta])).rejects.toMatchObject({ code: "22023" });
      }
    });

    it("no deja adjuntar a un aporte ajeno ni a uno ya revisado", async () => {
      const ajeno = await nuevoAporte(u.ciudadanoB);
      await expect(como(u.ciudadanaA, "adjuntar_evidencia($1, $2)", [ajeno.id, rutaDe(u.ciudadanaA, ajeno.id)])).rejects.toMatchObject({ code: "P0002" });
      const a = await nuevoAporte(u.ciudadanaA);
      await como(u.moderadora, "revisar_aporte($1, 'rechazado', 'No es ambiental')", [a.id]);
      await expect(como(u.ciudadanaA, "adjuntar_evidencia($1, $2)", [a.id, rutaDe(u.ciudadanaA, a.id)])).rejects.toMatchObject({ code: "55000" });
      const { rows } = await cliente().query<{ e: string | null }>("select evidencia_url e from aportes where id = any($1)", [[ajeno.id, a.id]]);
      expect(rows.every((x) => x.e === null)).toBe(true);
    });

    it("solo cambia la evidencia: descripción, ubicación y estado quedan igual", async () => {
      const a = await nuevoAporte(u.ciudadanaA);
      const r = await como(u.ciudadanaA, "adjuntar_evidencia($1, $2)", [a.id, rutaDe(u.ciudadanaA, a.id)]);
      expect(r).toMatchObject({ descripcion: a.descripcion, lat: a.lat, lng: a.lng, estado: "pendiente", punto_id: null });
    });

    it("la moderación ve la ruta en la cola", async () => {
      const a = await nuevoAporte(u.ciudadanoB);
      await como(u.ciudadanoB, "adjuntar_evidencia($1, $2)", [a.id, rutaDe(u.ciudadanoB, a.id)]);
      const cola = await como<{ datos: Json[] }>(u.moderadora, "cola_aportes('pendiente', 100, 0)");
      expect(cola.datos.find((x) => x.id === a.id)?.evidencia_ruta).toBe(rutaDe(u.ciudadanoB, a.id));
    });
  });

  describe("permisos de ejecución", () => {
    it("solo authenticated y service_role ejecutan las funciones; nadie llama los triggers", async () => {
      const funciones = [
        "crear_aporte(text,text,double precision,double precision,integer,uuid)",
        "mis_aportes(integer,integer)",
        "cola_aportes(text,integer,integer)",
        "revisar_aporte(uuid,text,text,text,integer,boolean,uuid)",
        "crear_punto(text,text,integer,text,double precision,double precision,text)",
        "cambiar_estado_punto(uuid,text)",
        "adjuntar_evidencia(uuid,text)",
      ];
      const { rows } = await cliente().query<{ f: string; anon: boolean; autenticado: boolean; servicio: boolean }>(
        `select f, has_function_privilege('anon', f, 'execute') anon,
                has_function_privilege('authenticated', f, 'execute') autenticado,
                has_function_privilege('service_role', f, 'execute') servicio
         from unnest($1::text[]) f`,
        [funciones],
      );
      for (const r of rows) expect(r, r.f).toMatchObject({ anon: false, autenticado: true, servicio: true });
      const triggers = await cliente().query<{ x: boolean }>(
        "select has_function_privilege('authenticated', 'auditar_aportes()', 'execute') or has_function_privilege('authenticated', 'auditar_puntos()', 'execute') as x",
      );
      expect(triggers.rows[0]?.x).toBe(false);
    });

    it("la auditoría sigue siendo inmutable", async () => {
      await expect(cliente().query("update auditoria set accion = 'x'")).rejects.toMatchObject({ code: "P0001" });
    });
  });
});
