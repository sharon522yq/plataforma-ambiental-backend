import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

/** Tabla de control: registra qué migraciones ya se aplicaron. Vive fuera de public. */
const TABLA_CONTROL = "esquema_migraciones.aplicadas";
const PATRON_ARCHIVO = /^\d{3}_[a-z0-9_]+\.sql$/;

export interface ResultadoMigraciones {
  aplicadas: string[];
  omitidas: string[];
}

/**
 * Aplica, en orden, las migraciones que aún no están registradas.
 * Cada migración corre en su propia transacción: si falla, no queda a medias.
 * Los mensajes de error nunca incluyen la cadena de conexión.
 */
export async function aplicarMigraciones(url: string, carpeta: string): Promise<ResultadoMigraciones> {
  const archivos = (await readdir(carpeta)).filter((n) => PATRON_ARCHIVO.test(n)).sort();

  const cliente = new pg.Client({ connectionString: url });
  await cliente.connect();
  try {
    await cliente.query("create schema if not exists esquema_migraciones");
    await cliente.query(
      `create table if not exists ${TABLA_CONTROL} (
         nombre text primary key,
         aplicado_en timestamptz not null default now()
       )`,
    );
    const { rows } = await cliente.query<{ nombre: string }>(`select nombre from ${TABLA_CONTROL}`);
    const yaAplicadas = new Set(rows.map((r) => r.nombre));

    const resultado: ResultadoMigraciones = { aplicadas: [], omitidas: [] };
    for (const nombre of archivos) {
      if (yaAplicadas.has(nombre)) {
        resultado.omitidas.push(nombre);
        continue;
      }
      const sql = await readFile(path.join(carpeta, nombre), "utf8");
      await cliente.query("begin");
      try {
        await cliente.query(sql);
        await cliente.query(`insert into ${TABLA_CONTROL} (nombre) values ($1)`, [nombre]);
        await cliente.query("commit");
      } catch (error) {
        await cliente.query("rollback");
        const detalle = error instanceof Error ? error.message : "error desconocido";
        throw new Error(`Falló la migración ${nombre}: ${detalle}`, { cause: error });
      }
      resultado.aplicadas.push(nombre);
    }
    return resultado;
  } finally {
    await cliente.end();
  }
}
