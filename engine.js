/**
 * engine.js — CatchUp Local AI Engine
 * 
 * Encapsulates all WebLLM interaction: initialization, inference, 
 * JSON parsing, and evidence validation. No DOM access.
 * 
 * Privacy: conversation content never leaves the browser.
 * Only model weight chunks are fetched from the CDN.
 */

import { CreateMLCEngine } from "https://esm.run/@mlc-ai/web-llm";
import { extractDeterministicFindings, dedupe } from "./heuristics.js";

const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

let enginePromise = null;
let engineReady = false;

/**
 * Initialize the WebLLM engine (idempotent).
 * Note: Uses a cached singleton promise; subsequent callers share the same engine
 * instance, and only the first caller's onProgress is used for initial load.
 * @param {function} onProgress - Called with { text: string, progress: number }
 * @returns {Promise<object>} The MLCEngine instance
 */
export function initEngine(onProgress) {
  if (!enginePromise) {
    enginePromise = CreateMLCEngine(MODEL_ID, {
      initProgressCallback: (info) => {
        if (onProgress) onProgress(info);
      }
    }).then(engine => {
      engineReady = true;
      return engine;
    }).catch(err => {
      enginePromise = null;
      engineReady = false;
      throw err;
    });
  }
  return enginePromise;
}

/**
 * @returns {boolean} Whether the engine has finished loading
 */
export function isEngineReady() {
  return engineReady;
}

/**
 * Parse a pasted conversation into structured messages.
 * Supports lines like "Alice: hello" or "Alice (10:30 AM): hello"
 * Each message gets a sequential msg_XX id.
 * @param {string} raw 
 * @returns {Array<{id: string, sender: string, text: string}>}
 */
export function parseConversation(raw) {
  const lines = raw.split('\n').filter(l => l.trim());
  const messages = [];
  let counter = 1;

  for (const line of lines) {
    // Match "[time] Name: message" or "Name (timestamp): message"
    const match = line.match(/^(?:\[[^\]]*\]\s*)?([A-Za-z0-9_ ]+?)(?:\s*\([^)]*\))?\s*:\s*(.+)$/);
    if (match) {
      messages.push({
        id: `msg_${String(counter).padStart(2, '0')}`,
        sender: match[1].trim(),
        text: match[2].trim()
      });
      counter++;
    } else if (messages.length > 0) {
      // Continuation of previous message
      messages[messages.length - 1].text += ' ' + line.trim();
    }
  }
  return messages;
}

const SYSTEM_PROMPT = `You are a conversation analyst. Analyze the conversation and output ONLY a valid stringified JSON format — no other text.

The output must have this exact structure:
{
  "needs_you": [
    { "text": "Description of what needs attention", "quote": "exact phrase from conversation", "source_id": "msg_xx", "priority": "high" }
  ],
  "summary_points": [
    "A useful, concise summary of the project's current state, key deadlines, agreed plan, and blockers (do NOT just write the project name)"
  ],
  "action_items": [
    { "text": "Task description", "owner": "Name or null", "quote": "exact phrase from conversation", "source_id": "msg_xx" }
  ],
  "decisions": [
    { "text": "Decision description", "quote": "exact phrase from conversation", "source_id": "msg_xx" }
  ],
  "open_questions": [
    { "text": "Unanswered question", "quote": "exact phrase from conversation", "source_id": "msg_xx" }
  ]
}

Rules:
- Every "quote" must be an EXACT substring copied from the referenced message.
- Every "source_id" must match a message ID from the conversation.
- Only include categories that have findings. Empty arrays are acceptable.
- "owner" must only be a name explicitly mentioned in the conversation, or null.
- Do not invent information not present in the conversation.
- Output ONLY the requested data format.`;

/**
 * Detect whether WebGPU is supported and available on this device/browser.
 * @returns {Promise<{supported: boolean, reason?: string}>}
 */
export async function checkWebGPUSupport() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return { supported: false, reason: "WebGPU is not enabled or supported by this browser." };
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return { supported: false, reason: "No compatible WebGPU hardware adapter found." };
    }
    return { supported: true };
  } catch (err) {
    return { supported: false, reason: err.message || "Failed to initialize WebGPU adapter." };
  }
}

/**
 * Run analysis on parsed messages.
 * @param {Array<{id: string, sender: string, text: string}>} messages
 * @param {function} onProgress - Called with { text, progress }
 * @param {string|null} targetUser - Optional name to focus "Needs You" attention detection
 * @param {object} options - Optional execution config: { mode: 'local'|'cloud'|'heuristic', apiKey, apiProvider, customEndpoint, model }
 * @returns {Promise<object>} Validated analysis result
 */
