const Database = require('better-sqlite3');
const db = new Database('server/jobs.db', { readonly: true });
const stmt = db.prepare('SELECT data FROM jobs ORDER BY id DESC LIMIT 5');
const rows = stmt.all();
for (const row of rows) {
  const d = JSON.parse(row.data);
  console.log('ID:', d.id);
  console.log('Title:', d.productTitle);
  console.log('Desc:', d.productDescription);
  console.log('Keyword:', d.keyword);
  console.log('Status:', d.status);
  console.log('Step:', d.currentStep);
  console.log('Progress:', d.progressMessage);
  console.log('---------------------------');
}
