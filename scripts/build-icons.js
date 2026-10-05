'use strict';
// Renders assets/icon.svg (and icon-small.svg for the tiny sizes) to PNGs and a multi-size icon.ico.
// Run with: npm run icons

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', 'assets');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const PNG_SIZES = [16, 32, 256, 512];
const SMALL_MAX = 24;

// ICO container with PNG-compressed entries (supported since Windows Vista).
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

async function render(win, file, size) {
  const src = `data:image/svg+xml;base64,${fs.readFileSync(path.join(ASSETS, file)).toString('base64')}`;
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image(${size}, ${size});
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = ${size};
      canvas.getContext('2d').drawImage(img, 0, 0, ${size}, ${size});
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('Could not load ${file}'));
    img.src = ${JSON.stringify(src)};
  })`);
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');

  const images = [];
  for (const size of [...new Set([...ICO_SIZES, ...PNG_SIZES])].sort((a, b) => a - b)) {
    const png = await render(win, size <= SMALL_MAX ? 'icon-small.svg' : 'icon.svg', size);
    if (ICO_SIZES.includes(size)) images.push({ size, png });
    if (PNG_SIZES.includes(size)) fs.writeFileSync(path.join(ASSETS, `icon-${size}.png`), png);
  }
  fs.writeFileSync(path.join(ASSETS, 'icon.ico'), buildIco(images));
  console.log(`Wrote assets/icon.ico (${ICO_SIZES.join(', ')} px) and icon-{${PNG_SIZES.join(',')}}.png`);
  app.quit();
});
