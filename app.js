/**
 * app.js — CatchUp Application Controller
 * 
 * Manages UI state, navigation, user input, and renders results.
 * Delegates all AI work to engine.js.
 * All model-generated content is rendered via safe DOM APIs (textContent / createTextNode).
 */

import { initEngine, isEngineReady, parseConversation, analyzeConversation } from './engine.js?v=9';

// ── Sample Conversation ──
const SAMPLE_CONVERSATION = `Alice: Hey, are we still meeting for the hackathon planning tomorrow at 10 AM?
Bob: I can't make 10 AM, I have a dentist appointment. Can we do 1 PM instead?
Charlie: 1 PM works for me. We need to decide on the tech stack. I'm thinking we use WebLLM for the AI component.
Alice: Sounds good. Bob, can you look into the WebLLM documentation before we meet?
Bob: Will do. Also, should we use React or keep it vanilla JS?
Alice: Let's keep it simple for now. Vanilla JS unless we hit a wall.
Charlie: Agreed. Who's handling the UI design? I can do it if nobody else wants to.
Alice: That would be great, Charlie. I'll focus on the AI integration then.
Bob: Perfect. See you both at 1 PM tomorrow.
Charlie: One more thing — do we have access to the hackathon API credentials yet?
Alice: Not yet. I'll email the organizers today and ask.`;

// ── DOM Elements ──
const $ = id => document.getElementById(id);

const dom = {
  // Sidebar & nav
  sidebar:         $('sidebar'),
  sidebarOverlay:  $('sidebar-overlay'),
  mobileMenuBtn:   $('mobile-menu-btn'),
  navAnalyze:      $('nav-analyze'),
  navAbout:        $('nav-about'),
  pageAnalyze:     $('page-analyze'),
  pageAbout:       $('page-about'),

  // Model status
  modelDot:        $('model-dot'),
  modelStatusText: $('model-status-text'),

  // Input
  inputPanel:      $('input-panel'),
  targetUserInput: $('target-user-input'),
  textarea:        $('conversation-input'),
  charCount:       $('char-count'),
  loadSampleBtn:   $('load-sample-btn'),
  clearBtn:        $('clear-btn'),
  analyzeBtn:      $('analyze-btn'),
  inputHint:       $('input-hint'),
  fileDropZone:    $('file-drop-zone'),
  fileInput:       $('file-input'),

  // Progress
  progressPanel:   $('progress-panel'),
  progressTitle:   $('progress-title'),
  progressDetail:  $('progress-detail'),
  progressFill:    $('progress-fill'),

  // Error
  errorPanel:      $('error-panel'),
  errorDetail:     $('error-detail'),
  retryBtn:        $('retry-btn'),

  // Results
  resultsWorkspace:$('results-workspace'),
  newAnalysisBtn:  $('new-analysis-btn'),
  copyMarkdownBtn: $('copy-markdown-btn'),
  copyBtnText:     $('copy-btn-text'),
  downloadMdBtn:   $('download-md-btn'),
  countNeedsYou:   $('count-needs-you'),
  countActions:    $('count-actions'),
  countDecisions:  $('count-decisions'),
  countQuestions:  $('count-questions'),
  sectionNeedsYou: $('section-needs-you'),
  needsYouList:    $('needs-you-list'),
  sectionSummary:  $('section-summary'),
  summaryList:     $('summary-list'),
  sectionActions:  $('section-actions'),
  actionsList:     $('actions-list'),
  sectionDecisions:$('section-decisions'),
  decisionsList:   $('decisions-list'),
  sectionQuestions:$('section-questions'),
  questionsList:   $('questions-list'),
};

// ── State ──
let isAnalyzing = false;
let currentMessages = [];
let lastAnalysisResult = null;

// ══════════════
// Navigation
// ══════════════
function navigateTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  if (page === 'about') {
    dom.pageAbout.classList.add('active');
    dom.navAbout.classList.add('active');
  } else {
    dom.pageAnalyze.classList.add('active');
    dom.navAnalyze.classList.add('active');
  }
  closeSidebar();
}

