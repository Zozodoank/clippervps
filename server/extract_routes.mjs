import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverPath = path.join(__dirname, 'server.js');

let code = fs.readFileSync(serverPath, 'utf8');
let lines = code.split('\n');

// 1. Grab common imports and setup
let commonSetupIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i] && lines[i].startsWith('const upload = multer({')) {
    // Find the end of the multer block
    for (let j = i; j < lines.length; j++) {
      if (lines[j] && lines[j].startsWith('});')) {
        commonSetupIdx = j;
        break;
      }
    }
    break;
  }
}

if (commonSetupIdx === -1) {
  console.error('Could not find upload multer block');
  process.exit(1);
}

const rawSetupLines = lines.slice(0, commonSetupIdx + 1);
const setupCode = rawSetupLines.join('\n')
  .replace(/from '\.\//g, "from '../")
  .replace(/from "\.\//g, "from \"../")
  // Remove express instantiation from routes (since they use router)
  .replace(/const app = express\(\);\n/, '')
  .replace(/const PORT = process.env.PORT \|\| 5000;\n/, '')
  .replace(/reloadEnvironment\(\);\n/, '');

const routerTemplate = setupCode + `\n\nconst router = express.Router();\n\n`;

const groups = {
  jobsRoutes: { path: 'api/routes/jobsRoutes.js', routes: [], prefixes: ['/api/jobs', '/api/progress'] },
  autoRoutes: { path: 'api/routes/autoRoutes.js', routes: [], prefixes: ['/api/auto'] },
  voiceoverRoutes: { path: 'api/routes/voiceoverRoutes.js', routes: [], prefixes: ['/api/upload-voiceover', '/api/regenerate-voiceover', '/api/retry-job-tts', '/api/batch-tts'] },
  mediaRoutes: { path: 'api/routes/mediaRoutes.js', routes: [], prefixes: ['/api/audio', '/api/video', '/api/download'] },
  generateRoutes: { path: 'api/routes/generateRoutes.js', routes: [], prefixes: ['/api/generate'] },
  systemRoutes: { path: 'api/routes/systemRoutes.js', routes: [], prefixes: ['/api/'] } // Catch-all for remaining
};

// 2. Extract routes
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (!line) continue;

  const match = line.match(/^app\.(get|post|delete|put)\('(\/api\/[^']+)',/);
  if (match) {
    const routeUrl = match[2];
    
    // Find group
    let groupKey = 'systemRoutes';
    for (const [key, group] of Object.entries(groups)) {
      if (key === 'systemRoutes') continue;
      if (group.prefixes.some(p => routeUrl.startsWith(p))) {
        // Exclude /api/jobs/:jobId/script.txt into mediaRoutes? No, it will go to jobsRoutes, which is fine.
        if (key === 'jobsRoutes' && routeUrl.endsWith('/script.txt')) {
           groupKey = 'mediaRoutes';
           break;
        }
        groupKey = key;
        break;
      }
    }

    let startIdx = i;
    // Check for preceding comments
    if (startIdx > 0 && lines[startIdx - 1] && lines[startIdx - 1].trim().startsWith('//')) {
      let j = startIdx - 1;
      while (j >= 0 && lines[j] && lines[j].trim().startsWith('//')) {
        j--;
      }
      startIdx = j + 1;
    }

    let endIdx = -1;
    let bracketCount = 0;
    let hasStarted = false;

    for (let k = startIdx; k < lines.length; k++) {
      const l = lines[k];
      if (!l) continue;
      for (let c = 0; c < l.length; c++) {
        if (l[c] === '{') { bracketCount++; hasStarted = true; }
        if (l[c] === '}') { bracketCount--; }
      }
      if (hasStarted && bracketCount === 0) {
        if (l.includes('});')) {
            endIdx = k;
            break;
        }
      }
    }

    if (endIdx !== -1) {
      let extractedLines = lines.slice(startIdx, endIdx + 1);
      // Replace app.get with router.get, but strip /api since router will be mounted at /api
      extractedLines = extractedLines.map(el => {
          if (el.match(/^app\.(get|post|delete|put)\('/)) {
             return el.replace(/^app\./, 'router.').replace(/'\/api\//, "'/");
          }
          return el;
      });
      groups[groupKey].routes.push(extractedLines.join('\n'));
      
      for (let k = startIdx; k <= endIdx; k++) {
        lines[k] = null;
      }
    }
  }
}

// Write the router files
let importedRouters = [];
for (const [key, group] of Object.entries(groups)) {
  if (group.routes.length === 0) continue;
  
  const targetPath = path.join(__dirname, group.path);
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  
  let content = routerTemplate + group.routes.join('\n\n') + '\n\nexport default router;\n';
  fs.writeFileSync(targetPath, content);
  
  importedRouters.push({
    name: key,
    importPath: `./${group.path.replace(/\\/g, '/')}`
  });
}

// Update server.js
let filtered = lines.filter(l => l !== null);
let importLines = importedRouters.map(ir => `import ${ir.name} from '${ir.importPath}';`);
let useLines = importedRouters.map(ir => `app.use('/api', ${ir.name});`);

// Insert imports right before tokenAuthMiddleware or some other top place
let insertionIdx = -1;
for (let i = 0; i < filtered.length; i++) {
  if (filtered[i] && filtered[i].includes('function tokenAuthMiddleware')) {
    insertionIdx = i;
    break;
  }
}

if (insertionIdx !== -1) {
  filtered.splice(insertionIdx, 0, ...importLines, '', ...useLines, '');
} else {
  filtered.push(...importLines, '', ...useLines);
}

fs.writeFileSync(serverPath, filtered.join('\n'));
console.log('Successfully extracted routes.');
