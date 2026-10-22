import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BaseDePruebas, comoRol, crearBaseDePruebas } from "../ayudas/base-de-pruebas.js";

const SIN_PERMISO = { code: "42501" }; // insufficient_privilege (permiso de tabla o violación de RLS)

describe.skipIf(!process.env.TEST_DATABASE_URL)("permisos por rol (RLS en la base, no solo en el código)", () => {
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

  const id = {
    ana: randomUUID(), // ciudadana
    beto: randomUUID(), // ciudadano
    moderador: randomUUID(),
    editor: randomUUID(),
    administrador: randomUUID(),
    inactivo: randomUUID(),
  };
  let aporteDeAna = "";
  let puntoEnRevision = "";
  let aporteDeBetoPendiente = "";

  beforeAll(async () => {
    base = await crearBaseDePruebas();
    c = new pg.Client({ connectionString: baseDePruebas().url });
    await cliente().connect();

    const usuarios: Array<[keyof typeof id, string]> = [
      ["ana", "ciudadano"],
      ["beto", "ciudadano"],
      ["moderador", "moderador"],
      ["editor", "editor"],
      ["administrador", "administrador"],
      ["inactivo", "ciudadano"],
    ];
    for (const [clave, rol] of usuarios) {
      await cliente().query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [
        id[clave],
        `${clave}@prueba.invalid`,
        { nombre: clave },
      ]);
      if (rol !== "ciudadano") {
        await cliente().query("update perfiles set rol = $2 where id = $1", [id[clave], rol]);
      }
    }
    await cliente().query("update perfiles set activo = false where id = $1", [id.inactivo]);

    const ubicacion = "st_setsrid(st_makepoint(-103.35, 20.67), 4326)::geography";
    const a = await cliente().query<{ id: string }>(
      `insert into aportes (tipo, descripcion, ubicacion, autor_id)
       values ('residuos', '[PRUEBA] aporte de Ana', ${ubicacion}, $1) returning id`,
      [id.ana],
    );
    aporteDeAna = a.rows[0]?.id ?? "";
    const b = await cliente().query<{ id: string }>(
      `insert into aportes (tipo, descripcion, ubicacion, autor_id)
       values ('residuos', '[PRUEBA] aporte pendiente de Beto', ${ubicacion}, $1) returning id`,
      [id.beto],
    );
    aporteDeBetoPendiente = b.rows[0]?.id ?? "";
    const p = await cliente().query<{ id: string }>(
      `insert into puntos (titulo, tipo, gravedad, descripcion, ubicacion, estado)
       values ('[PRUEBA] punto en revisión', 'otro', 2, 'Dato de prueba.', ${ubicacion}, 'en_revision') returning id`,
    );
    puntoEnRevision = p.rows[0]?.id ?? "";

    await cliente().query(
      "insert into auditoria (accion, tabla, detalle) values ('alta', 'puntos', '{\"resumen\":\"prueba\"}')",
    );
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await base?.limpiar();
  });

  describe("público (anon)", () => {
    it("solo ve puntos publicados", async () => {
      const { rows } = await comoRol(cliente(), "anon", null, () => cliente().query<{ estado: string }>("select estado from puntos"));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.estado === "publicado")).toBe(true);
    });

    it("no ve un punto en revisión aunque conozca su id", async () => {
      const { rows } = await comoRol(cliente(), "anon", null, () =>
        cliente().query("select id from puntos where id = $1", [puntoEnRevision]),
      );
      expect(rows).toHaveLength(0);
    });

    it("no puede leer aportes", async () => {
      await expect(comoRol(cliente(), "anon", null, () => cliente().query("select id from aportes"))).rejects.toMatchObject(SIN_PERMISO);
    });

    it("no puede leer perfiles, auditoría ni conversaciones del agente", async () => {
      for (const tabla of ["perfiles", "auditoria", "conversaciones_agente"]) {
        await expect(comoRol(cliente(), "anon", null, () => cliente().query(`select 1 from ${tabla}`))).rejects.toMatchObject(
          SIN_PERMISO,
        );
      }
    });

    it("no ve el contacto interno de las organizaciones", async () => {
      await expect(
        comoRol(cliente(), "anon", null, () => cliente().query("select contacto from organizaciones")),
      ).rejects.toMatchObject(SIN_PERMISO);
    });

    it("ve organizaciones activas sin datos internos", async () => {
      const { rows } = await comoRol(cliente(), "anon", null, () =>
        cliente().query<{ nombre: string }>("select nombre, zona from organizaciones"),
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it("no puede crear puntos", async () => {
      await expect(
        comoRol(cliente(), "anon", null, () =>
          cliente().query(
            `insert into puntos (titulo, tipo, gravedad, descripcion, ubicacion)
             values ('[PRUEBA] intento anónimo', 'otro', 1, 'x', st_setsrid(st_makepoint(-103.3, 20.6), 4326)::geography)`,
          ),
        ),
      ).rejects.toMatchObject(SIN_PERMISO);
    });
  });

  describe("ciudadano", () => {
    it("crea un aporte propio, siempre pendiente", async () => {
      const { rows } = await comoRol(cliente(), "authenticated", id.beto, () =>
        cliente().query<{ estado: string }>(
          `insert into aportes (tipo, descripcion, ubicacion, autor_id)
           values ('tala_ilegal', '[PRUEBA] aporte nuevo', st_setsrid(st_makepoint(-103.3, 20.6), 4326)::geography, $1)
           returning estado`,
          [id.beto],
        ),
      );
      expect(rows[0]?.estado).toBe("pendiente");
    });

    it("no puede crear un aporte a nombre de otra persona", async () => {
      await expect(
        comoRol(cliente(), "authenticated", id.beto, () =>
          cliente().query(
            `insert into aportes (tipo, descripcion, ubicacion, autor_id)
             values ('residuos', 'x', st_setsrid(st_makepoint(-103.3, 20.6), 4326)::geography, $1)`,
            [id.ana],
          ),
        ),
      ).rejects.toMatchObject(SIN_PERMISO);
    });

    it("no puede crear un aporte ya aprobado", async () => {
      await expect(
        comoRol(cliente(), "authenticated", id.beto, () =>
          cliente().query(
            `insert into aportes (tipo, descripcion, ubicacion, autor_id, estado)
             values ('residuos', 'x', st_setsrid(st_makepoint(-103.3, 20.6), 4326)::geography, $1, 'aprobado')`,
            [id.beto],
          ),
        ),
      ).rejects.toMatchObject(SIN_PERMISO);
    });

    it("no ve aportes de otra persona", async () => {
      const { rows } = await comoRol(cliente(), "authenticated", id.beto, () =>
        cliente().query("select id from aportes where id = $1", [aporteDeAna]),
      );
      expect(rows).toHaveLength(0);
    });

    it("no puede aprobar su propio aporte", async () => {
      const { rowCount } = await comoRol(cliente(), "authenticated", id.ana, () =>
        cliente().query("update aportes set estado = 'aprobado' where id = $1", [aporteDeAna]),
      );
      expect(rowCount).toBe(0);
    });

    it("no puede cambiar su propio rol", async () => {
      const rol = await comoRol(cliente(), "authenticated", id.ana, async () => {
        const upd = await cliente().query("update perfiles set rol = 'administrador' where id = $1", [id.ana]);
        expect(upd.rowCount).toBe(0);
        const { rows } = await cliente().query<{ rol: string }>("select rol from perfiles where id = $1", [id.ana]);
        return rows[0]?.rol;
      });
      expect(rol).toBe("ciudadano");
    });

    it("no ve la auditoría", async () => {
      const { rows } = await comoRol(cliente(), "authenticated", id.ana, () => cliente().query("select id from auditoria"));
      expect(rows).toHaveLength(0);
    });
  });

  describe("moderador", () => {
    it("lee aportes pendientes", async () => {
      const { rows } = await comoRol(cliente(), "authenticated", id.moderador, () =>
        cliente().query("select id from aportes where id = $1", [aporteDeBetoPendiente]),
      );
      expect(rows).toHaveLength(1);
    });

    it("aprueba un aporte pendiente", async () => {
      const { rowCount } = await comoRol(cliente(), "authenticated", id.moderador, () =>
        cliente().query(
          "update aportes set estado = 'aprobado', revisor_id = $2 where id = $1",
          [aporteDeBetoPendiente, id.moderador],
        ),
      );
      expect(rowCount).toBe(1);
    });

    it("crea un punto en revisión", async () => {
      const { rows } = await comoRol(cliente(), "authenticated", id.moderador, () =>
        cliente().query<{ id: string }>(
          `insert into puntos (titulo, tipo, gravedad, descripcion, ubicacion)
           values ('[PRUEBA] punto del moderador', 'residuos', 2, 'x', st_setsrid(st_makepoint(-103.3, 20.6), 4326)::geography)
           returning id`,
        ),
      );
      expect(rows).toHaveLength(1);
    });

    it("no puede crear un punto ya publicado", async () => {
      await expect(
        comoRol(cliente(), "authenticated", id.moderador, () =>
          cliente().query(
            `insert into puntos (titulo, tipo, gravedad, descripcion, ubicacion, estado)
             values ('[PRUEBA] publicado directo', 'residuos', 2, 'x', st_setsrid(st_makepoint(-103.3, 20.6), 4326)::geography, 'publicado')`,
          ),
        ),
      ).rejects.toMatchObject(SIN_PERMISO);
    });

    it("publica un punto en revisión", async () => {
      const { rowCount } = await comoRol(cliente(), "authenticated", id.moderador, () =>
        cliente().query("update puntos set estado = 'publicado', aprobado_por = $2 where id = $1", [puntoEnRevision, id.moderador]),
      );
      expect(rowCount).toBe(1);
    });

    it("no puede cambiar roles de otros usuarios", async () => {
      const { rowCount } = await comoRol(cliente(), "authenticated", id.moderador, () =>
        cliente().query("update perfiles set rol = 'editor' where id = $1", [id.beto]),
      );
      expect(rowCount).toBe(0);
    });
  });

  describe("editor", () => {
    it("no lee la cola de aportes", async () => {
      const { rows } = await comoRol(cliente(), "authenticated", id.editor, () => cliente().query("select id from aportes"));
      expect(rows).toHaveLength(0);
    });

    it("gestiona acciones", async () => {
      const { rowCount } = await comoRol(cliente(), "authenticated", id.editor, () =>
        cliente().query(
          "insert into acciones (tipo, nombre, enlace, activa) values ('firma', '[PRUEBA] acción de editor', 'https://ejemplo.org/x', true)",
        ),
      );
      expect(rowCount).toBe(1);
    });

    it("no puede crear puntos", async () => {
      await expect(
        comoRol(cliente(), "authenticated", id.editor, () =>
          cliente().query(
            `insert into puntos (titulo, tipo, gravedad, descripcion, ubicacion)
             values ('[PRUEBA] punto del editor', 'otro', 1, 'x', st_setsrid(st_makepoint(-103.3, 20.6), 4326)::geography)`,
          ),
        ),
      ).rejects.toMatchObject(SIN_PERMISO);
    });

    it("no puede cambiar roles", async () => {
      const { rowCount } = await comoRol(cliente(), "authenticated", id.editor, () =>
        cliente().query("update perfiles set rol = 'administrador' where id = $1", [id.beto]),
      );
      expect(rowCount).toBe(0);
    });
  });

  describe("administrador", () => {
    it("lee la auditoría", async () => {
      const { rows } = await comoRol(cliente(), "authenticated", id.administrador, () =>
        cliente().query("select id from auditoria"),
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    it("cambia el rol de otro usuario", async () => {
      const { rowCount } = await comoRol(cliente(), "authenticated", id.administrador, () =>
        cliente().query("update perfiles set rol = 'moderador' where id = $1", [id.beto]),
      );
      expect(rowCount).toBe(1);
    });

    it("no puede modificar la auditoría", async () => {
      await expect(
        comoRol(cliente(), "authenticated", id.administrador, () => cliente().query("update auditoria set accion = 'x'")),
      ).rejects.toMatchObject(SIN_PERMISO);
    });
  });

  describe("obtener_rol_actual", () => {
    it("devuelve null para un perfil desactivado", async () => {
      const { rows } = await comoRol(cliente(), "authenticated", id.inactivo, () =>
        cliente().query<{ rol: string | null }>("select obtener_rol_actual() as rol"),
      );
      expect(rows[0]?.rol).toBeNull();
    });
  });
});