function closeSidebar() {
  dom.sidebar.classList.remove('open');
  dom.sidebarOverlay.classList.add('hidden');
}

dom.navAnalyze.addEventListener('click', e => { e.preventDefault(); navigateTo('analyze'); });
dom.navAbout.addEventListener('click', e => { e.preventDefault(); navigateTo('about'); });
dom.mobileMenuBtn.addEventListener('click', () => {
  dom.sidebar.classList.add('open');
  dom.sidebarOverlay.classList.remove('hidden');
});
dom.sidebarOverlay.addEventListener('click', closeSidebar);

// ══════════════
// Input Handling
// ══════════════
function updateCharCount() {
  const val = dom.textarea.value;
  const len = val.length;
  dom.charCount.textContent = `${len.toLocaleString()} character${len !== 1 ? 's' : ''}`;
}

dom.textarea.addEventListener('input', () => {
  updateCharCount();
  dom.inputHint.textContent = '';
});

dom.loadSampleBtn.addEventListener('click', () => {
  dom.textarea.value = SAMPLE_CONVERSATION;
  updateCharCount();
  dom.inputHint.textContent = '';
});

dom.clearBtn.addEventListener('click', () => {
  dom.textarea.value = '';
  updateCharCount();
  dom.inputHint.textContent = '';
});

// ══════════════
// File Upload
// ══════════════
if (dom.fileDropZone && dom.fileInput) {
  dom.fileDropZone.addEventListener('click', () => dom.fileInput.click());
  
  dom.fileDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dom.fileDropZone.classList.add('dragover');
  });
  
  dom.fileDropZone.addEventListener('dragleave', () => {
    dom.fileDropZone.classList.remove('dragover');
  });
  
  dom.fileDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dom.fileDropZone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  dom.fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  });
}

function handleFile(file) {
  if (!file.name.endsWith('.md') && !file.name.endsWith('.txt')) {
    dom.inputHint.textContent = 'Please drop a Markdown (.md) or Text (.txt) file.';
    return;
  }
  if (file.size > 1024 * 1024) { // 1MB limit
    dom.inputHint.textContent = 'File is too large. Please upload a file smaller than 1MB.';
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    dom.textarea.value = e.target.result;
    updateCharCount();
    dom.inputHint.textContent = '';
    if (dom.fileInput) dom.fileInput.value = '';
  };
  reader.onerror = () => {
    dom.inputHint.textContent = 'Failed to read file.';
    if (dom.fileInput) dom.fileInput.value = '';
  };
  reader.readAsText(file);
}

// ══════════════
// Model Status
// ══════════════
function setModelStatus(state, text) {
  dom.modelDot.className = 'model-dot';
  if (state) dom.modelDot.classList.add(state);
  dom.modelStatusText.textContent = text;
}

// ══════════════
// UI State Transitions
// ══════════════
function showView(view) {
  dom.inputPanel.classList.toggle('hidden', view !== 'input');
  dom.progressPanel.classList.toggle('hidden', view !== 'progress');
  dom.errorPanel.classList.toggle('hidden', view !== 'error');
  dom.resultsWorkspace.classList.toggle('hidden', view !== 'results');
}

function setProgress(title, detail, pct) {
  dom.progressTitle.textContent = title;
  dom.progressDetail.textContent = detail;
  if (pct !== undefined) {
    dom.progressFill.style.width = `${Math.round(pct * 100)}%`;
  }
}

function showError(message) {
  showView('error');
  dom.errorDetail.textContent = message;
  dom.analyzeBtn.disabled = false;
  isAnalyzing = false;
}

