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
      if (category === 'action_items' || category === 'decisions') {
        const candidates = category === 'action_items' ? rules.fallbackActions : rules.fallbackDecisions;
        const canonical = candidates.find(finding => finding.source_id === source.id && finding.quote.includes(item.quote));
        // Status, ownership and linked context come from the shared conversation
        // policy, never from the model's unsupported claim of confirmation.
        return canonical ? [{ ...canonical }] : [];
      }
      if (supportedSources[category] && !supportedSources[category].has(source.id)) return [];
      if (category === 'summary' && /^(?:agreed|yes|sounds good|confirmed)[.!\s]*$/i.test(normalizeForMatching(item.quote))) return [];
      const finding = { text: item.quote, quote: item.quote, source_id: source.id };
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
