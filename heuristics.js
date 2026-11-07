
/**
 * heuristics.js — Deterministic Extraction Logic
 * 
 * Contains pure, stateless extraction heuristics for CatchUp.
 * Does not depend on WebLLM or external APIs.
 */

// Normalize punctuation for matching only; retain the original text as evidence.
export function normalizeForMatching(text) {
  return text.replace(/[‘’]/g, "'");
}

function speakerKey(name) { return normalizeForMatching(name || '').trim().replace(/^@/, '').toLocaleLowerCase(); }
function splitSentences(text) { return text.split(/(?<=[.!?])\s+|;\s*(?=(?:I|we|Everyone|@Team)\b)/i).map(sentence => sentence.trim()).filter(Boolean); }
function actionClauses(text) { return splitSentences(text).flatMap(sentence => sentence.split(/(?:,\s*|\s+)(?:but|however)\s+/i)); }
function stripQuotedText(text) { return text.replace(/"[^"]*"|“[^”]*”|`[^`]*`/g, '').replace(/(^|[\s:])'(.+?)'(?=$|[\s.,!?])/g, '$1'); }
function isConditional(text) { return /\b(?:if|unless|provided that|assuming|as long as)\b/i.test(normalizeForMatching(text)); }
function matchTaskRequest(text) {
  const match = text.match(/(?:^|[.!]\s+)@?([\p{L}\p{N}_][\p{L}\p{M}\p{N}_'’ -]*?)(?:[,：:]\s*|\s+)(?:please|can you|could you|would you|will you)\s+(.+)/iu);
  if (match) match[1] = match[1].replace(/^(?:hey|hi|hello)\s+/i, '');
  return match;
}
function meaningfulTerms(text) {
  const ignored = new Set(['where','what','when','which','who','why','how','will','have','need','can','could','should','would','you','the','that','this','for','are','and','with','from','about','just','also','some','any','one','more','thing','yet','still','not','did','does','been','were','was','our','out','into','before','then','pending','now','is','am','to','of','we','my','me','an','as','it','be','unconfirmed','undecided']);
  return new Set((normalizeForMatching(text).toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || []).filter(word => !ignored.has(word)).map(word => word.replace(/s$/, '')));
}
function factualAnswer(messages, index, question) {
  const terms = meaningfulTerms(question);
  for (let j = index + 1; j < messages.length; j++) {
    const reply = normalizeForMatching(messages[j]?.text || '');
    if (messages[j]?.sender === messages[index]?.sender && j === index + 1) continue;
    if (reply.includes('?') || /\bin (?:progress|review|development|doubt)(?:[.!]?$|\s)|\bon hold\b/i.test(reply) || /\b(?:will|i'll|might|would|should|could|not yet|pending|waiting|not ready|not available|don't know|not sure|can't find|cannot find)\b/i.test(reply)) continue;
    const numbers = question.match(/\b\d+\b/g) || [], replyNumbers = reply.match(/\b\d+\b/g) || [];
    if (numbers.length && replyNumbers.length && !numbers.some(n => replyNumbers.includes(n))) continue;
    const shared = [...meaningfulTerms(reply)].filter(word => terms.has(word)).length;
    const pronounReply = j === index + 1 && splitSentences(messages[index].text).filter(part => part.includes('?')).length === 1 && /^(?:it(?:'s| is)|they(?:'re| are))\b/i.test(reply);
    if (/\bwhere\b/i.test(question) && (shared || pronounReply) && /\b(?:in|at|under|inside|on)\s+\S+|https?:\/\//i.test(reply)) return true;
    if (/\bwho\b/i.test(question) && shared && /\b(?:owns|handles|assigned to|responsible for|owned by)\b/i.test(reply)) return true;
  }
  return false;
}
function blockerResolved(messages, index) {
  const terms = meaningfulTerms(messages[index].text);
  return messages.slice(index + 1).some(message => {
    const reply = normalizeForMatching(message?.text || '');
    return !reply.includes('?') && !/\b(?:not|no|pending|waiting|will|might|should|could|i'll)\b/i.test(reply)
      && /\b(?:ready|available|resolved|received|approved|confirmed|booked)\b/i.test(reply)
      && [...meaningfulTerms(reply)].filter(term => terms.has(term)).length >= Math.min(2, terms.size);
  });
}

export function extractDeterministicFindings(messages, targetUser = null) {
  const fallbackNeedsYou = [];
  const fallbackActions = [];
  const fallbackDecisions = [];
  const fallbackQuestions = [];

  // Prepare targeted regex
  let needsYouRegex = null, targetMentionRegex = null, targetAddressRegex = null;
  let targetUserTrimmed = '';
  let senderIsTargetUserRegex = null; // Hoisted: built once, tested per message
  if (targetUser && targetUser.trim()) {
    targetUserTrimmed = targetUser.trim().replace(/^@/, '');
    const escaped = normalizeForMatching(targetUserTrimmed).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    needsYouRegex = new RegExp(`(^|\\W)@?${escaped}(\\W|$)`, 'i');
    senderIsTargetUserRegex = new RegExp(`^${escaped}$`, 'i');
    targetMentionRegex = new RegExp(`(^|\\W)@${escaped}(\\W|$)`, 'i');
    targetAddressRegex = new RegExp(`(?:^|[.!?]\\s+)(?:(?:hey|hi|hello)\\s+)?${escaped}[,：:]`, 'i');
  }
  const mentionRegex = /@([A-Za-z0-9_]+)/;
  const urgentRegex = /(?:urgent|blocker|blocking|action required|attention)/i;

  messages.forEach((msg, currentIndex) => {
    // Guard: skip malformed messages
    if (!msg || typeof msg.text !== 'string') return;
    const text = normalizeForMatching(msg.text);

    // ── Strip URLs before any text analysis to avoid false positives ──────────
    const textWithoutUrls = stripQuotedText(text).replace(/https?:\/\/[^\s]*/g, '');

    // 1. Needs You (Attention)
    // FIX: Skip flagging if the sender IS the targetUser (self-mention guard)
    let isTargeted = false;
    if (needsYouRegex) {
      const sender = normalizeForMatching(msg.sender || '').trim().replace(/^@/, '');
      const senderIsTargetUser = senderIsTargetUserRegex.test(sender);
      if (!senderIsTargetUser) {
        isTargeted = targetMentionRegex.test(stripQuotedText(text)) || targetAddressRegex.test(stripQuotedText(text)) || speakerKey(matchTaskRequest(text)?.[1]) === speakerKey(targetUserTrimmed);
      }
    } else {
      isTargeted = mentionRegex.test(text) || (urgentRegex.test(text) && !/\b(?:no action (?:required|needed)|not urgent|(?:blocker|incident) (?:is |has been )?resolved)\b/i.test(text));
    }

    if (isTargeted) {
      fallbackNeedsYou.push({ text: `Attention requested: "${msg.text}"`, quote: msg.text, source_id: msg.id, priority: "high" });
    }

    // 2. Open Questions
    // FIX: Use textWithoutUrls for '?' check to avoid URL query-string false positives
    const hasQuestion = textWithoutUrls.includes('?');
    const hasUncertainty = /(?:unconfirmed|undecided|pending|haven't decided|not booked|not decided)/i.test(textWithoutUrls);

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

        const rawWords = (text.toLowerCase().match(/\w{3,}/g) || []);
        const questionWords = [...new Set(rawWords.filter(w => !stopwords.has(w)))];
        const questionNumbers = text.match(/\b\d+\b/g) || [];

        for (let j = currentIndex + 1; j <= currentIndex + 2 && j < messages.length; j++) {
          if (!messages[j] || typeof messages[j].text !== 'string') continue;
          const nextMsg = normalizeForMatching(messages[j].text).toLowerCase();

          // Guard: explicit blocker / unresolved statement means question is STILL OPEN
          const isExplicitUnresolved = /\b(?:not yet|still pending|still waiting|haven't heard|blocked on|no update|no access|waiting on|not ready|not available|don't know|not sure|can't find|cannot find)\b/i.test(nextMsg);
          if (isExplicitUnresolved) {
            resolved = false;
            break;
          }

          // Rescheduling / alternative proposal resolves the original meeting time question
          const isReschedule = /\b(?:can't make|reschedule|instead|appointment|conflict|how about|what about)\b/i.test(nextMsg);
          const replyNumbers = new Set(nextMsg.match(/\b\d+\b/g) || []);
          const sharesNumber = questionNumbers.some(n => replyNumbers.has(n));
          if (isReschedule && (sharesNumber || questionWords.some(k => nextMsg.includes(k)))) {
            resolved = true;
            break;
          }
          if (questionNumbers.length && replyNumbers.size && !sharesNumber) continue;

          // Offer accepted (e.g. "I can do it if nobody else wants to" answered by "That would be great, Charlie")
          if (/(?:i can do it|i can handle|i could do|i'll do it)\b/i.test(text)) {
            if (/(?:great|perfect|awesome|sounds good|thanks|thank you)\b/i.test(nextMsg) || (msg.sender && nextMsg.includes(msg.sender.toLowerCase()))) {
              resolved = true;
              break;
            }
          }

          // Action request accepted (e.g. "can you look into X?" answered by "will do")
          const isActionRequest = /(?:can you|could you|would you|will you|please)\s+/i.test(text);
          const isInformationQuestion = /\b(?:who|what|where|when|why|how|which)\b/i.test(text);
          const ownershipAnswer = /\bwho\b/i.test(text) && /\b(?:i will|i'll|i can|i handle|i own)\b/.test(nextMsg);
          if (isInformationQuestion && !ownershipAnswer && /\b(?:will|might|would|should|could|need to)\b/.test(nextMsg)) continue;
          const isPositiveAck = /(?:sure|will do|got it|accepted|yes|ok|okay|no problem|on it|i'll|i will|works for me|sounds good|confirmed|can do|that works|perfect|great|done)\b/i.test(nextMsg);
          if (isActionRequest && !isInformationQuestion && isPositiveAck && messages[j].sender !== msg.sender) {
            resolved = true;
            break;
          }

          if (isPositiveAck && (!isInformationQuestion || ownershipAnswer)) {
            const sharesKeyword = questionWords.some(w => nextMsg.includes(w));
            if (sharesKeyword || sharesNumber) {
              resolved = true;
              break;
            }
          }

          // Standalone confirmation
          if (!isInformationQuestion && j === currentIndex + 1 && messages[j].sender !== msg.sender && /^(?:works for me|sounds good(?: to me)?|confirmed|can do|that works|perfect|great|done|ok|yes|sure)[\s!.]*$/i.test(nextMsg.trim())) {
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
          const plausibleAnswer = !isInformationQuestion || ownershipAnswer || /\b(?:is|are|located|stored|available|handles|owns|assigned|in|under|at|on|use|keep|prefer)\b/.test(nextMsg);
          if (plausibleAnswer && sharedSubstantive.length >= 1 && !messages[j].text.includes('?') && !isExplicitUnresolved) {
            if (/(?:let's|use|keep|go with|decided|prefer|agreed|works|simple)\b/i.test(nextMsg) || sharedSubstantive.length >= 2) {
              resolved = true;
              break;
            }
          }
        }

        // A later substantive answer can close a question, but a distant "yes"
        // or keyword echo cannot. Stem simple plurals to match handles/handle.
        if (!resolved) {
          const questionTerms = new Set(questionWords.map(word => word.replace(/s$/, '')));
          for (let j = currentIndex + 3; j < messages.length; j++) {
            if (!messages[j] || typeof messages[j].text !== 'string') continue;
            const reply = normalizeForMatching(messages[j].text).toLowerCase();
            if (reply.includes('?') || /\b(?:not yet|pending|waiting|no access|not ready|not available|don't know|not sure|can't find|cannot find)\b/.test(reply)) continue;
            const replyNumbers = new Set(reply.match(/\b\d+\b/g) || []);
            if (questionNumbers.length && replyNumbers.size && !questionNumbers.some(number => replyNumbers.has(number))) continue;
            const replyTerms = new Set((reply.match(/\w{3,}/g) || []).filter(word => !stopwords.has(word)).map(word => word.replace(/s$/, '')));
            const shared = [...questionTerms].filter(word => replyTerms.has(word));
            const ownershipAnswer = /\bwho\b/i.test(text) && /\b(?:i will|i'll|i can|i handle|i own)\b/.test(reply);
            const factualAnswer = /\b(?:is|are|located|stored|available|belongs|handled|owned|assigned)\b/.test(reply) && !/\b(?:will|might|would|should|could)\b/.test(reply);
            if (shared.length >= 2 && (ownershipAnswer || factualAnswer)) {
              resolved = true;
              break;
            }
          }
        }
      }

      const parts = splitSentences(textWithoutUrls).filter(part => part.includes('?'));
      if (parts.length > 1) resolved = parts.every(part => factualAnswer(messages, currentIndex, part));
      else if (/\bwhere\b/i.test(textWithoutUrls)) resolved = factualAnswer(messages, currentIndex, textWithoutUrls);
      if (!hasQuestion && hasUncertainty) resolved = blockerResolved(messages, currentIndex);

      if (!resolved && (hasQuestion || hasUncertainty)) {
        fallbackQuestions.push({ text: `Open item/question: "${msg.text}"`, quote: msg.text, source_id: msg.id });
      }
    }

    // Classify each sentence independently: one negation must not erase an
    // unrelated promise, and two promises must not collapse into one task.
    for (const sentence of actionClauses(msg.text)) {
      const matching = stripQuotedText(normalizeForMatching(sentence));
      const promise = /\b(?:i will|i'll|i can|we will|we'll)\s+/i.test(matching);
      const team = /\b(?:everyone must|everyone arrive|we need team|team testing)\b/i.test(matching)
        || /^@Team\s+(?:please\s+)?(?:review|submit|send|finish|test|arrive|check|prepare|update|complete)\b/i.test(matching);
      const negative = /\b(?:can't|cannot|can not|won't|will not|would not|wouldn't)\b/i.test(matching);
      const vague = /\b(?:maybe|probably|possibly|will see|will think|will consider|let's see|we'll see|we will see|think about|try to)\b/i.test(matching);
      const statusOnly = /\b(?:i will|i'll|i can|we will|we'll)\s+(?:be\s+(?:there|offline|online|available|unavailable|late|away)|see|hear|understand|imagine|speak)\b/i.test(matching);
      const choice = /\b(?:we will|we'll)\s+use\b/i.test(matching);
      if ((promise || team) && !matching.includes('?') && !negative && !vague && !statusOnly && !choice) {
        fallbackActions.push({ text: `Confirmed task: "${sentence}"`, owner: team && !promise ? 'Team' : msg.sender, quote: sentence, source_id: msg.id });
      }
    }

    // A decision noun or draft document is not itself a completed choice.
    for (const sentence of actionClauses(msg.text)) {
      const matching = stripQuotedText(normalizeForMatching(sentence));
      const decision = /\b(?:decided|agreed|will use|let's keep|let's use|let's go with|see you both at)\b/i.test(matching)
        || /\b(?:final )?decision\s*(?:is|:)\s*/i.test(matching) || /\b(?:we|i|team)\s+(?:chose|selected)\b/i.test(matching);
      const uncertain = /\b(?:maybe|probably|unconfirmed|undecided|pending|haven't decided|not decided|not booked|tbd|to be decided|to be determined)\b/i.test(matching);
      const negated = /\b(?:(?:never|not)\s+(?:\w+\s+){0,2}(?:agreed|decided)|(?:haven't|hadn't|didn't|have not|had not|did not)\s+(?:agreed|decided|agree|decide))\b/i.test(matching);
      if (decision && !uncertain && !negated && !/agreed to disagree/i.test(matching) && !matching.includes('?')) {
        fallbackDecisions.push({ text: `Decision made: "${sentence}"`, quote: sentence, source_id: msg.id });
      }
    }
  });

  const tasks = reconcileTasks(messages, fallbackActions);
  // A named request stays open until that assignee accepts, or somebody else
  // makes a matching commitment. An unrelated acknowledgement cannot close it.
  for (const message of messages) {
    if (!message?.text?.includes('?')) continue;
    const request = matchTaskRequest(normalizeForMatching(message.text));
    if (!request) continue;
    const fulfilled = tasks.some(task => task.status === 'confirmed' && (task.source_id === message.id || sharesTask(request[2], task.quote)));
    const existing = fallbackQuestions.findIndex(item => item.source_id === message.id);
    if (!fulfilled && existing === -1) fallbackQuestions.push({ text: `Open item/question: "${message.text}"`, quote: message.text, source_id: message.id });
    if (fulfilled && splitSentences(message.text).filter(part => part.includes('?')).length === 1 && existing !== -1) fallbackQuestions.splice(existing, 1);
  }
  const positions = new Map(messages.map((message, index) => [message?.id, index]));
  fallbackQuestions.sort((a,b) => positions.get(a.source_id) - positions.get(b.source_id));
  return {
    fallbackNeedsYou,
    fallbackActions: tasks,
    fallbackDecisions: contextualizeDecisions(messages, fallbackDecisions),
    fallbackQuestions
  };
}

function evidence(message, quote = message.text) {
  return { source_id: message.id, quote };
}

function taskWords(text) {
  const ignored = new Set(['can', 'could', 'would', 'will', 'you', 'please', 'the', 'that', 'this', 'with', 'for', 'and', 'sure', 'do', 'it', 'we', 'my', 'to', 'is', 'on', 'me']);
  return new Set((normalizeForMatching(text).toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || []).filter(word => !ignored.has(word)));
}

function sharesTask(left, right) {
  const leftNumbers = left.match(/\b\d+\b/g) || [];
  const rightNumbers = new Set(right.match(/\b\d+\b/g) || []);
  if (leftNumbers.length && rightNumbers.size && !leftNumbers.some(number => rightNumbers.has(number))) return false;
  const words = taskWords(left);
  return [...taskWords(right)].filter(word => words.has(word)).length >= 2;
}

export function reconcileTasks(messages, extracted) {
  const knownSenders = new Map(messages.filter(message => typeof message?.sender === 'string').map(message => [speakerKey(message.sender), message.sender]));
  let tasks = extracted.map(task => ({ ...task, status: /\b(?:i will|i'll|i can|we will|we'll)\b/i.test(normalizeForMatching(task.quote)) ? 'confirmed' : 'requested' }));
  tasks = tasks.filter(task => {
    if (!isConditional(task.quote)) return true;
    const index = messages.findIndex(message => message?.id === task.source_id);
    const next = messages[index + 1];
    if (/if nobody else/i.test(task.quote) && next?.sender !== task.owner && typeof next?.text === 'string' && /\b(?:great|perfect|yes|accepted|sounds good)\b/i.test(next.text)) {
      task.confirmation = evidence(next);
      return true;
    }
    return false;
  });
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || typeof message.text !== 'string') continue;
    const text = normalizeForMatching(message.text);
    // Require a named addressee, not an incidental mention in the task body.
    const request = matchTaskRequest(message.text);
    if (!request) continue;
    const owner = knownSenders.get(speakerKey(request[1])) || request[1].trim();
    const body = normalizeForMatching(request[2]);
    if (/\b(?:don't|do not|must not|never)\b/i.test(body)) continue;
    const next = messages[index + 1];
    const reply = next && typeof next.text === 'string' ? normalizeForMatching(next.text) : '';
    const firstReply = splitSentences(reply)[0] || '';
    const sameOwner = speakerKey(next?.sender) === speakerKey(owner);
    const declined = sameOwner && /\b(?:no|can't|cannot|won't|will not|unable|not now)\b/i.test(firstReply);
    const substantivePromise = /\b(?:i'll|i will|i can)\b/i.test(firstReply);
    const genericAcceptance = /\b(?:i'll|i will|i can)\s+(?:do|handle|take)\s+(?:it|that|this)\b/i.test(firstReply);
    let acceptanceMessage = sameOwner && !declined && !isConditional(firstReply) && !/\bnot (?:done|finished|completed|yet)\b/i.test(firstReply) && !firstReply.includes('?') && /\b(?:will do|on it|sure|can do|i'll|i will|yes|accepted|confirmed|done|finished|completed)\b/i.test(firstReply) && (!substantivePromise || genericAcceptance || sharesTask(body, firstReply)) ? next : null;
    if (!acceptanceMessage) {
      acceptanceMessage = messages.slice(index + 2).find(candidate => {
        if (speakerKey(candidate?.sender) !== speakerKey(owner) || typeof candidate.text !== 'string') return false;
        const answer = normalizeForMatching(candidate.text);
        return !isConditional(answer) && !answer.includes('?') && !/\b(?:can't|cannot|won't|will not)\b/i.test(answer) && /\b(?:i'll|i will|will do|on it|accepted)\b/i.test(answer) && sharesTask(body, answer);
      });
    }
    const accepted = Boolean(acceptanceMessage);
    const volunteer = !sameOwner && next && !isConditional(reply) && !/\b(?:can't|cannot|won't|will not)\b/i.test(reply) && /\b(?:i'll|i will|i can)\b/i.test(reply) && sharesTask(body, reply);
    if ((declined && !accepted) || volunteer) {
      tasks = tasks.filter(task => task.source_id !== message.id);
      continue;
    }
    const existing = tasks.find(task => task.source_id === message.id);
    const task = {
      text: `${accepted ? 'Confirmed' : 'Requested'} task: "${message.text}"`,
      owner, ...evidence(message), status: accepted ? 'confirmed' : 'requested',
      ...(accepted ? { confirmation: evidence(acceptanceMessage, splitSentences(acceptanceMessage.text)[0]) } : {})
    };
    if (existing) Object.assign(existing, task);
    else tasks.push(task);
    // A substantive acceptance is evidence for the request, not a second task.
    if (accepted && sharesTask(body, acceptanceMessage.text)) {
      tasks = tasks.flatMap(item => {
        if (item === existing || item.source_id !== acceptanceMessage.id || item.owner !== owner) return [item];
        // Keep any additional promise in the same reply after merging acceptance.
        return splitSentences(item.quote).filter(sentence => /\b(?:i will|i'll|i can)\b/i.test(normalizeForMatching(sentence)) && !/\b(?:can't|cannot|won't|will not)\b/i.test(normalizeForMatching(sentence)) && !sharesTask(body, sentence))
          .map(sentence => ({ ...item, text: `Confirmed task: "${sentence}"`, quote: sentence }));
      });
    }
  }
  // Index the relatively rare state changes once, rather than comparing every
  // task with every later ordinary message in long conversations.
  const positions = new Map(messages.map((message, index) => message ? [message.id, index] : null).filter(Boolean));
  const changes = new Map();
  messages.forEach((message, index) => {
    if (typeof message?.text !== 'string' || typeof message.sender !== 'string') return;
    const reply = stripQuotedText(normalizeForMatching(message.text));
    const withdrawal = !isConditional(reply) && /\b(?:i will not|i won't|i cannot|i can't|cancel(?:led|ed)?|withdraw(?:n)?)\b/i.test(reply);
    const completion = /^(?:done|finished|completed)[.!\s]*$/i.test(reply) || /\bI(?: have|'ve)?\s+(?:finished|completed)\b/i.test(reply);
    if (!withdrawal && !completion) return;
    const owner = speakerKey(message.sender);
    if (!changes.has(owner)) changes.set(owner, []);
    changes.get(owner).push({ index, reply, withdrawal, completion });
  });
  tasks = tasks.filter(task => {
    const start = positions.get(task.confirmation?.source_id || task.source_id);
    return !(changes.get(speakerKey(task.owner)) || []).some(change => change.index > start && change.withdrawal && sharesTask(task.quote, change.reply));
  });
  const taskCounts = new Map();
  tasks.forEach(task => taskCounts.set(task.source_id, (taskCounts.get(task.source_id) || 0) + 1));
  for (const task of tasks) {
    const start = positions.get(task.source_id);
    task.completed = (changes.get(speakerKey(task.owner)) || []).some(change => {
      if (change.index <= start || !change.completion || /\b(?:not|no|will|i'll|might|could|should|if|yesterday|previously)\b/i.test(change.reply)) return false;
      const shortDone = change.index === start + 1 && taskCounts.get(task.source_id) === 1 && /^(?:done|finished|completed)[.!\s]*$/i.test(change.reply);
      return shortDone || sharesTask(task.quote, change.reply);
    });
  }
  const order = new Map(messages.filter(Boolean).map((message, index) => [message.id, index]));
  return tasks.sort((a, b) => order.get(a.source_id) - order.get(b.source_id));
}

export function contextualizeDecisions(messages, extracted) {
  const results = new Map();
  const byId = new Map(messages.filter(Boolean).map((message, index) => [message.id, { message, index }]));
  for (const original of extracted) {
    const location = byId.get(original.source_id);
    if (!location) continue;
    const { message, index } = location;
    const quote = original.quote.trim();
    const bareAgreement = /^(?:agreed|yes|sounds good|confirmed|let's do that)[.!\s]*$/i.test(normalizeForMatching(quote));
    if (bareAgreement) {
      const proposal = messages[index - 1];
      if (!proposal || typeof proposal.text !== 'string' || proposal.sender === message.sender) continue;
      const text = normalizeForMatching(proposal.text);
      if (!/\b(?:let's (?:use|keep|go with)|we (?:should|will|could) (?:use|keep)|we need to (?!decide|discuss)|i (?:propose|suggest)|should we use|decided|agreed to)\b/i.test(text) || /\bor\b|\b(?:can you|could you|please|not decided|haven't decided)\b/i.test(text)) continue;
      const existingChoices = [...results.values()].filter(item => item.source_id === proposal.id);
      if (existingChoices.length > 1) continue;
      const existing = existingChoices[0];
      results.set(`${proposal.id}\0${existing?.quote || proposal.text}`,  { ...(existing || { text: `Agreed proposal: "${proposal.text}"`, ...evidence(proposal) }), confirmation: evidence(message, original.quote) });
      continue;
    }
    // Preserve the choice after a vague opener such as "Let's keep it simple."
    const fullQuote = /\blet's keep it simple\b/i.test(normalizeForMatching(quote)) ? message.text : original.quote;
    if (/^let's keep it simple[.!\s]*(?:for now[.!\s]*)?$/i.test(normalizeForMatching(fullQuote))) continue;
    results.set(`${message.id}\0${fullQuote}`, { ...original, text: `Decision made: "${fullQuote}"`, quote: fullQuote });
  }
  return [...results.values()];
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
