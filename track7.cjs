const acorn = require('acorn');
const fs = require('fs');
let code = fs.readFileSync('server/worker/stage1Render.js', 'utf8');
code = code.replace(/break; \/\/ Berhasil, keluar dari master loop/g, '// break;');
code = code.replace(/continue; \/\/ Kembali/g, '// continue;');
const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });

function walk(node, parents) {
  if (!node) return;
  if (node.loc && node.loc.start.line === 2662) {
    console.log('Parents of try at 2662:');
    parents.forEach(p => console.log('  ' + p.type + ' (lines ' + p.loc.start.line + '-' + p.loc.end.line + ')'));
    return;
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
