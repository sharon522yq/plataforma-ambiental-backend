import type { RequestHandler } from "express";

/** Las respuestas públicas pueden guardarse en caché un minuto (navegador o CDN). */
export const cachePublica: RequestHandler = (_req, res, siguiente) => {
  res.set("Cache-Control", "public, max-age=60");
  siguiente();
};

/** Respuestas de una sesión: nunca se guardan en caché. */
export const sinCache: RequestHandler = (_req, res, siguiente) => {
  res.set("Cache-Control", "no-store");
  siguiente();
};
