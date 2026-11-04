const fs = require('fs');

const heuristicsCode = fs.readFileSync('heuristics.js', 'utf8')
  .replace(/export function/g, 'function')
  .replace(/export /g, '');
const heuristicsFn = new Function('assert', heuristicsCode + '\nreturn { extractDeterministicFindings, dedupe };');
const { extractDeterministicFindings, dedupe } = heuristicsFn();

const engineCode = fs.readFileSync('engine.js', 'utf8')
  .replace(/import\s+[^;]+;/g, '')
  .replace(/export async function/g, 'async function')
  .replace(/export function/g, 'function')
  .replace(/export /g, '');

const engineFn = new Function('extractDeterministicFindings', 'dedupe', engineCode + '\nreturn { parseConversation, analyzeConversation };');
const { parseConversation, analyzeConversation } = engineFn(extractDeterministicFindings, dedupe);

const SAMPLE = `Alice: Hey, are we still meeting for the hackathon planning tomorrow at 10 AM?
Bob: I can't make 10 AM, I have a dentist appointment. Can we do 1 PM instead?
Charlie: 1 PM works for me. We need to decide on the tech stack. I'm thinking we use WebLLM for the AI component.
Alice: Sounds good. Bob, can you look into the WebLLM documentation before we meet?
Bob: Will do. Also, should we use React or keep it vanilla JS?
Alice: Let's keep it simple for now. Vanilla JS unless we hit a wall.
Charlie: Agreed. Who's handling the UI design? I can do it if nobody else wants to.
Alice: That would be great, Charlie. I'll focus on the AI integration then.
Bob: Perfect. See you both at 1 PM tomorrow.
Charlie: One more thing — do we have access to the hackathon API credentials yet?
Alice: Not yet. I'll email the organizers today and ask.`;

const msgs = parseConversation(SAMPLE);

(async () => {
  const result = await analyzeConversation(msgs, null, null, { mode: 'heuristic' });
  console.log('=== INSTANT HEURISTIC MODE COMPLETE RESULT ===');
  console.log('\nSUMMARY POINTS:');
  result.summary_points.forEach(p => console.log('  • ' + p));

  console.log('\nACTION ITEMS (' + result.action_items.length + '):');
  result.action_items.forEach(a => console.log(`  [${a.owner}] ${a.text}`));

  console.log('\nDECISIONS (' + result.decisions.length + '):');
  result.decisions.forEach(d => console.log(`  ${d.text}`));

  console.log('\nOPEN QUESTIONS / BLOCKERS (' + result.open_questions.length + '):');
  result.open_questions.forEach(q => console.log(`  [${q.source_id}] ${q.text}`));
})();
