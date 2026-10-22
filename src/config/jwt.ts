import { createRemoteJWKSet, decodeProtectedHeader, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { ErrorAplicacion, NoAutenticado } from "../compartido/errores.js";
import type { Entorno } from "./env.js";

/** Los tokens de usuarios de Supabase llevan esta audiencia. La llave anon no la tiene. */
const AUDIENCIA = "authenticated";
const ALGORITMOS_ASIMETRICOS = ["ES256", "RS256", "EdDSA"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VerificadorJwt {
  /** Devuelve el id del usuario (claim sub) o lanza NoAutenticado. */
  verificar(token: string): Promise<{ id: string }>;
}

export interface OpcionesVerificador {
  /** Secreto compartido del proyecto (tokens HS256, modo legacy de Supabase). */
  secreto: string;
  /** Emisor esperado: `<SUPABASE_URL>/auth/v1`. */
  emisor: string;
  /** Llaves públicas del proyecto (tokens ES256/RS256). Sin ellas, solo se acepta HS256. */
  llavesPublicas?: JWTVerifyGetKey;
}

/**
 * Verifica tokens de Supabase Auth (D-16). Acepta los dos modos de firma que usa Supabase:
 * secreto compartido (HS256) y llaves asimétricas publicadas en JWKS. El algoritmo se elige
 * por la cabecera del token, pero cada llave solo se usa con su propia familia de algoritmos.
 */
export function crearVerificadorJwt(opciones: OpcionesVerificador): VerificadorJwt {
  const secreto = new TextEncoder().encode(opciones.secreto);
  const comunes = { issuer: opciones.emisor, audience: AUDIENCIA, clockTolerance: 5 };

  return {
    async verificar(token) {
      let algoritmo: string | undefined;
      try {
        algoritmo = decodeProtectedHeader(token).alg;
      } catch {
        throw new NoAutenticado("El token no es válido");
      }

      let payload: JWTPayload;
      try {
        if (algoritmo === "HS256") {
          ({ payload } = await jwtVerify(token, secreto, { ...comunes, algorithms: ["HS256"] }));
        } else if (algoritmo && ALGORITMOS_ASIMETRICOS.includes(algoritmo) && opciones.llavesPublicas) {
          ({ payload } = await jwtVerify(token, opciones.llavesPublicas, {
            ...comunes,
            algorithms: ALGORITMOS_ASIMETRICOS,
          }));
        } else {
          throw new NoAutenticado("El token no es válido");
        }
      } catch (error) {
        throw traducirError(error);
      }

      if (typeof payload.sub !== "string" || !UUID.test(payload.sub)) {
        throw new NoAutenticado("El token no es válido");
      }
      return { id: payload.sub };
    },
  };
}

function traducirError(error: unknown): Error {
  if (error instanceof ErrorAplicacion) return error;
  if (error instanceof errors.JWTExpired) return new NoAutenticado("La sesión expiró, inicia sesión de nuevo");
  // No se pudieron descargar las llaves públicas: es un fallo nuestro, no del usuario.
  if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError)) {
    return new ErrorAplicacion(503, "SERVICIO_NO_DISPONIBLE", "No se pudo verificar la sesión, intenta más tarde");
  }
  return new NoAutenticado("El token no es válido");
}

/** Verificador para el proyecto configurado en el entorno. */
export function crearVerificadorSupabase(entorno: Entorno): VerificadorJwt {
  const emisor = `${entorno.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1`;
  return crearVerificadorJwt({
    secreto: entorno.SUPABASE_JWT_SECRET,
    emisor,
    llavesPublicas: createRemoteJWKSet(new URL(`${emisor}/.well-known/jwks.json`)),
  });
}
