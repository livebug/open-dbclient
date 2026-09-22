/**
 * Generates `media/icon/icon.png`, the 128x128 PNG that the Marketplace shows next to the
 * extension name.
 *
 * The Marketplace accepts PNG only, and the repository's other icons are SVG, so the bitmap has to
 * be produced one way or another. Rather than add an image library — the whole point of this project
 * is that it has no dependencies — the PNG is encoded here directly, which is only about forty lines
 * of zlib plus a CRC table.
 *
 * Supersampling is used instead of any anti-aliasing maths: the shape is drawn at 4x into an RGBA
 * buffer and each 4x4 block is averaged down. That is enough to make the curves clean at the size
 * anybody will actually see.
 *
 * Run with: node scripts/make-icon.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 128;
const SCALE = 4;
const HI = SIZE * SCALE;

const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'media', 'icon', 'icon.png');

// --- geometry, in final-image pixels -------------------------------------------------------------

const CORNER_RADIUS = 26;
const CYLINDER = {
  centerX: 64,
  radiusX: 29,
  radiusY: 11,
  topCenterY: 44,
  bottomCenterY: 85,
};

const BAND_OFFSETS = [0.36, 0.72];
const BAND_HALF_THICKNESS = 0.9;
const BAND_COLOR = [47, 104, 168];

// --- paints --------------------------------------------------------------------------------------

/** Blends `top` towards `bottom` over the full height and returns an [r, g, b] triple. */
function backgroundGradient(y) {
  const t = y / (SIZE - 1);
  return [
    Math.round(43 + (22 - 43) * t),
    Math.round(58 + (28 - 58) * t),
    Math.round(79 + (37 - 79) * t),
  ];
}

function cylinderGradient(y) {
  const span = CYLINDER.bottomCenterY + CYLINDER.radiusY - (CYLINDER.topCenterY - CYLINDER.radiusY);
  const t = Math.min(Math.max((y - (CYLINDER.topCenterY - CYLINDER.radiusY)) / span, 0), 1);
  return [
    Math.round(129 + (46 - 129) * t),
    Math.round(199 + (124 - 199) * t),
    Math.round(255 + (214 - 255) * t),
  ];
}

// --- shape membership ----------------------------------------------------------------------------

function insideRoundedRect(x, y) {
  const half = SIZE / 2;
  const dx = Math.max(Math.abs(x - half) - (half - CORNER_RADIUS), 0);
  const dy = Math.max(Math.abs(y - half) - (half - CORNER_RADIUS), 0);
  return Math.hypot(dx, dy) <= CORNER_RADIUS;
}

function insideEllipse(x, y, centerY) {
  const nx = (x - CYLINDER.centerX) / CYLINDER.radiusX;
  const ny = (y - centerY) / CYLINDER.radiusY;
  return nx * nx + ny * ny <= 1;
}

function insideCylinder(x, y) {
  const { centerX, radiusX, topCenterY, bottomCenterY } = CYLINDER;
  if (insideEllipse(x, y, topCenterY) || insideEllipse(x, y, bottomCenterY)) {
    return true;
  }
  const withinWidth = Math.abs(x - centerX) <= radiusX;
  return withinWidth && y >= topCenterY && y <= bottomCenterY;
}

/**
 * True when the point sits on one of the elliptical seams that give a plain rounded rectangle the
 * look of a stack of disks. Solving the ellipse for y at a given x keeps the stroke a constant
 * thickness, which testing a normalised distance would not.
 */
function onBandStroke(x, y) {
  const { centerX, radiusX, radiusY, topCenterY, bottomCenterY } = CYLINDER;
  const nx = (x - centerX) / radiusX;
  if (nx * nx > 1) {
    return false;
  }
  const halfHeight = radiusY * Math.sqrt(1 - nx * nx);
  for (const offset of BAND_OFFSETS) {
    const centerY = topCenterY + (bottomCenterY - topCenterY) * offset;
    if (Math.abs(y - (centerY - halfHeight)) <= BAND_HALF_THICKNESS) {
      return true;
    }
    if (Math.abs(y - (centerY + halfHeight)) <= BAND_HALF_THICKNESS) {
      return true;
    }
  }
  return false;
}

// --- rasterisation -------------------------------------------------------------------------------

/** Renders straight to RGBA, with the cylinder composited over the rounded-rect background. */
function render() {
  const pixels = new Uint8Array(HI * HI * 4);
  for (let y = 0; y < HI; y += 1) {
    const fy = (y + 0.5) / SCALE;
    for (let x = 0; x < HI; x += 1) {
      const fx = (x + 0.5) / SCALE;
      const offset = (y * HI + x) * 4;

      if (!insideRoundedRect(fx, fy)) {
        continue;
      }

      let [r, g, b] = backgroundGradient(fy);
      if (insideCylinder(fx, fy)) {
        [r, g, b] = onBandStroke(fx, fy) ? BAND_COLOR : cylinderGradient(fy);
      }

      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

/** Averages each SCALE x SCALE block, in premultiplied alpha, so edges do not fringe dark. */
function downsample(pixels) {
  const out = new Uint8Array(SIZE * SIZE * 4);
  const samples = SCALE * SCALE;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SCALE; sy += 1) {
        for (let sx = 0; sx < SCALE; sx += 1) {
          const offset = ((y * SCALE + sy) * HI + (x * SCALE + sx)) * 4;
          const alpha = pixels[offset + 3] / 255;
          r += pixels[offset] * alpha;
          g += pixels[offset + 1] * alpha;
          b += pixels[offset + 2] * alpha;
          a += pixels[offset + 3];
        }
      }
      const outOffset = (y * SIZE + x) * 4;
      const alpha = a / samples;
      // Un-premultiplying by the averaged alpha keeps the colour of a partially covered pixel
      // correct instead of dragging it towards black.
      const weight = a === 0 ? 0 : (alpha / 255) * samples;
      out[outOffset] = weight === 0 ? 0 : Math.round(r / weight);
      out[outOffset + 1] = weight === 0 ? 0 : Math.round(g / weight);
      out[outOffset + 2] = weight === 0 ? 0 : Math.round(b / weight);
      out[outOffset + 3] = Math.round(alpha);
    }
  }
  return out;
}

// --- PNG container -------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlacing

  // Filter type 0 (None) on every scanline. The image is small and mostly flat, so deflate handles it
  // well enough that a smarter filter would not pay for itself in code.
  const stride = SIZE * 4;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = encodePng(downsample(render()));
mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, png);
console.log(`[icon] wrote ${OUTPUT} (${SIZE}x${SIZE}, ${png.length} bytes)`);
