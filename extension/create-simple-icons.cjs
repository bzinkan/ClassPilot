const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

function createIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Clear background
  ctx.clearRect(0, 0, size, size);

  // Scale for different sizes
  const scale = size / 128;

  // Draw monitor/screen icon (simple rectangle with stand)
  const monitorWidth = 90 * scale;
  const monitorHeight = 60 * scale;
  const x = (size - monitorWidth) / 2;
  const y = 20 * scale;

  // Monitor screen
  ctx.fillStyle = '#2563eb'; // Blue color
  ctx.strokeStyle = '#1e40af'; // Darker blue for border
  ctx.lineWidth = 3 * scale;
  
  // Rounded rectangle for screen
  const radius = 4 * scale;
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + monitorWidth - radius, y);
  ctx.quadraticCurveTo(x + monitorWidth, y, x + monitorWidth, y + radius);
  ctx.lineTo(x + monitorWidth, y + monitorHeight - radius);
  ctx.quadraticCurveTo(x + monitorWidth, y + monitorHeight, x + monitorWidth - radius, y + monitorHeight);
  ctx.lineTo(x + radius, y + monitorHeight);
  ctx.quadraticCurveTo(x, y + monitorHeight, x, y + monitorHeight - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Monitor stand
  const standWidth = 30 * scale;
  const standHeight = 8 * scale;
  const standX = size / 2 - standWidth / 2;
  const standY = y + monitorHeight;

  ctx.fillStyle = '#1e40af';
  ctx.fillRect(standX, standY, standWidth, standHeight);

  // Monitor base
  const baseWidth = 50 * scale;
  const baseHeight = 4 * scale;
  const baseX = size / 2 - baseWidth / 2;
  const baseY = standY + standHeight;

  ctx.fillRect(baseX, baseY, baseWidth, baseHeight);

  // Add eye icon inside monitor to indicate monitoring
  const eyeY = y + monitorHeight / 2;
  const eyeX = size / 2;
  const eyeWidth = 20 * scale;
  const eyeHeight = 12 * scale;

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2 * scale;

  // Eye shape
  ctx.beginPath();
  ctx.ellipse(eyeX, eyeY, eyeWidth, eyeHeight, 0, 0, 2 * Math.PI);
  ctx.stroke();

  // Pupil
  ctx.beginPath();
  ctx.arc(eyeX, eyeY, 6 * scale, 0, 2 * Math.PI);
  ctx.fill();

  return canvas;
}

// Create icons directory if it doesn't exist
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir);
}

// Generate icons
[16, 48, 128].forEach(size => {
  const canvas = createIcon(size);
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(iconsDir, `icon${size}.png`), buffer);
  console.log(`✅ Created icon${size}.png`);
});

console.log('✨ All icons created successfully!');
