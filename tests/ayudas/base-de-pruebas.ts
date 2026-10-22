import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { aplicarMigraciones } from "../../src/config/migraciones.js";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface BaseDePruebas {
  url: string;
  limpiar: () => Promise<void>;
}

/**
 * Crea una base nueva y descartable dentro del servidor de pruebas.
 * Requiere TEST_DATABASE_URL (superusuario local). Nunca apunta a Supabase de producción.
 */
export async function crearBaseDePruebas(opciones: { migrar?: boolean } = {}): Promise<BaseDePruebas> {
  const admin = process.env.TEST_DATABASE_URL;
  if (!admin) throw new Error("Falta TEST_DATABASE_URL (base de pruebas)");

  const nombre = `pruebas_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const mantenimiento = new pg.Client({ connectionString: admin });
  await mantenimiento.connect();
  await mantenimiento.query(`create database ${nombre}`);

  const destino = new URL(admin);
  destino.pathname = `/${nombre}`;
  const url = destino.toString();

  const base = new pg.Client({ connectionString: url });
  await base.connect();
  try {
    await base.query(await readFile(path.join(RAIZ, "tests/ayudas/base-local.sql"), "utf8"));
  } finally {
    await base.end();
  }

  if (opciones.migrar !== false) {
    await aplicarMigraciones(url, path.join(RAIZ, "migrations"));
  }

  return {
    url,
    limpiar: async () => {
      await mantenimiento.query(`drop database if exists ${nombre} with (force)`);
      await mantenimiento.end();
    },
  };
}

/**
 * Ejecuta fn dentro de una transacción que se revierte al final, como el rol indicado.
 * uid simula el usuario autenticado (lo lee auth.uid()).
 */
export async function comoRol<T>(
  cliente: pg.Client,
  rol: "anon" | "authenticated",
  uid: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  await cliente.query("begin");
  try {
    if (uid) await cliente.query("select set_config('request.jwt.claim.sub', $1, true)", [uid]);
    await cliente.query(`set local role ${rol}`);
    return await fn();
  } finally {
    await cliente.query("rollback");
  }
}
