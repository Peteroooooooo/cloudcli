/**
 * Writes every CloudCLI icon file in public/ from one drawing: a near-black
 * tile with the white message-square glyph the sidebar header shows.
 *
 * Two shapes come out of it. The rounded tile, with transparent corners, is
 * for places that show the file as it is: the browser tab, desktop installs,
 * notifications and the Electron window. The full square is for places that
 * cut their own shape out of it: iOS rounds the home-screen icon itself, and
 * Android crops a "maskable" icon to the launcher's circle or squircle, so a
 * rounded tile there would end up with black corners inside the cut shape.
 *
 * The drawing is repeated in src/shared/ui/AppLogo.tsx, which the app renders
 * inline; change both together.
 *
 * Run: node scripts/generate-icons.mjs
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** hsl(240 5.9% 10%), the dark shade of the app's neutral palette. */
const TILE_COLOR = '#18181b';
/** 22.5% of the side, close to the corner of an iOS app icon. */
const CORNER_RADIUS = 14.4;
const GLYPH = 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z';

const drawIcon = ({ rounded }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64"${rounded ? ` rx="${CORNER_RADIUS}"` : ''} fill="${TILE_COLOR}"/>
  <path transform="translate(32 32) scale(1.333) translate(-12 -12)" d="${GLYPH}" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

const ROUNDED_SVG = drawIcon({ rounded: true });
const SQUARE_SVG = drawIcon({ rounded: false });

const render = (svg, size, file) =>
  sharp(Buffer.from(svg), { density: (72 * size) / 64 })
    .resize(size, size)
    .png()
    .toFile(path.join(PUBLIC_DIR, file));

await writeFile(path.join(PUBLIC_DIR, 'logo.svg'), ROUNDED_SVG);
await writeFile(path.join(PUBLIC_DIR, 'favicon.svg'), ROUNDED_SVG);

await render(ROUNDED_SVG, 64, 'favicon.png');
for (const size of [32, 64, 128, 256, 512]) {
  await render(ROUNDED_SVG, size, `logo-${size}.png`);
}
for (const size of [72, 96, 128, 144, 152, 192, 384, 512]) {
  await render(ROUNDED_SVG, size, `icons/icon-${size}x${size}.png`);
}
for (const size of [192, 512]) {
  await render(SQUARE_SVG, size, `icons/icon-maskable-${size}x${size}.png`);
}
await render(SQUARE_SVG, 180, 'icons/apple-touch-icon.png');

console.log('Icons written to', PUBLIC_DIR);
