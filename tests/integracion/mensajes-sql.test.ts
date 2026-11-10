import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BaseDePruebas, crearBaseDePruebas } from "../ayudas/base-de-pruebas.js";

type Json = Record<string, unknown>;
type Hilo = { id: string; con: string; soy_quien_reporto: boolean; estado: string; cerrado_por_mi: boolean; no_leidos: number; punto: Json };
type Mensaje = { id: string; mio: boolean; texto: string; leido_en: string | null };
type Escrito = { hilo: Hilo; mensaje: Mensaje };

/**
 * Migración 016: mensajes entre personas sobre un punto publicado (D-46). Cada llamada es una
 * transacción aparte, como una petición real a la API.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("mensajes en la base (migración 016)", () => {
  let base: BaseDePruebas | undefined;
  let c: pg.Client | undefined;
  const cliente = (): pg.Client => {
    if (!c) throw new Error("Sin conexión de pruebas");
    return c;
  };
  const u = { autora: randomUUID(), beto: randomUUID(), carla: randomUUID(), moderadora: randomUUID(), intrusa: randomUUID(), muda: randomUUID() };
  const punto = { publicado: "", enRevision: "", sinAutor: "", deMuda: "" };

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
  const escribir = (quien: string, puntoId: string, texto: string) => como<Escrito>(quien, "escribir_sobre_punto($1, $2)", [puntoId, texto]);
  const responder = (quien: string, hilo: string, texto: string) => como<Escrito>(quien, "responder_hilo($1, $2)", [hilo, texto]);
  const leer = (quien: string, hilo: string) => como<{ hilo: Hilo; mensajes: Mensaje[] }>(quien, "leer_hilo($1)", [hilo]);
  const destinatario = (mensaje: string) => como<Json | null>(null, "destinatario_mensaje($1)", [mensaje], "service_role");
  async function nuevoPunto(titulo: string, autor: string | null, estado = "publicado"): Promise<string> {
    const { rows } = await cliente().query<{ id: string }>(
      `insert into puntos (titulo, tipo, gravedad, descripcion, ubicacion, estado, autor_id)
       values ($1, 'residuos', 3, 'x', st_setsrid(st_makepoint(-103.35, 20.66), 4326)::geography, $2, $3) returning id`,
      [titulo, estado, autor],
    );
    return rows[0]?.id ?? "";
  }

  beforeAll(async () => {
    base = await crearBaseDePruebas();
    c = new pg.Client({ connectionString: base.url });
    await cliente().connect();
    for (const [nombre, id] of Object.entries(u)) {
      await cliente().query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, `${nombre}@prueba.local`, { nombre }]);
    }
    await cliente().query("update perfiles set rol = 'moderador' where id = $1", [u.moderadora]);
    punto.publicado = await nuevoPunto("Basura en el río", u.autora);
    punto.enRevision = await nuevoPunto("En revisión", u.autora, "en_revision");
    punto.sinAutor = await nuevoPunto("Sin autor", null);
    punto.deMuda = await nuevoPunto("De cuenta inactiva", u.muda);
    await cliente().query("update perfiles set activo = false where id = $1", [u.muda]);
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await base?.limpiar();
  });

  let hiloBeto = "";

  describe("escribir sobre un punto", () => {
    it("abre la conversación; quien reportó sigue anónima y quien escribe aparece con su nombre", async () => {
      const r = await escribir(u.beto, punto.publicado, "  Hola, ¿organizamos una limpieza el sábado?  ");
      hiloBeto = r.hilo.id;
      expect(r.mensaje).toMatchObject({ mio: true, texto: "Hola, ¿organizamos una limpieza el sábado?", leido_en: null });
      expect(r.hilo).toMatchObject({ con: "Quien reportó el punto", soy_quien_reporto: false, estado: "abierto", no_leidos: 0, punto: { titulo: "Basura en el río" } });
      const [deAutora] = await como<Hilo[]>(u.autora, "mis_hilos()");
      expect(deAutora).toMatchObject({ id: hiloBeto, con: "beto", soy_quien_reporto: true, no_leidos: 1 });
      expect(JSON.stringify(deAutora)).not.toContain("@prueba.local");
    });

    it("un segundo mensaje al mismo punto usa la misma conversación", async () => {
      const r = await escribir(u.beto, punto.publicado, "Puedo llevar bolsas");
      expect(r.hilo.id).toBe(hiloBeto);
      expect(await como<Hilo[]>(u.beto, "mis_hilos()")).toHaveLength(1);
    });

    it.each([
      ["el propio reporte", "autora", "publicado", "Es tu propio reporte", "22023"],
      ["un punto en revisión", "beto", "enRevision", "El punto no existe o no está publicado", "P0002"],
      ["un punto sin autor", "beto", "sinAutor", "quien lo reportó ya no tiene una cuenta activa", "55000"],
      ["un punto de una cuenta inactiva", "beto", "deMuda", "quien lo reportó ya no tiene una cuenta activa", "55000"],
    ] as const)("no se escribe sobre %s", async (_caso, quien, cual, mensaje, codigo) => {
      await expect(escribir(u[quien], punto[cual], "Hola")).rejects.toMatchObject({ code: codigo, message: expect.stringContaining(mensaje) as unknown });
    });

    it("el texto debe tener de 1 a 2000 caracteres y exige sesión activa", async () => {
      await expect(escribir(u.carla, punto.publicado, "   ")).rejects.toMatchObject({ code: "22023" });
      await expect(escribir(u.carla, punto.publicado, "x".repeat(2001))).rejects.toMatchObject({ code: "22023" });
      await expect(sentenciaComo(null, "select escribir_sobre_punto($1, 'hola')", [punto.publicado])).rejects.toMatchObject({ code: "42501" });
      await expect(escribir(u.muda, punto.publicado, "hola")).rejects.toMatchObject({ code: "42501" });
    });
  });

  describe("leer y responder", () => {
    it("solo las dos personas leen la conversación; nadie más sabe que existe", async () => {
      await expect(leer(u.intrusa, hiloBeto)).rejects.toMatchObject({ code: "P0002", message: "No tienes una conversación con ese id" });
      await expect(leer(u.moderadora, hiloBeto)).rejects.toMatchObject({ code: "P0002" });
      await expect(responder(u.intrusa, hiloBeto, "hola")).rejects.toMatchObject({ code: "P0002" });
      await expect(sentenciaComo(u.intrusa, "select * from mensajes")).rejects.toMatchObject({ code: "42501" });
      await expect(sentenciaComo(u.intrusa, "select * from hilos")).rejects.toMatchObject({ code: "42501" });
    });

    it("leer marca como leídos los mensajes recibidos, no los propios", async () => {
      const r = await leer(u.autora, hiloBeto);
      expect(r.mensajes.map((m) => [m.mio, m.texto])).toEqual([[false, "Hola, ¿organizamos una limpieza el sábado?"], [false, "Puedo llevar bolsas"]]);
      expect(r.hilo.no_leidos).toBe(0);
      const deBeto = await leer(u.beto, hiloBeto);
      expect(deBeto.mensajes.every((m) => m.mio && m.leido_en !== null)).toBe(true);
    });

    it("quien reportó responde", async () => {
      const r = await responder(u.autora, hiloBeto, "¡Sí! A las 9");
      expect(r.mensaje).toMatchObject({ mio: true, texto: "¡Sí! A las 9" });
      const [deBeto] = await como<Hilo[]>(u.beto, "mis_hilos()");
      expect(deBeto?.no_leidos).toBe(1);
    });
  });

  describe("aviso por correo", () => {
    it("solo la llave de servicio lo pide", async () => {
      const r = await escribir(u.carla, punto.publicado, "Hola, soy vecina");
      await expect(como(u.carla, "destinatario_mensaje($1)", [r.mensaje.id])).rejects.toMatchObject({ code: "42501" });
      await expect(como(null, "destinatario_mensaje($1)", [r.mensaje.id])).rejects.toMatchObject({ code: "42501" });
    });

    it("avisa del primer mensaje sin leer y no de los siguientes; nunca devuelve el texto", async () => {
      const primero = await responder(u.beto, hiloBeto, "Perfecto");
      // La autora aún tiene sin leer «Hola, soy vecina» de Carla, pero en otra conversación: no cuenta.
      const aviso = await destinatario(primero.mensaje.id);
      expect(aviso).toEqual({ punto: { titulo: "Basura en el río" }, destinatario: { email: "autora@prueba.local", nombre: "autora" } });
      expect(JSON.stringify(aviso)).not.toContain("Perfecto");
      const segundo = await responder(u.beto, hiloBeto, "Llevo guantes también");
      expect(await destinatario(segundo.mensaje.id)).toBeNull();
      await leer(u.autora, hiloBeto);
      const tercero = await responder(u.beto, hiloBeto, "Nos vemos");
      expect(await destinatario(tercero.mensaje.id)).toMatchObject({ destinatario: { email: "autora@prueba.local" } });
      expect(await destinatario(randomUUID())).toBeNull();
    });
  });

  describe("cerrar, reabrir y denunciar", () => {
    it("cerrar impide escribir a las dos; solo quien cerró la reabre", async () => {
      const cerrado = await como<Hilo>(u.autora, "cerrar_hilo($1)", [hiloBeto]);
      expect(cerrado).toMatchObject({ estado: "cerrado", cerrado_por_mi: true });
      await expect(responder(u.beto, hiloBeto, "¿Hola?")).rejects.toMatchObject({ code: "55000", message: "La conversación está cerrada" });
      await expect(escribir(u.beto, punto.publicado, "¿Hola?")).rejects.toMatchObject({ code: "55000" });
      await expect(responder(u.autora, hiloBeto, "x")).rejects.toMatchObject({ code: "55000" });
      await expect(como(u.beto, "reabrir_hilo($1)", [hiloBeto])).rejects.toMatchObject({ code: "P0002" });
      expect(await como<Hilo>(u.autora, "reabrir_hilo($1)", [hiloBeto])).toMatchObject({ estado: "abierto", cerrado_por_mi: false });
    });

    it("una conversación cerrada no avisa por correo", async () => {
      const m = await responder(u.beto, hiloBeto, "último");
      await como(u.autora, "cerrar_hilo($1)", [hiloBeto]);
      expect(await destinatario(m.mensaje.id)).toBeNull();
      await como(u.autora, "reabrir_hilo($1)", [hiloBeto]);
    });

    let denuncia = "";
    it("denunciar cierra la conversación, se audita sin el texto y no se reabre mientras esté en revisión", async () => {
      const [h] = await como<Hilo[]>(u.autora, "mis_hilos()").then((l) => l.filter((x) => x.con === "carla"));
      await expect(como(u.autora, "denunciar_hilo($1, 'corto')", [h?.id])).rejects.toMatchObject({ code: "22023" });
      const r = await como<Hilo>(u.autora, "denunciar_hilo($1, $2)", [h?.id, "Me escribe cosas ofensivas"]);
      expect(r).toMatchObject({ estado: "cerrado", cerrado_por_mi: true });
      await expect(como(u.autora, "denunciar_hilo($1, $2)", [h?.id, "Me escribe cosas ofensivas"])).rejects.toMatchObject({ code: "55000" });
      await expect(como(u.autora, "reabrir_hilo($1)", [h?.id])).rejects.toMatchObject({ code: "55000", message: "La conversación tiene una denuncia en revisión" });
      const { rows } = await cliente().query<{ id: string; detalle: Json }>("select registro_id as id, detalle from auditoria where accion = 'conversacion_denunciada'");
      expect(rows).toHaveLength(1);
      denuncia = rows[0]?.id ?? "";
      expect(JSON.stringify(rows)).not.toMatch(/ofensivas|vecina/);
    });

    it("moderación ve solo las conversaciones denunciadas, con sus mensajes, y las marca revisadas", async () => {
      await expect(como(u.beto, "listar_denuncias_hilos()")).rejects.toMatchObject({ code: "42501" });
      type Denuncia = { id: string; estado: string; denunciante: Json; hilo: { mensajes: { texto: string; autor: Json }[] } };
      const lista = await como<Denuncia[]>(u.moderadora, "listar_denuncias_hilos()");
      expect(lista).toHaveLength(1);
      expect(lista[0]).toMatchObject({ id: denuncia, estado: "pendiente", denunciante: { nombre: "autora" } });
      expect(lista[0]?.hilo.mensajes).toEqual([expect.objectContaining({ texto: "Hola, soy vecina", autor: { id: u.carla, nombre: "carla" } })]);
      expect(JSON.stringify(lista)).not.toContain("@prueba.local");
      expect(JSON.stringify(lista)).not.toContain("Puedo llevar bolsas");

      await expect(como(u.beto, "revisar_denuncia_hilo($1)", [denuncia])).rejects.toMatchObject({ code: "42501" });
      expect(await como(u.moderadora, "revisar_denuncia_hilo($1, 'Se habló con la persona')", [denuncia])).toMatchObject({ estado: "revisada", nota: "Se habló con la persona" });
      await expect(como(u.moderadora, "revisar_denuncia_hilo($1)", [denuncia])).rejects.toMatchObject({ code: "P0002" });
      const auditada = await cliente().query("select 1 from auditoria where accion = 'denuncia_revisada' and usuario_id = $1", [u.moderadora]);
      expect(auditada.rowCount).toBe(1);
    });
  });

  describe("límites", () => {
    it("30 mensajes por hora por persona", async () => {
      const h = (await escribir(u.intrusa, punto.publicado, "1")).hilo.id;
      for (let i = 2; i <= 30; i++) await responder(u.intrusa, h, String(i));
      await expect(responder(u.intrusa, h, "31")).rejects.toMatchObject({ code: "55000", message: expect.stringContaining("muchos mensajes") as unknown });
    });

    it("10 conversaciones nuevas por día por persona", async () => {
      for (let i = 0; i < 10; i++) await escribir(u.moderadora, await nuevoPunto(`Punto ${String(i)}`, u.autora), "hola");
      await expect(escribir(u.moderadora, await nuevoPunto("Once", u.autora), "hola")).rejects.toMatchObject({ code: "55000", message: expect.stringContaining("muchas conversaciones") as unknown });
    });
  });
});
