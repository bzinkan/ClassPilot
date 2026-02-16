import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createSvg(size) {
  // The airplane path is designed for a ~28x28 coordinate space (4-24 range)
  // Scale factor to fit within the icon with padding
  const padding = size * 0.12;
  const drawArea = size - padding * 2;
  const scale = drawArea / 28;
  const strokeWidth = Math.max(1, size * 0.07);

  // Round corners for the background
  const radius = Math.round(size * 0.18);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fbbf24"/>
  <g transform="translate(${padding}, ${padding}) scale(${scale})">
    <path d="M4 14L24 4L18 24L14 16L24 4" fill="none" stroke="#0f172a" stroke-width="${strokeWidth / scale}" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M14 16L16 22" fill="none" stroke="#0f172a" stroke-width="${strokeWidth / scale}" stroke-linecap="round"/>
  </g>
</svg>`;
}

async function generateIcons() {
  const sizes = [16, 32, 48, 128];

  for (const size of sizes) {
    const svg = createSvg(size);
    const outputPath = path.join(__dirname, `icon${size}.png`);

    await sharp(Buffer.from(svg))
      .resize(size, size)
      .png()
      .toFile(outputPath);

    const stats = fs.statSync(outputPath);
    console.log(`Created icon${size}.png (${size}x${size}, ${stats.size} bytes)`);
  }

  console.log('All icons generated!');
}

generateIcons().catch(console.error);
