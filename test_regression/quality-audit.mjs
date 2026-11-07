import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { analyzeConversation, parseConversation } from '../engine.js';
import { qualityCorpus } from './quality-corpus.mjs';

import { compareScenario, formats } from './quality-checks.mjs';

const results = [], start = performance.now();
for (const scenario of qualityCorpus) {
  for (const [format, chat] of formats(scenario.chat)) {
    const messages = parseConversation(chat);
    const result = await analyzeConversation(messages, null, scenario.target, { mode: 'heuristic' });
    results.push({ id: scenario.id, format, chat, issues: compareScenario(scenario, result), result });
  }
}
const failures = results.filter(result => result.issues.length);
const report = {
  scope: 'Human-authored synthetic English scenarios; format variants are not independent real-world examples. Direct production rules engine, no network or browser. No live LLM inference.',
  independentScenarios: qualityCorpus.length, checks: results.length, passed: results.length - failures.length, failed: failures.length,
  elapsedMs: Math.round(performance.now() - start), failures
};
const outputIndex = process.argv.indexOf('--output');
if (outputIndex !== -1) { const path = process.argv[outputIndex + 1]; mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ ...report, failures: failures.filter(item => item.format === 'plain').map(({id,issues}) => ({id,issues})) }, null, 2));
process.exitCode = failures.length ? 1 : 0;
