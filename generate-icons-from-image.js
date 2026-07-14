/**
 * Generate extension icons from a source image.
 * Usage: node generate-icons-from-image.js <source-image>
 * Default source: icons/zenitsu_icon256.png
 */

const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const sourceFile = process.argv[2] || path.join(__dirname, "icons", "zenitsu_icon256.png");
const iconsDir = path.join(__dirname, "icons");

async function main() {
  if (!fs.existsSync(sourceFile)) {
    console.error(`Source image not found: ${sourceFile}`);
    process.exit(1);
  }

  const metadata = await sharp(sourceFile).metadata();
  console.log(`Source: ${path.basename(sourceFile)}`);
  console.log(`  Size: ${metadata.width}x${metadata.height}`);
  console.log(`  Format: ${metadata.format}`);
  console.log(`  Channels: ${metadata.channels}`);
  console.log();

  const sizes = [
    { size: 16, file: "icon16.png" },
    { size: 48, file: "icon48.png" },
    { size: 128, file: "icon128.png" },
  ];

  for (const { size, file } of sizes) {
    // Resize with sharp Lanczos resampling for best quality
    const buf = await sharp(sourceFile)
      .resize(size, size, {
        kernel: "lanczos3",
        fit: "cover",
        position: "center",
      })
      .png()
      .toBuffer();

    const filePath = path.join(iconsDir, file);
    fs.writeFileSync(filePath, buf);
    console.log(`Created ${file}: ${buf.length} bytes (${size}x${size})`);
  }

  console.log("\nAll icons generated successfully!");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
