import { isDeepStrictEqual } from 'node:util';
const id = index => `msg_${String(index).padStart(2, '0')}`;
export function compareScenario(scenario, result) {
  const issues = [];
  const tasks = result.action_items.map(item => [item.source_id, item.owner, item.status]);
  const expectedTasks = scenario.tasks.map(([source, owner, status]) => [id(source), owner, status]);
  if (!isDeepStrictEqual(tasks, expectedTasks)) issues.push({ category: 'tasks', expected: expectedTasks, actual: tasks });
  for (const [index, task] of scenario.tasks.entries()) if (task[3] && !result.action_items[index]?.quote.includes(task[3])) issues.push({ category: 'task-context', expected: task[3], actual: result.action_items[index]?.quote });
  for (const [category, expected] of [['decisions', scenario.decisions], ['open_questions', scenario.questions], ...(scenario.attention ? [['needs_you', scenario.attention]] : [])]) {
    const actual = result[category].map(item => item.source_id);
    if (!isDeepStrictEqual(actual, expected.map(id))) issues.push({ category, expected: expected.map(id), actual });
  }
  const summary = result.summary_points.join(' ');
  if (scenario.completed) {
    const actual = result.action_items.flatMap((task, index) => task.completed ? [index] : []);
    if (!isDeepStrictEqual(actual, scenario.completed)) issues.push({ category: 'completion', expected: scenario.completed, actual });
  }
  for (const text of scenario.summaryIncludes || []) if (!summary.toLocaleLowerCase().includes(text.toLocaleLowerCase())) issues.push({ category: 'summary-missing', expected: text, actual: summary });
  for (const text of scenario.summaryExcludes || []) if (summary.toLocaleLowerCase().includes(text.toLocaleLowerCase())) issues.push({ category: 'summary-invented', expected: `Must not contain ${text}`, actual: summary });
  for (const text of scenario.decisionIncludes || []) if (!result.decisions.some(item => item.quote.includes(text))) issues.push({ category: 'decision-context', expected: text, actual: result.decisions });
  return issues;
}

export function formats(chat) {
  const lines = chat.split('\n');
  return [
    ['plain', chat],
    ['smart-apostrophes', chat.replaceAll("'", '’')],
    ['whatsapp-android', lines.map((line, i) => `08/11/2026, 10:${String(i).padStart(2,'0')} - ${line}`).join('\n')],
    ['whatsapp-ios', lines.map((line, i) => `[08/11/2026, 10:${String(i).padStart(2,'0')}:00] ${line}`).join('\n')]
  ];
}
