import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..');

const dirsToCheck = [
  '',
  'services',
  'services/ai',
  'store',
  'api/routes',
  'worker',
  'utils',
  'config'
];

let failed = false;

for (const dir of dirsToCheck) {
  const fullPath = path.join(serverDir, dir);
  if (!fs.existsSync(fullPath)) continue;
  
  const files = fs.readdirSync(fullPath).filter(f => f.endsWith('.js') || f.endsWith('.mjs'));
  for (const file of files) {
    const filePath = path.join(fullPath, file);
    try {
      execSync(`node --check "${filePath}"`, { stdio: 'ignore' });
      // console.log(`✅ Passed: ${path.join(dir, file)}`);
    } catch (err) {
      console.error(`❌ Syntax Error in: ${path.join(dir, file)}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
} else {
  console.log('✅ All server files passed syntax check.');
}
