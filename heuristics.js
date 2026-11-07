
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
  let senderIsTargetUserRegex = null; // Hoisted: built once, tested per message
  if (targetUser && targetUser.trim()) {
    targetUserTrimmed = targetUser.trim().replace(/^@/, '');
    const escaped = targetUserTrimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    needsYouRegex = new RegExp(`(^|\\W)@?${escaped}(\\W|$)`, 'i');
    senderIsTargetUserRegex = new RegExp(`^${escaped}$`, 'i');
  }
  const mentionRegex = /@([A-Za-z0-9_]+)/;
  const urgentRegex = /(?:urgent|blocker|blocking|action required|attention)/i;

  messages.forEach(msg => {
    // Guard: skip malformed messages
    if (!msg || typeof msg.text !== 'string') return;

    // ── Strip URLs before any text analysis to avoid false positives ──────────
    const textWithoutUrls = msg.text.replace(/https?:\/\/[^\s]*/g, '');

    // 1. Needs You (Attention)
    // FIX: Skip flagging if the sender IS the targetUser (self-mention guard)
    let isTargeted = false;
    if (needsYouRegex) {
      const sender = (msg.sender || '').trim().replace(/^@/, '');
      const senderIsTargetUser = senderIsTargetUserRegex.test(sender);
      if (!senderIsTargetUser) {
        isTargeted = needsYouRegex.test(msg.text) || (msg.sender ? needsYouRegex.test(msg.sender) : false);
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
        // Substantive words: exclude conversational stopwords
        const stopwords = new Set([
          'what', 'when', 'where', 'which', 'who', 'why', 'how', 'will', 'have', 'need', 'can', 'could',
          'should', 'would', 'you', 'the', 'that', 'this', 'for', 'are', 'and', 'with', 'from', 'about',
          'just', 'also', 'some', 'any', 'one', 'more', 'thing', 'yet', 'still', 'not', 'did', 'does',
          'been', 'were', 'was', 'our', 'out', 'all', 'into', 'before', 'then'
        ]);

        const rawWords = (msg.text.toLowerCase().match(/\w{3,}/g) || []);
        const questionWords = rawWords.filter(w => !stopwords.has(w));
        const questionNumbers = msg.text.match(/\b\d+\b/g) || [];
        const currentIndex = messages.indexOf(msg);

        for (let j = currentIndex + 1; j <= currentIndex + 2 && j < messages.length; j++) {
          if (!messages[j] || typeof messages[j].text !== 'string') continue;
          const nextMsg = messages[j].text.toLowerCase();

          // Guard: explicit blocker / unresolved statement means question is STILL OPEN
          const isExplicitUnresolved = /\b(?:not yet|still pending|still waiting|haven't heard|blocked on|no update|no access|waiting on)\b/i.test(nextMsg);
          if (isExplicitUnresolved) {
            resolved = false;
            break;
          }

          // Rescheduling / alternative proposal resolves the original meeting time question
          const isReschedule = /\b(?:can't make|reschedule|instead|appointment|conflict|how about|what about)\b/i.test(nextMsg);
          const sharesNumber = questionNumbers.some(n => nextMsg.includes(n));
          if (isReschedule && (sharesNumber || questionWords.some(k => nextMsg.includes(k)))) {
            resolved = true;
            break;
          }

          // Offer accepted (e.g. "I can do it if nobody else wants to" answered by "That would be great, Charlie")
          if (/(?:i can do it|i can handle|i could do|i'll do it)\b/i.test(msg.text)) {
            if (/(?:great|perfect|awesome|sounds good|thanks|thank you)\b/i.test(nextMsg) || (msg.sender && nextMsg.includes(msg.sender.toLowerCase()))) {
              resolved = true;
              break;
            }
          }

          // Action request accepted (e.g. "can you look into X?" answered by "will do")
          const isActionRequest = /(?:can you|could you|would you|will you|please)\s+/i.test(msg.text);
          const isInformationQuestion = /\b(?:who|what|where|when|why|how|which)\b/i.test(msg.text);
          const isPositiveAck = /(?:sure|will do|got it|accepted|yes|ok|okay|no problem|on it|i'll|i will|works for me|sounds good|confirmed|can do|that works|perfect|great|done)\b/i.test(nextMsg);
          if (isActionRequest && !isInformationQuestion && isPositiveAck && messages[j].sender !== msg.sender) {
            resolved = true;
            break;
          }

          if (isPositiveAck) {
            const sharesKeyword = questionWords.some(w => nextMsg.includes(w));
            if (sharesKeyword || sharesNumber) {
              resolved = true;
              break;
            }
          }

          // Standalone confirmation
          if (!isInformationQuestion && j === currentIndex + 1 && messages[j].sender !== msg.sender && /^(?:works for me|sounds good|confirmed|can do|that works|perfect|great|done|ok|yes|sure)[\s!.]*$/i.test(nextMsg.trim())) {
            resolved = true;
            break;
          }
          
          // Time/numeric echo alongside affirmation
          if (/(?:works for me|sounds good|can do|that works|see you|perfect)/i.test(nextMsg)) {
            if (sharesNumber) {
              resolved = true;
              break;
            }
          }

          // Direct answer containing shared substantive keywords without asking another question
          const replyWords = new Set((nextMsg.match(/\w{3,}/g) || []).filter(w => !stopwords.has(w)));
          const sharedSubstantive = questionWords.filter(k => replyWords.has(k));
          if (sharedSubstantive.length >= 1 && !messages[j].text.includes('?') && !isExplicitUnresolved) {
            if (/(?:let's|use|keep|go with|decided|prefer|agreed|works|simple)\b/i.test(nextMsg) || sharedSubstantive.length >= 2) {
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

    let actionAdded = false;
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
      actionAdded = true;
    }

    // Task Assignment Pattern: "@Bob / Bob, can you [task]?" followed by acceptance ("will do", "sure", etc.)
    if (!actionAdded) {
      const assignmentMatch = msg.text.match(/(?:^|\b)([A-Za-z0-9_]+)[,:]\s*(?:can you|could you|please)\s+(.+?)(?:\?|$)/i);
      if (assignmentMatch) {
        const assignedTo = assignmentMatch[1];
        const currentIndex = messages.indexOf(msg);
        const nextMsg = messages[currentIndex + 1]?.text || '';
        if (/(?:will do|on it|sure|can do|i'll do it|i will)/i.test(nextMsg)) {
          fallbackActions.push({
            text: `Confirmed task: "${msg.text}"`,
            owner: assignedTo,
            quote: msg.text,
            source_id: msg.id
          });
          actionAdded = true;
        }
      }
    }

    // Sentence-level commitment fallback for multi-sentence messages with questions
    if (!actionAdded && msg.text.includes('?')) {
      const sentences = msg.text.split(/(?<=[.?!])\s+/).filter(s => s.trim().length > 0);
      for (const sent of sentences) {
        const sentCommitment = /(?:I will|I'll|I can|we will|we'll)\b/i.test(sent);
        const sentNeg = negationPattern.test(sent);
        const sentVag = vaguePattern.test(sent);
        if (sentCommitment && !sent.includes('?') && !sentNeg && !sentVag) {
          let owner = msg.sender;
          const mentionMatch = sent.match(/^@([A-Za-z0-9_]+)/);
          if (mentionMatch) owner = mentionMatch[1];
          fallbackActions.push({ text: `Confirmed task: "${sent.trim()}"`, owner, quote: sent.trim(), source_id: msg.id });
          break;
        }
      }
    }

    // 4. Decisions
    // FIX: Removed "require/requirement" (too noisy); added exclusions for TBD,
    //      "agreed to disagree", and speculative phrasing
    const tbdPattern = /\b(?:tbd|to be decided|to be determined)\b/i;
    const agreedToDisagree = /agreed to disagree/i;
    const negatedDecision = /\b(?:(?:never|not)\s+(?:\w+\s+){0,2}(?:agreed|decided)|(?:haven't|hadn't|didn't|have not|had not|did not)\s+(?:agreed|decided|agree|decide))\b/i;
    const isDecisionKeyword = /\b(?:decided|agreed|will use|decision)\b/i.test(msg.text);
    const isUncertain = /(?:maybe|unconfirmed|undecided|pending|haven't decided|not decided|not booked)/i.test(msg.text);
    const isTBD = tbdPattern.test(msg.text);
    const isAgreedToDisagree = agreedToDisagree.test(msg.text);

    if (isDecisionKeyword && !negatedDecision.test(msg.text) && !isUncertain && !isTBD && !isAgreedToDisagree && !msg.text.includes('?')) {
      fallbackDecisions.push({ text: `Decision made: "${msg.text}"`, quote: msg.text, source_id: msg.id });
    } else {
      // Sentence-level decision check for messages with questions or conversational phrases
      const sentences = msg.text.split(/(?<=[.?!])\s+/).filter(s => s.trim().length > 0);
      for (const sent of sentences) {
        const sentDecision = /\b(?:decided|agreed|will use|decision|let's keep|let's use|let's go with|see you both at)\b/i.test(sent);
        const sentUncertain = isUncertain || /(?:maybe|unconfirmed|undecided|pending|haven't decided|not decided|not booked)/i.test(sent);
        const sentTBD = tbdPattern.test(sent);
        const sentDisagreed = agreedToDisagree.test(sent);

        if (sentDecision && !negatedDecision.test(sent) && !sentUncertain && !sentTBD && !sentDisagreed && !sent.includes('?')) {
          fallbackDecisions.push({ text: `Decision made: "${sent.trim()}"`, quote: sent.trim(), source_id: msg.id });
          break;
        }
      }
    }
  });

  return { fallbackNeedsYou, fallbackActions, fallbackDecisions, fallbackQuestions };
}

export function dedupe(arr1, arr2) {
  const groups = new Map();
  const ownerKey = finding => typeof finding.owner === 'string' ? finding.owner.trim().toLocaleLowerCase() : '';
  for (const finding of [...arr1, ...arr2]) {
    if (!finding || !finding.text || !finding.source_id) continue;
    const key = JSON.stringify([finding.source_id, finding.quote?.trim() ? finding.quote : finding.text]);
    const group = groups.get(key) || [];
    const owner = ownerKey(finding);
    const existing = group.find(item => ownerKey(item) === owner);
    if (existing) continue;
    if (!owner && group.length) continue;
    const unassigned = group.findIndex(item => !ownerKey(item));
    if (owner && unassigned !== -1) group[unassigned] = { ...group[unassigned], owner: finding.owner };
    else group.push({ ...finding });
    groups.set(key, group);
  }
  return Array.from(groups.values()).flat();
}
