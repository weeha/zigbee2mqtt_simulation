// Runs every scenario that contains an "Expect" step on a running simulator
// and exits with 1 if one of them fails:  npm run scenarios  [-- http://host:8099]

const base = (process.argv[2] || process.env.SIM_URL || 'http://localhost:8099').replace(/\/$/, '');

let res;
try {
  res = await fetch(`${base}/api/tests/run`, { method: 'POST' });
} catch (err) {
  console.error(`Could not reach the simulator at ${base}: ${err.cause?.message || err.message}`);
  process.exit(2);
}
const data = await res.json();
if (!res.ok) {
  console.error(data.error || `Request failed (${res.status})`);
  process.exit(2);
}

for (const r of data.results) {
  console.log(`${r.status === 'passed' ? 'PASS' : r.status === 'failed' ? 'FAIL' : 'STOP'}  ${r.name}  (${r.seconds.toFixed(1)} s)`);
  for (const f of r.failures) console.log(`      step ${f.step + 1}: ${f.message}`);
}
console.log(`\n${data.passed} passed, ${data.failed} failed${data.stopped ? `, ${data.stopped} stopped` : ''}`);
process.exit(data.ok ? 0 : 1);
