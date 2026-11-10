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

export interface EstadoMigraciones {
  /** Archivos de la carpeta que la base ya tiene registrados. */
  aplicadas: string[];
  /** Archivos de la carpeta que la base aún no tiene. */
  pendientes: string[];
  /** Registradas en la base pero sin archivo en la carpeta (copia vieja del código o archivo renombrado). */
  desconocidas: string[];
}

async function listarArchivos(carpeta: string): Promise<string[]> {
  return (await readdir(carpeta)).filter((n) => PATRON_ARCHIVO.test(n)).sort();
}

/**
 * Solo lectura: compara la carpeta con lo registrado en la base, sin crear ni cambiar nada.
 * Sirve para saber qué falta antes de migrar (por ejemplo, contra producción).
 */
export async function estadoMigraciones(url: string, carpeta: string): Promise<EstadoMigraciones> {
  const archivos = await listarArchivos(carpeta);
  const cliente = new pg.Client({ connectionString: url });
  await cliente.connect();
  try {
    await cliente.query("begin read only");
    const existe = await cliente.query<{ t: string | null }>(`select to_regclass('${TABLA_CONTROL}')::text as t`);
    const registradas = existe.rows[0]?.t
      ? (await cliente.query<{ nombre: string }>(`select nombre from ${TABLA_CONTROL} order by nombre`)).rows.map((r) => r.nombre)
      : [];
    await cliente.query("rollback");
    const enBase = new Set(registradas);
    const enCarpeta = new Set(archivos);
    return {
      aplicadas: archivos.filter((n) => enBase.has(n)),
      pendientes: archivos.filter((n) => !enBase.has(n)),
      desconocidas: registradas.filter((n) => !enCarpeta.has(n)),
    };
  } finally {
    await cliente.end();
  }
}

/**
 * Aplica, en orden, las migraciones que aún no están registradas.
 * Cada migración corre en su propia transacción: si falla, no queda a medias.
 * Los mensajes de error nunca incluyen la cadena de conexión.
 */
export async function aplicarMigraciones(url: string, carpeta: string): Promise<ResultadoMigraciones> {
  const archivos = await listarArchivos(carpeta);

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
