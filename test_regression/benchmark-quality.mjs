import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run against the working tree, or a read-only source snapshot supplied as argv[2].
const moduleURL = process.argv[2] ? pathToFileURL(resolve(process.argv[2], 'engine.js')) : new URL('../engine.js', import.meta.url);
const { analyzeConversation, parseConversation } = await import(moduleURL.href);
const results = [];
for (const [label, count, question] of [['200 tasks',200,false], ['1000 tasks',1000,false], ['1000 open questions',1000,true]]) {
  const chat = Array.from({ length: count }, (_, index) => `Person${index}: ${question ? `Where is document number ${index + 1}?` : `I will review document ${index + 1} tomorrow.`}`).join('\n');
  const times = [];
  let result;
  for (let run = 0; run < 6; run++) {
    const start = performance.now();
    result = await analyzeConversation(parseConversation(chat), null, null, { mode: 'heuristic' });
    if (run) times.push(performance.now() - start);
  }
  times.sort((a,b) => a-b);
  results.push({ label, messages: count, tasks: result.action_items.length, openQuestions: result.open_questions.length,
    medianMs: Number(times[2].toFixed(2)), minMs: Number(times[0].toFixed(2)), maxMs: Number(times[4].toFixed(2)) });
}
const report = { scope: 'Node on this machine, synthetic chats, parsing + rule extraction + briefing. Five measured runs after warm-up. Not GPU/cloud timings or a general latency guarantee.', results };
console.log(JSON.stringify(report, null, 2));
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
