import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../extension/icons/logo.svg', import.meta.url));
for (const size of [16, 32, 48, 128]) {
  const target = fileURLToPath(new URL(`../extension/icons/icon${size}.png`, import.meta.url));
  await sharp(source, { density: 384 }).resize(size, size).png().toFile(target);
  console.log(`Generated icon${size}.png`);
}
