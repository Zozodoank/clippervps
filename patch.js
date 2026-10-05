const fs = require('fs');

// 1. Patch jobStore.js
let jobStore = fs.readFileSync('server/store/jobStore.js', 'utf8');
jobStore = jobStore.replace(
  /if \(b\.status === 'done'\) return \{ status: 'done', lastStatus, batch: b, verdict: b\.verdict \};/,
  "if (b.status === 'done') return { status: 'done', lastStatus, batch: b, verdict: b.verdict, error: b.lastError };"
);
fs.writeFileSync('server/store/jobStore.js', jobStore);

// 2. Patch vlmOracleService.js (normalizeOracleVerdict)
let vlmOracle = fs.readFileSync('server/services/vlmOracleService.js', 'utf8');
vlmOracle = vlmOracle.replace(
  /export function normalizeOracleVerdict\(verdict, \{ expectedFrames = 0, fallbackError = '' \} = \{\}\) \{\s*if \(!verdict \|\| typeof verdict !== 'object'\) \{/,
  export function normalizeOracleVerdict(verdict, { expectedFrames = 0, fallbackError = '' } = {}) {\n  if (typeof verdict === 'string') {\n    try {\n      const parsed = JSON.parse(verdict);\n      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) verdict = parsed;\n    } catch (e) {}\n  }\n  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) {
);
// Also patch waited.error -> waited.batch.lastError (wait, we made waitForOracleVerdict return .error instead!)
// So waited.error is now populated! No need to patch vlmOracleService for that.
fs.writeFileSync('server/services/vlmOracleService.js', vlmOracle);
