import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { it, expect } from 'vitest';
import JSZip from 'jszip';

it('builds isolated runtime archives with the right active environment and no source mutation', async () => {
  const original = await readFile('extension/config.js', 'utf8');
  for (const mode of ['development', 'production']) {
    execFileSync(process.execPath, ['scripts/build.mjs', ...(mode === 'development' ? ['--dev'] : [])], { stdio: 'pipe' });
    const zip = await JSZip.loadAsync(await readFile(`dist/youtube-subtitle-translator-0.1.0-${mode}.zip`));
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    expect(zip.file(manifest.background.service_worker)).toBeTruthy();
    expect(zip.file('lib/auth.js')).toBeTruthy();
    expect(zip.file('lib/api.js')).toBeTruthy();
    expect(zip.file('popup.js')).toBeTruthy();
    expect(zip.file('popup.css')).toBeTruthy();
    expect(Object.keys(zip.files).some(name => /node_modules|tests\/|\.env|local-db|Readability/.test(name))).toBe(false);
    const context = { chrome: { runtime: { getManifest: () => manifest, getURL: value => value } } };
    vm.runInNewContext(await zip.file('config.js').async('string'), context);
    expect(context.CONFIG.SITE_URL).toBe(mode === 'production' ? 'https://lingread.app' : 'http://localhost:3100');
    expect(context.CONFIG.API_BASE_URL).toBe(mode === 'production' ? 'https://lingread.app' : 'http://localhost:4100');
    for (const script of manifest.content_scripts.flatMap(entry => entry.js)) expect(zip.file(script)).toBeTruthy();
  }
  expect(await readFile('extension/config.js', 'utf8')).toBe(original);
});
