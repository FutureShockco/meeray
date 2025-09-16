// scripts/build-prod.js
// Elegant cross-platform build script for Meeray Node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd) {
  console.log(`[build-prod] $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', shell: true });
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  if (fs.lstatSync(src).isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const file of fs.readdirSync(src)) {
      copyRecursive(path.join(src, file), path.join(dest, file));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

// 1. Install all dependencies (including dev)
run('npm install');

// 2. Build the TypeScript project
run('npm run build');

// 3. Install only production dependencies (prune dev)
run('npm prune --production');

// 4. Copy dist/ to build/dist/
copyRecursive('dist', path.join('build', 'dist'));

// 5. Copy node_modules/ to build/node_modules/
copyRecursive('node_modules', path.join('build', 'node_modules'));

console.log('[build-prod] Build and packaging steps complete. You can now run your NSIS installer script.');
