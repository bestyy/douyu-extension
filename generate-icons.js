/**
 * Generate PNG icon files for the extension without any external graphics library.
 * Creates red-orange (#FF4400) circular icons with hint of a "斗" character pattern.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// CRC32 lookup table
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcData = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  return Buffer.concat([len, typeBytes, data, crc]);
}

function createPNG(width, height) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk("IHDR", ihdr);

  // Generate pixel data
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) / 2 - 1;

  // Color: #FF4400 with slight gradient effect
  const r = 0xff;
  const g = 0x44;
  const b = 0x00;

  // Build raw scanlines (each scanline starts with filter byte 0)
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const scanlineOffset = y * (1 + width * 4);
    rawData[scanlineOffset] = 0; // filter: None

    for (let x = 0; x < width; x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const pixelOffset = scanlineOffset + 1 + x * 4;

      if (dist <= radius) {
        // Inside circle - red-orange with slight shading for 3D effect
        const shade = 1 - (dist / radius) * 0.2; // slight radial gradient
        const pr = Math.min(255, Math.round(r * shade));
        const pg = Math.min(255, Math.round(g * shade));
        const pb = Math.min(255, Math.round(b * shade));

        // Draw simple "斗" character hint (cross pattern) for larger icons
        let fr = pr, fg = pg, fb = pb;
        if (width >= 48) {
          const cx = Math.round(centerX);
          const cy = Math.round(centerY);
          const thickness = Math.max(1, Math.round(width / 16));
          // Horizontal line
          if (Math.abs(y - cy) <= thickness && Math.abs(x - cx) <= radius * 0.6) {
            fr = 255; fg = 255; fb = 255; // white lines for the character
          }
          // Vertical line
          if (Math.abs(x - cx) <= thickness && Math.abs(y - cy) <= radius * 0.7) {
            fr = 255; fg = 255; fb = 255;
          }
          // Top horizontal line
          if (Math.abs(y - (cy - radius * 0.35)) <= thickness && Math.abs(x - cx) <= radius * 0.5) {
            fr = 255; fg = 255; fb = 255;
          }
        }

        rawData[pixelOffset] = fr;
        rawData[pixelOffset + 1] = fg;
        rawData[pixelOffset + 2] = fb;
        rawData[pixelOffset + 3] = 255; // alpha
      } else {
        // Outside circle - transparent
        rawData[pixelOffset] = 0;
        rawData[pixelOffset + 1] = 0;
        rawData[pixelOffset + 2] = 0;
        rawData[pixelOffset + 3] = 0;
      }
    }
  }

  // Compress with zlib
  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const idatChunk = makeChunk("IDAT", compressed);

  // IEND
  const iendChunk = makeChunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Generate icons
const sizes = [
  { size: 16, file: "icon16.png" },
  { size: 48, file: "icon48.png" },
  { size: 128, file: "icon128.png" },
];

const iconsDir = path.join(__dirname, "icons");
fs.mkdirSync(iconsDir, { recursive: true });

for (const { size, file } of sizes) {
  const pngData = createPNG(size, size);
  const filePath = path.join(iconsDir, file);
  fs.writeFileSync(filePath, pngData);
  console.log(`Created ${file}: ${pngData.length} bytes (${size}x${size})`);
}

console.log("\nAll icons generated successfully!");

// Verify the generated files are valid by trying to parse them
function verifyPNG(filePath) {
  const data = fs.readFileSync(filePath);
  // Check PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (data.slice(0, 8).equals(sig)) {
    return true;
  }
  return false;
}

for (const { file } of sizes) {
  const filePath = path.join(iconsDir, file);
  const valid = verifyPNG(filePath);
  console.log(`  ${file}: ${valid ? "VALID PNG" : "INVALID"}`);
}
