const fs = require('fs');
const file = 'server/worker/stage1Render.js';
let code = fs.readFileSync(file, 'utf8');

const lines = code.split('\n');

for (let i = 0; i < lines.length; i++) {
  if (i === 886 && lines[i].includes('ttsSucceeded = false;')) {
    lines[i] = lines[i].replace('ttsSucceeded = false;', 'let ttsSucceeded = false;');
  }
  if (i === 2633 && lines[i].includes('let ttsSucceeded = false;')) {
    lines[i] = lines[i].replace('let ttsSucceeded = false;', 'ttsSucceeded = false;');
  }
}

fs.writeFileSync(file, lines.join('\n'), 'utf8');
console.log('Fixed ttsSucceeded shadowing');
