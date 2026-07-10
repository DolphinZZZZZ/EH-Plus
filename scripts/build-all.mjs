import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = join(root, 'extension');
const iconDir = join(extensionDir, 'icons');
const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(extensionDir, 'manifest.json'), 'utf8'));
const packageName = `EH＋-extension-v${manifest.version}`;
const distDir = join(root, 'dist', packageName);
const downloadsDir = join(process.env.USERPROFILE || '', 'Downloads', packageName);
const zipPath = join(process.env.USERPROFILE || '', 'Downloads', `${packageName}.zip`);

await mkdir(iconDir, { recursive: true });
const iconGeneration = spawnSync('pwsh', [
  '-NoProfile',
  '-File',
  join(root, 'scripts', 'generate-icons.ps1')
], {
  cwd: root,
  stdio: 'inherit'
});
if (iconGeneration.status !== 0) {
  process.exit(iconGeneration.status ?? 1);
}

const test = spawnSync(process.execPath, ['--test', join(root, 'tests', 'shared.test.js')], {
  cwd: root,
  stdio: 'inherit'
});
if (test.status !== 0) {
  process.exit(test.status ?? 1);
}

await rm(distDir, { recursive: true, force: true });
await cp(extensionDir, distDir, { recursive: true });
await cp(join(root, 'shared'), join(distDir, 'shared'), { recursive: true });

// 发布包瘦身（2026-07-07）：manifest 只引用 icons/icon-16/32/48/128，
// 候选图与 1024 源图属于设计资产，保留在源仓库并另行备份 zip 到 Downloads，
// 不进正式包（原先让包体积多出 ~21MB）。
const excludedDesignAssets = [
  join(distDir, 'icons', 'candidates'),
  join(distDir, 'icons', 'icon-1024.png'),
  join(distDir, 'icons', 'icon-applied-preview.png')
];
for (const excluded of excludedDesignAssets) {
  await rm(excluded, { recursive: true, force: true });
}

const serviceWorkerPath = join(distDir, 'service-worker.js');
let serviceWorkerSource = await (await import('node:fs/promises')).readFile(serviceWorkerPath, 'utf8');
serviceWorkerSource = serviceWorkerSource.replaceAll('../shared/', './shared/');
await writeFile(serviceWorkerPath, serviceWorkerSource);

try {
  await rm(downloadsDir, { recursive: true, force: true });
  await cp(distDir, downloadsDir, { recursive: true });
} catch (error) {
  console.warn(`Downloads folder locked (${error.message}); mirroring with robocopy.`);
  const robocopy = spawnSync('robocopy', [distDir, downloadsDir, '/MIR', '/R:1', '/W:1'], {
    stdio: 'inherit',
    shell: true
  });
  if (robocopy.status >= 8) {
    throw new Error(`robocopy failed with exit code ${robocopy.status}`);
  }
}

await rm(zipPath, { force: true });
const escapedDistDir = distDir.replace(/'/g, "''");
const escapedZipPath = zipPath.replace(/'/g, "''");
const archive = spawnSync('pwsh', [
  '-NoProfile',
  '-Command',
  [
    `$source = '${escapedDistDir}'`,
    `$destination = '${escapedZipPath}'`,
    'Compress-Archive -Path (Join-Path $source "*") -DestinationPath $destination -Force',
    'if (-not (Test-Path -LiteralPath $destination)) { throw "zip was not created: $destination" }'
  ].join('; ')
], {
  stdio: 'inherit'
});
if (archive.status !== 0) {
  throw new Error(`zip creation failed with exit code ${archive.status}`);
}

console.log(`Built extension directory: ${distDir}`);
console.log(`Copied unpacked extension to: ${downloadsDir}`);
console.log(`Created zip package: ${zipPath}`);
