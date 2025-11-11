// Generate proper extension icons using Canvas
import fs from 'fs';
import { createCanvas } from 'canvas';

function createIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  
  // Blue background (#3b82f6)
  ctx.fillStyle = '#3b82f6';
  ctx.fillRect(0, 0, size, size);
  
  // White monitor icon
  ctx.fillStyle = '#ffffff';
  const padding = size * 0.2;
  const w = size - (padding * 2);
  const h = w * 0.7;
  const x = padding;
  const y = padding;
  
  // Screen
  ctx.fillRect(x, y, w, h);
  
  // Stand
  const standW = w * 0.4;
  const standH = h * 0.15;
  const standX = x + (w - standW) / 2;
  const standY = y + h;
  ctx.fillRect(standX, standY, standW, standH);
  
  // Base
  const baseW = w * 0.6;
  const baseH = h * 0.1;
  const baseX = x + (w - baseW) / 2;
  const baseY = standY + standH;
  ctx.fillRect(baseX, baseY, baseW, baseH);
  
  // Save to file
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(`./extension/icons/icon${size}.png`, buffer);
  console.log(`✓ Created icon${size}.png (${size}x${size})`);
}

// Generate all three icon sizes
console.log('Generating Chrome extension icons...');
createIcon(16);
createIcon(48);
createIcon(128);
console.log('✓ All icons generated successfully!');