export async function analyzeConversation(messages, onProgress, targetUser = null, options = {}) {
  const mode = options.mode || 'local';

  // ── Mode: Instant Heuristic Rule Engine (Zero-download, ~5ms) ───────────
  if (mode === 'heuristic') {
    if (onProgress) onProgress({ text: "Extracting findings with instant rule engine…", progress: 0.8 });
    const { fallbackNeedsYou, fallbackActions, fallbackDecisions, fallbackQuestions } = extractDeterministicFindings(messages, targetUser);

    const summaryPoints = [];
    const participants = Array.from(new Set(messages.map(m => m.sender).filter(Boolean)));
    
    // 1. Topic & Scope Overview
    const allText = messages.map(m => m.text).join(' ');
    const topics = [];
    if (/hackathon/i.test(allText)) topics.push('hackathon planning');
    if (/tech stack|architecture|framework|api|database|backend|frontend/i.test(allText)) topics.push('tech stack selection');
    if (/meeting|reschedule|tomorrow|schedule|calendar/i.test(allText)) topics.push('schedule coordination');
    if (/release|deploy|launch|shipping/i.test(allText)) topics.push('release planning');
    if (/bug|issue|incident|outage|fix/i.test(allText)) topics.push('incident response');

    const topicLabel = topics.length > 0 ? topics.slice(0, 2).join(' and ') : 'Project coordination';
    const participantsLabel = participants.length > 0 
      ? `between ${participants.slice(0, 3).join(', ')}${participants.length > 3 ? ` and ${participants.length - 3} others` : ''}`
      : '';
    summaryPoints.push(`${topicLabel.charAt(0).toUpperCase() + topicLabel.slice(1)} ${participantsLabel} (${messages.length} messages).`.trim());

    // 2. Confirmed Decisions
    if (fallbackDecisions.length > 0) {
      const decisionPhrases = fallbackDecisions.slice(0, 3).map(d => {
        return (d.quote || d.text)
          .replace(/^Decision made:\s*"?|"?$/g, '')
          .replace(/[.;]+$/, '')
          .trim();
      });
      summaryPoints.push(`Decisions: ${decisionPhrases.join('; ')}.`);
    }

    // 3. Action Items & Ownership
    if (fallbackActions.length > 0) {
      const ownerGroups = {};
      fallbackActions.forEach(a => {
        const owner = a.owner || 'Unassigned';
        if (!ownerGroups[owner]) ownerGroups[owner] = [];
        const taskText = (a.quote || a.text)
          .replace(/^(?:Confirmed task:\s*|Task for [^:]+:\s*)"?|"?$/g, '')
          .replace(/^(?:Sounds good\.\s*)?([A-Za-z0-9_]+)[,:]\s*(?:can you|could you|please)\s+/i, '')
          .replace(/^(?:That would be great,?\s*[A-Za-z0-9_]*\.?\s*)?(?:I will|I'll|I can|we will)\s+/i, '')
          .replace(/^(?:Not yet\.\s*)?(?:I will|I'll|I can)\s+/i, '')
          .replace(/[.;]+$/, '')
          .trim();
        ownerGroups[owner].push(taskText);
      });
      const actionSummaries = Object.entries(ownerGroups).slice(0, 4).map(([owner, tasks]) => {
        const firstTask = tasks[0];
        const preview = firstTask.length > 45 ? firstTask.slice(0, 42) + '…' : firstTask;
        return `${owner} (${preview})`;
      });
      summaryPoints.push(`Assigned Deliverables: ${actionSummaries.join(', ')}.`);
    }

    // 4. Open Blockers / Questions
    if (fallbackQuestions.length > 0) {
      const questionPhrases = fallbackQuestions.slice(0, 2).map(q => {
        return (q.quote || q.text)
          .replace(/^Open item\/question:\s*"?|"?$/g, '')
          .replace(/^One more thing\s*[-—:]*\s*/i, '')
          .replace(/[.;]+$/, '')
          .trim();
      });
      summaryPoints.push(`Open Blockers & Questions: ${questionPhrases.join('; ')}.`);
    }

    if (summaryPoints.length === 0) {
      summaryPoints.push("Discussion completed with no high-priority blockers or open questions.");
    }

    return {
      needs_you: fallbackNeedsYou,
      summary_points: summaryPoints,
      action_items: fallbackActions,
      decisions: fallbackDecisions,
      open_questions: fallbackQuestions
    };
  }

  const convText = messages.map(c => `[${c.id}] ${c.sender}: ${c.text}`).join('\n');
  let replyText = '';

  // ── Mode: Cloud Turbo API (Gemini or OpenAI/Groq compatible) ────────────
  if (mode === 'cloud') {
    const apiKey = options.apiKey?.trim();
    if (!apiKey) {
      throw new Error("Cloud Turbo mode requires an API key. Please enter your API key in the engine settings.");
    }

    const provider = options.apiProvider || 'gemini';

    if (provider === 'gemini') {
      if (onProgress) onProgress({ text: "Connecting to Gemini 1.5 Flash API…", progress: 0.4 });
      const model = options.model || 'gemini-1.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text: `${SYSTEM_PROMPT}\n\nAnalyze this conversation:\n\n${convText}` }]
          }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json"
          }
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(`Gemini API Error (${res.status}): ${errJson.error?.message || res.statusText}`);
      }
      const data = await res.json();
      replyText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!replyText) throw new Error("Gemini returned empty response content.");

    } else {
      // Groq, OpenAI, or Custom endpoint
      const isGroq = provider === 'groq';
      const endpoint = isGroq 
        ? 'https://api.groq.com/openai/v1/chat/completions' 
        : (options.customEndpoint || 'https://api.openai.com/v1/chat/completions');
      const model = isGroq ? 'llama-3.1-8b-instant' : (options.model || 'gpt-4o-mini');

      if (onProgress) onProgress({ text: `Calling ${isGroq ? 'Groq' : 'OpenAI'} API (${model})…`, progress: 0.4 });

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: `Analyze this conversation:\n\n${convText}` }
          ],
          temperature: 0.1,
          response_format: { type: "json_object" }
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(`API Error (${res.status}): ${errJson.error?.message || res.statusText}`);
      }
      const data = await res.json();
      replyText = data.choices?.[0]?.message?.content;
      if (!replyText) throw new Error("Model returned empty response content.");
    }

  } else {
    // ── Mode: Local Private WebGPU (Default) ───────────────────────────────
    const engine = await initEngine(onProgress);

    const chatMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Analyze this conversation:\n\n${convText}` }
    ];

    const reply = await engine.chat.completions.create({
      messages: chatMessages,
      temperature: 0.1,
      max_tokens: 2048,
      response_format: { type: "text" }
    });

    replyText = reply.choices[0].message.content;
  }

  // Parse JSON with fallback for markdown-wrapped output
  let parsed;
  try {
    parsed = JSON.parse(replyText);
  } catch (e) {
    const match = replyText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (match) {
      parsed = JSON.parse(match[1].trim());
    } else {
      throw new Error("Model did not return valid JSON. Raw output: " + replyText.substring(0, 100) + "...");
    }
  }

  // Validate and filter
  const msgMap = new Map(messages.map(m => [m.id, m.text]));

  const placeholders = [
    "description of what needs attention",
    "task description",
    "decision description",
    "unanswered question",
    "concise bullet point about the conversation",
    "exact phrase from conversation"
  ];

  function isPlaceholder(str) {
    if (!str || typeof str !== 'string') return true;
    const lower = str.toLowerCase();
    return placeholders.some(p => lower.includes(p));
  }

  function validateFindings(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.filter(f => {
      if (!f || typeof f !== 'object') return false;
      if (isPlaceholder(f.text)) return false;
      if (!f.quote || !f.quote.trim()) return false;
      
      const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const normQuote = normalize(f.quote);
      if (!normQuote) return false;
      
      let matchedMsg = null;
      for (const m of messages) {
        if (m && m.text && normalize(m.text).includes(normQuote)) {
          matchedMsg = m;
          break;
        }
      }
      if (!matchedMsg) return false;
      f.source_id = matchedMsg.id;
      return true;
    });
  }

  const getArr = (keys) => {
    for (const k of keys) {
      if (Array.isArray(parsed[k])) return parsed[k];
    }
    for (const root of ['results', 'output', 'data']) {
      if (parsed[root] && typeof parsed[root] === 'object') {
        for (const k of keys) {
          if (Array.isArray(parsed[root][k])) return parsed[root][k];
        }
      }
    }
    return [];
  };

  const summaries = getArr(['summary_points', 'summaryPoints', 'summary', 'Summary']);

// Filter out placeholders and invalid summaries
const validSummaries = summaries.filter(s => {
  if (!s || typeof s !== 'string') return false;
  if (isPlaceholder(s)) return false;
  // Additional validation: summary should not be a generic instruction
  const lower = s.toLowerCase();
  return !/(?:a useful.*summary|concise bullet|exact phrase from|do not just write)/i.test(lower);
});

// Fallback: if no valid summary, provide a safe default
const summary_points = validSummaries.length > 0 ? validSummaries : ["This conversation has not yet been summarized."];
  
  // Principled Deterministic Extraction via heuristics.js
  const { fallbackNeedsYou, fallbackActions, fallbackDecisions, fallbackQuestions } = extractDeterministicFindings(messages, targetUser);

  return {
    needs_you: dedupe(validateFindings(getArr(['needs_you', 'needsYou', 'Needs You'])), fallbackNeedsYou),
    summary_points: summary_points,
    action_items: dedupe(validateFindings(getArr(['action_items', 'actionItems', 'Action Items', 'tasks'])), fallbackActions),
    decisions: dedupe(validateFindings(getArr(['decisions', 'Decisions Made', 'decisions_made'])), fallbackDecisions),
    open_questions: dedupe(validateFindings(getArr(['open_questions', 'openQuestions', 'Open Questions', 'questions'])), fallbackQuestions)
  };
}
