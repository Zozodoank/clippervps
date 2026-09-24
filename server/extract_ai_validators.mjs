import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const aiServicePath = path.join(__dirname, 'services', 'aiService.js');
let code = fs.readFileSync(aiServicePath, 'utf8');
let lines = code.split('\n');

const clientElements = [
  'function repairJson',
  'export function formatSeconds',
  'export function normalizeClipPlan'
];

let clientCode = `import { getMediaDurationSec } from '../videoRenderer.js';\n\n`;

let exportedElements = [];

for (const element of clientElements) {
  let startIdx = -1;
  // find start
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    if (lines[i].startsWith(element)) {
      startIdx = i;
      // Also grab preceding JSDoc if exists
      if (startIdx > 0 && lines[startIdx - 1].trim() === '*/') {
        let j = startIdx - 1;
        while (j >= 0 && !lines[j].trim().startsWith('/**')) {
          j--;
        }
        if (j >= 0) startIdx = j;
      } else if (startIdx > 0 && lines[startIdx - 1].trim().startsWith('//')) {
        let j = startIdx - 1;
        while (j >= 0 && lines[j].trim().startsWith('//')) {
          j--;
        }
        if (j >= 0) startIdx = j + 1;
      }
      break;
    }
  }

  if (startIdx === -1) {
    console.log(`Not found: ${element}`);
    continue;
  }

  if (element.startsWith('export')) {
    const nameMatch = element.match(/export (?:async )?(?:function|const) (\w+)/);
    if (nameMatch) {
      exportedElements.push(nameMatch[1]);
    }
  } else if (element.startsWith('function') || element.startsWith('const')) {
    const nameMatch = element.match(/(?:function|const) (\w+)/);
    if (nameMatch) {
      const name = nameMatch[1];
      lines[startIdx] = lines[startIdx].replace(/^(function|const)/, 'export $1');
      exportedElements.push(name);
    }
  }

  // find end
  let endIdx = -1;
  let bracketCount = 0;
  let hasStarted = false;
  
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '{') { bracketCount++; hasStarted = true; }
      if (line[c] === '}') { bracketCount--; }
    }

    if (hasStarted && bracketCount === 0) {
      endIdx = i;
      break;
    }
  }

  if (endIdx !== -1) {
    const elLines = lines.slice(startIdx, endIdx + 1);
    clientCode += elLines.join('\n') + '\n\n';
    for (let i = startIdx; i <= endIdx; i++) {
      lines[i] = null;
    }
    lines[startIdx] = `// Moved to ai/aiValidators.js`;
  }
}

// Write aiValidators.js
const aiDir = path.join(__dirname, 'services', 'ai');
if (!fs.existsSync(aiDir)) fs.mkdirSync(aiDir);
fs.writeFileSync(path.join(aiDir, 'aiValidators.js'), clientCode);

// Add import to aiService
const importLine = `import { ${exportedElements.join(', ')} } from './ai/aiValidators.js';\nexport { formatSeconds, normalizeClipPlan };`;
const finalLines = [importLine, ...lines.filter(l => l !== null)];
fs.writeFileSync(aiServicePath, finalLines.join('\n'));

console.log('Done extracting aiValidators.');
