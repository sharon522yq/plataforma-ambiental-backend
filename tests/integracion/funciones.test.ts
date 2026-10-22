import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BaseDePruebas, comoRol, crearBaseDePruebas } from "../ayudas/base-de-pruebas.js";

const CENTRO = { lat: 20.6597, lng: -103.3496 };
const DIMENSION = 768;

describe.skipIf(!process.env.TEST_DATABASE_URL)("funciones de la base", () => {
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

  beforeAll(async () => {
    base = await crearBaseDePruebas();
    c = new pg.Client({ connectionString: baseDePruebas().url });
    await cliente().connect();

    // Un punto en revisión justo en el centro: no debe aparecer en las búsquedas públicas.
    await cliente().query(
      `insert into puntos (titulo, tipo, gravedad, descripcion, ubicacion, estado)
       values ('[PRUEBA] en revisión en el centro', 'otro', 1, 'x',
               st_setsrid(st_makepoint($1, $2), 4326)::geography, 'en_revision')`,
      [CENTRO.lng, CENTRO.lat],
    );
  }, 120_000);

  afterAll(async () => {
    await c?.end();
    await base?.limpiar();
  });

  describe("puntos_cercanos", () => {
    it("devuelve solo puntos publicados, ordenados por distancia", async () => {
      const { rows } = await cliente().query<{ titulo: string; distancia_metros: number }>(
        "select titulo, distancia_metros from puntos_cercanos($1, $2, 50000)",
        [CENTRO.lat, CENTRO.lng],
      );
      expect(rows.length).toBe(3);
      expect(rows.some((r) => r.titulo.includes("en revisión"))).toBe(false);
      const distancias = rows.map((r) => r.distancia_metros);
      expect([...distancias].sort((a, b) => a - b)).toEqual(distancias);
    });

    it("filtra por tipo", async () => {
      const { rows } = await cliente().query<{ tipo: string }>(
        "select tipo from puntos_cercanos($1, $2, 50000, 'tala_ilegal')",
        [CENTRO.lat, CENTRO.lng],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tipo).toBe("tala_ilegal");
    });

    it("rechaza un radio fuera de rango", async () => {
      await expect(cliente().query("select * from puntos_cercanos($1, $2, 0)", [CENTRO.lat, CENTRO.lng])).rejects.toMatchObject({
        code: "22023",
      });
      await expect(
        cliente().query("select * from puntos_cercanos($1, $2, 50001)", [CENTRO.lat, CENTRO.lng]),
      ).rejects.toMatchObject({ code: "22023" });
    });

    it("rechaza coordenadas fuera de rango", async () => {
      await expect(cliente().query("select * from puntos_cercanos(95, $1, 1000)", [CENTRO.lng])).rejects.toMatchObject({
        code: "22023",
      });
    });
  });

  describe("buscar_fragmentos (RAG)", () => {
    const vector = `[${Array.from({ length: DIMENSION }, () => "0.01").join(",")}]`;

    it("rechaza vectores de otra dimensión", async () => {
      await expect(cliente().query("select * from buscar_fragmentos('[1,2,3]'::vector)")).rejects.toMatchObject({
        code: "22000",
      });
    });

    it("rechaza una cantidad fuera de rango", async () => {
      await expect(cliente().query("select * from buscar_fragmentos($1::vector, 0)", [vector])).rejects.toMatchObject({
        code: "22023",
      });
    });

    it("encuentra el fragmento más parecido y omite documentos inactivos", async () => {
      const doc = await cliente().query<{ id: string }>(
        "insert into documentos_conocimiento (titulo, fuente) values ('[PRUEBA] documento', 'prueba') returning id",
      );
      const documentoId = doc.rows[0]?.id;
      await cliente().query(
        "insert into fragmentos (documento_id, texto, embedding) values ($1, '[PRUEBA] fragmento', $2::vector)",
        [documentoId, vector],
      );

      const activo = await cliente().query<{ distancia: number }>("select distancia from buscar_fragmentos($1::vector, 3)", [
        vector,
      ]);
      expect(activo.rows).toHaveLength(1);
      expect(Number(activo.rows[0]?.distancia)).toBeCloseTo(0, 5);

      await cliente().query("update documentos_conocimiento set activo = false where id = $1", [documentoId]);
      const inactivo = await cliente().query("select 1 from buscar_fragmentos($1::vector, 3)", [vector]);
      expect(inactivo.rows).toHaveLength(0);
    });

    it("no es ejecutable por usuarios anónimos ni autenticados", async () => {
      await expect(
        comoRol(cliente(), "anon", null, () => cliente().query("select 1 from buscar_fragmentos($1::vector, 1)", [vector])),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("los fragmentos no son legibles por usuarios autenticados", async () => {
      await expect(
        comoRol(cliente(), "authenticated", randomUUID(), () => cliente().query("select id from fragmentos")),
      ).rejects.toMatchObject({ code: "42501" });
    });
  });

  describe("creación automática de perfiles", () => {
    it("crea un perfil de ciudadano con el nombre del registro", async () => {
      const id = randomUUID();
      await cliente().query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [
        id,
        "nueva@prueba.invalid",
        { nombre: "Nueva" },
      ]);
      const { rows } = await cliente().query<{ nombre: string; rol: string; activo: boolean }>(
        "select nombre, rol, activo from perfiles where id = $1",
        [id],
      );
      expect(rows[0]).toEqual({ nombre: "Nueva", rol: "ciudadano", activo: true });
    });

    it("no permite elevar el rol desde los metadatos del registro", async () => {
      const id = randomUUID();
      await cliente().query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [
        id,
        "pillo@prueba.invalid",
        { nombre: "Pillo", rol: "administrador" },
      ]);
      const { rows } = await cliente().query<{ rol: string }>("select rol from perfiles where id = $1", [id]);
      expect(rows[0]?.rol).toBe("ciudadano");
    });

    it("usa 'Ciudadano' como nombre si el registro no trae uno", async () => {
      const id = randomUUID();
      await cliente().query("insert into auth.users (id, email) values ($1, $2)", [id, "sin-nombre@prueba.invalid"]);
      const { rows } = await cliente().query<{ nombre: string }>("select nombre from perfiles where id = $1", [id]);
      expect(rows[0]?.nombre).toBe("Ciudadano");
    });
  });

  describe("auditoría inmutable, incluso para la llave de servicio", () => {
    beforeAll(async () => {
      await cliente().query("insert into auditoria (accion, tabla) values ('alta', 'puntos')");
    });

    it("bloquea update", async () => {
      await expect(cliente().query("update auditoria set accion = 'cambio'")).rejects.toMatchObject({ code: "P0001" });
    });

    it("bloquea delete", async () => {
      await expect(cliente().query("delete from auditoria")).rejects.toMatchObject({ code: "P0001" });
    });

    it("bloquea truncate", async () => {
      await expect(cliente().query("truncate auditoria")).rejects.toMatchObject({ code: "P0001" });
    });
  });
});
