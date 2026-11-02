
/**
 * heuristics.js — Deterministic Extraction Logic
 * 
 * Contains pure, stateless extraction heuristics for CatchUp.
 * Does not depend on WebLLM or external APIs.
 */

export function extractDeterministicFindings(messages, targetUser = null) {
  const fallbackNeedsYou = [];
  const fallbackActions = [];
  const fallbackDecisions = [];
  const fallbackQuestions = [];

  // Prepare targeted regex
  let needsYouRegex = null;
  let targetUserTrimmed = '';
  if (targetUser && targetUser.trim()) {
    targetUserTrimmed = targetUser.trim();
    const escaped = targetUserTrimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    needsYouRegex = new RegExp(`(^|\\W)@?${escaped}(\\W|$)`, 'i');
  }
  const mentionRegex = /@([A-Za-z0-9_]+)/;
  const urgentRegex = /(?:urgent|blocker|blocking|action required|attention)/i;

  messages.forEach(msg => {
    // ── Strip URLs before any text analysis to avoid false positives ──────────
    const textWithoutUrls = msg.text.replace(/https?:\/\/[^\s]*/g, '');

    // 1. Needs You (Attention)
    // FIX: Skip flagging if the sender IS the targetUser (self-mention guard)
    let isTargeted = false;
    if (needsYouRegex) {
      const escaped = targetUserTrimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const senderIsTargetUser = new RegExp(`^${escaped}$`, 'i').test(msg.sender.trim());
      if (!senderIsTargetUser) {
        isTargeted = needsYouRegex.test(msg.text) || needsYouRegex.test(msg.sender);
      }
    } else {
      isTargeted = mentionRegex.test(msg.text) || urgentRegex.test(msg.text);
    }

    if (isTargeted) {
      fallbackNeedsYou.push({ text: `Attention requested: "${msg.text}"`, quote: msg.text, source_id: msg.id, priority: "high" });
    }

    // 2. Open Questions
    // FIX: Use textWithoutUrls for '?' check to avoid URL query-string false positives
    const hasQuestion = textWithoutUrls.includes('?');
    const hasUncertainty = /(?:unconfirmed|undecided|pending|haven't decided|not booked|not decided)/i.test(msg.text);

    if (hasQuestion || hasUncertainty) {
      let resolved = false;

      if (hasQuestion) {
        // FIX: Use 3+ char words (was 4+) to catch short tokens like "1 PM"
        const questionWords = msg.text.toLowerCase().match(/\w{3,}/g) || [];
        const currentIndex = messages.indexOf(msg);

        for (let j = currentIndex + 1; j <= currentIndex + 2 && j < messages.length; j++) {
          const nextMsg = messages[j].text.toLowerCase();

          // FIX: Expanded positive-ack list to include common short confirmations
          const isPositiveAck = /(?:sure|will do|got it|accepted|yes|ok|okay|no problem|on it|i'll|i will|works for me|sounds good|confirmed|can do|that works|perfect|great|done)\b/i.test(nextMsg);

          if (isPositiveAck) {
            const sharesKeyword = questionWords.some(w =>
              nextMsg.includes(w) && !['what', 'when', 'where', 'will', 'have', 'need', 'can', 'you', 'the', 'that', 'this', 'for', 'are'].includes(w)
            );

            // Also extract numeric tokens (e.g. "1", "3") from question for time references
            const questionNumbers = msg.text.match(/\b\d+\b/g) || [];
            const sharesNumber = questionNumbers.some(n => nextMsg.includes(n));

            if (sharesKeyword || sharesNumber) {
              resolved = true;
              break;
            }
          }

          // Also resolve if next message IS a pure positive-ack on its own
          // (short standalone confirmations like "confirmed", "ok", "sure", etc.)
          if (/^(?:works for me|sounds good|confirmed|can do|that works|perfect|great|done|ok|yes|sure)[\s!.]*$/i.test(nextMsg.trim())) {
            resolved = true;
            break;
          }
          
          // Also resolve if response contains "works for me" / "sounds good" alongside any numeric/time echo
          if (/(?:works for me|sounds good|can do|that works)/i.test(nextMsg)) {
            const sharesNumber = (msg.text.match(/\b\d+\b/g) || []).some(n => nextMsg.includes(n));
            if (sharesNumber) {
              resolved = true;
              break;
            }
          }
        }
      }

      if (!resolved && (hasQuestion || hasUncertainty)) {
        fallbackQuestions.push({ text: `Open item/question: "${msg.text}"`, quote: msg.text, source_id: msg.id });
      }
    }

    // 3. Commitments/Tasks
    // FIX: Exclude negations ("I can't", "I cannot", "I won't") and vague hedges
    const negationPattern = /\b(?:can't|cannot|can not|won't|will not|would not|wouldn't)\b/i;
    const vaguePattern = /\b(?:will see|will think|will consider|let's see|we'll see|we will see|think about)\b/i;

    const isCommitment = /(?:I will|I'll|I can|we will|we'll)\b/i.test(msg.text);
    const isTeamImperative = /(?:Everyone must|Everyone arrive|We need team|team testing)/i.test(msg.text);
    const isNegation = negationPattern.test(msg.text);
    const isVague = vaguePattern.test(msg.text);

    if ((isCommitment || isTeamImperative || msg.text.match(/^@Team/i)) && !msg.text.includes('?') && !isNegation && !isVague) {
      let owner = msg.sender;
      const mentionMatch = msg.text.match(/^@([A-Za-z0-9_]+)/);
      if (mentionMatch) {
        owner = mentionMatch[1];
      }
      // Ensure owner is "Team" if the message starts with @Team
      if (msg.text.match(/^@Team/i)) {
        owner = "Team";
      }
      fallbackActions.push({ text: `Confirmed task: "${msg.text}"`, owner, quote: msg.text, source_id: msg.id });
    }

    // 4. Decisions
    // FIX: Removed "require/requirement" (too noisy); added exclusions for TBD,
    //      "agreed to disagree", and speculative phrasing
    const isDecisionKeyword = /\b(?:decided|agreed|will use|decision)\b/i.test(msg.text);
    const isUncertain = /(?:maybe|unconfirmed|undecided|pending|haven't decided|not decided|not booked)/i.test(msg.text);
    const isTBD = /\b(?:tbd|to be decided|to be determined)\b/i.test(msg.text);
    const isAgreedToDisagree = /agreed to disagree/i.test(msg.text);

    if (isDecisionKeyword && !isUncertain && !isTBD && !isAgreedToDisagree && !msg.text.includes('?')) {
      fallbackDecisions.push({ text: `Decision made: "${msg.text}"`, quote: msg.text, source_id: msg.id });
    }
  });

  return { fallbackNeedsYou, fallbackActions, fallbackDecisions, fallbackQuestions };
}

export function dedupe(arr1, arr2) {
    const map = new Map();

    const getKey = f => {
      if (!f || !f.source_id) return null;
      if (f.quote && typeof f.quote === 'string' && f.quote.trim().length > 0) {
        return f.source_id + '::' + f.quote;
      }
      return f.source_id + '::' + f.text;
    };

    // First pass: deduplicate using the key function
    const allFindings = [...arr1, ...arr2];
    const uniqueKeys = new Set();
    const deduplicated = [];

    allFindings.forEach(f => {
      if (!f || !f.text || !f.source_id) return;

      const key = getKey(f);
      if (key === null) return;

      if (!uniqueKeys.has(key)) {
        uniqueKeys.add(key);
        deduplicated.push(f);
      }
    });

    // Second pass: apply owner guard to deduplicated findings
    const finalMap = new Map();
    deduplicated.forEach(f => {
      const key = getKey(f);
      if (key === null) return;

      const existing = finalMap.get(key);

      if (existing) {
        // If one finding is quote-based and the other is text-based (fallback),
        // but they have different text/quotes, do not consider them duplicates.
        const isExistingQuoteBased = existing.quote && typeof existing.quote === 'string' && existing.quote.trim().length > 0;
        const isNewQuoteBased = f.quote && typeof f.quote === 'string' && f.quote.trim().length > 0;

        if (isExistingQuoteBased !== isNewQuoteBased) {
          finalMap.set(key + '::' + (f.quote || f.text), f);
          return;
        }

        // Same key found — apply owner guard
        const existingOwner = existing.owner;
        const newOwner = f.owner;

        const ownersDiffer = existingOwner !== newOwner &&
          existingOwner !== undefined && newOwner !== undefined &&
          String(existingOwner).trim() !== String(newOwner).trim();

        if (ownersDiffer) {
          const newKey = key + '::' + (f.owner || 'unknown');
          finalMap.set(newKey, f);
        } else if (existingOwner === undefined && f.owner !== undefined) {
          existing.owner = f.owner;
        }
      } else {
        finalMap.set(key, f);
      }
    });

    return Array.from(finalMap.values());
}
