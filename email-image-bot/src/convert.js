// Some images (AVIF made of tiles, as many shops serve) cannot be read by ffmpeg, but the browser shows them
// fine. This turns such an image into a JPEG with the browser, so it can be checked and opened anywhere.

const log = (...args) => console.log(new Date().toISOString(), ...args);

/** Returns { content, contentType, filename } as JPEG, or null if the browser cannot read it either. */
export async function imageToJpegWithBrowser(file) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    return null;
  }
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort()); // works only on the bytes it is given
    const base64 = await page.evaluate(
      async ([data, type]) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; // transparent parts become white
        ctx.fillRect(0, 0, bitmap.width, bitmap.height);
        ctx.drawImage(bitmap, 0, 0);
        const out = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 })).arrayBuffer());
        let s = '';
        for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
        return btoa(s);
      },
      [file.content.toString('base64'), file.contentType],
    );
    return {
      content: Buffer.from(base64, 'base64'),
      contentType: 'image/jpeg',
      filename: `${file.filename.replace(/\.[^.]+$/, '')}.jpg`,
    };
  } catch (err) {
    log(`browser could not convert ${file.filename}: ${err.message.split('\n')[0]}`);
    return null;
  } finally {
    await browser.close().catch(() => {});
  }
}
