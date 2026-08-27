/**
 * Generate Ambry's PWA icons (180/192/512 PNG) with zero dependencies:
 * a hand-rolled PNG encoder (zlib is built into node) drawing a simple
 * amber rounded square with a white pantry jar. Run: npm run icons
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(size, pixels /* RGBA */) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const S = size / 100; // design in a 100x100 space
  const corner = 18 * S;
  // amber rounded square
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const cx = x < corner ? corner - x : x >= size - corner ? x - (size - 1 - corner) : 0;
      const cy = y < corner ? corner - y : y >= size - corner ? y - (size - 1 - corner) : 0;
      if (cx * cx + cy * cy > corner * corner) continue; // outside rounded corner
      put(x, y, 138, 90, 43); // #8a5a2b
    }
  const rect = (x0, y0, x1, y1, r, g, b) => {
    for (let y = Math.round(y0 * S); y < Math.round(y1 * S); y++)
      for (let x = Math.round(x0 * S); x < Math.round(x1 * S); x++) put(x, y, r, g, b);
  };
  // white jar: lid, neck, body; amber fill line to suggest contents
  rect(34, 20, 66, 27, 250, 246, 240); // lid
  rect(39, 27, 61, 33, 250, 246, 240); // neck
  rect(30, 33, 70, 82, 250, 246, 240); // body
  rect(34, 55, 66, 78, 224, 172, 105); // contents (#e0ac69)
  return png(size, px);
}

mkdirSync("public/icons", { recursive: true });
for (const s of [180, 192, 512]) writeFileSync(`public/icons/icon-${s}.png`, drawIcon(s));
console.log("icons written: 180, 192, 512");