// ══════════════
// Analysis Flow
// ══════════════
async function runAnalysis() {
  if (isAnalyzing) return;

  const raw = dom.textarea.value.trim();
  if (!raw) {
    dom.inputHint.textContent = 'Please paste a conversation to analyze.';
    return;
  }

  currentMessages = parseConversation(raw);
  if (currentMessages.length < 2) {
    dom.inputHint.textContent = 'Could not detect messages. Use the format "Name: message", one per line.';
    return;
  }

  isAnalyzing = true;
  dom.analyzeBtn.disabled = true;
  dom.inputHint.textContent = '';

  showView('progress');
  setProgress('Preparing model…', 'This may take a moment on the first run.', 0);
  setModelStatus('loading', 'Loading model…');

  const targetUser = dom.targetUserInput ? dom.targetUserInput.value.trim() : null;

  try {
    const result = await analyzeConversation(currentMessages, (info) => {
      setProgress('Loading model…', info.text, info.progress);
    }, targetUser);

    setModelStatus('ready', 'Model ready');
    renderResults(result);
    showView('results');

  } catch (err) {
    console.error('Analysis failed:', err);
    setModelStatus('error', 'Model error');
    showError(err.message || 'An unknown error occurred during analysis.');
  } finally {
    dom.analyzeBtn.disabled = false;
    isAnalyzing = false;
  }
}

dom.analyzeBtn.addEventListener('click', runAnalysis);
dom.retryBtn.addEventListener('click', () => {
  showView('input');
  if (dom.textarea.value.trim()) {
    runAnalysis();
  }
});
dom.newAnalysisBtn.addEventListener('click', () => {
  showView('input');
  dom.textarea.focus();
});

// ══════════════
// Render Results (safe DOM only)
// ══════════════
function renderResults(data) {
  lastAnalysisResult = data;

  // Update Metric summary bar
  if (dom.countNeedsYou) dom.countNeedsYou.textContent = (data.needs_you || []).length;
  if (dom.countActions) dom.countActions.textContent = (data.action_items || []).length;
  if (dom.countDecisions) dom.countDecisions.textContent = (data.decisions || []).length;
  if (dom.countQuestions) dom.countQuestions.textContent = (data.open_questions || []).length;

  // Needs You
  renderCardList(dom.needsYouList, data.needs_you, dom.sectionNeedsYou, true, false, false);

  // Summary
  dom.summaryList.innerHTML = '';
  const points = (data.summary_points && data.summary_points.length > 0) 
    ? data.summary_points 
    : ['This conversation has not yet been summarized.'];
  points.forEach(point => {
    const li = document.createElement('li');
    li.textContent = point; // Safe
    dom.summaryList.appendChild(li);
  });

  // Action Items (with interactive checklist)
  renderCardList(dom.actionsList, data.action_items, dom.sectionActions, false, true, true);

  // Decisions
  renderCardList(dom.decisionsList, data.decisions, dom.sectionDecisions, false, false, false);

  // Open Questions
  renderCardList(dom.questionsList, data.open_questions, dom.sectionQuestions, false, false, false);
}

/**
 * Renders a list of finding cards using safe DOM APIs.
 * @param {HTMLElement} container 
 * @param {Array} items 
 * @param {HTMLElement} section - The section wrapper to show/hide
 * @param {boolean} showPriority 
 * @param {boolean} showOwner 
 * @param {boolean} isActionItem 
 */
function renderCardList(container, items, section, showPriority = false, showOwner = false, isActionItem = false) {
  container.innerHTML = '';

  if (!items || items.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'finding-card';

    // Content container (for action items with checkboxes)
    let textWrapper = card;
    if (isActionItem) {
      const row = document.createElement('div');
      row.className = 'task-card-wrapper';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'task-checkbox';
      checkbox.setAttribute('aria-label', 'Mark task complete');
      checkbox.addEventListener('change', () => {
        card.classList.toggle('completed', checkbox.checked);
      });

      const body = document.createElement('div');
      body.className = 'task-card-content';

      row.appendChild(checkbox);
      row.appendChild(body);
      card.appendChild(row);
      textWrapper = body;
    }

    // Text
    const textEl = document.createElement('p');
    textEl.className = 'finding-text';
    textEl.textContent = item.text; // Safe
    textWrapper.appendChild(textEl);

    // Owner (action items)
    if (showOwner && item.owner) {
      const ownerEl = document.createElement('span');
      ownerEl.className = 'finding-owner';
      ownerEl.textContent = `→ ${item.owner}`; // Safe
      textWrapper.appendChild(ownerEl);
    }

    // Meta row
    const meta = document.createElement('div');
    meta.className = 'finding-meta';

    // Quote
    if (item.quote) {
      const quoteEl = document.createElement('span');
      quoteEl.className = 'finding-quote';
      quoteEl.textContent = `"${item.quote}"`; // Safe
      meta.appendChild(quoteEl);
    }

    // Ref badge
    if (item.source_id) {
      const ref = document.createElement('span');
      ref.className = 'finding-ref';

      // Look up the sender for this message
      const msg = currentMessages.find(m => m.id === item.source_id);
      const senderLabel = msg ? `${msg.sender} · ` : '';
      ref.textContent = `${senderLabel}${item.source_id}`; // Safe
      meta.appendChild(ref);
    }

    textWrapper.appendChild(meta);
    container.appendChild(card);
  });
}

