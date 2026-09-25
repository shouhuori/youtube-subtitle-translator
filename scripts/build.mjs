import { cp, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { checkExtension } from './check.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = resolve(root, 'extension');
const dev = process.argv.includes('--dev');
const environment = dev ? 'development' : 'production';
const output = resolve(root, 'dist', environment);
await checkExtension(source);
await mkdir(resolve(root, 'dist'), { recursive: true });
await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true });
const configPath = resolve(output, 'config.js');
const config = await readFile(configPath, 'utf8');
if (!config.includes('const DEV_MODE = true;')) throw new Error('Build could not locate environment setting');
await writeFile(configPath, config.replace('const DEV_MODE = true;', `const DEV_MODE = ${dev};`));
const manifest = await checkExtension(output);
const zip = new JSZip();
async function addFiles(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name);
    if (entry.isDirectory()) await addFiles(path);
    else zip.file(relative(output, path).replaceAll('\\', '/'), await readFile(path));
  }
}
await addFiles(output);
const archive = resolve(root, 'dist', `youtube-subtitle-translator-${manifest.version}-${environment}.zip`);
await writeFile(archive, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Unpacked extension: ${output}`);
console.log(`Archive: ${archive}`);
