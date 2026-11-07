import { normalizeForMatching, extractDeterministicFindings } from './heuristics.js';

/** Exact source validation. This verifies provenance, not semantic correctness. */
export function validateAnalysis(parsed, messages, targetUser = null) {
  const root = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  const msgMap = new Map(messages.map(message => [message.id, message]));
  const rules = extractDeterministicFindings(messages, targetUser);
  const canonicalCategories = {
    needs_you: rules.fallbackNeedsYou, action_items: rules.fallbackActions,
    decisions: rules.fallbackDecisions, open_questions: rules.fallbackQuestions
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
      if (canonicalCategories[category]) {
        const candidates = canonicalCategories[category];
        const canonical = candidates.find(finding => finding.source_id === source.id && finding.quote.includes(item.quote));
        // Status, ownership and linked context come from the shared conversation
        // policy, never from the model's unsupported claim of confirmation.
        return canonical ? [{ ...canonical }] : [];
      }
      if (category === 'summary' && /^(?:agreed|yes|sounds good|confirmed)[.!\s]*$/i.test(normalizeForMatching(item.quote))) return [];
      // An exact substring can still omit a negation or condition. Briefing
      // selections retain the whole message rather than a misleading fragment.
      const finding = { text: source.text, quote: source.text, source_id: source.id };
      return [finding];
    });
  }

  return {
    needs_you: validate(getArray(['needs_you', 'needsYou', 'Needs You']), 'needs_you'),
    summary_points: [...new Set(validate(getArray(['summary_points', 'summaryPoints', 'summary', 'Summary']), 'summary').map(item => item.text))],
    action_items: validate(getArray(['action_items', 'actionItems', 'Action Items', 'tasks']), 'action_items'),
    decisions: validate(getArray(['decisions', 'Decisions Made', 'decisions_made']), 'decisions'),
    open_questions: validate(getArray(['open_questions', 'openQuestions', 'Open Questions', 'questions']), 'open_questions')
  };
}
