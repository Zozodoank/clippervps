import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const aiServicePath = path.join(__dirname, 'services', 'aiService.js');
let code = fs.readFileSync(aiServicePath, 'utf8');
let lines = code.split('\n');

const funcsToExtract = [
  'truncateProductDescription',
  'getDynamicProductHookFallback',
  'buildNicheProductCriterion',
  'buildFaceAndMotionCriterion',
  'formatEnrichedCaption',
  'sanitizeScriptVocabulary',
  'build7SlotStoryboardClips'
];

let promptBuildersCode = `import { extractCoreProductInfo, isBulkyOrUnsuitableProduct } from '../discoveryService.js';\nimport { getNichePreset } from '../../config/nichePresets.js';\n\n`;

for (const func of funcsToExtract) {
  let startIdx = -1;
  // find start
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    if (lines[i].startsWith(`export function ${func}`) || lines[i].startsWith(`export async function ${func}`)) {
      startIdx = i;
      // Also grab preceding JSDoc if exists
      if (startIdx > 0 && lines[startIdx - 1].trim() === '*/') {
        let j = startIdx - 1;
        while (j >= 0 && !lines[j].trim().startsWith('/**')) {
          j--;
        }
        if (j >= 0) startIdx = j;
      }
      break;
    }
  }

  if (startIdx === -1) {
    console.log(`Not found: ${func}`);
    continue;
  }

  // find end
  let endIdx = -1;
  let bracketCount = 0;
  let hasStarted = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    // basic bracket counting, ignore strings/comments for simplicity since the code is pretty clean
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
    const funcLines = lines.slice(startIdx, endIdx + 1);
    promptBuildersCode += funcLines.join('\n') + '\n\n';
    // null out the lines in original
    for (let i = startIdx; i <= endIdx; i++) {
      lines[i] = null;
    }
    lines[startIdx] = `// Moved ${func} to ai/promptBuilders.js`;
  }
}

// Write promptBuilders.js
const aiDir = path.join(__dirname, 'services', 'ai');
if (!fs.existsSync(aiDir)) fs.mkdirSync(aiDir);
fs.writeFileSync(path.join(aiDir, 'promptBuilders.js'), promptBuildersCode);

// Add import to aiService
const importLine = `import { ${funcsToExtract.join(', ')} } from './ai/promptBuilders.js';`;
const finalLines = [importLine, ...lines.filter(l => l !== null)];
fs.writeFileSync(aiServicePath, finalLines.join('\n'));

console.log('Done extracting.');
