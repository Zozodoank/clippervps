const acorn = require('acorn');
const fs = require('fs');
let code = fs.readFileSync('stage1Render_true_old.js', 'utf16le');
// Wait, the file generated from PowerShell might have a BOM or just be UTF16LE.
// I will just strip BOM if needed.
const ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });

function walk(node) {
  if (!node) return;
  if (node.loc && node.loc.end.line === 2058) {
    console.log('Node ending at 2058 is: ' + node.type);
    console.log('Starts at line: ' + node.loc.start.line);
  }
  for (const key in node) {
    if (node[key] && typeof node[key] === 'object') {
      walk(node[key]);
    }
  }
}
walk(ast);
