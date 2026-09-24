import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const groups = [
  {
    target: 'utils/envLoader.js',
    elements: [
      'let loadedEnvFiles = [];',
      'function cleanEnvValue',
      'function isPlaceholderEnvValue',
      'function reloadEnvironment'
    ],
    imports: `import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
`
  },
  {
    target: 'services/quotaService.js',
    elements: [
      'function getDailyOutputVideoLimit',
      'function getDailyOutputVideoStats'
    ],
    imports: `import { activeJobs } from '../store/jobStore.js';
`
  },
  {
    target: 'services/antiDupService.js',
    elements: [
      'function getAllUsedYouTubeVideoIds',
      'function getAllUsedBrandProductPairsToday',
      'function getAllUsedProductNounsToday'
    ],
    imports: `import { activeJobs } from '../store/jobStore.js';
`
  },
  {
    target: 'utils/jobHelpers.js',
    elements: [
      'function isValidHttpUrl',
      'function resolveOutputVideoPath',
      'function isVideoFilePath',
      'function isQuotaErrorMessage',
      'function sanitizeCaptionText'
    ],
    imports: `import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const outputDir = path.join(__dirname, '..', 'output');
`
  }
];

function extractGroups() {
  const serverPath = path.join(__dirname, 'server.js');
  let code = fs.readFileSync(serverPath, 'utf8');
  let lines = code.split('\n');
  
  let allExported = [];

  for (const group of groups) {
    let storeCode = group.imports + '\n';
    let exportedElements = [];

    for (const element of group.elements) {
      let startIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        if (lines[i].startsWith(element) || lines[i].startsWith('export ' + element)) {
          startIdx = i;
          if (startIdx > 0 && lines[startIdx - 1] && lines[startIdx - 1].trim() === '*/') {
            let j = startIdx - 1;
            while (j >= 0 && lines[j] && !lines[j].trim().startsWith('/**')) j--;
            if (j >= 0) startIdx = j;
          }
          break;
        }
      }

      if (startIdx === -1) {
        console.log(`Not found: ${element}`);
        continue;
      }

      // Identify name and add export
      let name = '';
      if (element.startsWith('function') || element.startsWith('const') || element.startsWith('let')) {
        const nameMatch = element.match(/(?:function|const|let) (\w+)/);
        if (nameMatch) {
          name = nameMatch[1];
          // Don't add export to 'let loadedEnvFiles' automatically here if we just want it as is
          if (!lines[startIdx].startsWith('export ') && !element.startsWith('let ')) {
            lines[startIdx] = lines[startIdx].replace(/^(function|const)/, 'export $1');
          } else if (element.startsWith('let ')) {
            lines[startIdx] = lines[startIdx].replace(/^let /, 'export let ');
          }
          exportedElements.push(name);
        }
      }

      let endIdx = -1;
      let bracketCount = 0;
      let hasStarted = false;
      
      for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i];
        for (let c = 0; c < line.length; c++) {
          if (line[c] === '{') { bracketCount++; hasStarted = true; }
          if (line[c] === '}') { bracketCount--; }
        }
        
        // for variables that end with ;
        if (element.startsWith('let') && !hasStarted && line.includes(';')) {
           endIdx = i;
           break;
        }

        if (hasStarted && bracketCount === 0) {
          endIdx = i;
          break;
        }
      }

      if (endIdx !== -1) {
        const elLines = lines.slice(startIdx, endIdx + 1);
        storeCode += elLines.join('\n') + '\n\n';
        for (let i = startIdx; i <= endIdx; i++) {
          lines[i] = null;
        }
      }
    }

    const targetPath = path.join(__dirname, group.target);
    const targetDir = path.dirname(targetPath);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(targetPath, storeCode);

    if (exportedElements.length > 0) {
      allExported.push(`import { ${exportedElements.join(', ')} } from './${group.target.replace(/\\/g, '/')}';`);
    }
  }

  const finalLines = [];
  let filtered = lines.filter(l => l !== null);
  
  // Insert imports below last existing import
  let lastImportIdx = -1;
  for(let i=0; i<filtered.length; i++){
      if(filtered[i].startsWith('import ')) lastImportIdx = i;
  }
  
  if(lastImportIdx !== -1) {
      filtered.splice(lastImportIdx + 1, 0, ...allExported);
  } else {
      filtered.unshift(...allExported);
  }

  fs.writeFileSync(serverPath, filtered.join('\n'));
  console.log('Successfully extracted groups.');
}

extractGroups();
