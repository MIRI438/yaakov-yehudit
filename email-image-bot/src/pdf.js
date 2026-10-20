// All the images of a reply in one PDF: one image per page, the page the size of the image.
// JPEG files go in as they are (no re-compression); other formats are decoded with ffmpeg and stored
// losslessly, on white where they are transparent. Videos are not included (they are sent as videos).

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { run, withTempDir } from './video.js';

const POINTS_PER_PIXEL = 0.75; // 96 dpi: the page shows the image at its natural size

/** Width, height and colour components of a JPEG (from its frame header), or null. */
function jpegInfo(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), components: buf[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

/** Any image ffmpeg can read -> raw RGB on a white background. */
async function decodeToRgb(file) {
  return withTempDir(async (dir) => {
    const input = path.join(dir, `in${path.extname(file.filename) || '.img'}`);
    await writeFile(input, file.content);
    const probe = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', input,
    ]);
    const [width, height] = String(probe).trim().split('x').map(Number);
    if (!width || !height) throw new Error('unreadable image');
    const rgb = await run(
      'ffmpeg',
      [
        '-v', 'error', '-i', input, '-f', 'lavfi', '-i', `color=white:s=${width}x${height}`,
        '-filter_complex', '[1][0]overlay=format=auto,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: width * height * 3 + 1024 },
    );
    if (rgb.length !== width * height * 3) throw new Error('unexpected image size');
    return { width, height, rgb };
  });
}

async function imageObject(file) {
  const jpeg = /jpe?g/i.test(file.contentType) && jpegInfo(file.content);
  if (jpeg && [1, 3, 4].includes(jpeg.components)) {
    const space = { 1: '/DeviceGray', 3: '/DeviceRGB', 4: '/DeviceCMYK' }[jpeg.components];
    // CMYK JPEGs (usually from Adobe) are stored inverted.
    const decode = jpeg.components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
    return {
      width: jpeg.width,
      height: jpeg.height,
      dict: `/Type /XObject /Subtype /Image /Width ${jpeg.width} /Height ${jpeg.height} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode${decode}`,
      data: file.content,
    };
  }
  const { width, height, rgb } = await decodeToRgb(file);
  return {
    width,
    height,
    dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
    data: deflateSync(rgb, { level: 9 }),
  };
}

/** files: image files ({ content, contentType, filename }). Returns the PDF, or null if no image could be added. */
export async function imagesToPdf(files, filename = 'images.pdf') {
  const images = [];
  for (const f of files) {
    try {
      images.push(await imageObject(f));
    } catch {
      /* an image that cannot be read is left out of the PDF (the caller sends it as is) */
      f.notInPdf = true;
    }
  }
  if (!images.length) return null;

  // Objects: 1 catalog, 2 page tree, then for each image: page, contents, image.
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (chunk) => {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'latin1');
    parts.push(b);
    size += b.length;
  };
  const object = (n, body, stream) => {
    offsets[n] = size;
    if (stream) {
      push(`${n} 0 obj\n<< ${body} /Length ${stream.length} >>\nstream\n`);
      push(stream);
      push('\nendstream\nendobj\n');
    } else push(`${n} 0 obj\n${body}\nendobj\n`);
  };

  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  const pageIds = images.map((_, i) => 3 + i * 3);
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${images.length} >>`);
  images.forEach((img, i) => {
    const [page, contents, xobject] = [3 + i * 3, 4 + i * 3, 5 + i * 3];
    const w = +(img.width * POINTS_PER_PIXEL).toFixed(2);
    const h = +(img.height * POINTS_PER_PIXEL).toFixed(2);
    object(
      page,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${xobject} 0 R >> >> /Contents ${contents} 0 R >>`,
    );
    object(contents, '', Buffer.from(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`, 'latin1'));
    object(xobject, img.dict, img.data);
  });

  const count = 3 + images.length * 3;
  const xref = size;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  return { filename, content: Buffer.concat(parts), contentType: 'application/pdf', pages: images.length };
}

const isImage = (f) => f.content && /^image\//.test(f.contentType || '');

/**
 * The files to send: the images as one PDF, then the videos (and any image the PDF could not take).
 * Falls back to the files as they are when there are no images, PDF=off, or the PDF would be too big.
 */
export async function packImagesAsPdf(files, maxBytes) {
  const images = files.filter(isImage);
  if (process.env.PDF === 'off' || !images.length) return { files, pdf: null };
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const pdf = await imagesToPdf(images, `images-${day}.pdf`).catch(() => null);
  if (!pdf || pdf.content.length > maxBytes) return { files, pdf: null };
  const inPdf = new Set(images.filter((f) => !f.notInPdf));
  pdf.has = (f) => inPdf.has(f);
  return { files: [pdf, ...files.filter((f) => !inPdf.has(f))], pdf };
}
