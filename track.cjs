const fs = require('fs');
let code = fs.readFileSync('server/worker/stage1Render.js', 'utf8');
code = code.replace(/break; \/\/ Berhasil, keluar dari master loop/g, '// break;');
code = code.replace(/continue; \/\/ Kembali/g, '// continue;');

// replace all strings and template literals with empty string to avoid false positives
code = code.replace(/`([^`\\]|\\.)*`/g, '``');
code = code.replace(/'([^'\\]|\\.)*'/g, '\'\'');
code = code.replace(/\"([^\"\\]|\\.)*\"/g, '\"\"');
// replace single line comments
code = code.replace(/\/\/.*/g, '');

const lines = code.split('\n');
let bal = 0;
for (let i = 1124; i <= 2057; i++) {
  const line = lines[i];
  const opens = (line.match(/\{/g) || []).length;
  const closes = (line.match(/\}/g) || []).length;
  bal += opens - closes;
  if (bal === 0) {
    console.log('Balance 0 reached at line ' + (i+1));
    break;
  }
}
