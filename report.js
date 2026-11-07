/** Pure report formatting shared by clipboard and file export. */
export function generateMarkdown(data) {
  if (!data) return '';
  const lines = [];
  lines.push('# CatchUp — Conversation Analysis Report');
  const processingLabel = data.processing_mode === 'cloud' ? 'Cloud API analysis'
    : data.processing_mode === 'heuristic' ? 'On-device rule analysis' : 'On-device AI analysis';
  lines.push(`*Generated on ${new Date().toLocaleString()} · ${processingLabel}*\n`);
  if (data.notice) lines.push(`Processing note: ${data.notice}\n`);

  if (data.summary_points && data.summary_points.length > 0) {
    lines.push('## Executive Summary');
    data.summary_points.forEach(pt => lines.push(`- ${pt}`));
    lines.push('');
  }

  if (data.needs_you && data.needs_you.length > 0) {
    lines.push('## Needs Your Attention');
    data.needs_you.forEach(item => {
      lines.push(`- **[ALERT]** ${item.text}`);
      if (item.quote) lines.push(`  > "${item.quote}" (${item.source_id})`);
    });
    lines.push('');
  }

  if (data.action_items && data.action_items.length > 0) {
    lines.push('## Action Items & Deliverables');
    data.action_items.forEach(task => {
      const owner = task.owner ? ` (@${task.owner})` : '';
      lines.push(`- [${task.completed ? 'x' : ' '}] **${task.text}**${owner} · ${task.status === 'requested' ? 'Requested' : 'Confirmed'}`);
      if (task.quote) lines.push(`  > "${task.quote}" (${task.source_id})`);
      if (task.confirmation) lines.push(`  > Acceptance: "${task.confirmation.quote}" (${task.confirmation.source_id})`);
    });
    lines.push('');
  }

  if (data.decisions && data.decisions.length > 0) {
    lines.push('## Decisions Made');
    data.decisions.forEach(dec => {
      lines.push(`- ✅ ${dec.text}`);
      if (dec.quote) lines.push(`  > "${dec.quote}" (${dec.source_id})`);
      if (dec.confirmation) lines.push(`  > Agreement: "${dec.confirmation.quote}" (${dec.confirmation.source_id})`);
    });
    lines.push('');
  }

  if (data.open_questions && data.open_questions.length > 0) {
    lines.push('## Open Questions & Blockers');
    data.open_questions.forEach(q => {
      lines.push(`- ❓ ${q.text}`);
      if (q.quote) lines.push(`  > "${q.quote}" (${q.source_id})`);
    });
    lines.push('');
  }

  return lines.join('\n');
}
