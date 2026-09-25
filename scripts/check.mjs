import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

export async function checkExtension(root) {
  const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  const referenced = new Set([
    manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap(entry => [...(entry.js || []), ...(entry.css || [])]),
    ...manifest.web_accessible_resources.flatMap(entry => entry.resources),
  ]);
  const html = await readFile(resolve(root, manifest.action.default_popup), 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) referenced.add(match[1]);
  for (const path of referenced) {
    if (!(await stat(resolve(root, path))).isFile()) throw new Error(`Missing extension resource: ${path}`);
  }
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = resolve(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (path.endsWith('.js')) {
        execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
        const source = await readFile(path, 'utf8');
        for (const match of source.matchAll(/\bimport\s+(?:[^'";]+?from\s+)?['"](\.[^'"]+)['"]/g)) {
          await stat(resolve(dirname(path), match[1]));
        }
      }
    }
  }
  await walk(root);
  for (const size of [16, 32, 48, 128]) {
    const image = await sharp(resolve(root, `icons/icon${size}.png`)).metadata();
    if (image.width !== size || image.height !== size) throw new Error(`Invalid icon dimensions: ${size}`);
  }
  if (manifest.name.length > 75 || manifest.description.length > 132) throw new Error('Manifest text too long');
  if (manifest.content_scripts.some(entry => entry.matches.includes('<all_urls>'))) throw new Error('Unexpected global injection');
  console.log(`Checked ${referenced.size} resources, JavaScript syntax, module imports and icon dimensions.`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkExtension(fileURLToPath(new URL('../extension', import.meta.url)));
}
