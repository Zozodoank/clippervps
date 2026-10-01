const acorn = require('acorn');
const fs = require('fs');
let code = fs.readFileSync('server/worker/stage1Render.js', 'utf8');
code = code.replace(/break; \/\/ Berhasil, keluar dari master loop/g, '// break;');
code = code.replace(/continue; \/\/ Kembali/g, '// continue;');
const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });

function walk(node, parents) {
  if (!node) return;
  if (node.type === 'WhileStatement' && node.loc.start.line === 1125) {
    console.log('Master loop spans lines ' + node.loc.start.line + '-' + node.loc.end.line);
  }
  for (const key in node) {
    if (node[key] && typeof node[key] === 'object' && node[key].type) {
      walk(node[key], [...parents, node]);
    } else if (Array.isArray(node[key])) {
      node[key].forEach(child => {
        if (child && child.type) {
          walk(child, [...parents, node]);
        }
      });
    }
  }
}
walk(ast, []);
