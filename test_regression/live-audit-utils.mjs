import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { qualityCorpus } from './quality-corpus.mjs';
import { compareScenario } from './quality-checks.mjs';
import { longScenarios } from './live-long-scenarios.mjs';

const smokeIDs = ['unaccepted-request', 'choice-and-unrelated-blocker', 'conditional-acceptance', 'multiple-tasks-in-owner-summary', 'decision-qualification-preserved'];
export function livePlan(argv = process.argv.slice(2)) {
  const limitIndex = argv.indexOf('--limit');
  const limit = limitIndex === -1 ? 5 : Number(argv[limitIndex + 1]);
  const ordered = argv.includes('--long') ? longScenarios : [...smokeIDs.map(id => qualityCorpus.find(scenario => scenario.id === id)), ...qualityCorpus.filter(scenario => !smokeIDs.includes(scenario.id))];
  if (!Number.isInteger(limit) || limit < 1 || limit > ordered.length) throw new Error(`--limit must be between 1 and ${ordered.length}.`);
  return { run: argv.includes('--run'), scenarios: ordered.slice(0, limit) };
}
export function geminiKey() {
  let file = '';
  try { file = readFileSync(resolve('.env.local'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read .env.local.'); }
  const values = {};
  for (const line of file.split(/\r?\n/)) {
    const match = line.match(/^\s*(GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || values.GEMINI_API_KEY || values.GOOGLE_API_KEY || '';
}
export function redact(value, key = '') {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return key ? text.replaceAll(key, '[REDACTED]') : text;
}
export function saveLiveReport(mode, report, key = '') {
  const path = resolve('.live-tests', `${mode}-report.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, redact(report, key));
  return path;
}
function parseJSON(text) {
  try { return JSON.parse(text); } catch {
    const fenced = typeof text === 'string' && text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced) try { return JSON.parse(fenced[1]); } catch { /* Record malformed output, never execute it. */ }
    return null;
  }
}
export function evaluateLive(scenario, messages, result, rawText, mode) {
  const parsed = parseJSON(rawText);
  const raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  const modelOnlyIssues = [];
  const modelFormatIssues = !raw ? ['Model output is not usable JSON.'] : mode === 'local' && !Array.isArray(raw.summary_ids) ? ['summary_ids must be an array.'] : [];
  if (!raw) modelOnlyIssues.push({ category: 'model-format', detail: 'Model output is not usable JSON.' });
  if (raw && mode === 'gemini') {
    for (const [category, expected] of [['action_items', scenario.tasks.map(task => `msg_${String(task[0]).padStart(2,'0')}`)], ['decisions', scenario.decisions.map(index => `msg_${String(index).padStart(2,'0')}`)], ['open_questions', scenario.questions.map(index => `msg_${String(index).padStart(2,'0')}`)]]) {
      const actual = (Array.isArray(raw[category]) ? raw[category] : []).map(item => item.source_id);
      if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) modelOnlyIssues.push({ category, expectedSources: expected, actualSources: actual });
    }
    for (const task of Array.isArray(raw.action_items) ? raw.action_items : []) {
      const expected = scenario.tasks.find(item => `msg_${String(item[0]).padStart(2,'0')}` === task.source_id);
      const normalize = name => String(name || '').trim().replace(/^@/, '').replace(/[‘’]/g,"'").toLowerCase();
      if (expected && normalize(task.owner) !== normalize(expected[1])) modelOnlyIssues.push({ category: 'task-owner', source: task.source_id, expected: expected[1], actual: task.owner });
    }
  }
  const summaryIDs = mode === 'local' ? (Array.isArray(raw?.summary_ids) ? raw.summary_ids.filter(id => typeof id === 'string') : []) : (Array.isArray(raw?.summary_points) ? raw.summary_points : []).map(point => point.source_id);
  const expectedSources = [...new Set([...scenario.tasks.map(task => task[0]), ...scenario.decisions, ...scenario.questions])].map(index => `msg_${String(index).padStart(2,'0')}`);
  const filler = /^(?:thanks|thank you|good morning|good afternoon|good evening|hi|hello|agreed|yes|noted|ok|okay)[.!\s]*$/i;
  const rawSummaryFlags = summaryIDs.filter(id => filler.test(messages.find(message => message.id === id)?.text || '')).map(id => `Non-informative selection: ${id}`);
  const finalSummaryFlags = result.summary_points.filter(point => filler.test(point)).map(() => 'Non-informative message in final briefing');
  const findings = [...result.action_items, ...result.decisions, ...result.open_questions];
  if (expectedSources.length && !findings.some(finding => result.summary_points.some(point => point.includes(finding.quote)))) finalSummaryFlags.push('Briefing omits all expected actionable findings; review it manually.');
  return {
    id: scenario.id, chat: scenario.chat, expected: { tasks: scenario.tasks, decisions: scenario.decisions, questions: scenario.questions },
    rawModelText: rawText, rawModelJSON: raw, rawSummaryFlags, finalSummaryFlags, modelFormatIssues,
    modelOnlyIssues: mode === 'local' ? null : modelOnlyIssues,
    summarySelection: { selectedIDs: summaryIDs, invalidIDs: summaryIDs.filter(id => !messages.some(message => message.id === id)), findingSourcesCovered: expectedSources.filter(id => summaryIDs.includes(id)).length, totalExpectedFindingSources: expectedSources.length,
      interpretation: 'Coverage indicator only, not a semantic summary-quality score; local model selection is limited to four messages.' },
    finalPipelineIssues: compareScenario(scenario, result), finalResult: result
  };
}
