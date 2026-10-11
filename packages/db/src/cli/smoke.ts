import { runSmokeTest } from '../smoke.js';

// Usage: node dist/cli/smoke.js <local-database-url> [--expect <n>]
// The database must already have the schema applied with --shims (and --upgrade for the full 17-failure run).

const [url, ...rest] = process.argv.slice(2);
if (!url) {
  console.error('usage: smoke <local-database-url> [--expect <n>]');
  process.exit(2);
}
const expectIdx = rest.indexOf('--expect');
const expected = expectIdx >= 0 ? Number(rest[expectIdx + 1]) : undefined;

const report = await runSmokeTest(url);
console.log(
  `smoke test: ${report.expectedFailuresFired}/${report.expectedFailuresDeclared} expected failures fired`,
);
for (const p of report.problems) console.error(`  problem: ${p}`);
const countOk = expected === undefined || report.expectedFailuresFired === expected;
if (!countOk) console.error(`  expected exactly ${expected} failures`);
process.exit(report.problems.length === 0 && countOk ? 0 : 1);
