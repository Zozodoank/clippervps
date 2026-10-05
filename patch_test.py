import os

f = 'server/tests/vlmOracle.test.js'
c = open(f, encoding='utf-8').read()

c = c.replace(
    'submitOracleResult({ batchId: batch.id, verdict: verdictFor(batch) });',
    'submitOracleResult({ batchId: batch.id, verdict: verdictFor(batch), attempt: batch.attempts, workerId: batch.workerId });'
)

# And standalone submitOracleResult in jobStore oracle queue tests:
c = c.replace(
    "submitOracleResult({ batchId: 'q_atomic', verdict: { safe: false, face: true } })",
    "submitOracleResult({ batchId: 'q_atomic', verdict: { safe: false, face: true }, attempt: 1, workerId: 'nb1' })"
)
c = c.replace(
    "submitOracleResult({ batchId: 'q_atomic', verdict: { safe: true } })",
    "submitOracleResult({ batchId: 'q_atomic', verdict: { safe: true }, attempt: 1, workerId: 'nb1' })"
)
c = c.replace(
    "submitOracleResult({ batchId: 'q_stale', verdict: { safe: false } })",
    "submitOracleResult({ batchId: 'q_stale', verdict: { safe: false }, attempt: 2, workerId: 'nb2' })"
)
c = c.replace(
    "submitOracleResult({ batchId: 'q_give', verdict: { safe: true } })",
    "submitOracleResult({ batchId: 'q_give', verdict: { safe: true }, attempt: 1, workerId: 'nb1' })"
)

# In test "STRICT: vonis tidak sah -> LEMPAR":
# Since we modified normalizeOracleVerdict to parse JSON, if a test sends { text: "..." } it's fine.
# But if it sends a string "model mengirim prosa", it might be caught by the string parser and return null, triggering infraError.
# Wait, the test does: () => ({ text: 'model mengirim prosa' }) which is an OBJECT with key 'text'. So it's fine.

open(f, 'w', encoding='utf-8').write(c)
print('Patched test')
