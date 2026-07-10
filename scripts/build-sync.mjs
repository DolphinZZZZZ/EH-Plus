import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8'));
const packageName = `EH＋-extension-v${manifest.version}`;
const distDir = join(root, 'dist', packageName);
const downloadsDir = join(process.env.USERPROFILE || '', 'Downloads', packageName);
const zipPath = join(process.env.USERPROFILE || '', 'Downloads', `${packageName}.zip`);

function runNode(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: node ${scriptPath}`);
  }
}

function resetDir(path) {
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
  mkdirSync(path, { recursive: true });
}

function copyTree(source, destination) {
  cpSync(source, destination, { recursive: true, force: true });
}

runNode(join(root, 'scripts', 'generate-icons.mjs'));

resetDir(distDir);
copyTree(join(root, 'extension'), distDir);
copyTree(join(root, 'shared'), join(distDir, 'shared'));

const serviceWorkerPath = join(distDir, 'service-worker.js');
const serviceWorkerSource = readFileSync(serviceWorkerPath, 'utf8').replaceAll('../shared/', './shared/');
writeFileSync(serviceWorkerPath, serviceWorkerSource, 'utf8');

resetDir(downloadsDir);
copyTree(distDir, downloadsDir);

if (existsSync(zipPath)) {
  rmSync(zipPath, { force: true });
}

const archiver = spawnSync(
  'powershell',
  ['-NoProfile', '-Command', `Compress-Archive -LiteralPath '${distDir.replace(/'/g, "''")}\\*' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`],
  { stdio: 'inherit' }
);
if (archiver.status !== 0) {
  console.warn('Zip creation failed; unpacked builds are ready.');
}

console.log(`Built extension directory: ${distDir}`);
console.log(`Copied unpacked extension to: ${downloadsDir}`);
console.log(`Created zip package: ${zipPath}`);
