import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

/** Deben coincidir con entornoDePrueba(): secreto-falso y proyecto-falso. */
export const SECRETO_PRUEBA = "secreto-falso";
export const EMISOR_PRUEBA = "https://proyecto-falso.supabase.co/auth/v1";

export interface OpcionesToken {
  sub?: string;
  aud?: string;
  iss?: string;
  /** Segundos desde ahora; negativo para un token vencido. */
  expiraEn?: number;
  secreto?: string;
  claims?: Record<string, unknown>;
}

/** Token HS256 con la forma de los de Supabase Auth. */
export async function tokenDePrueba(opciones: OpcionesToken = {}): Promise<string> {
  const ahora = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: "authenticated", ...opciones.claims })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(opciones.sub ?? randomUUID())
    .setAudience(opciones.aud ?? "authenticated")
    .setIssuer(opciones.iss ?? EMISOR_PRUEBA)
    .setIssuedAt(ahora)
    .setExpirationTime(ahora + (opciones.expiraEn ?? 3600))
    .sign(new TextEncoder().encode(opciones.secreto ?? SECRETO_PRUEBA));
}