// ══════════════
// Markdown Export & Sharing
// ══════════════
function generateMarkdown(data) {
  if (!data) return '';
  const lines = [];
  lines.push('# CatchUp — Conversation Analysis Report');
  lines.push(`*Generated on ${new Date().toLocaleString()} · 100% On-Device AI*\n`);

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
      lines.push(`- [ ] **${task.text}**${owner}`);
      if (task.quote) lines.push(`  > "${task.quote}" (${task.source_id})`);
    });
    lines.push('');
  }

  if (data.decisions && data.decisions.length > 0) {
    lines.push('## Decisions Made');
    data.decisions.forEach(dec => {
      lines.push(`- ✅ ${dec.text}`);
      if (dec.quote) lines.push(`  > "${dec.quote}" (${dec.source_id})`);
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

// Wire Copy Markdown Button with fallback
if (dom.copyMarkdownBtn) {
  dom.copyMarkdownBtn.addEventListener('click', async () => {
    if (!lastAnalysisResult) return;
    const md = generateMarkdown(lastAnalysisResult);
    
    function setCopySuccess() {
      if (dom.copyBtnText) {
        const orig = dom.copyBtnText.textContent;
        dom.copyBtnText.textContent = '✓ Copied!';
        dom.copyMarkdownBtn.classList.add('copied');
        setTimeout(() => {
          dom.copyBtnText.textContent = orig;
          dom.copyMarkdownBtn.classList.remove('copied');
        }, 2000);
      }
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(md);
        setCopySuccess();
      } else {
        throw new Error('Clipboard API unavailable');
      }
    } catch (err) {
      console.warn('Clipboard API failed, trying fallback:', err);
      try {
        const textArea = document.createElement('textarea');
        textArea.value = md;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        if (successful) {
          setCopySuccess();
        } else {
          throw new Error('Fallback copy failed');
        }
      } catch (fallbackErr) {
        console.error('All copy attempts failed:', fallbackErr);
        if (dom.copyBtnText) {
          dom.copyBtnText.textContent = 'Copy failed';
          setTimeout(() => {
            dom.copyBtnText.textContent = 'Copy Markdown';
          }, 2000);
        }
      }
    }
  });
}

// Wire Download .md Button
if (dom.downloadMdBtn) {
  dom.downloadMdBtn.addEventListener('click', () => {
    if (!lastAnalysisResult) return;
    const md = generateMarkdown(lastAnalysisResult);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `catchup-report-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  });
}

// Wire Metric Pills Smooth Scroll
document.querySelectorAll('.metric-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    const targetId = pill.getAttribute('data-target');
    if (!targetId) return;
    const el = document.getElementById(targetId);
    if (el && !el.classList.contains('hidden')) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
});

// ══════════════
// Init & Target User Persistence
// ══════════════
if (dom.targetUserInput) {
  const savedUser = localStorage.getItem('catchup_target_user');
  if (savedUser) dom.targetUserInput.value = savedUser;
  dom.targetUserInput.addEventListener('input', () => {
    localStorage.setItem('catchup_target_user', dom.targetUserInput.value.trim());
  });
}

updateCharCount();
