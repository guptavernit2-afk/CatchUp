import { performance } from 'node:perf_hooks';
import { analyzeConversation, parseConversation, DEFAULT_GEMINI_MODEL } from '../engine.js';
import { livePlan, geminiKey, redact, saveLiveReport, evaluateLive } from './live-audit-utils.mjs';

const plan = livePlan(), key = geminiKey();
console.log(JSON.stringify({ mode: 'gemini', model: DEFAULT_GEMINI_MODEL, keyConfigured: Boolean(key), cases: plan.scenarios.map(scenario => scenario.id), liveRequestsEnabled: plan.run }));
if (!plan.run) { console.log('Preflight only. Use --run to make live requests.'); process.exit(0); }
if (!key) { console.error('Set GEMINI_API_KEY in .env.local or the process environment. Do not paste it into chat.'); process.exit(2); }
const report = { mode: 'gemini', model: DEFAULT_GEMINI_MODEL, startedAt: new Date().toISOString(), scope: 'Synthetic corpus; real Gemini responses captured separately from canonical rule corrections. Five cases by default, no retries.', cases: [] };
const fetchOriginal = globalThis.fetch;
let captured = '';
globalThis.fetch = async (...args) => {
  const response = await fetchOriginal(...args);
  if (response.ok) {
    const data = await response.clone().json();
    captured = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
  }
  return response;
};
try {
  for (const scenario of plan.scenarios) {
    const messages = parseConversation(scenario.chat), started = performance.now(); captured = '';
    try {
      const result = await analyzeConversation(messages, null, scenario.target, { mode: 'cloud', apiProvider: 'gemini', apiKey: key });
      const evaluation = evaluateLive(scenario, messages, result, captured, 'gemini');
      report.cases.push({ ...evaluation, elapsedMs: Math.round(performance.now() - started) });
      if (evaluation.finalPipelineIssues.length || evaluation.finalSummaryFlags.length) process.exitCode = 1;
      console.log(JSON.stringify({ id: scenario.id, ms: report.cases.at(-1).elapsedMs, modelOnlyIssues: evaluation.modelOnlyIssues.length, finalPipelineIssues: evaluation.finalPipelineIssues.length, rawSummaryFlags: evaluation.rawSummaryFlags.length, finalSummaryFlags: evaluation.finalSummaryFlags.length }));
    } catch (error) {
      report.cases.push({ id: scenario.id, error: redact(error.message, key), elapsedMs: Math.round(performance.now() - started) });
      console.error(`Stopped at ${scenario.id}: ${redact(error.message, key)}`);
      process.exitCode = 1; break;
    }
    // Serial, low-volume smoke run. Respect a quota error by stopping, not retrying.
    if (scenario !== plan.scenarios.at(-1)) await new Promise(resolve => setTimeout(resolve, 1500));
  }
} finally {
  globalThis.fetch = fetchOriginal;
  console.log(`Report: ${saveLiveReport(process.argv.includes('--long') ? 'gemini-long' : 'gemini', report, key)}`);
}
