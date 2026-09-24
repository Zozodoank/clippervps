import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const aiServicePath = path.join(__dirname, 'services', 'aiService.js');
let code = fs.readFileSync(aiServicePath, 'utf8');

function extractFunction(source, funcName) {
  // Find "export function funcName" or "export const funcName = "
  const startRegex = new RegExp(`export\\s+(async\\s+)?function\\s+${funcName}\\s*\\([^{]*\\)\\s*\\{`, 's');
  const match = startRegex.exec(source);
  if (!match) return null;
  
  let startIndex = match.index;
  let bracketCount = 0;
  let i = startIndex + match[0].length;
  bracketCount = 1; // from the '{' in the regex

  while (i < source.length && bracketCount > 0) {
    if (source[i] === '{') bracketCount++;
    if (source[i] === '}') bracketCount--;
    i++;
  }
  
  return source.slice(startIndex, i);
}

const promptBuildersFunctions = [
  'getDynamicProductHookFallback',
  'buildNicheProductCriterion',
  'buildFaceAndMotionCriterion',
  'formatEnrichedCaption',
  'sanitizeScriptVocabulary',
  'build7SlotStoryboardClips',
  'truncateProductDescription'
];

let promptBuildersCode = `import { extractCoreProductInfo, isBulkyOrUnsuitableProduct } from '../discoveryService.js';\nimport { getNichePreset } from '../../config/nichePresets.js';\n\n`;

for (const func of promptBuildersFunctions) {
  const funcCode = extractFunction(code, func);
  if (funcCode) {
    promptBuildersCode += funcCode + '\n\n';
    // Remove from original code
    code = code.replace(funcCode, `// Moved ${func} to ai/promptBuilders.js`);
  } else {
    console.log(`Could not find ${func}`);
  }
}

const aiDir = path.join(__dirname, 'services', 'ai');
if (!fs.existsSync(aiDir)) fs.mkdirSync(aiDir);

fs.writeFileSync(path.join(aiDir, 'promptBuilders.js'), promptBuildersCode);
fs.writeFileSync(aiServicePath, `import { ${promptBuildersFunctions.join(', ')} } from './ai/promptBuilders.js';\n` + code);

console.log('Successfully extracted promptBuilders.js');
