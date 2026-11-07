import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseConversation } from '../engine.js';
import { livePlan, saveLiveReport, evaluateLive } from './live-audit-utils.mjs';

const plan = livePlan();
const root = fileURLToPath(new URL('..', import.meta.url));
const modules = new Set(['engine.js','heuristics.js','evidence.js','local-runtime.js','local-worker.js']);
const server = createServer((request, response) => {
  const name = new URL(request.url, 'http://127.0.0.1').pathname.slice(1);
  response.setHeader('Cache-Control', 'no-store');
  if (!name) {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>CatchUp internal WebLLM test</title><script type="module">import * as engine from "/engine.js"; import {localRuntime} from "/local-runtime.js"; window.liveHarness={engine,localRuntime};</script>'); return;
  }
  if (!modules.has(name)) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', 'text/javascript');
  try { response.end(readFileSync(resolve(root, name))); } catch { response.writeHead(404); response.end(); }
});
let context;
const report = { mode: 'local', startedAt: new Date().toISOString(), scope: 'Exact production WebLLM worker/model in headless installed Chrome; isolated persistent test profile. No visible window, UI driving, user profile, or Gemini key access.', cases: [] };
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8767, '127.0.0.1', resolve); });
  context = await chromium.launchPersistentContext(resolve('.live-tests/webllm-profile'), {
    channel: 'chrome', headless: true, chromiumSandbox: true, args: ['--enable-gpu'],
    viewport: { width: 800, height: 600 }
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto('http://127.0.0.1:8767/');
  await page.waitForFunction(() => Boolean(window.liveHarness), undefined, { timeout: 15000 });
  report.gpu = await page.evaluate(async () => {
    const support = await window.liveHarness.engine.checkWebGPUSupport();
    const adapter = support.supported ? await navigator.gpu.requestAdapter() : null;
    return { ...support, adapter: adapter ? { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture, description: adapter.info?.description } : null };
  });
  console.log(JSON.stringify({ mode: 'local', headless: true, gpu: report.gpu, liveInferenceEnabled: plan.run, cases: plan.scenarios.map(scenario => scenario.id) }));
  if (!report.gpu.supported) { process.exitCode = 2; }
  else if (!plan.run) { console.log('GPU preflight only. Use --run to download/load the real model and run inference.'); }
  else {
    await page.exposeFunction('auditProgress', stage => console.log(`Local AI: ${stage}`));
    for (const scenario of plan.scenarios) {
      const started = performance.now();
      const value = await page.evaluate(async scenario => {
        const { engine, localRuntime } = window.liveHarness;
        let rawModelText = '', lastStage, suppliedCandidateIDs = [];
        const original = localRuntime.run;
        localRuntime.run = async (...args) => {
          suppliedCandidateIDs = [...(args[0]?.[1]?.content || '').matchAll(/^\[(msg_\d+)\]/gm)].map(match => match[1]);
          const reply = await original.apply(localRuntime, args);
          rawModelText = reply?.choices?.[0]?.message?.content || '';
          return reply;
        };
        try {
          const result = await engine.analyzeConversation(engine.parseConversation(scenario.chat), info => {
            if (info.stage !== lastStage) { lastStage = info.stage; window.auditProgress(info.stage); }
          }, scenario.target, { mode: 'local' });
          return { result, rawModelText, suppliedCandidateIDs };
        } catch (error) { return { error: error.message }; }
        finally { localRuntime.run = original; }
      }, scenario);
      if (value.error) { report.cases.push({ id: scenario.id, error: value.error }); console.error(`Stopped at ${scenario.id}: ${value.error}`); process.exitCode = 1; break; }
      const evaluation = evaluateLive(scenario, parseConversation(scenario.chat), value.result, value.rawModelText, 'local');
      report.cases.push({ ...evaluation, suppliedCandidateIDs: value.suppliedCandidateIDs, elapsedMs: Math.round(performance.now() - started) });
      if (evaluation.finalPipelineIssues.length || evaluation.finalSummaryFlags.length) process.exitCode = 1;
      console.log(JSON.stringify({ id: scenario.id, ms: report.cases.at(-1).elapsedMs, selected: evaluation.summarySelection.selectedIDs, finalPipelineIssues: evaluation.finalPipelineIssues.length, rawSummaryFlags: evaluation.rawSummaryFlags.length, finalSummaryFlags: evaluation.finalSummaryFlags.length, usedRuleBriefing: Boolean(value.result.notice) }));
    }
  }
} catch (error) { report.error = error.message; console.error(error.message); process.exitCode = 1; }
finally {
  try { await context?.close(); } finally { server.close(); }
  console.log(`Report: ${saveLiveReport(process.argv.includes('--long') ? 'local-long' : 'local', report)}`);
}
