import type { NextFunction, Request, Response } from "express";
import { z, type ZodType } from "zod";
import { SolicitudInvalida } from "../compartido/errores.js";

// Los mensajes de validación que ve el cliente (en `detalles`) salen en español.
z.config(z.locales.es());

interface Esquemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/** Valida body, query y params con Zod antes de llegar al controlador. */
export function validar(esquemas: Esquemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const partes = ["body", "query", "params"] as const;
    for (const parte of partes) {
      const esquema = esquemas[parte];
      if (!esquema) continue;
      const r = esquema.safeParse(req[parte]);
      if (!r.success) {
        next(
          new SolicitudInvalida(
            `Datos inválidos en ${parte}`,
            r.error.issues.map((i) => ({ parte, campo: i.path.join("."), mensaje: i.message })),
          ),
        );
        return;
      }
      Object.defineProperty(req, parte, { value: r.data, writable: true, configurable: true });
    }
    next();
  };
}
