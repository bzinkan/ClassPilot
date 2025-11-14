const { createCanvas, loadImage } = require('canvas');
const fs = require('fs');
const path = require('path');

async function createScreenshot(width, height, filename, title, description) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#f8fafc';
  ctx.fillRect(0, 0, width, height);

  // Header bar
  ctx.fillStyle = '#2563eb';
  ctx.fillRect(0, 0, width, 60);

  // ClassPilot logo text
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px Arial';
  ctx.fillText('ClassPilot', 20, 40);

  // Title
  ctx.fillStyle = '#1e293b';
  ctx.font = 'bold 36px Arial';
  ctx.fillText(title, 40, 140);

  // Description
  ctx.fillStyle = '#64748b';
  ctx.font = '20px Arial';
  const lines = description.split('\n');
  lines.forEach((line, i) => {
    ctx.fillText(line, 40, 200 + (i * 35));
  });

  // Monitor icon in center
  const iconSize = 120;
  const iconX = width / 2 - iconSize / 2;
  const iconY = height / 2 + 20;

  // Monitor
  ctx.fillStyle = '#2563eb';
  ctx.strokeStyle = '#1e40af';
  ctx.lineWidth = 4;
  
  const monitorWidth = iconSize;
  const monitorHeight = iconSize * 0.67;
  ctx.fillRect(iconX, iconY, monitorWidth, monitorHeight);
  ctx.strokeRect(iconX, iconY, monitorWidth, monitorHeight);

  // Monitor stand
  ctx.fillRect(iconX + monitorWidth / 2 - 15, iconY + monitorHeight, 30, 15);
  ctx.fillRect(iconX + monitorWidth / 2 - 25, iconY + monitorHeight + 15, 50, 5);

  // Eye icon
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(iconX + monitorWidth / 2, iconY + monitorHeight / 2, 25, 15, 0, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(iconX + monitorWidth / 2, iconY + monitorHeight / 2, 8, 0, 2 * Math.PI);
  ctx.fill();

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(filename, buffer);
  console.log(`✅ Created ${filename}`);
}

async function createSmallPromoTile() {
  const canvas = createCanvas(440, 280);
  const ctx = canvas.getContext('2d');

  // Gradient background
  const gradient = ctx.createLinearGradient(0, 0, 440, 280);
  gradient.addColorStop(0, '#2563eb');
  gradient.addColorStop(1, '#1e40af');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 440, 280);

  // Monitor icon
  const iconSize = 80;
  const iconX = 220 - iconSize / 2;
  const iconY = 80;

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#e0e7ff';
  ctx.lineWidth = 3;
  
  const monitorWidth = iconSize;
  const monitorHeight = iconSize * 0.67;
  ctx.fillRect(iconX, iconY, monitorWidth, monitorHeight);
  ctx.strokeRect(iconX, iconY, monitorWidth, monitorHeight);

  // Monitor stand
  ctx.fillRect(iconX + monitorWidth / 2 - 12, iconY + monitorHeight, 24, 12);
  ctx.fillRect(iconX + monitorWidth / 2 - 20, iconY + monitorHeight + 12, 40, 4);

  // Eye icon
  ctx.fillStyle = '#2563eb';
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(iconX + monitorWidth / 2, iconY + monitorHeight / 2, 20, 12, 0, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(iconX + monitorWidth / 2, iconY + monitorHeight / 2, 6, 0, 2 * Math.PI);
  ctx.fill();

  // Title
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 42px Arial';
  ctx.textAlign = 'center';
  ctx.fillText('ClassPilot', 220, 200);

  // Subtitle
  ctx.font = '18px Arial';
  ctx.fillText('Privacy-Aware Classroom Monitoring', 220, 235);

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync('chrome-store-small-promo-440x280.png', buffer);
  console.log('✅ Created chrome-store-small-promo-440x280.png');
}

async function createMarqueePromoTile() {
  const canvas = createCanvas(1400, 560);
  const ctx = canvas.getContext('2d');

  // Gradient background
  const gradient = ctx.createLinearGradient(0, 0, 1400, 560);
  gradient.addColorStop(0, '#2563eb');
  gradient.addColorStop(1, '#1e40af');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1400, 560);

  // Left side - Icon
  const iconSize = 200;
  const iconX = 150;
  const iconY = 180;

  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#e0e7ff';
  ctx.lineWidth = 6;
  
  const monitorWidth = iconSize;
  const monitorHeight = iconSize * 0.67;
  ctx.fillRect(iconX, iconY, monitorWidth, monitorHeight);
  ctx.strokeRect(iconX, iconY, monitorWidth, monitorHeight);

  // Monitor stand
  ctx.fillRect(iconX + monitorWidth / 2 - 30, iconY + monitorHeight, 60, 30);
  ctx.fillRect(iconX + monitorWidth / 2 - 50, iconY + monitorHeight + 30, 100, 10);

  // Eye icon
  ctx.fillStyle = '#2563eb';
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.ellipse(iconX + monitorWidth / 2, iconY + monitorHeight / 2, 50, 30, 0, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(iconX + monitorWidth / 2, iconY + monitorHeight / 2, 15, 0, 2 * Math.PI);
  ctx.fill();

  // Right side - Text
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  
  // Title
  ctx.font = 'bold 72px Arial';
  ctx.fillText('ClassPilot', 520, 180);

  // Subtitle
  ctx.font = '32px Arial';
  ctx.fillText('Real-Time Classroom Monitoring for Chromebooks', 520, 240);

  // Features
  ctx.font = '24px Arial';
  const features = [
    '✓ Live Student Activity Tracking',
    '✓ Remote Classroom Control',
    '✓ Privacy-First Design',
    '✓ Works with Google Workspace'
  ];

  features.forEach((feature, i) => {
    ctx.fillText(feature, 520, 310 + (i * 45));
  });

  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync('chrome-store-marquee-1400x560.png', buffer);
  console.log('✅ Created chrome-store-marquee-1400x560.png');
}

async function main() {
  // Create screenshots (1280x800)
  await createScreenshot(
    1280, 800,
    'chrome-store-screenshot-1-1280x800.png',
    'Real-Time Student Monitoring',
    'View all student activity in real-time\nTrack browsing, identify off-task behavior\nColor-coded status indicators'
  );

  await createScreenshot(
    1280, 800,
    'chrome-store-screenshot-2-1280x800.png',
    'Remote Classroom Control',
    'Open tabs, close tabs, lock screens\nApply website restrictions (Flight Paths)\nManage individual students or groups'
  );

  await createScreenshot(
    1280, 800,
    'chrome-store-screenshot-3-1280x800.png',
    'Privacy-First Design',
    'Transparent monitoring with student disclosure\nConfigurable data retention\nFERPA/COPPA compliant architecture'
  );

  // Create promo tiles
  await createSmallPromoTile();
  await createMarqueePromoTile();

  console.log('\n✨ All Chrome Web Store promotional images created!');
  console.log('\nFiles created:');
  console.log('  Screenshots (1280x800):');
  console.log('    - chrome-store-screenshot-1-1280x800.png');
  console.log('    - chrome-store-screenshot-2-1280x800.png');
  console.log('    - chrome-store-screenshot-3-1280x800.png');
  console.log('  Small promo tile (440x280):');
  console.log('    - chrome-store-small-promo-440x280.png');
  console.log('  Marquee promo tile (1400x560):');
  console.log('    - chrome-store-marquee-1400x560.png');
}

main().catch(console.error);
