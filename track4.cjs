const fs = require('fs');
let code = fs.readFileSync('server/worker/stage1Render.js', 'utf8');
code = code.replace(/break; \/\/ Berhasil, keluar dari master loop/g, '// break;');
code = code.replace(/continue; \/\/ Kembali/g, '// continue;');
code = code.replace(/`([^`\\]|\\.)*`/g, '``');
code = code.replace(/'([^'\\]|\\.)*'/g, '\'\'');
code = code.replace(/\"([^\"\\]|\\.)*\"/g, '\"\"');
code = code.replace(/\/\/.*/g, '');

const lines = code.split('\n');
let bal = 0;
let started = false;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('while (!finalCompletedJob')) started = true;
  if (!started) continue;
  
  const opens = (line.match(/\{/g) || []).length;
  const closes = (line.match(/\}/g) || []).length;
  bal += opens - closes;
  if (bal === 0) {
    console.log('Balance 0 reached at line ' + (i+1));
    break;
  }
}
