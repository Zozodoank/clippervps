import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const aiServicePath = path.join(__dirname, 'services', 'aiService.js');
let code = fs.readFileSync(aiServicePath, 'utf8');

function extractFunction2(source, funcName) {
  // Find "export function funcName" or "export const funcName = "
  const startRegex = new RegExp(`export\\s+(async\\s+)?function\\s+${funcName}\\b`);
  const match = startRegex.exec(source);
  if (!match) return null;
  
  let startIndex = match.index;
  // find the first '{' after the name, but wait, if it's an object destructuring it could be many
  // we just parse until we balance '{' and '}'
  let i = startIndex;
  let bracketCount = 0;
  let hasFoundFirstBracket = false;

  while (i < source.length) {
    if (source[i] === '{') {
      bracketCount++;
      hasFoundFirstBracket = true;
    }
    if (source[i] === '}') {
      bracketCount--;
    }
    i++;
    if (hasFoundFirstBracket && bracketCount === 0) {
      break;
    }
  }
  
  return source.slice(startIndex, i);
}

const promptBuildersFunctions = [
  'formatEnrichedCaption',
  'build7SlotStoryboardClips'
];

let promptBuildersCode = fs.readFileSync(path.join(__dirname, 'services', 'ai', 'promptBuilders.js'), 'utf8');

for (const func of promptBuildersFunctions) {
  const funcCode = extractFunction2(code, func);
  if (funcCode) {
    promptBuildersCode += '\n' + funcCode + '\n';
    // Remove from original code
    code = code.replace(funcCode, `// Moved ${func} to ai/promptBuilders.js`);
  } else {
    console.log(`Could not find ${func}`);
  }
}

fs.writeFileSync(path.join(__dirname, 'services', 'ai', 'promptBuilders.js'), promptBuildersCode);
fs.writeFileSync(aiServicePath, code);

console.log('Successfully extracted remaining functions.');
