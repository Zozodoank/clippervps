import os

f = 'server/store/jobStore.js'
content = open(f, encoding='utf-8').read()
content = content.replace(
    "if (b.status === 'done') return { status: 'done', lastStatus, batch: b, verdict: b.verdict };",
    "if (b.status === 'done') return { status: 'done', lastStatus, batch: b, verdict: b.verdict, error: b.lastError };"
)
open(f, 'w', encoding='utf-8').write(content)

f = 'server/services/vlmOracleService.js'
content = open(f, encoding='utf-8').read()
old_norm = """export function normalizeOracleVerdict(verdict, { expectedFrames = 0, fallbackError = '' } = {}) {
  if (!verdict || typeof verdict !== 'object') {"""
new_norm = """export function normalizeOracleVerdict(verdict, { expectedFrames = 0, fallbackError = '' } = {}) {
  if (typeof verdict === 'string') {
    try {
      const parsed = JSON.parse(verdict);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) verdict = parsed;
    } catch (e) {}
  }
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) {"""
content = content.replace(old_norm, new_norm)

# Juga ubah pemanggil normalizeOracleVerdict untuk menggunakan batch.lastError (di pool, clip, dan preflight)
content = content.replace("fallbackError: waited.error", "fallbackError: waited.error || (waited.batch && waited.batch.lastError)")
open(f, 'w', encoding='utf-8').write(content)
print('Patched files successfully.')
