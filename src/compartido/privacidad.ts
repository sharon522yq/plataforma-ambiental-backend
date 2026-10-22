/**
 * Quita correos y teléfonos de textos que se van a publicar (descripciones de aportes y puntos).
 * Es una protección básica: no reemplaza la revisión del moderador.
 */
const CORREO = /[\p{L}0-9._%+-]+@[\p{L}0-9.-]+\.[\p{L}]{2,}/giu;
// Secuencias de dígitos con separadores comunes de teléfono: +52 (33) 1234-5678, 33 1234 5678, 3312345678.
const POSIBLE_TELEFONO = /\+?\(?\d[\d\s().-]{7,}\d/g;
// Coordenadas decimales (20.659712, -103.349634) no son teléfonos.
const COORDENADA = /^-?\d{1,3}\.\d{4,}$/;
const MINIMO_DIGITOS_TELEFONO = 10;

export function quitarDatosPersonales(texto: string): string {
  return texto
    .replace(CORREO, "[correo eliminado]")
    .replace(POSIBLE_TELEFONO, (coincidencia) => {
      const digitos = coincidencia.replace(/\D/g, "").length;
      const pedazos = coincidencia.trim().split(/[\s,]+/);
      if (digitos < MINIMO_DIGITOS_TELEFONO || pedazos.every((p) => COORDENADA.test(p))) return coincidencia;
      return "[teléfono eliminado]";
    });
}
