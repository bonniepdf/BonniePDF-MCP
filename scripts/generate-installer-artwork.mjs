import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

const logo = (await readFile(new URL('../installer/bonniepdf-logo.svg', import.meta.url))).toString('base64');

// Match the light hero on bonniepdf.dev. Its 28 contours use these same two waves.
const contours = Array.from({ length: 28 }, (_, line) => {
  const points = Array.from({ length: 121 }, (_, step) => {
    const x = step * 12;
    const y = 380 + line * 16 + 90 * Math.sin(x / 260 + line * 0.09) + 50 * Math.sin(x / 610 - line * 0.05);
    return x.toFixed(1) + ',' + y.toFixed(1);
  });
  return '<path d="M' + points.join(' L') + '"/>';
}).join('\n');

const hero = `
<defs>
  <radialGradient id="blue">
    <stop stop-color="#b8d6f2" stop-opacity=".75"/>
    <stop offset="1" stop-color="#b8d6f2" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="teal">
    <stop stop-color="#bfdcd8" stop-opacity=".55"/>
    <stop offset="1" stop-color="#bfdcd8" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="green">
    <stop stop-color="#b9d8c7" stop-opacity=".6"/>
    <stop offset="1" stop-color="#b9d8c7" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="azure">
    <stop stop-color="#bcd8f1" stop-opacity=".65"/>
    <stop offset="1" stop-color="#bcd8f1" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="fade" x2="1" y2=".35">
    <stop stop-color="white" stop-opacity=".15"/>
    <stop offset=".45" stop-color="white" stop-opacity=".6"/>
    <stop offset="1" stop-color="white"/>
  </linearGradient>
  <mask id="contours"><rect width="1440" height="900" fill="url(#fade)"/></mask>
</defs>
<rect width="1440" height="900" fill="#f3f7fb"/>
<circle cx="160" cy="120" r="520" fill="url(#blue)"/>
<circle cx="1320" cy="140" r="560" fill="url(#teal)"/>
<circle cx="1180" cy="860" r="620" fill="url(#green)"/>
<circle cx="200" cy="900" r="480" fill="url(#azure)"/>
<g fill="none" stroke="#475569" stroke-width="2" opacity=".22" mask="url(#contours)">
  ${contours}
</g>
`;

// Inno Setup accepts 24-bit BMP. Store four times the logical size for high-DPI displays.
await mkdir(new URL('../out/installer-artwork/', import.meta.url), { recursive: true });
for (const [name, width, height, mark, x, y] of [
  ['banner-side', 164, 314, 120, 22, 48],
  ['banner-top', 55, 58, 40, 7.5, 9],
]) {
  const title = name === 'banner-side'
    ? '<text x="82" y="196" text-anchor="middle" fill="#243b53" font-family="Segoe UI, sans-serif" font-size="17" font-weight="600">BonniePDF</text>'
    : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width * 4}" height="${height * 4}" viewBox="0 0 ${width} ${height}">
    <svg width="${width}" height="${height}" viewBox="0 0 1440 900" preserveAspectRatio="none">${hero}</svg>
    <image href="data:image/svg+xml;base64,${logo}" x="${x}" y="${y}" width="${mark}" height="${mark}"/>
    ${title}
  </svg>`;
  const image = new Resvg(svg).render();
  const rowSize = Math.ceil(image.width * 3 / 4) * 4;
  const bitmap = Buffer.alloc(54 + rowSize * image.height);
  bitmap.write('BM');
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(image.width, 18);
  bitmap.writeInt32LE(image.height, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(24, 28);
  bitmap.writeUInt32LE(rowSize * image.height, 34);
  const pixels = image.pixels;
  for (let row = 0; row < image.height; row++) {
    for (let column = 0; column < image.width; column++) {
      const source = (row * image.width + column) * 4;
      const destination = 54 + (image.height - row - 1) * rowSize + column * 3;
      bitmap[destination] = pixels[source + 2];
      bitmap[destination + 1] = pixels[source + 1];
      bitmap[destination + 2] = pixels[source];
    }
  }
  await writeFile(new URL('../installer/' + name + '.bmp', import.meta.url), bitmap);
  await writeFile(new URL('../out/installer-artwork/' + name + '.png', import.meta.url), image.asPng());
  console.log(name + ': ' + image.width + ' × ' + image.height);
}
