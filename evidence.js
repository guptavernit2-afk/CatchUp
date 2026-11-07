import { normalizeForMatching, extractDeterministicFindings } from './heuristics.js';

/** Exact source validation. This verifies provenance, not semantic correctness. */
export function validateAnalysis(parsed, messages, targetUser = null) {
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const msgMap = new Map(messages.map(message => [message.id, message]));
  const rules = extractDeterministicFindings(messages, targetUser);
  const supportedSources = {
    needs_you: new Set(rules.fallbackNeedsYou.map(item => item.source_id)),
    decisions: new Set(rules.fallbackDecisions.map(item => item.source_id)),
    open_questions: new Set(rules.fallbackQuestions.map(item => item.source_id))
  };

  function getArray(keys) {
    for (const container of [root, root.results, root.output, root.data]) {
      if (!container || typeof container !== 'object') continue;
      for (const key of keys) if (Array.isArray(container[key])) return container[key];
    }
    return [];
  }

  function validate(items, category) {
    return items.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      if (typeof item.source_id !== 'string' || typeof item.quote !== 'string' || !item.quote.trim()) return [];
      const source = msgMap.get(item.source_id);
      // Never search for a different source or normalize away meaningful characters.
      if (!source || !source.text.includes(item.quote)) return [];
      const matchingText = normalizeForMatching(source.text);
      // A real quote alone doesn't establish that it is a task, alert or question.
      // Be conservative about classifications, particularly with small local models.
      if (supportedSources[category] && !supportedSources[category].has(source.id)) return [];
      if (category === 'action_items' && !/(?:\b(?:i will|i'll|i can|we will|we'll|please|can you|could you|would you|must)\b)/i.test(matchingText)) return [];
      if (category === 'decisions' && /\b(?:(?:never|not)\s+(?:\w+\s+){0,2}(?:agreed|decided)|(?:haven't|hadn't|didn't|have not|had not|did not)\s+(?:agreed|decided|agree|decide))\b/i.test(matchingText)) return [];
      if (category === 'action_items' && /\b(?:must not|should not|shouldn't|do not|don't|cannot|can't|won't|will not)\b/i.test(matchingText)) return [];

      const finding = { text: item.quote, quote: item.quote, source_id: source.id };
      if (category === 'action_items') {
        finding.owner = null;
        if (typeof item.owner === 'string' && item.owner.trim()) {
          const owner = item.owner.trim().replace(/^@/, '');
          const escaped = owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const assignment = new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:@${escaped}(?=$|[^\\p{L}\\p{N}_])|${escaped}[,:]\\s*(?:can you|could you|would you|please)\\b)`, 'iu');
          const firstPerson = /\b(?:i will|i'll|i can)\b/i.test(matchingText);
          if (owner && (source.sender?.toLocaleLowerCase() === owner.toLocaleLowerCase() || (!firstPerson && assignment.test(source.text)))) finding.owner = owner;
        }
      }
      if (category === 'needs_you') finding.priority = ['high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium';
      return [finding];
    });
  }

  return {
    needs_you: validate(getArray(['needs_you', 'needsYou', 'Needs You']), 'needs_you'),
    summary_points: validate(getArray(['summary_points', 'summaryPoints', 'summary', 'Summary']), 'summary').map(item => item.text),
    action_items: validate(getArray(['action_items', 'actionItems', 'Action Items', 'tasks']), 'action_items'),
    decisions: validate(getArray(['decisions', 'Decisions Made', 'decisions_made']), 'decisions'),
    open_questions: validate(getArray(['open_questions', 'openQuestions', 'Open Questions', 'questions']), 'open_questions')
  };
}
