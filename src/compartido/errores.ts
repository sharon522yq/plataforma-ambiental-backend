export class ErrorAplicacion extends Error {
  constructor(
    readonly estado: number,
    readonly codigo: string,
    mensaje: string,
    readonly detalles: unknown[] = [],
  ) {
    super(mensaje);
  }
}

export class SolicitudInvalida extends ErrorAplicacion {
  constructor(mensaje = "Los datos enviados no son válidos", detalles: unknown[] = []) {
    super(400, "SOLICITUD_INVALIDA", mensaje, detalles);
  }
}
export class NoAutenticado extends ErrorAplicacion {
  constructor(mensaje = "Debes iniciar sesión") {
    super(401, "NO_AUTENTICADO", mensaje);
  }
}
export class Prohibido extends ErrorAplicacion {
  constructor(mensaje = "No tienes permiso para esta acción") {
    super(403, "PROHIBIDO", mensaje);
  }
}
export class NoEncontrado extends ErrorAplicacion {
  constructor(mensaje = "El recurso no existe") {
    super(404, "NO_ENCONTRADO", mensaje);
  }
}
export class Conflicto extends ErrorAplicacion {
  constructor(mensaje = "La operación entra en conflicto con el estado actual") {
    super(409, "CONFLICTO", mensaje);
  }
}
export class LimiteExcedido extends ErrorAplicacion {
  constructor(mensaje = "Demasiadas solicitudes, intenta más tarde") {
    super(429, "LIMITE_EXCEDIDO", mensaje);
  }
}
