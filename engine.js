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
 * Run analysis on parsed messages.
 * @param {Array<{id: string, sender: string, text: string}>} messages
 * @param {function} onProgress - Called with { text, progress }
 * @returns {Promise<object>} Validated analysis result
 */
export async function analyzeConversation(messages, onProgress, targetUser = null) {
  const engine = await initEngine(onProgress);

  const convText = messages.map(c => `[${c.id}] ${c.sender}: ${c.text}`).join('\n');

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

  const replyText = reply.choices[0].message.content;

  // Parse JSON with fallback for markdown-wrapped output
  let parsed;
  try {
    parsed = JSON.parse(replyText);
  } catch (e) {
    const match = replyText.match(/```(?:json)?\n([\s\S]*?)\n```/);
    if (match) {
      parsed = JSON.parse(match[1]);
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
    if (!str) return true;
    const lower = str.toLowerCase();
    return placeholders.some(p => lower.includes(p));
  }

  function validateFindings(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.filter(f => {
      if (!f || typeof f !== 'object') return false;
      if (isPlaceholder(f.text)) return false;
      if (!f.quote) return false;
      
      const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const normQuote = normalize(f.quote);
      
      let matchedMsg = null;
      for (const m of messages) {
        if (normalize(m.text).includes(normQuote)) {
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
  return !/(?:description|task|decision|question|point|conversation|exact phrase|from conversation)/i.test(lower);
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
