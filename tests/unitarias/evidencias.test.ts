import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { conEnlaces, crearAlmacenSupabase, DURACION_ENLACE_SEGUNDOS, prepararEvidencia } from "../../src/compartido/evidencias.js";
import { almacenFalso } from "../ayudas/almacen-falso.js";

const imagen = (ancho: number, alto: number) =>
  sharp({ create: { width: ancho, height: alto, channels: 3, background: { r: 30, g: 120, b: 60 } } });

describe("prepararEvidencia", () => {
  it("quita los metadatos EXIF, incluida la ubicación GPS", async () => {
    const original = await imagen(800, 600)
      .withExif({ IFD0: { Make: "CamaraDePrueba", Model: "X1" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "20/1 39/1 0/1" } })
      .jpeg()
      .toBuffer();
    expect((await sharp(original).metadata()).exif).toBeDefined(); // la prueba tiene sentido solo si había EXIF

    const limpia = await prepararEvidencia(original);
    const meta = await sharp(limpia).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.format).toBe("jpeg");
    expect(limpia.includes(Buffer.from("CamaraDePrueba"))).toBe(false);
  });

  it("reduce a 1600 px por lado sin deformar y no agranda las pequeñas", async () => {
    const grande = await prepararEvidencia(await imagen(4000, 2000).png().toBuffer());
    expect(await sharp(grande).metadata()).toMatchObject({ width: 1600, height: 800, format: "jpeg" });
    const chica = await prepararEvidencia(await imagen(300, 200).webp().toBuffer());
    expect(await sharp(chica).metadata()).toMatchObject({ width: 300, height: 200 });
  });

  it("aplica la orientación de la cámara antes de quitarla", async () => {
    const girada = await imagen(400, 200).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const limpia = await prepararEvidencia(girada);
    expect(await sharp(limpia).metadata()).toMatchObject({ width: 200, height: 400 });
  });

  it.each([
    ["un texto", () => Promise.resolve(Buffer.from("esto no es una foto"))],
    ["un GIF", () => imagen(10, 10).gif().toBuffer()],
    ["un SVG", () => Promise.resolve(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'))],
  ])("rechaza %s con 400", async (_caso, crear) => {
    await expect(prepararEvidencia(await crear())).rejects.toMatchObject({ estado: 400 });
  });
});

describe("conEnlaces", () => {
  it("cambia la ruta interna por un enlace temporal y deja null si no hay foto", async () => {
    const { almacen } = almacenFalso();
    const r = await conEnlaces(almacen, [{ id: "a", evidencia_ruta: "u/a.jpg" }, { id: "b", evidencia_ruta: null }]);
    expect(r).toEqual([
      { id: "a", evidencia: { url: "https://firmado.prueba/u/a.jpg?token=t", expira_en_segundos: DURACION_ENLACE_SEGUNDOS } },
      { id: "b", evidencia: null },
    ]);
  });

  it("si Storage no firma, la foto sigue indicada pero sin url", async () => {
    const { almacen } = almacenFalso({ sinEnlaces: true });
    const [r] = await conEnlaces(almacen, [{ evidencia_ruta: "u/a.jpg" }]);
    expect(r).toEqual({ evidencia: { url: null, expira_en_segundos: DURACION_ENLACE_SEGUNDOS } });
  });
});

describe("crearAlmacenSupabase", () => {
  type Error = { message: string; statusCode?: string } | null;
  function servicioFalso(r: { subir?: Error; borrar?: Error; firmar?: { data: unknown; error: Error } }) {
    const bucket = {
      upload: vi.fn(() => Promise.resolve({ error: r.subir ?? null })),
      remove: vi.fn(() => Promise.resolve({ error: r.borrar ?? null })),
      createSignedUrls: vi.fn(() => Promise.resolve(r.firmar ?? { data: [], error: null })),
    };
    const from = vi.fn(() => bucket);
    return { cliente: { storage: { from } } as unknown as SupabaseClient, bucket, from };
  }

  it("sube al bucket privado como JPEG y sin reemplazar", async () => {
    const { cliente, bucket, from } = servicioFalso({});
    expect(await crearAlmacenSupabase(cliente).subir("u/a.jpg", Buffer.from("x"))).toBe("ok");
    expect(from).toHaveBeenCalledWith("evidencias");
    expect(bucket.upload).toHaveBeenCalledWith("u/a.jpg", Buffer.from("x"), { contentType: "image/jpeg", upsert: false });
  });

  it.each([
    [{ message: "The resource already exists", statusCode: "409" }],
    [{ message: "Duplicate" }],
  ])("devuelve 'existe' si el archivo ya está (%o)", async (error) => {
    const { cliente } = servicioFalso({ subir: error });
    expect(await crearAlmacenSupabase(cliente).subir("u/a.jpg", Buffer.from("x"))).toBe("existe");
  });

  it("otro error al subir se lanza sin detalles", async () => {
    const { cliente } = servicioFalso({ subir: { message: "secreto interno", statusCode: "500" } });
    await expect(crearAlmacenSupabase(cliente).subir("u/a.jpg", Buffer.from("x"))).rejects.toThrow("No se pudo guardar la evidencia");
  });

  it("un fallo al borrar se registra sin la ruta y no se lanza", async () => {
    const espia = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { cliente } = servicioFalso({ borrar: { message: "x" } });
    await crearAlmacenSupabase(cliente).borrar("u/a.jpg");
    expect(espia).toHaveBeenCalledWith(expect.stringContaining("evidencia_no_borrada"));
    expect(espia).not.toHaveBeenCalledWith(expect.stringContaining("u/a.jpg"));
    espia.mockRestore();
  });

  it("firma por 10 minutos y omite las rutas que fallaron", async () => {
    const { cliente, bucket } = servicioFalso({
      firmar: { data: [{ path: "u/a.jpg", signedUrl: "https://s/a", error: null }, { path: "u/b.jpg", signedUrl: "", error: "Not found" }], error: null },
    });
    const enlaces = await crearAlmacenSupabase(cliente).firmar(["u/a.jpg", "u/b.jpg"]);
    expect(bucket.createSignedUrls).toHaveBeenCalledWith(["u/a.jpg", "u/b.jpg"], DURACION_ENLACE_SEGUNDOS);
    expect([...enlaces]).toEqual([["u/a.jpg", "https://s/a"]]);
  });

  it("sin rutas no llama a Storage; si Storage falla devuelve vacío", async () => {
    const { cliente, bucket } = servicioFalso({});
    expect((await crearAlmacenSupabase(cliente).firmar([])).size).toBe(0);
    expect(bucket.createSignedUrls).not.toHaveBeenCalled();
    const espia = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fallo = servicioFalso({ firmar: { data: null, error: { message: "caído" } } });
    expect((await crearAlmacenSupabase(fallo.cliente).firmar(["u/a.jpg"])).size).toBe(0);
    espia.mockRestore();
  });
});
