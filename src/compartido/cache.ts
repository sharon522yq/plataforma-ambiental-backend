import type { RequestHandler } from "express";

/** Las respuestas públicas pueden guardarse en caché un minuto (navegador o CDN). */
export const cachePublica: RequestHandler = (_req, res, siguiente) => {
  res.set("Cache-Control", "public, max-age=60");
  siguiente();
};
