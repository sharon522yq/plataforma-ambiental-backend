import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { crearVerificadorJwt } from "../../src/config/jwt.js";
import { EMISOR_PRUEBA, SECRETO_PRUEBA, tokenDePrueba } from "../ayudas/tokens.js";

const ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const verificador = crearVerificadorJwt({ secreto: SECRETO_PRUEBA, emisor: EMISOR_PRUEBA });

async function llavesES256() {
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "llave-1", alg: "ES256" };
  const firmar = (claims: Record<string, unknown> = {}) =>
    new SignJWT({ role: "authenticated", ...claims })
      .setProtectedHeader({ alg: "ES256", kid: "llave-1" })
      .setSubject(ID)
      .setAudience("authenticated")
      .setIssuer(EMISOR_PRUEBA)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  return { jwks: createLocalJWKSet({ keys: [jwk] }), firmar };
}

describe("verificador de JWT (HS256, secreto compartido)", () => {
  it("acepta un token válido y devuelve el id del usuario", async () => {
    await expect(verificador.verificar(await tokenDePrueba({ sub: ID }))).resolves.toEqual({ id: ID });
  });

  it("rechaza un token vencido con un mensaje de sesión expirada", async () => {
    const token = await tokenDePrueba({ expiraEn: -60 });
    await expect(verificador.verificar(token)).rejects.toMatchObject({ estado: 401 });
    await expect(verificador.verificar(token)).rejects.toThrow(/expiró/);
  });

  it.each([
    ["firmado con otro secreto", { secreto: "otro-secreto" }],
    ["de otro proyecto (emisor distinto)", { iss: "https://otro.supabase.co/auth/v1" }],
    ["sin audiencia authenticated", { aud: "anon" }],
    ["con sub que no es un uuid", { sub: "admin" }],
  ])("rechaza un token %s", async (_caso, opciones) => {
    await expect(verificador.verificar(await tokenDePrueba(opciones))).rejects.toMatchObject({ estado: 401 });
  });

  it("rechaza la llave anon del proyecto usada como token de usuario", async () => {
    const anon = await new SignJWT({ role: "anon", ref: "proyecto-falso" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("supabase")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRETO_PRUEBA));
    await expect(verificador.verificar(anon)).rejects.toMatchObject({ estado: 401 });
  });

  it("rechaza tokens sin firma (alg none) y texto que no es un JWT", async () => {
    const cuerpo = Buffer.from(JSON.stringify({ sub: ID, aud: "authenticated", iss: EMISOR_PRUEBA })).toString("base64url");
    const sinFirma = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${cuerpo}.`;
    await expect(verificador.verificar(sinFirma)).rejects.toMatchObject({ estado: 401 });
    await expect(verificador.verificar("esto-no-es-un-jwt")).rejects.toMatchObject({ estado: 401 });
  });
});

describe("verificador de JWT (llaves asimétricas, JWKS)", () => {
  it("acepta un token ES256 firmado con una llave publicada", async () => {
    const { jwks, firmar } = await llavesES256();
    const conLlaves = crearVerificadorJwt({ secreto: SECRETO_PRUEBA, emisor: EMISOR_PRUEBA, llavesPublicas: jwks });
    await expect(conLlaves.verificar(await firmar())).resolves.toEqual({ id: ID });
  });

  it("rechaza un token ES256 si no hay llaves públicas configuradas", async () => {
    const { firmar } = await llavesES256();
    await expect(verificador.verificar(await firmar())).rejects.toMatchObject({ estado: 401 });
  });

  it("rechaza un token ES256 firmado con una llave que no está publicada", async () => {
    const publicadas = await llavesES256();
    const ajena = await llavesES256();
    const conLlaves = crearVerificadorJwt({ secreto: SECRETO_PRUEBA, emisor: EMISOR_PRUEBA, llavesPublicas: publicadas.jwks });
    await expect(conLlaves.verificar(await ajena.firmar())).rejects.toMatchObject({ estado: 401 });
  });

  it("responde 503, no 401, si no se pueden descargar las llaves", async () => {
    const { firmar } = await llavesES256();
    const sinRed: JWTVerifyGetKey = () => Promise.reject(new TypeError("fetch failed"));
    const caido = crearVerificadorJwt({ secreto: SECRETO_PRUEBA, emisor: EMISOR_PRUEBA, llavesPublicas: sinRed });
    await expect(caido.verificar(await firmar())).rejects.toMatchObject({ estado: 503 });
  });
});
