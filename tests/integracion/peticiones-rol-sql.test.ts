import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BaseDePruebas, crearBaseDePruebas } from "../ayudas/base-de-pruebas.js";

type Json = Record<string, unknown>;
type Peticion = { id: string; estado: string; rol_actual: string; rol_pedido: string; motivo: string; zona: string | null; respuesta: string | null } & Json;

const MOTIVO = "Coordino las brigadas de limpieza del río en mi colonia";

/**
 * Migración 015: peticiones de rol que inicia la propia persona (D-45). Cada llamada es una
 * transacción aparte, como una petición real a la API.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("peticiones de rol en la base (migración 015)", () => {
  let base: BaseDePruebas | undefined;
  let c: pg.Client | undefined;
  const cliente = (): pg.Client => {
    if (!c) throw new Error("Sin conexión de pruebas");
    return c;
  };
  const u = {
    admin: randomUUID(), admin2: randomUUID(), ana: randomUUID(), beto: randomUUID(),
    carla: randomUUID(), dani: randomUUID(), eva: randomUUID(), inactiva: randomUUID(),
  };

  async function sentenciaComo(uid: string | null, sql: string, valores: unknown[] = [], rolBd?: string): Promise<pg.QueryResult> {
    await cliente().query("begin");
    try {
      if (uid) await cliente().query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
      await cliente().query(`set local role ${rolBd ?? (uid ? "authenticated" : "anon")}`);
      const resultado = await cliente().query(sql, valores);
      await cliente().query("commit");
      return resultado;
    } catch (error) {
      await cliente().query("rollback");
      throw error;
    }
  }
  async function como<T = Json>(uid: string | null, expresion: string, valores: unknown[] = [], rolBd?: string): Promise<T> {
    const { rows } = await sentenciaComo(uid, `select ${expresion} as r`, valores, rolBd);
    const fila = rows[0] as { r: T } | undefined;
    if (!fila) throw new Error("Sin resultado");
    return fila.r;
  }
  const rol = async (id: string) => (await cliente().query<{ rol: string }>("select rol from perfiles where id = $1", [id])).rows[0]?.rol;
  const pedir = (quien: string, r: string, motivo: string = MOTIVO, zona: string | null = null) =>
    como<Peticion>(quien, "pedir_rol($1, $2, $3)", [r, motivo, zona]);
  const resolver = (quien: string, id: string, aprobar: boolean, respuesta: string | null = null) =>
    como<Peticion>(quien, "resolver_peticion_rol($1, $2, $3)", [id, aprobar, respuesta]);
  const auditoria = async (registro: string) =>
    (await cliente().query<{ accion: string; usuario_id: string | null; detalle: Json }>(
      "select accion, usuario_id, detalle from auditoria where registro_id = $1 order by creado_en, accion", [registro],
    )).rows;

  beforeAll(async () => {
    base = await crearBaseDePruebas();
    c = new pg.Client({ connectionString: base.url });
    await cliente().connect();
    for (const [nombre, id] of Object.entries(u)) {
      await cliente().query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, `${nombre}@prueba.local`, { nombre }]);
    }
    await cliente().query("update perfiles set rol = 'administrador' where id = any($1)", [[u.admin, u.admin2]]);
    await cliente().query("update perfiles set rol = 'editor' where id = $1", [u.eva]);
    await cliente().query("update perfiles set activo = false where id = $1", [u.inactiva]);
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await base?.limpiar();
  });

  describe("pedir", () => {
    it("crea la petición pendiente con el rol actual, el motivo y la zona limpios", async () => {
      const p = await pedir(u.ana, "moderador", `  ${MOTIVO}  `, "  Atlixco  ");
      expect(p).toMatchObject({ estado: "pendiente", rol_actual: "ciudadano", rol_pedido: "moderador", motivo: MOTIVO, zona: "Atlixco", respuesta: null });
      expect(p).not.toHaveProperty("usuario");
      expect(await rol(u.ana)).toBe("ciudadano");
    });

    it("audita el pedido sin el motivo ni la zona", async () => {
      const [p] = await como<Peticion[]>(u.ana, "mis_peticiones_rol()");
      const registros = await auditoria(p?.id ?? "");
      expect(registros).toEqual([
        { accion: "rol_pedido", usuario_id: u.ana, detalle: { usuario_id: u.ana, rol_actual: "ciudadano", rol_pedido: "moderador" } },
      ]);
      expect(JSON.stringify(registros)).not.toContain("Atlixco");
    });

    it("solo una pendiente a la vez", async () => {
      await expect(pedir(u.ana, "editor")).rejects.toMatchObject({ code: "55000", message: "Ya tienes una petición pendiente" });
    });

    it.each([
      ["administrador", MOTIVO, null, "Solo se puede pedir el rol de moderador o de editor"],
      ["ciudadano", MOTIVO, null, "Solo se puede pedir el rol de moderador o de editor"],
      ["editor", "muy corto", null, "Explica el motivo en 20 a 1000 caracteres"],
      ["editor", "x".repeat(1001), null, "Explica el motivo en 20 a 1000 caracteres"],
      ["editor", `   ${"a".repeat(5)}               `, null, "Explica el motivo en 20 a 1000 caracteres"],
      ["editor", MOTIVO, "z".repeat(201), "La zona o colectivo debe tener de 2 a 200 caracteres"],
      ["editor", MOTIVO, "z", "La zona o colectivo debe tener de 2 a 200 caracteres"],
    ])("rechaza rol %s / motivo o zona inválidos", async (r, motivo, zona, mensaje) => {
      await expect(pedir(u.beto, r, motivo, zona)).rejects.toMatchObject({ code: "22023", message: mensaje });
    });

    it("una zona vacía cuenta como sin zona", async () => {
      const p = await pedir(u.dani, "editor", MOTIVO, "   ");
      expect(p.zona).toBeNull();
      await como(u.dani, "cancelar_peticion_rol($1)", [p.id]);
    });

    it("no se pide el rol que ya se tiene, ni nada siendo administrador", async () => {
      await expect(pedir(u.eva, "editor")).rejects.toMatchObject({ code: "22023", message: "Ya tienes ese rol" });
      await expect(pedir(u.admin, "moderador")).rejects.toMatchObject({ code: "22023", message: "Ya eres administrador" });
    });

    it("una editora sí puede pedir ser moderadora", async () => {
      const p = await pedir(u.eva, "moderador");
      expect(p).toMatchObject({ rol_actual: "editor", rol_pedido: "moderador" });
    });

    it("exige una cuenta activa con sesión", async () => {
      await expect(pedir(u.inactiva, "editor")).rejects.toMatchObject({ code: "42501" });
      await expect(sentenciaComo(null, "select pedir_rol('editor', $1)", [MOTIVO])).rejects.toMatchObject({ code: "42501" });
    });
  });

  describe("mis peticiones y cancelar", () => {
    it("cada persona ve solo las suyas", async () => {
      const deAna = await como<Peticion[]>(u.ana, "mis_peticiones_rol()");
      expect(deAna).toHaveLength(1);
      expect(await como<Peticion[]>(u.beto, "mis_peticiones_rol()")).toEqual([]);
    });

    it("nadie cancela la petición de otra persona, y el error no revela si existe", async () => {
      const [p] = await como<Peticion[]>(u.ana, "mis_peticiones_rol()");
      const ajena = como(u.beto, "cancelar_peticion_rol($1)", [p?.id]);
      await expect(ajena).rejects.toMatchObject({ code: "P0002", message: "No tienes una petición pendiente con ese id" });
      const inexistente = como(u.beto, "cancelar_peticion_rol($1)", [randomUUID()]);
      await expect(inexistente).rejects.toMatchObject({ code: "P0002", message: "No tienes una petición pendiente con ese id" });
    });

    it("cancelar la propia la cierra, la audita y permite pedir de nuevo", async () => {
      const p = await pedir(u.carla, "editor");
      const cancelada = await como<Peticion>(u.carla, "cancelar_peticion_rol($1)", [p.id]);
      expect(cancelada).toMatchObject({ estado: "cancelada" });
      expect((await auditoria(p.id)).map((r) => r.accion).sort()).toEqual(["peticion_cancelada", "rol_pedido"]);
      await expect(como(u.carla, "cancelar_peticion_rol($1)", [p.id])).rejects.toMatchObject({ code: "P0002" });
      const otra = await pedir(u.carla, "editor");
      expect(otra.estado).toBe("pendiente");
    });
  });

  describe("administración", () => {
    it("solo un administrador lista y resuelve", async () => {
      await expect(como(u.beto, "listar_peticiones_rol()")).rejects.toMatchObject({ code: "42501" });
      await expect(como(u.eva, "listar_peticiones_rol()")).rejects.toMatchObject({ code: "42501" });
      const [p] = await como<Peticion[]>(u.ana, "mis_peticiones_rol()");
      await expect(resolver(u.eva, p?.id ?? "", true)).rejects.toMatchObject({ code: "42501" });
    });

    it("la lista trae pendientes primero, con el nombre pero sin correo", async () => {
      const lista = await como<Peticion[]>(u.admin, "listar_peticiones_rol()");
      expect(lista.length).toBeGreaterThanOrEqual(3);
      const estados = lista.map((p) => p.estado);
      expect(estados.indexOf("cancelada")).toBeGreaterThan(estados.lastIndexOf("pendiente"));
      const deAna = lista.find((p) => (p.usuario as Json).id === u.ana);
      expect(deAna).toMatchObject({ usuario: { id: u.ana, nombre: "ana" }, resuelto_por: null });
      expect(JSON.stringify(lista)).not.toContain("@prueba.local");
    });

    it("aprobar cambia el rol y lo audita a nombre del administrador", async () => {
      const [p] = await como<Peticion[]>(u.ana, "mis_peticiones_rol()");
      const r = await resolver(u.admin, p?.id ?? "", true, "  Bienvenida  ");
      expect(r).toMatchObject({ estado: "aprobada", respuesta: "Bienvenida", resuelto_por: { id: u.admin, nombre: "admin" } });
      expect(await rol(u.ana)).toBe("moderador");
      expect(await auditoria(u.ana)).toContainEqual({ accion: "rol_cambiado", usuario_id: u.admin, detalle: { rol_anterior: "ciudadano", rol_nuevo: "moderador" } });
      expect((await auditoria(p?.id ?? "")).map((x) => x.accion)).toContain("peticion_aprobada");
    });

    it("una petición resuelta no se resuelve otra vez", async () => {
      const [p] = await como<Peticion[]>(u.ana, "mis_peticiones_rol()");
      await expect(resolver(u.admin2, p?.id ?? "", false)).rejects.toMatchObject({ code: "55000", message: "La petición ya fue resuelta" });
      await expect(resolver(u.admin2, randomUUID(), false)).rejects.toMatchObject({ code: "P0002" });
    });

    it("rechazar no cambia el rol y obliga a esperar 7 días", async () => {
      const [p] = await como<Peticion[]>(u.carla, "mis_peticiones_rol()");
      const r = await resolver(u.admin, p?.id ?? "", false, "Falta conocer tu trabajo en la zona");
      expect(r).toMatchObject({ estado: "rechazada", respuesta: "Falta conocer tu trabajo en la zona" });
      expect(await rol(u.carla)).toBe("ciudadano");
      await expect(pedir(u.carla, "editor")).rejects.toMatchObject({ code: "55000", message: expect.stringContaining("7 días") as unknown });
      // Pasados los 7 días, puede volver a pedir.
      await cliente().query("update peticiones_rol set resuelto_en = now() - interval '8 days', creado_en = now() - interval '9 days' where id = $1", [p?.id]);
      expect((await pedir(u.carla, "editor")).estado).toBe("pendiente");
    });

    it("la respuesta tiene un máximo de 500 caracteres", async () => {
      const [p] = await como<Peticion[]>(u.carla, "mis_peticiones_rol()");
      await expect(resolver(u.admin, p?.id ?? "", false, "r".repeat(501))).rejects.toMatchObject({ code: "22023" });
    });

    it("no se aprueba si el rol cambió desde que la persona pidió", async () => {
      const [p] = await como<Peticion[]>(u.carla, "mis_peticiones_rol()");
      await cliente().query("update perfiles set rol = 'moderador' where id = $1", [u.carla]);
      await expect(resolver(u.admin, p?.id ?? "", true)).rejects.toMatchObject({ code: "55000", message: expect.stringContaining("cambió") as unknown });
      expect(await rol(u.carla)).toBe("moderador");
      await resolver(u.admin, p?.id ?? "", false);
    });

    it("no se aprueba la de una cuenta desactivada", async () => {
      const p = await pedir(u.dani, "editor");
      await cliente().query("update perfiles set activo = false where id = $1", [u.dani]);
      await expect(resolver(u.admin, p.id, true)).rejects.toMatchObject({ code: "55000", message: "La cuenta está desactivada" });
      expect(await rol(u.dani)).toBe("ciudadano");
      await cliente().query("update perfiles set activo = true where id = $1", [u.dani]);
    });

    it("un administrador no resuelve su propia petición", async () => {
      // Caso límite: una petición creada antes de que la persona fuera administradora.
      const { rows } = await cliente().query<{ id: string }>(
        "insert into peticiones_rol (usuario_id, rol_actual, rol_pedido, motivo) values ($1, 'ciudadano', 'editor', $2) returning id",
        [u.admin2, MOTIVO],
      );
      await expect(resolver(u.admin2, rows[0]?.id ?? "", true)).rejects.toMatchObject({ code: "42501", message: "No puedes resolver tu propia petición" });
      await resolver(u.admin, rows[0]?.id ?? "", false);
    });
  });

  describe("destinatarios del correo", () => {
    it("ni anon ni authenticated pueden leer los correos", async () => {
      const [p] = await como<Peticion[]>(u.ana, "mis_peticiones_rol()");
      await expect(como(u.admin, "destinatarios_peticion_rol($1, 'nueva')", [p?.id])).rejects.toMatchObject({ code: "42501" });
      await expect(como(null, "destinatarios_peticion_rol($1, 'nueva')", [p?.id])).rejects.toMatchObject({ code: "42501" });
    });

    it("la llave de servicio obtiene los administradores activos para una nueva y la persona para una resuelta", async () => {
      const p = await pedir(u.beto, "editor");
      type Destinos = { peticion: Json; destinatarios: { email: string; nombre: string }[] };
      const nueva = await como<Destinos>(null, "destinatarios_peticion_rol($1, 'nueva')", [p.id], "service_role");
      expect(nueva.peticion).toMatchObject({ id: p.id, rol_pedido: "editor", estado: "pendiente", nombre: "beto" });
      expect(nueva.destinatarios.map((d) => d.email).sort()).toEqual(["admin2@prueba.local", "admin@prueba.local"]);

      await resolver(u.admin, p.id, false, "Aún no");
      const resuelta = await como<Destinos>(null, "destinatarios_peticion_rol($1, 'resuelta')", [p.id], "service_role");
      expect(resuelta).toMatchObject({ peticion: { estado: "rechazada", respuesta: "Aún no" }, destinatarios: [{ email: "beto@prueba.local", nombre: "beto" }] });

      expect(await como(null, "destinatarios_peticion_rol($1, 'otro')", [p.id], "service_role")).toMatchObject({ destinatarios: [] });
      expect(await como(null, "destinatarios_peticion_rol($1, 'nueva')", [randomUUID()], "service_role")).toBeNull();
    });
  });

  it("la tabla está cerrada para anon y authenticated", async () => {
    await expect(sentenciaComo(u.ana, "select * from peticiones_rol")).rejects.toMatchObject({ code: "42501" });
    await expect(sentenciaComo(null, "select * from peticiones_rol")).rejects.toMatchObject({ code: "42501" });
  });
});
