import { randomUUID } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { crearApp } from "../../src/app.js";
import type { Perfil } from "../../src/compartido/perfiles.js";
import type { Rol } from "../../src/compartido/sesion.js";
import { crearVerificadorJwt } from "../../src/config/jwt.js";
import { almacenFalso } from "../ayudas/almacen-falso.js";
import { clienteFalso } from "../ayudas/cliente-falso.js";
import { entornoDePrueba } from "../ayudas/entorno.js";
import { conversacionesFalsas, iaFalsa } from "../ayudas/ia-falsa.js";
import { perfilesFalsos } from "../ayudas/perfiles-falsos.js";
import { rpcFalso } from "../ayudas/rpc-falso.js";
import { EMISOR_PRUEBA, SECRETO_PRUEBA, tokenDePrueba } from "../ayudas/tokens.js";

/**
 * Matriz de permisos (sección 8): cada endpoint contra cada tipo de sesión. Solo comprueba la
 * puerta de entrada: sin sesión 401, rol sin permiso 403, rol con permiso ni 401 ni 403
 * (lo que pase después, validación o base, lo cubren las pruebas de cada módulo).
 */
const ID = randomUUID();
const USUARIOS = {
  ciudadano: randomUUID(),
  moderador: randomUUID(),
  editor: randomUUID(),
  administrador: randomUUID(),
} satisfies Record<Rol, string>;
const INACTIVO = randomUUID();
const SIN_PERFIL = randomUUID();
const tabla: Record<string, Perfil> = {
  [USUARIOS.ciudadano]: { rol: "ciudadano", activo: true },
  [USUARIOS.moderador]: { rol: "moderador", activo: true },
  [USUARIOS.editor]: { rol: "editor", activo: true },
  [USUARIOS.administrador]: { rol: "administrador", activo: true },
  // Un administrador desactivado no conserva ningún permiso.
  [INACTIVO]: { rol: "administrador", activo: false },
};

function app() {
  return crearApp(entornoDePrueba({ LIMITE_SOLICITUDES_POR_MINUTO: "10000" }), {
    publico: clienteFalso({ error: null }),
    verificador: crearVerificadorJwt({ secreto: SECRETO_PRUEBA, emisor: EMISOR_PRUEBA }),
    perfiles: perfilesFalsos(tabla),
    clienteUsuario: () => rpcFalso({}).cliente,
    almacen: almacenFalso().almacen,
    ia: iaFalsa().ia,
    conversaciones: conversacionesFalsas().conversaciones,
  });
}

type Metodo = "get" | "post" | "patch";
const TODOS: Rol[] = ["ciudadano", "moderador", "editor", "administrador"];
const MODERACION: Rol[] = ["moderador", "administrador"];
const CATALOGO: Rol[] = ["editor", "administrador"];
const ADMIN: Rol[] = ["administrador"];

const protegidos: [Metodo, string, Rol[]][] = [
  ["get", "/api/v1/sesion", TODOS],
  ["post", "/api/v1/aportes", TODOS],
  ["get", "/api/v1/aportes/mis", TODOS],
  ["post", `/api/v1/aportes/${ID}/evidencia`, TODOS],
  ["get", "/api/v1/admin/aportes", MODERACION],
  ["patch", `/api/v1/admin/aportes/${ID}/revision`, MODERACION],
  ["post", "/api/v1/admin/puntos", MODERACION],
  ["patch", `/api/v1/admin/puntos/${ID}/estado`, MODERACION],
  ["post", "/api/v1/admin/acciones", CATALOGO],
  ["post", "/api/v1/admin/organizaciones", CATALOGO],
  ["get", "/api/v1/admin/usuarios", ADMIN],
  ["patch", `/api/v1/admin/usuarios/${ID}/rol`, ADMIN],
  ["get", "/api/v1/admin/auditoria", ADMIN],
  ["get", "/api/v1/salud/ia", ADMIN],
];

const publicos: [Metodo, string][] = [
  ["get", "/api/v1/salud"],
  ["get", "/api/v1/puntos"],
  ["get", "/api/v1/puntos/cercanos?lat=20.67&lng=-103.35"],
  ["get", `/api/v1/puntos/${ID}`],
  ["get", "/api/v1/acciones"],
  ["get", "/api/v1/organizaciones"],
  ["post", "/api/v1/agente/consulta"],
];

const enviar = (a: ReturnType<typeof app>, metodo: Metodo, ruta: string, autorizacion?: string) => {
  const s = request(a)[metodo](ruta);
  return autorizacion ? s.set("Authorization", autorizacion) : s;
};
const bearer = async (sub: string) => `Bearer ${await tokenDePrueba({ sub })}`;

// Una fila por endpoint y sesión, para que un fallo diga exactamente cuál.
const filas = protegidos.flatMap(([metodo, ruta, permitidos]) =>
  TODOS.map((rol) => ({ metodo, ruta, rol, permitido: permitidos.includes(rol) })),
);

describe("matriz de permisos", () => {
  const a = app();

  it("cubre todos los endpoints protegidos de la API", () => {
    expect(protegidos).toHaveLength(14);
  });

  it.each(protegidos)("%s %s sin token responde 401", async (metodo, ruta) => {
    const r = await enviar(a, metodo, ruta);
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: { codigo: "NO_AUTENTICADO" } });
  });

  it.each(protegidos)("%s %s con un token inválido responde 401", async (metodo, ruta) => {
    const vencido = await tokenDePrueba({ sub: USUARIOS.administrador, expiraEn: -60 });
    const ajeno = await tokenDePrueba({ sub: USUARIOS.administrador, secreto: "otro-secreto" });
    for (const token of [vencido, ajeno, "no-es-un-jwt"]) {
      const r = await enviar(a, metodo, ruta, `Bearer ${token}`);
      expect(r.status).toBe(401);
    }
  });

  it.each(filas)("$metodo $ruta como $rol → permitido: $permitido", async ({ metodo, ruta, rol, permitido }) => {
    const r = await enviar(a, metodo, ruta, await bearer(USUARIOS[rol]));
    if (permitido) {
      expect([401, 403]).not.toContain(r.status);
    } else {
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ error: { codigo: "PROHIBIDO" } });
    }
  });

  it.each(protegidos)("%s %s con una cuenta inactiva responde 403", async (metodo, ruta) => {
    const r = await enviar(a, metodo, ruta, await bearer(INACTIVO));
    expect(r.status).toBe(403);
  });

  it.each(protegidos)("%s %s con un token válido sin perfil responde 403", async (metodo, ruta) => {
    const r = await enviar(a, metodo, ruta, await bearer(SIN_PERFIL));
    expect(r.status).toBe(403);
  });

  it.each(publicos)("%s %s es público: no pide sesión", async (metodo, ruta) => {
    const r = await enviar(a, metodo, ruta);
    expect([401, 403]).not.toContain(r.status);
  });
});
