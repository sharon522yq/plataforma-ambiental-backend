/**
 * Parte un documento en fragmentos de hasta `maximo` caracteres para el RAG (F14).
 * Respeta párrafos; un párrafo largo se corta por oraciones y una oración larga por palabras.
 * Los párrafos cortos se juntan mientras quepan, para no perder contexto.
 */
export const MAXIMO_FRAGMENTO = 1200;

function cortarPorPalabras(texto: string, maximo: number): string[] {
  const partes: string[] = [];
  let actual = "";
  for (const palabra of texto.split(/\s+/).filter(Boolean)) {
    if (palabra.length > maximo) {
      if (actual) partes.push(actual);
      for (let i = 0; i < palabra.length; i += maximo) partes.push(palabra.slice(i, i + maximo));
      actual = "";
      continue;
    }
    const junto = actual ? `${actual} ${palabra}` : palabra;
    if (junto.length > maximo) {
      partes.push(actual);
      actual = palabra;
    } else {
      actual = junto;
    }
  }
  if (actual) partes.push(actual);
  return partes;
}

/** Piezas de a lo más `maximo` caracteres: párrafos, o sus oraciones, o sus palabras. */
function piezas(parrafo: string, maximo: number): string[] {
  if (parrafo.length <= maximo) return [parrafo];
  return parrafo
    .split(/(?<=[.!?…;:])\s+/)
    .flatMap((oracion) => (oracion.length <= maximo ? [oracion] : cortarPorPalabras(oracion, maximo)));
}

export function fragmentar(texto: string, maximo = MAXIMO_FRAGMENTO): string[] {
  const parrafos = texto
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim())
    .filter(Boolean);

  const fragmentos: string[] = [];
  let actual = "";
  for (const pieza of parrafos.flatMap((p) => piezas(p, maximo))) {
    if (!actual) actual = pieza;
    else if (actual.length + 2 + pieza.length <= maximo) actual = `${actual}\n\n${pieza}`;
    else {
      fragmentos.push(actual);
      actual = pieza;
    }
  }
  if (actual) fragmentos.push(actual);
  return fragmentos;
}
