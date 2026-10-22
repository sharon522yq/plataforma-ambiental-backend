import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BaseDePruebas, crearBaseDePruebas } from "../ayudas/base-de-pruebas.js";

type Json = Record<string, unknown>;
type Pagina = { total: number; datos: Json[] };

/** Funciones y triggers de la migración 010 con la sesión de cada rol. Cada llamada se confirma. */
describe.skipIf(!process.env.TEST_DATABASE_URL)("administración en la base (migración 010)", () => {
  let base: BaseDePruebas | undefined;
  let c: pg.Client | undefined;
  const cliente = (): pg.Client => {
    if (!c) throw new Error("Sin conexión de pruebas");
    return c;
  };
  const u = { ciudadana: randomUUID(), moderador: randomUUID(), editora: randomUUID(), admin: randomUUID(), admin2: randomUUID() };

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
  const auditoria = async (registro: unknown) =>
    (await cliente().query<{ accion: string; usuario_id: string | null; detalle: Json }>(
      "select accion, usuario_id, detalle from auditoria where registro_id = $1 order by creado_en, accion", [registro],
    )).rows;
  const nuevaAccion = (uid: string, extra = "null, null, null, null") => como(uid, `crear_accion('firma', 'Firma por el río', ${extra})`);

  beforeAll(async () => {
    base = await crearBaseDePruebas();
    c = new pg.Client({ connectionString: base.url });
    await cliente().connect();
    for (const [nombre, id] of Object.entries(u)) {
      await cliente().query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, `${nombre}@prueba.local`, { nombre }]);
    }
    await cliente().query("update perfiles set telefono = '3312345678'");
    await cliente().query("update perfiles set rol = 'moderador' where id = $1", [u.moderador]);
    await cliente().query("update perfiles set rol = 'editor' where id = $1", [u.editora]);
    await cliente().query("update perfiles set rol = 'administrador' where id = any($1)", [[u.admin, u.admin2]]);
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await base?.limpiar();
  });

  describe("acciones", () => {
    it("la editora crea una acción y queda exactamente un registro de auditoría", async () => {
      const a = await nuevaAccion(u.editora, "'Detalle', 'https://ejemplo.org/f', null, null");
      expect(a).toMatchObject({ tipo: "firma", enlace: "https://ejemplo.org/f", activa: true });
      expect(await auditoria(a.id)).toEqual([{ accion: "accion_creada", usuario_id: u.editora, detalle: { tipo: "firma", activa: true } }]);
    });

    it("ciudadana y moderador no pueden crear acciones", async () => {
      for (const uid of [u.ciudadana, u.moderador]) await expect(nuevaAccion(uid)).rejects.toMatchObject({ code: "42501" });
      await expect(como(null, "crear_accion('firma', 'x')")).rejects.toMatchObject({ code: "42501" });
    });

    it("el enlace debe ser https, también insertando directo en la tabla", async () => {
      await expect(nuevaAccion(u.editora, "null, 'http://ejemplo.org', null, null")).rejects.toMatchObject({ code: "22023" });
      await expect(
        sentenciaComo(u.editora, "insert into acciones (tipo, nombre, enlace) values ('firma', 'x', 'javascript:alert(1)')"),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("no se cuelga de un punto sin publicar ni de una organización inactiva", async () => {
      const { rows: [punto] } = await cliente().query<{ id: string }>(
        "insert into puntos (titulo, tipo, gravedad, descripcion, ubicacion) values ('Oculto', 'otro', 1, 'x', st_setsrid(st_makepoint(0,0),4326)::geography) returning id",
      );
      const { rows: [org] } = await cliente().query<{ id: string }>("insert into organizaciones (nombre, activa) values ('Inactiva', false) returning id");
      await expect(nuevaAccion(u.editora, `null, null, null, '${String(punto?.id)}'`)).rejects.toMatchObject({ code: "22023" });
      await expect(nuevaAccion(u.editora, `null, null, '${String(org?.id)}', null`)).rejects.toMatchObject({ code: "22023" });
    });

    it("editar y borrar también se auditan, con las columnas cambiadas y sin textos", async () => {
      const a = await nuevaAccion(u.editora);
      await sentenciaComo(u.editora, "update acciones set activa = false, descripcion = 'texto secreto' where id = $1", [a.id]);
      await sentenciaComo(u.admin, "delete from acciones where id = $1", [a.id]);
      const registros = await auditoria(a.id);
      expect(registros.map((r) => r.accion)).toEqual(["accion_creada", "accion_actualizada", "accion_eliminada"]);
      expect(registros[1]?.detalle).toEqual({ columnas: ["activa", "descripcion"] });
      expect(JSON.stringify(registros)).not.toContain("texto secreto");
    });
  });

  describe("organizaciones", () => {
    it("la editora crea una organización a su nombre, con un solo registro de auditoría", async () => {
      const o = await como(u.editora, "crear_organizacion('Colectivo Río Vivo', 'tel interno', 'Zapopan')");
      expect(o).toMatchObject({ contacto: "tel interno", creado_por: u.editora, activa: true });
      expect(await auditoria(o.id)).toEqual([{ accion: "organizacion_creada", usuario_id: u.editora, detalle: { activa: true } }]);
      await expect(como(u.moderador, "crear_organizacion('Otra organización')")).rejects.toMatchObject({ code: "42501" });
    });
  });

  describe("usuarios", () => {
    it("el administrador lista con correo y sin teléfono", async () => {
      const r = await como<Pagina>(u.admin, "listar_usuarios(null, null, 100, 0)");
      expect(r.total).toBe(5);
      expect(r.datos.find((x) => x.id === u.editora)).toEqual(expect.objectContaining({ email: "editora@prueba.local", rol: "editor", nombre: "editora" }));
      expect(JSON.stringify(r)).not.toMatch(/telefono|3312345678/);
    });

    it("filtra por rol y busca por nombre o correo; % y _ se toman como texto", async () => {
      expect((await como<Pagina>(u.admin, "listar_usuarios('administrador')")).total).toBe(2);
      expect((await como<Pagina>(u.admin, "listar_usuarios(null, 'EDITORA@')")).total).toBe(1);
      expect((await como<Pagina>(u.admin, "listar_usuarios(null, '%')")).total).toBe(0);
      expect((await como<Pagina>(u.admin, "listar_usuarios(null, '_')")).total).toBe(0);
    });

    it("nadie más puede listar usuarios", async () => {
      for (const uid of [u.ciudadana, u.moderador, u.editora]) {
        await expect(como(uid, "listar_usuarios()")).rejects.toMatchObject({ code: "42501" });
      }
      await expect(como(null, "listar_usuarios()")).rejects.toMatchObject({ code: "42501" });
    });
  });

  describe("cambiar_rol", () => {
    it("cambia el rol, aplica en la siguiente consulta y deja un solo registro", async () => {
      const r = await como(u.admin, "cambiar_rol($1, 'moderador')", [u.ciudadana]);
      expect(r).toMatchObject({ id: u.ciudadana, rol: "moderador" });
      expect(await como<string>(u.ciudadana, "obtener_rol_actual()")).toBe("moderador");
      await como(u.admin, "cambiar_rol($1, 'moderador')", [u.ciudadana]); // mismo rol: sin cambio
      expect(await auditoria(u.ciudadana)).toEqual([
        { accion: "rol_cambiado", usuario_id: u.admin, detalle: { rol_anterior: "ciudadano", rol_nuevo: "moderador" } },
      ]);
      await como(u.admin, "cambiar_rol($1, 'ciudadano')", [u.ciudadana]);
    });

    it("un administrador no puede cambiar su propio rol ni desactivarse, ni por la tabla", async () => {
      await expect(como(u.admin, "cambiar_rol($1, 'ciudadano')", [u.admin])).rejects.toMatchObject({ code: "42501" });
      await expect(sentenciaComo(u.admin, "update perfiles set rol = 'ciudadano' where id = $1", [u.admin])).rejects.toMatchObject({ code: "42501" });
      await expect(sentenciaComo(u.admin, "update perfiles set activo = false where id = $1", [u.admin])).rejects.toMatchObject({ code: "42501" });
      expect(await como<string>(u.admin, "obtener_rol_actual()")).toBe("administrador");
    });

    it("otro administrador sí puede cambiarlo, y desactivar queda auditado", async () => {
      await como(u.admin2, "cambiar_rol($1, 'editor')", [u.admin]);
      await sentenciaComo(u.admin2, "update perfiles set activo = false where id = $1", [u.admin]);
      await cliente().query("update perfiles set rol = 'administrador', activo = true where id = $1", [u.admin]);
      const registros = await auditoria(u.admin);
      expect(registros.filter((x) => x.usuario_id === u.admin2).map((x) => x.accion)).toEqual(["rol_cambiado", "usuario_desactivado"]);
      // Los cambios sin sesión (llave de servicio o consola) también quedan, sin usuario.
      expect(registros.filter((x) => x.usuario_id === null).map((x) => x.detalle)).toContainEqual({ rol_anterior: "ciudadano", rol_nuevo: "administrador" });
    });

    it("errores: rol inválido, usuario inexistente y sin permiso", async () => {
      await expect(como(u.admin, "cambiar_rol($1, 'jefe')", [u.ciudadana])).rejects.toMatchObject({ code: "22023" });
      await expect(como(u.admin, "cambiar_rol($1, 'editor')", [randomUUID()])).rejects.toMatchObject({ code: "P0002" });
      await expect(como(u.editora, "cambiar_rol($1, 'administrador')", [u.ciudadana])).rejects.toMatchObject({ code: "42501" });
    });

    it("un no administrador que actualiza perfiles directo no cambia nada (RLS)", async () => {
      const r = await sentenciaComo(u.editora, "update perfiles set rol = 'administrador' where id = $1", [u.ciudadana]);
      expect(r.rowCount).toBe(0);
      const propio = await sentenciaComo(u.editora, "update perfiles set rol = 'administrador' where id = $1", [u.editora]);
      expect(propio.rowCount).toBe(0);
    });
  });

  describe("listar_auditoria", () => {
    it("el administrador ve lo más reciente primero y filtra", async () => {
      const r = await como<Pagina>(u.admin, "listar_auditoria('perfiles', 'rol_cambiado')");
      expect(r.total).toBeGreaterThan(0);
      expect(r.datos.every((x) => x.tabla === "perfiles" && x.accion === "rol_cambiado")).toBe(true);
      const fechas = r.datos.map((x) => String(x.creado_en));
      expect([...fechas].sort().reverse()).toEqual(fechas);
      const futuro = await como<Pagina>(u.admin, "listar_auditoria(desde => now() + interval '1 day')");
      expect(futuro.total).toBe(0);
    });

    it("nadie más la ve, y las fechas invertidas son un 22023", async () => {
      for (const uid of [u.ciudadana, u.moderador, u.editora]) {
        await expect(como(uid, "listar_auditoria()")).rejects.toMatchObject({ code: "42501" });
      }
      await expect(como(u.admin, "listar_auditoria(desde => now(), hasta => now() - interval '1 day')")).rejects.toMatchObject({ code: "22023" });
    });
  });

  describe("permisos de ejecución", () => {
    it("solo authenticated y service_role ejecutan las funciones; nadie llama los triggers", async () => {
      const funciones = [
        "crear_accion(text,text,text,text,uuid,uuid)",
        "crear_organizacion(text,text,text)",
        "listar_usuarios(text,text,integer,integer)",
        "cambiar_rol(uuid,text)",
        "listar_auditoria(text,text,uuid,uuid,timestamptz,timestamptz,integer,integer)",
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
        `select bool_or(has_function_privilege('authenticated', f, 'execute')) as x
         from unnest(array['auditar_perfiles()', 'auditar_catalogo()', 'proteger_perfil_propio()']) f`,
      );
      expect(triggers.rows[0]?.x).toBe(false);
    });
  });
});
