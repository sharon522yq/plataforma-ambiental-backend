import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BaseDePruebas, crearBaseDePruebas } from "../ayudas/base-de-pruebas.js";

type Json = Record<string, unknown>;
type Solicitud = { id: string; estado: string; rol_anterior: string; rol_nuevo: string; usuario: Json; solicitado_por: Json; resuelto_por: Json | null };

/**
 * Migración 014: regla de dos administradores (B-08) y métricas (B-12). Cada llamada es una
 * transacción aparte, como una petición real a la API.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("operación en la base (migración 014)", () => {
  let base: BaseDePruebas | undefined;
  let c: pg.Client | undefined;
  const cliente = (): pg.Client => {
    if (!c) throw new Error("Sin conexión de pruebas");
    return c;
  };
  const u = { primera: randomUUID(), segunda: randomUUID(), tercera: randomUUID(), ana: randomUUID(), beto: randomUUID(), editora: randomUUID() };

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
  const rol = async (id: string) => (await cliente().query<{ rol: string }>("select rol from perfiles where id = $1", [id])).rows[0]?.rol;
  const pedir = (quien: string, a: string, nuevo: string) => como<Json & { solicitud: Solicitud | null }>(quien, "cambiar_rol($1, $2)", [a, nuevo]);
  const resolver = (quien: string, id: string, aprobar: boolean) => como<Solicitud>(quien, "resolver_solicitud_rol($1, $2)", [id, aprobar]);
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
    await cliente().query("update perfiles set rol = 'editor' where id = $1", [u.editora]);
    // La primera administradora la nombra la llave de servicio, como en un proyecto nuevo.
    await cliente().query("update perfiles set rol = 'administrador' where id = $1", [u.primera]);
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await base?.limpiar();
  });

  describe("regla de dos administradores", () => {
    it("con un solo administrador, nombra al segundo sin confirmación", async () => {
      const r = await pedir(u.primera, u.segunda, "administrador");
      expect(r).toMatchObject({ id: u.segunda, rol: "administrador", solicitud: null });
      expect(await auditoria(u.segunda)).toContainEqual({ accion: "rol_cambiado", usuario_id: u.primera, detalle: { rol_anterior: "ciudadano", rol_nuevo: "administrador" } });
    });

    it("los cambios que no tocan administrador siguen siendo inmediatos", async () => {
      expect(await pedir(u.primera, u.beto, "moderador")).toMatchObject({ rol: "moderador", solicitud: null });
      expect(await pedir(u.segunda, u.beto, "ciudadano")).toMatchObject({ rol: "ciudadano", solicitud: null });
    });

    it("con dos, nombrar a otro crea una solicitud y no cambia el rol todavía", async () => {
      const r = await pedir(u.primera, u.tercera, "administrador");
      expect(r).toMatchObject({ id: u.tercera, rol: "ciudadano" });
      expect(r.solicitud).toMatchObject({
        estado: "pendiente", rol_anterior: "ciudadano", rol_nuevo: "administrador",
        usuario: { id: u.tercera, nombre: "tercera" }, solicitado_por: { id: u.primera, nombre: "primera" }, resuelto_por: null,
      });
      expect(await rol(u.tercera)).toBe("ciudadano");
      expect(await auditoria(r.solicitud?.id ?? "")).toEqual([
        { accion: "rol_solicitado", usuario_id: u.primera, detalle: { usuario_id: u.tercera, rol_anterior: "ciudadano", rol_nuevo: "administrador" } },
      ]);
    });

    it("no se puede pedir otra vez ni aprobar la propia solicitud", async () => {
      await expect(pedir(u.segunda, u.tercera, "administrador")).rejects.toMatchObject({ code: "55000" });
      const [s] = await como<Solicitud[]>(u.primera, "listar_solicitudes_rol()");
      await expect(resolver(u.primera, s?.id ?? "", true)).rejects.toMatchObject({ code: "42501" });
      expect(await rol(u.tercera)).toBe("ciudadano");
    });

    it("otro administrador la aprueba y el cambio se aplica y se audita", async () => {
      const [s] = await como<Solicitud[]>(u.segunda, "listar_solicitudes_rol()");
      const r = await resolver(u.segunda, s?.id ?? "", true);
      expect(r).toMatchObject({ estado: "aprobada", resuelto_por: { id: u.segunda, nombre: "segunda" } });
      expect(await rol(u.tercera)).toBe("administrador");
      expect((await auditoria(r.id)).map((x) => [x.accion, x.usuario_id])).toEqual([["rol_solicitado", u.primera], ["solicitud_aprobada", u.segunda]]);
      expect(await auditoria(u.tercera)).toContainEqual({ accion: "rol_cambiado", usuario_id: u.segunda, detalle: { rol_anterior: "ciudadano", rol_nuevo: "administrador" } });
      await expect(resolver(u.tercera, r.id, true)).rejects.toMatchObject({ code: "55000" });
    });

    it("nadie se salta la regla por la tabla: ni dar, ni quitar, ni desactivar a un administrador", async () => {
      await expect(sentenciaComo(u.primera, "update perfiles set rol = 'administrador' where id = $1", [u.ana])).rejects.toMatchObject({ code: "42501" });
      await expect(sentenciaComo(u.primera, "update perfiles set rol = 'editor' where id = $1", [u.tercera])).rejects.toMatchObject({ code: "42501" });
      await expect(sentenciaComo(u.primera, "update perfiles set activo = false where id = $1", [u.tercera])).rejects.toMatchObject({ code: "42501" });
      // Tampoco escribiendo una solicitud aprobada a mano.
      await expect(
        sentenciaComo(u.primera, "insert into solicitudes_rol (usuario_id, rol_anterior, rol_nuevo, solicitado_por, estado, resuelto_por, resuelto_en) values ($1, 'ciudadano', 'administrador', $2, 'aprobada', $2, now())", [u.ana, u.primera]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(sentenciaComo(u.primera, "select * from solicitudes_rol")).rejects.toMatchObject({ code: "42501" });
      expect([await rol(u.ana), await rol(u.tercera)]).toEqual(["ciudadano", "administrador"]);
    });

    it("quitar el rol: la persona afectada puede consentirlo", async () => {
      const r = await pedir(u.primera, u.tercera, "editor");
      expect(r).toMatchObject({ rol: "administrador", solicitud: { estado: "pendiente", rol_nuevo: "editor" } });
      await resolver(u.tercera, r.solicitud?.id ?? "", true);
      expect(await rol(u.tercera)).toBe("editor");
      // Una aprobación vieja no sirve para volver a darle el rol por la tabla.
      await expect(sentenciaComo(u.segunda, "update perfiles set rol = 'administrador' where id = $1", [u.tercera])).rejects.toMatchObject({ code: "42501" });
      // Pero sigue sin poder cambiarse el rol por su cuenta.
      await expect(sentenciaComo(u.segunda, "update perfiles set rol = 'ciudadano' where id = $1", [u.segunda])).rejects.toMatchObject({ code: "42501" });
    });

    it("rechazar y cancelar", async () => {
      const a = await pedir(u.primera, u.ana, "administrador");
      expect(await resolver(u.segunda, a.solicitud?.id ?? "", false)).toMatchObject({ estado: "rechazada", resuelto_por: { id: u.segunda } });
      const b = await pedir(u.primera, u.ana, "administrador");
      expect(await resolver(u.primera, b.solicitud?.id ?? "", false)).toMatchObject({ estado: "cancelada" });
      await expect(resolver(u.segunda, b.solicitud?.id ?? "", true)).rejects.toMatchObject({ code: "55000" });
      expect(await rol(u.ana)).toBe("ciudadano");
      expect((await auditoria(b.solicitud?.id ?? "")).map((x) => x.accion)).toEqual(["rol_solicitado", "solicitud_cancelada"]);
    });

    it("una solicitud de más de 7 días vence y no bloquea una nueva", async () => {
      const a = await pedir(u.primera, u.ana, "administrador");
      const id = a.solicitud?.id ?? "";
      await cliente().query("update solicitudes_rol set creado_en = now() - interval '8 days' where id = $1", [id]);
      await expect(resolver(u.segunda, id, true)).rejects.toMatchObject({ code: "55000" });
      expect((await como<Solicitud[]>(u.segunda, "listar_solicitudes_rol()")).find((s) => s.id === id)?.estado).toBe("vencida");
      const b = await pedir(u.primera, u.ana, "administrador");
      expect(b.solicitud?.estado).toBe("pendiente");
      const { rows } = await cliente().query<{ estado: string }>("select estado from solicitudes_rol where id = $1", [id]);
      expect(rows[0]?.estado).toBe("vencida");
      await resolver(u.primera, b.solicitud?.id ?? "", false);
    });

    it("no se aprueba si el rol cambió o si quien pidió ya no es administrador", async () => {
      const a = await pedir(u.primera, u.beto, "administrador");
      await cliente().query("update perfiles set rol = 'editor' where id = $1", [u.beto]); // llave de servicio
      await expect(resolver(u.segunda, a.solicitud?.id ?? "", true)).rejects.toMatchObject({ code: "55000" });
      await resolver(u.segunda, a.solicitud?.id ?? "", false);

      const b = await pedir(u.primera, u.beto, "administrador");
      await cliente().query("update perfiles set rol = 'ciudadano' where id = $1", [u.primera]);
      await expect(resolver(u.segunda, b.solicitud?.id ?? "", true)).rejects.toMatchObject({ code: "55000" });
      expect(await rol(u.beto)).toBe("editor");
      await cliente().query("update perfiles set rol = 'administrador' where id = $1", [u.primera]);
      await resolver(u.segunda, b.solicitud?.id ?? "", false);
    });

    it("la llave de servicio no tiene la regla (vía de recuperación)", async () => {
      await cliente().query("update perfiles set rol = 'administrador' where id = $1", [u.beto]);
      await cliente().query("update perfiles set rol = 'editor', activo = false where id = $1", [u.beto]);
      await cliente().query("update perfiles set activo = true where id = $1", [u.beto]);
      expect(await rol(u.beto)).toBe("editor");
    });

    it("solo un administrador pide, resuelve o lista; el anónimo ni siquiera ejecuta", async () => {
      await expect(pedir(u.editora, u.ana, "administrador")).rejects.toMatchObject({ code: "42501" });
      await expect(como(u.editora, "listar_solicitudes_rol()")).rejects.toMatchObject({ code: "42501" });
      await expect(resolver(u.editora, randomUUID(), true)).rejects.toMatchObject({ code: "42501" });
      await expect(resolver(u.primera, randomUUID(), true)).rejects.toMatchObject({ code: "P0002" });
      await expect(como(u.primera, "resolver_solicitud_rol($1, null)", [randomUUID()])).rejects.toMatchObject({ code: "22023" });
      const { rows } = await cliente().query<{ f: string; anon: boolean; autenticado: boolean }>(
        `select f, has_function_privilege('anon', f, 'execute') anon, has_function_privilege('authenticated', f, 'execute') autenticado
         from unnest(array['cambiar_rol(uuid,text)', 'resolver_solicitud_rol(uuid,boolean)', 'listar_solicitudes_rol()', 'metricas_plataforma()',
                           'solicitud_rol_json(solicitudes_rol)', 'exigir_segundo_administrador()', 'auditar_solicitudes_rol()']) f`,
      );
      expect(rows.filter((r) => r.anon).map((r) => r.f)).toEqual([]);
      expect(rows.filter((r) => r.autenticado).map((r) => r.f)).toEqual(["cambiar_rol(uuid,text)", "resolver_solicitud_rol(uuid,boolean)", "listar_solicitudes_rol()", "metricas_plataforma()"]);
    });
  });

  describe("métricas", () => {
    it("cuentan exactamente los datos conocidos y no traen datos personales", async () => {
      // Sin los datos iniciales de la 005, para saber exactamente qué hay.
      await cliente().query("truncate puntos, aportes, acciones, conversaciones_agente cascade");
      const punto = (titulo: string, tipo: string, gravedad: number, estado: string) =>
        cliente().query(
          "insert into puntos (titulo, tipo, gravedad, descripcion, ubicacion, estado) values ($1, $2, $3, 'x', st_setsrid(st_makepoint(-103.3, 20.6), 4326)::geography, $4)",
          [titulo, tipo, gravedad, estado],
        );
      await punto("Río", "contaminacion_agua", 4, "publicado");
      await punto("Arroyo", "contaminacion_agua", 2, "publicado");
      await punto("Tiradero", "residuos", 4, "publicado");
      await punto("Revisión", "otro", 1, "en_revision");
      const aporte = (estado: string, creado: string, decidido: string) =>
        cliente().query(
          `insert into aportes (tipo, descripcion, ubicacion, autor_id, estado, creado_en, actualizado_en)
           values ('residuos', 'x', st_setsrid(st_makepoint(-103.3, 20.6), 4326)::geography, $1, $2, now() - $3::interval, now() - $4::interval)`,
          [u.ana, estado, creado, decidido],
        );
      await aporte("pendiente", "1 hour", "1 hour");
      await aporte("aprobado", "10 hours", "8 hours"); // 2 h de revisión
      await aporte("rechazado", "20 hours", "16 hours"); // 4 h
      await aporte("aprobado", "40 days", "34 days"); // 6 días, fuera de los últimos 30
      await cliente().query(
        `insert into conversaciones_agente (pregunta, respuesta, fuentes) values
           ('a', 'b', '{"modelo": "gemini-2.5-flash", "herramientas": ["buscar_puntos"], "documentos": []}'),
           ('a', 'b', '{"modelo": "gemini-2.5-flash", "herramientas": ["buscar_conocimiento"], "documentos": ["d"]}'),
           ('a', 'b', '{"modelo": "respaldo-sin-ia", "herramientas": [], "documentos": []}'),
           ('a', 'b', null)`,
      );

      const m = await como(u.primera, "metricas_plataforma()");
      expect(m.puntos).toEqual({ publicados: 3, en_revision: 1, archivados: 0, por_tipo: { contaminacion_agua: 2, residuos: 1 }, por_gravedad: { "2": 1, "4": 2 } });
      expect(m.aportes).toMatchObject({ pendientes: 1, aprobados: 2, rechazados: 1, duplicados: 0, ultimos_30_dias: 3, horas_revision_mediana: 4 });
      const semanas = (m.aportes as { por_semana: { semana: string; recibidos: number }[] }).por_semana;
      expect(semanas).toHaveLength(8);
      expect(semanas.reduce((s, x) => s + x.recibidos, 0)).toBe(4);
      expect(m.usuarios).toEqual({ total: 6, activos: 6, nuevos_30_dias: 6, por_rol: { administrador: 2, editor: 3, ciudadano: 1 } });
      expect(m.asistente).toEqual({ conversaciones_7_dias: 4, con_herramientas: 2, con_documentos: 1, sin_ia: 1 });
      expect(m.catalogo).toMatchObject({ acciones_activas: 0, documentos_activos: 0, fragmentos: 0 });
      expect(m.pendientes_de_rol).toBe(0);
      const texto = JSON.stringify(m);
      expect(texto).not.toMatch(/@prueba\.local|"primera"|"ana"/);
    });

    it("solo administración las ve", async () => {
      for (const uid of [u.ana, u.editora]) await expect(como(uid, "metricas_plataforma()")).rejects.toMatchObject({ code: "42501" });
    });
  });
});

/** Casos que necesitan una base propia: dos sesiones a la vez y muchas solicitudes. */
describe.skipIf(!process.env.TEST_DATABASE_URL)("regla de dos administradores con sesiones simultáneas", () => {
  let base: BaseDePruebas | undefined;
  const conexiones: pg.Client[] = [];
  const u = { ana: randomUUID(), beto: randomUUID(), carla: randomUUID() };

  async function conectar(): Promise<pg.Client> {
    if (!base) throw new Error("Sin base");
    const c = new pg.Client({ connectionString: base.url });
    await c.connect();
    conexiones.push(c);
    return c;
  }
  async function abrirComo(c: pg.Client, uid: string): Promise<void> {
    await c.query("begin");
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
    await c.query("set local role authenticated");
  }
  async function solicitar(c: pg.Client, quien: string, a: string, nuevo: string): Promise<string> {
    await abrirComo(c, quien);
    const { rows } = await c.query<{ r: { solicitud: { id: string } | null } }>("select cambiar_rol($1, $2) as r", [a, nuevo]);
    await c.query("commit");
    const id = rows[0]?.r.solicitud?.id;
    if (!id) throw new Error("No se creó la solicitud");
    return id;
  }

  beforeAll(async () => {
    base = await crearBaseDePruebas();
    const c = await conectar();
    for (const [nombre, id] of Object.entries(u)) {
      await c.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, `${nombre}@prueba.local`, { nombre }]);
    }
    // Dos administradores nombrados con la llave de servicio.
    await c.query("update perfiles set rol = 'administrador' where id = any($1)", [[u.ana, u.beto]]);
  }, 120_000);

  afterAll(async () => {
    for (const c of conexiones) await c.end();
    await base?.limpiar();
  });

  it("si los dos últimos administradores aceptan a la vez quitarse el rol, la segunda falla", async () => {
    const [c1, c2, c3] = [await conectar(), await conectar(), await conectar()];
    const quitarBeto = await solicitar(c3, u.ana, u.beto, "ciudadano");
    const quitarAna = await solicitar(c3, u.beto, u.ana, "ciudadano");

    await abrirComo(c1, u.beto);
    await c1.query("select resolver_solicitud_rol($1, true)", [quitarBeto]);
    await abrirComo(c2, u.ana);
    const segunda = c2.query("select resolver_solicitud_rol($1, true)", [quitarAna]).then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise((listo) => setTimeout(listo, 300));
    await c1.query("commit");
    const error = await segunda;
    await c2.query(error ? "rollback" : "commit");

    expect(error).toMatchObject({ code: "42501", message: "Debe quedar al menos un administrador activo" });
    const { rows } = await c3.query<{ n: number }>("select count(*)::int as n from perfiles where rol = 'administrador' and activo");
    expect(rows[0]?.n).toBe(1);
  });

  it("una solicitud pendiente sigue en la lista aunque haya más de 50 resueltas después", async () => {
    const c = await conectar();
    // Queda un solo administrador (Ana); nombra a Carla al momento y después pide quitarle el rol.
    const admin = (await c.query<{ id: string }>("select id from perfiles where rol = 'administrador' and activo")).rows[0]?.id;
    if (!admin) throw new Error("Sin administrador");
    const otra = admin === u.ana ? u.beto : u.ana;
    await abrirComo(c, admin);
    await c.query("select cambiar_rol($1, 'administrador')", [u.carla]);
    await c.query("commit");
    const pendiente = await solicitar(c, admin, u.carla, "ciudadano");
    await c.query(
      `insert into solicitudes_rol (usuario_id, rol_anterior, rol_nuevo, solicitado_por, estado, resuelto_por, creado_en, resuelto_en)
       select $1, 'ciudadano', 'administrador', $2, 'rechazada', $2, now() + make_interval(secs => g), now() + make_interval(secs => g)
       from generate_series(1, 60) g`,
      [otra, admin],
    );
    await abrirComo(c, admin);
    const { rows } = await c.query<{ r: { id: string; estado: string }[] }>("select listar_solicitudes_rol() as r");
    await c.query("rollback");
    const lista = rows[0]?.r ?? [];
    expect(lista).toHaveLength(50);
    expect(lista[0]).toMatchObject({ id: pendiente, estado: "pendiente" });
  });
});
