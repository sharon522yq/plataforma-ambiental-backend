import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  accionAdmin,
  organizacionAdmin,
  registroAuditoria,
  usuarioAdmin,
  usuarioRolCambiado,
} from "../../src/modulos/administracion/esquemas.js";
import { accion } from "../../src/modulos/acciones/rutas.js";
import { aporteModeracion, aportePropio, aporteRevisado } from "../../src/modulos/aportes/esquemas.js";
import { puntoModeracion } from "../../src/modulos/moderacion/esquemas.js";
import { organizacion } from "../../src/modulos/organizaciones/rutas.js";
import { puntoCercano, puntoDetalle, puntoResumen } from "../../src/modulos/puntos/esquemas.js";
import { armarPagina } from "../../src/compartido/consultas.js";
import { type BaseDePruebas, crearBaseDePruebas } from "../ayudas/base-de-pruebas.js";

const CENTRO = { lat: 20.6597, lng: -103.3496 };
const PAGINA = { pagina: 1, limite: 20 };

/**
 * Contrato entre la base y la API: cada función se llama en una base real y su respuesta
 * se valida con el mismo esquema que usa la ruta. Las pruebas HTTP usan respuestas falsas,
 * así que solo aquí se nota si la función devuelve una forma distinta (incidente I-04:
 * revisar_aporte no devuelve autor_id y la ruta respondía 500 después de guardar).
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)("contrato entre funciones SQL y esquemas de la API", () => {
  let base: BaseDePruebas | undefined;
  let c: pg.Client | undefined;
  const cliente = (): pg.Client => {
    if (!c) throw new Error("Sin conexión de pruebas");
    return c;
  };
  const u = { ciudadana: randomUUID(), moderadora: randomUUID(), admin: randomUUID() };

  /** `select <expresion>` como el usuario uid (o anon si es null), confirmado. */
  async function como(uid: string | null, expresion: string, valores: unknown[] = []): Promise<unknown> {
    await cliente().query("begin");
    try {
      if (uid) await cliente().query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
      await cliente().query(`set local role ${uid ? "authenticated" : "anon"}`);
      const { rows } = await cliente().query<{ r: unknown }>(`select ${expresion} as r`, valores);
      await cliente().query("commit");
      return rows[0]?.r;
    } catch (error) {
      await cliente().query("rollback");
      throw error;
    }
  }

  const validar = <T>(esquema: z.ZodType<T>, valor: unknown): T => {
    const r = esquema.safeParse(valor);
    if (!r.success) throw new Error(`La respuesta no cumple el esquema: ${JSON.stringify(r.error.issues)}`);
    return r.data;
  };
  const id = (x: unknown) => (x as { id: string }).id;
  const nuevoAporte = (descripcion = "Basura acumulada en la esquina") =>
    como(u.ciudadana, "crear_aporte('residuos', $1, $2, $3, 3, null)", [descripcion, CENTRO.lat, CENTRO.lng]);

  beforeAll(async () => {
    base = await crearBaseDePruebas();
    c = new pg.Client({ connectionString: base.url });
    await cliente().connect();
    for (const uid of Object.values(u)) {
      await cliente().query("insert into auth.users (id, email) values ($1, $2)", [uid, `${uid}@prueba.local`]);
    }
    await cliente().query("update perfiles set rol = 'moderador' where id = $1", [u.moderadora]);
    await cliente().query("update perfiles set rol = 'administrador' where id = $1", [u.admin]);
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await base?.limpiar();
  });

  describe("aportes", () => {
    it("crear_aporte, mis_aportes y adjuntar_evidencia cumplen aportePropio", async () => {
      const a = await nuevoAporte();
      validar(aportePropio, a);
      validar(aportePropio, await como(u.ciudadana, "adjuntar_evidencia($1, $2)", [id(a), `${u.ciudadana}/${id(a)}.jpg`]));
      armarPagina(await como(u.ciudadana, "mis_aportes()"), aportePropio, PAGINA);
    });

    it("un aporte con enlaces cumple aportePropio, aporteModeracion y aporteRevisado (migración 012)", async () => {
      const a = await como(u.ciudadana, "crear_aporte('residuos', 'Basura junto al río', $1, $2, null, null, $3::jsonb)",
        [CENTRO.lat, CENTRO.lng, JSON.stringify([{ tipo: "firma", nombre: "Firma por el río", enlace: "https://ejemplo.org/f" }])]);
      expect(validar(aportePropio, a).enlaces).toHaveLength(1);
      armarPagina(await como(u.moderadora, "cola_aportes()"), aporteModeracion, PAGINA);
      validar(aporteRevisado, await como(u.moderadora, "revisar_aporte($1, 'aprobado', null, 'Basura junto al río', 2, true)", [id(a)]));
    });

    it("cola_aportes cumple aporteModeracion", async () => {
      await nuevoAporte();
      const pagina = armarPagina(await como(u.moderadora, "cola_aportes()"), aporteModeracion, PAGINA);
      expect(pagina.datos.length).toBeGreaterThan(0);
    });

    it.each([
      ["aprobado", "revisar_aporte($1, 'aprobado', null, 'Basura en la esquina', 4, true)"],
      ["rechazado", "revisar_aporte($1, 'rechazado', 'No es ambiental')"],
    ])("revisar_aporte (%s) cumple el esquema de la respuesta", async (decision, expresion) => {
      const a = await nuevoAporte();
      const r = validar(aporteRevisado, await como(u.moderadora, expresion, [id(a)]));
      expect(r).toMatchObject({ id: id(a), estado: decision, revisor_id: u.moderadora });
    });

    it("revisar_aporte (duplicado) cumple el esquema de la respuesta", async () => {
      const original = await nuevoAporte("Descarga al canal");
      const aprobado = await como(u.moderadora, "revisar_aporte($1, 'aprobado', null, 'Descarga', 3, true)", [id(original)]);
      const a = await nuevoAporte("Descarga al canal otra vez");
      const punto = (aprobado as { punto_id: string }).punto_id;
      const r = validar(aporteRevisado, await como(u.moderadora, "revisar_aporte($1, 'duplicado', null, null, null, false, $2)", [id(a), punto]));
      expect(r).toMatchObject({ estado: "duplicado", punto_id: punto });
    });
  });

  describe("puntos", () => {
    it("crear_punto y cambiar_estado_punto cumplen puntoModeracion; las consultas públicas, las suyas", async () => {
      const p = validar(puntoModeracion, await como(u.admin, "crear_punto('Tala en el cerro', 'tala_ilegal', 4, 'Tala sin permiso', $1, $2, 'en_revision')", [CENTRO.lat, CENTRO.lng]));
      validar(puntoModeracion, await como(u.moderadora, "cambiar_estado_punto($1, 'publicado')", [p.id]));
      armarPagina(await como(null, "listar_puntos_publicos()"), puntoResumen, PAGINA);
      validar(puntoCercano.array(), await como(null, "puntos_cercanos_publicos($1, $2, 5000)", [CENTRO.lat, CENTRO.lng]));
      validar(puntoDetalle, await como(null, "obtener_punto_publico($1)", [p.id]));
    });
  });

  describe("administración y catálogo", () => {
    it("proponer_accion y retirar_accion cumplen accionAdmin (migración 012)", async () => {
      const p = validar(puntoModeracion, await como(u.admin, "crear_punto('Río', 'contaminacion_agua', 3, 'x', $1, $2, 'publicado')", [CENTRO.lat, CENTRO.lng]));
      const a = validar(accionAdmin, await como(u.ciudadana, "proponer_accion($1, 'evento', 'Jornada de limpieza', 'https://ejemplo.org/evento')", [p.id]));
      expect(a).toMatchObject({ de_la_comunidad: true });
      validar(accionAdmin, await como(u.moderadora, "retirar_accion($1)", [a.id]));
    });

    it("crear_organizacion, crear_accion y los listados públicos cumplen sus esquemas", async () => {
      const o = validar(organizacionAdmin, await como(u.admin, "crear_organizacion('Vecinos del río', 'contacto@ejemplo.org', 'Centro')"));
      validar(accionAdmin, await como(u.admin, "crear_accion('voluntariado', 'Limpieza del río', null, null, $1, null)", [o.id]));
      armarPagina(await como(null, "listar_organizaciones_publicas()"), organizacion, PAGINA);
      armarPagina(await como(null, "listar_acciones_publicas()"), accion, PAGINA);
    });

    it("listar_usuarios, cambiar_rol y listar_auditoria cumplen sus esquemas", async () => {
      armarPagina(await como(u.admin, "listar_usuarios()"), usuarioAdmin, PAGINA);
      validar(usuarioRolCambiado, await como(u.admin, "cambiar_rol($1, 'editor')", [u.ciudadana]));
      await como(u.admin, "cambiar_rol($1, 'ciudadano')", [u.ciudadana]);
      armarPagina(await como(u.admin, "listar_auditoria()"), registroAuditoria, { pagina: 1, limite: 50 });
    });
  });
});
