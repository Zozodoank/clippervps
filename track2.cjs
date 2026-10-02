const fs = require('fs');
let code = fs.readFileSync('server/worker/stage1Render.js', 'utf8');
code = code.replace(/break; \/\/ Berhasil, keluar dari master loop/g, '// break;');
code = code.replace(/continue; \/\/ Kembali/g, '// continue;');
code = code.replace(/`([^`\\]|\\.)*`/g, '``');
code = code.replace(/'([^'\\]|\\.)*'/g, '\'\'');
code = code.replace(/\"([^\"\\]|\\.)*\"/g, '\"\"');
code = code.replace(/\/\/.*/g, '');

const lines = code.split('\n');
console.log('Modified Line 1124: ' + lines[1124]);
console.log('Opens: ' + (lines[1124].match(/\{/g) || []).length);
console.log('Closes: ' + (lines[1124].match(/\}/g) || []).length);
