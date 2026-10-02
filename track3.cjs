const fs = require('fs');
let code = fs.readFileSync('server/worker/stage1Render.js', 'utf8');
code = code.replace(/break; \/\/ Berhasil, keluar dari master loop/g, '// break;');
code = code.replace(/continue; \/\/ Kembali/g, '// continue;');
code = code.replace(/`([^`\\]|\\.)*`/g, '``');
code = code.replace(/'([^'\\]|\\.)*'/g, '\'\'');
code = code.replace(/\"([^\"\\]|\\.)*\"/g, '\"\"');
code = code.replace(/\/\/.*/g, '');

const lines = code.split('\n');
for (let i = 1115; i < 1135; i++) {
  console.log((i+1) + ': ' + lines[i]);
}
