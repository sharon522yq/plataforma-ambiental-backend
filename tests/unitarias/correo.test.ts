import { afterEach, describe, expect, it, vi } from "vitest";
import { correoDesactivado, crearCorreo, crearCorreoBrevo, escaparHtml } from "../../src/compartido/correo.js";

const LLAVE = "llave-brevo-falsa";
const CORREO = { para: { email: "ana@correo.mx", nombre: "Ana" }, asunto: "Asunto", texto: "Hola", html: "<p>Hola</p>" };

function fetchFalso(respuesta: () => Promise<Response>) {
  const llamadas: { url: string; init: RequestInit }[] = [];
  const f = ((url: string, init: RequestInit) => {
    llamadas.push({ url, init });
    return respuesta();
  }) as unknown as typeof fetch;
  return { f, llamadas };
}

afterEach(() => vi.restoreAllMocks());

describe("correo por Brevo", () => {
  it("envía a la API HTTP con la llave en la cabecera y un solo destinatario", async () => {
    const { f, llamadas } = fetchFalso(() => Promise.resolve(new Response('{"messageId":"x"}', { status: 201 })));
    const correo = crearCorreoBrevo({ llave: LLAVE, remitente: "avisos@ejemplo.mx", nombreRemitente: "Plataforma", fetch: f });
    expect(correo.activo).toBe(true);
    expect(await correo.enviar(CORREO)).toBe(true);
    expect(llamadas).toHaveLength(1);
    const [llamada] = llamadas;
    expect(llamada?.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(llamada?.init.method).toBe("POST");
    expect(llamada?.init.headers).toMatchObject({ "api-key": LLAVE, "content-type": "application/json" });
    expect(llamada?.url).not.toContain(LLAVE);
    expect(JSON.parse(llamada?.init.body as string)).toEqual({
      sender: { email: "avisos@ejemplo.mx", name: "Plataforma" },
      to: [{ email: "ana@correo.mx", name: "Ana" }],
      subject: "Asunto",
      textContent: "Hola",
      htmlContent: "<p>Hola</p>",
    });
  });

  it("si Brevo rechaza, devuelve false y registra solo el código HTTP", async () => {
    const espia = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { f } = fetchFalso(() => Promise.resolve(new Response("{}", { status: 401 })));
    const correo = crearCorreoBrevo({ llave: LLAVE, remitente: "avisos@ejemplo.mx", nombreRemitente: "P", fetch: f });
    expect(await correo.enviar(CORREO)).toBe(false);
    const registro = espia.mock.calls.map((c) => String(c[0])).join("\n");
    expect(registro).toContain('"estado":401');
    expect(registro).not.toContain(LLAVE);
    expect(registro).not.toContain("ana@correo.mx");
  });

  it("si no hay conexión, devuelve false sin lanzar", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { f } = fetchFalso(() => Promise.reject(new Error("sin red")));
    const correo = crearCorreoBrevo({ llave: LLAVE, remitente: "avisos@ejemplo.mx", nombreRemitente: "P", fetch: f });
    expect(await correo.enviar({ ...CORREO, para: { email: "x@y.mx" } })).toBe(false);
  });

  it("sin llave o sin remitente queda desactivado", async () => {
    expect(crearCorreo({ CORREO_REMITENTE_NOMBRE: "P" })).toBe(correoDesactivado);
    expect(crearCorreo({ BREVO_API_KEY: LLAVE, CORREO_REMITENTE_NOMBRE: "P" })).toBe(correoDesactivado);
    expect(crearCorreo({ CORREO_REMITENTE: "a@b.mx", CORREO_REMITENTE_NOMBRE: "P" })).toBe(correoDesactivado);
    expect(crearCorreo({ BREVO_API_KEY: LLAVE, CORREO_REMITENTE: "a@b.mx", CORREO_REMITENTE_NOMBRE: "P" }).activo).toBe(true);
    expect(await correoDesactivado.enviar(CORREO)).toBe(false);
  });

  it("escapa el texto escrito por personas", () => {
    expect(escaparHtml(`<script>alert("x")</script> & 'y'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;");
  });
});
