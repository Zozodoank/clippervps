import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const aiServicePath = path.join(__dirname, 'services', 'aiService.js');
let code = fs.readFileSync(aiServicePath, 'utf8');
let lines = code.split('\n');

const clientElements = [
  'const envCandidates =',
  'function cleanEnvKey',
  'function loadEnvFromDisk',
  'const defaultOpenRouterModels =',
  'function isBannedOpenRouterModel',
  'function getEffectiveOpenRouterModels',
  'function getOpenRouterKeys',
  'let currentOpenRouterKeyIndex =',
  'export const defaultGeminiDirectModels =',
  'export function getDirectGeminiApiKey',
  'export function getDirectGeminiClientConfig',
  'function getAiClientConfig',
  'function formatApiError',
  'export function isQuotaError',
  'export function isDailyQuotaExhaustedError',
  'export async function resolveImageBufferAndBase64'
];

let clientCode = `import OpenAI from 'openai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

`;

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
    // If not exported, we might need to export it if aiService uses it
    // Let's just export everything except internal vars
    const nameMatch = element.match(/(?:function|const) (\w+)/);
    if (nameMatch) {
      const name = nameMatch[1];
      if (['getAiClientConfig', 'formatApiError'].includes(name)) {
        lines[startIdx] = lines[startIdx].replace(/^(function|const)/, 'export $1');
        exportedElements.push(name);
      }
    }
  }

  // find end
  let endIdx = -1;
  let bracketCount = 0;
  let hasStarted = false;
  // some elements are array declarations ending with ];
  let arrayBracketCount = 0;
  
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    for (let c = 0; c < line.length; c++) {
      if (line[c] === '{') { bracketCount++; hasStarted = true; }
      if (line[c] === '}') { bracketCount--; }
      if (line[c] === '[') { arrayBracketCount++; hasStarted = true; }
      if (line[c] === ']') { arrayBracketCount--; }
    }

    if (element.includes('currentOpenRouterKeyIndex =')) {
      endIdx = i;
      break;
    }

    if (hasStarted && bracketCount === 0 && arrayBracketCount === 0) {
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
    lines[startIdx] = `// Moved to ai/aiClient.js`;
  }
}

// Write aiClient.js
const aiDir = path.join(__dirname, 'services', 'ai');
if (!fs.existsSync(aiDir)) fs.mkdirSync(aiDir);
fs.writeFileSync(path.join(aiDir, 'aiClient.js'), clientCode);

// Add import to aiService
const importLine = `import { ${exportedElements.join(', ')} } from './ai/aiClient.js';\nexport { defaultGeminiDirectModels, getDirectGeminiApiKey, getDirectGeminiClientConfig, isQuotaError, isDailyQuotaExhaustedError, resolveImageBufferAndBase64 };`;
const finalLines = [importLine, ...lines.filter(l => l !== null)];
fs.writeFileSync(aiServicePath, finalLines.join('\n'));

console.log('Done extracting aiClient.');
