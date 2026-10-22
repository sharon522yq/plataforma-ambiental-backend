/** Registro sin datos personales: nunca recibe correos, teléfonos, tokens ni texto de mensajes. */
type Nivel = "info" | "warn" | "error";

export function registrar(nivel: Nivel, evento: string, datos: Record<string, string | number> = {}): void {
  const linea = JSON.stringify({ t: new Date().toISOString(), nivel, evento, ...datos });
  if (nivel === "error") console.error(linea);
  else console.log(linea);
}
