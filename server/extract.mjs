import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function extractToStore() {
  const serverPath = path.join(__dirname, 'server.js');
  let code = fs.readFileSync(serverPath, 'utf8');
  let lines = code.split('\n');

  const elementsToExtract = [
    'const activeJobs = new Map();',
    'const jobProgress = new Map();',
    'const autoRuns = new Map();',
    'const autoRetryRuns = new Map();',
    'function sanitizeJobForDisk',
    'function atomicWriteJsonSync',
    'function loadJobsFromDisk',
    'function persistJob',
    'function deletePersistedJob',
    'function updateJobProgress',
    'function publicAutoRetryState',
    'function publicAutoRunState',
    'function updateAutoRun',
    'function getLatestAutoRun'
  ];

  let storeCode = `import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDailyOutputVideoStats } from '../server.js'; // Needed by publicAutoRunState

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const jobsFilePath = path.join(__dirname, '..', 'jobs.json');

`;

  let exportedElements = ['jobsFilePath'];

  for (const element of elementsToExtract) {
    let startIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      if (lines[i].startsWith(element)) {
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
    if (element.startsWith('function') || element.startsWith('const')) {
      const nameMatch = element.match(/(?:function|const) (\w+)/);
      if (nameMatch) {
        name = nameMatch[1];
        if (!lines[startIdx].startsWith('export ')) {
          lines[startIdx] = lines[startIdx].replace(/^(function|const)/, 'export $1');
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
      if (element.includes('new Map()')) {
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

  // Remove jobsFilePath manually
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] && lines[i].includes("const jobsFilePath = path.join(__dirname, 'jobs.json');")) {
      lines[i] = null;
    }
  }

  const storeDir = path.join(__dirname, 'store');
  if (!fs.existsSync(storeDir)) fs.mkdirSync(storeDir);
  fs.writeFileSync(path.join(storeDir, 'jobStore.js'), storeCode);

  const importLine = `import { ${exportedElements.join(', ')} } from './store/jobStore.js';`;
  const finalLines = [];
  
  // Clean nulls
  let filtered = lines.filter(l => l !== null);
  
  // Insert import below last existing import
  let lastImportIdx = -1;
  for(let i=0; i<filtered.length; i++){
      if(filtered[i].startsWith('import ')) lastImportIdx = i;
  }
  
  if(lastImportIdx !== -1) {
      filtered.splice(lastImportIdx + 1, 0, importLine);
  } else {
      filtered.unshift(importLine);
  }

  fs.writeFileSync(serverPath, filtered.join('\n'));
  console.log('Successfully extracted elements to store/jobStore.js and updated server.js.');
}

extractToStore();
