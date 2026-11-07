/**
 * app.js — CatchUp Application Controller
 * 
 * Manages UI state, navigation, user input, and renders results.
 * Delegates all AI work to engine.js.
 * All model-generated content is rendered via safe DOM APIs (textContent / createTextNode).
 */

import { generateMarkdown } from './report.js';
import { isEngineReady, parseConversation, analyzeConversation, checkWebGPUSupport, DEFAULT_GEMINI_MODEL } from './engine.js?v=15';

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

  // Input & Mode
  inputPanel:      $('input-panel'),
  targetUserInput: $('target-user-input'),
  optModeLocal:    $('opt-mode-local'),
  optModeCloud:    $('opt-mode-cloud'),
  optModeHeuristic:$('opt-mode-heuristic'),
  engineStatusBadge:$('engine-status-badge'),
  cloudConfigDrawer:$('cloud-config-drawer'),
  cloudProviderSelect:$('cloud-provider-select'),
  cloudApiKey:     $('cloud-api-key'),
  keyToggleBtn:    $('key-toggle-btn'),
  saveApiKeyBtn:   $('save-api-key-btn'),
  clearApiKeyBtn:  $('clear-api-key-btn'),
  keyStatusText:   $('key-status-text'),
  keyStatusDot:    $('key-status-dot'),
  cloudCustomEndpointRow:$('cloud-custom-endpoint-row'),
  cloudCustomEndpoint:$('cloud-custom-endpoint'),
  hardwareAlertBanner:$('hardware-alert-banner'),
  hardwareAlertText:$('hardware-alert-text'),
  cloudKeyHelpLink:$('cloud-key-help-link'),
  privacyNote:     document.querySelector('.privacy-note'),
  privacyNoteText: $('privacy-note-text'),
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
  cancelBtn:       $('cancel-analysis-btn'),
  progressRulesBtn:$('progress-rules-btn'),

  // Error
  errorPanel:      $('error-panel'),
  errorDetail:     $('error-detail'),
  retryBtn:        $('retry-btn'),
  errorBackBtn:    $('error-back-btn'),
  errorRulesBtn:   $('error-rules-btn'),

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
let activeAnalysis = null;
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
    const progress = Math.round(Math.max(0, Math.min(1, pct)) * 100);
    dom.progressFill.style.width = `${progress}%`;
    dom.progressFill.style.opacity = '1';
    dom.progressFill.parentElement.setAttribute('aria-valuenow', String(progress));
  } else {
    dom.progressFill.style.width = '100%';
    dom.progressFill.style.opacity = '0.35';
    dom.progressFill.parentElement.removeAttribute('aria-valuenow');
  }
  dom.progressFill.parentElement.setAttribute('aria-valuetext', detail);
}

function showError(message) {
  showView('error');
  dom.errorDetail.textContent = message;
  dom.analyzeBtn.disabled = false;
  isAnalyzing = false;
}

// ══════════════
// Engine Mode & Cloud Config
// ══════════════
let currentEngineMode = localStorage.getItem('catchup_engine_mode') || 'local';

function getSavedApiKey(provider) {
  return localStorage.getItem(`catchup_api_key_${provider}`) || '';
}

function saveApiKey(provider, key) {
  if (key && key.trim()) {
    localStorage.setItem(`catchup_api_key_${provider}`, key.trim());
  } else {
    localStorage.removeItem(`catchup_api_key_${provider}`);
  }
  updateKeyStatusDisplay();
}

function updateKeyStatusDisplay() {
  if (!dom.cloudProviderSelect) return;
  const provider = dom.cloudProviderSelect.value;
  const key = getSavedApiKey(provider);

  // Update help link based on provider
  if (dom.cloudKeyHelpLink) {
    if (provider === 'gemini') {
      dom.cloudKeyHelpLink.href = 'https://aistudio.google.com/app/apikey';
      dom.cloudKeyHelpLink.textContent = 'Get free Gemini API Key ↗';
      dom.cloudKeyHelpLink.classList.remove('hidden');
    } else if (provider === 'groq') {
      dom.cloudKeyHelpLink.href = 'https://console.groq.com/keys';
      dom.cloudKeyHelpLink.textContent = 'Get Groq API Key ↗';
      dom.cloudKeyHelpLink.classList.remove('hidden');
    } else if (provider === 'openai') {
      dom.cloudKeyHelpLink.href = 'https://platform.openai.com/api-keys';
      dom.cloudKeyHelpLink.textContent = 'Get OpenAI API Key ↗';
      dom.cloudKeyHelpLink.classList.remove('hidden');
    } else {
      dom.cloudKeyHelpLink.classList.add('hidden');
    }
  }

  // Toggle custom endpoint row
  if (dom.cloudCustomEndpointRow) {
    dom.cloudCustomEndpointRow.classList.toggle('hidden', provider !== 'custom');
  }

  if (dom.cloudApiKey) dom.cloudApiKey.value = key;

  if (dom.keyStatusDot && dom.keyStatusText) {
    if (key) {
      dom.keyStatusDot.className = 'status-indicator-dot dot-green';
      const masked = key.length > 8 ? `${key.slice(0, 4)}••••${key.slice(-4)}` : '••••••••';
      dom.keyStatusText.textContent = `Key saved for ${provider.toUpperCase()} (${masked})`;
    } else {
      dom.keyStatusDot.className = 'status-indicator-dot dot-gray';
      dom.keyStatusText.textContent = `No API key saved for ${provider.toUpperCase()}`;
    }
  }
}

function setEngineMode(mode) {
  currentEngineMode = mode;
  localStorage.setItem('catchup_engine_mode', mode);
  const privacyDetail = document.querySelector('.privacy-detail');
  if (privacyDetail) privacyDetail.textContent = mode === 'cloud' ? 'Sent directly to your API provider' : 'Conversation analysis stays on-device';

  // Update radio buttons and active classes
  if (dom.optModeLocal) dom.optModeLocal.classList.toggle('active', mode === 'local');
  if (dom.optModeCloud) dom.optModeCloud.classList.toggle('active', mode === 'cloud');
  if (dom.optModeHeuristic) dom.optModeHeuristic.classList.toggle('active', mode === 'heuristic');

  const radio = document.querySelector(`input[name="engine-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;

  // Toggle Cloud API Drawer
  if (dom.cloudConfigDrawer) {
    dom.cloudConfigDrawer.classList.toggle('hidden', mode !== 'cloud');
    if (mode === 'cloud') updateKeyStatusDisplay();
  }

  // Update status badge
  if (dom.engineStatusBadge) {
    dom.engineStatusBadge.className = `engine-badge badge-${mode}`;
    if (mode === 'local') {
      dom.engineStatusBadge.textContent = '100% On-Device WebGPU';
    } else if (mode === 'cloud') {
      const provider = dom.cloudProviderSelect ? dom.cloudProviderSelect.value : 'API';
      dom.engineStatusBadge.textContent = `Cloud API (${provider.toUpperCase()})`;
    } else {
      dom.engineStatusBadge.textContent = 'Instant Rule Engine (on-device)';
    }
  }

  // Update Privacy Note safely
  if (dom.privacyNoteText) {
    if (mode === 'local') {
      dom.privacyNoteText.textContent = '100% Local Inference. Your data never leaves your device.';
    } else if (mode === 'heuristic') {
      dom.privacyNoteText.textContent = '100% Offline Rule Engine. Zero network calls or telemetry.';
    } else {
      dom.privacyNoteText.textContent = 'Cloud API Mode. Transcript is sent securely to your configured API provider.';
    }
  }

  // Update model status pill in header
  if (mode === 'local') {
    setModelStatus(isEngineReady() ? 'ready' : '', isEngineReady() ? 'Local WebGPU ready' : 'Local model not loaded');
  } else if (mode === 'cloud') {
    const provider = dom.cloudProviderSelect ? dom.cloudProviderSelect.value : 'API';
    setModelStatus('ready', `Cloud API (${provider.toUpperCase()})`);
  } else {
    setModelStatus('ready', 'Instant Rule Engine ready');
  }
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

  try {
    currentMessages = parseConversation(raw);
  } catch (error) {
    dom.inputHint.textContent = error.message;
    return;
  }
  if (currentMessages.length < 2) {
    dom.inputHint.textContent = 'Could not detect messages. Use the format "Name: message", one per line.';
    return;
  }

  const provider = dom.cloudProviderSelect ? dom.cloudProviderSelect.value : 'gemini';
  const apiKey = getSavedApiKey(provider);

  // Check Cloud mode prerequisite
  if (currentEngineMode === 'cloud' && !apiKey) {
    showView('input');
    if (dom.cloudConfigDrawer) dom.cloudConfigDrawer.classList.remove('hidden');
    dom.inputHint.textContent = `Please enter and save your API key for ${provider.toUpperCase()} mode.`;
    if (dom.cloudApiKey) dom.cloudApiKey.focus();
    return;
  }

  isAnalyzing = true;
  const run = new AbortController();
  activeAnalysis = run;
  const mode = currentEngineMode;
  dom.analyzeBtn.disabled = true;
  dom.inputHint.textContent = '';

  showView('progress');

  if (currentEngineMode === 'local') {
    setProgress(isEngineReady() ? 'Analyzing on your GPU…' : 'Loading local model…', isEngineReady()
      ? 'The model is ready. Selecting source messages for your briefing…'
      : 'First use downloads model files and can take several minutes. You can cancel or use Instant Rules.', isEngineReady() ? undefined : 0);
    setModelStatus('loading', isEngineReady() ? 'Analyzing with local AI…' : 'Loading WebGPU model…');
  } else if (currentEngineMode === 'cloud') {
    setProgress('Cloud Turbo…', `Contacting ${provider.toUpperCase()} API for instant analysis…`, 0.4);
    setModelStatus('loading', `Calling ${provider.toUpperCase()}…`);
  } else {
    setProgress('Analyzing…', 'Running instantaneous deterministic heuristic rules…', 0.8);
    setModelStatus('loading', 'Processing rules…');
  }

  const targetUser = dom.targetUserInput ? dom.targetUserInput.value.trim() : null;

  try {
    const options = {
      mode,
      signal: run.signal,
      apiProvider: provider,
      apiKey: apiKey,
      customEndpoint: provider === 'custom' && dom.cloudCustomEndpoint ? dom.cloudCustomEndpoint.value.trim() : ''
    };

    const result = await analyzeConversation(currentMessages, (info) => {
      if (activeAnalysis !== run) return;
      setProgress(info.stage === 'loading' ? 'Loading local model…' : info.stage === 'inference' ? 'Analyzing on your GPU…' : 'Processing…', info.text, info.progress);
      if (info.stage === 'inference') setModelStatus('loading', 'Analyzing with local AI…');
    }, targetUser, options);
    if (activeAnalysis !== run || run.signal.aborted) return;

    if (currentEngineMode === 'local') {
      setModelStatus('ready', 'WebGPU Ready');
    } else if (currentEngineMode === 'cloud') {
      setModelStatus('ready', `${provider.toUpperCase()} Ready`);
    } else {
      setModelStatus('ready', 'Rules Ready');
    }

    renderResults(result);
    showView('results');

  } catch (err) {
    if (activeAnalysis !== run || err?.name === 'AbortError') return;
    console.error('Analysis failed:', err);
    setModelStatus('error', 'Analysis error');
    showError(err?.message || 'Analysis could not finish. Retry, return to input, or use Instant Rules.');
  } finally {
    if (activeAnalysis === run) {
      activeAnalysis = null;
      dom.analyzeBtn.disabled = false;
      isAnalyzing = false;
    }
  }
}

function returnToInput() {
  activeAnalysis?.abort();
  activeAnalysis = null;
  isAnalyzing = false;
  dom.analyzeBtn.disabled = false;
  showView('input');
  setEngineMode(currentEngineMode);
  dom.textarea.focus();
}

function useInstantRules() {
  returnToInput();
  setEngineMode('heuristic');
  runAnalysis();
}

dom.cancelBtn.addEventListener('click', returnToInput);
dom.progressRulesBtn.addEventListener('click', useInstantRules);
dom.errorBackBtn.addEventListener('click', returnToInput);
dom.errorRulesBtn.addEventListener('click', useInstantRules);

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
function cleanFindingText(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/^(?:Confirmed task|Requested task|Attention requested|Decision made|Open item\/question|Question raised|Status update):\s*"?/i, '')
    .replace(/"\s*$/, '')
    .trim();
}

function switchTab(tabId) {
  const grid = $('results-grid');
  if (!grid) return;

  // Update tabs active state
  document.querySelectorAll('.switcher-tab').forEach(btn => {
    const isActive = btn.getAttribute('data-tab') === tabId;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  // Update metrics pills active state
  document.querySelectorAll('.metric-pill').forEach(pill => {
    pill.classList.toggle('active', pill.getAttribute('data-target') === tabId);
  });

  // Update grid layout mode
  grid.className = `results-grid layout-${tabId}`;

  // If in overview mode, restore visibility based on item counts
  if (tabId === 'overview' && lastAnalysisResult) {
    if (dom.sectionNeedsYou) dom.sectionNeedsYou.classList.toggle('hidden', !(lastAnalysisResult.needs_you && lastAnalysisResult.needs_you.length > 0));
    if (dom.sectionSummary) dom.sectionSummary.classList.remove('hidden');
    if (dom.sectionActions) dom.sectionActions.classList.toggle('hidden', !(lastAnalysisResult.action_items && lastAnalysisResult.action_items.length > 0));
    if (dom.sectionDecisions) dom.sectionDecisions.classList.toggle('hidden', !(lastAnalysisResult.decisions && lastAnalysisResult.decisions.length > 0));
    if (dom.sectionQuestions) dom.sectionQuestions.classList.toggle('hidden', !(lastAnalysisResult.open_questions && lastAnalysisResult.open_questions.length > 0));
  }
}

function renderResults(data) {
  lastAnalysisResult = data;
  const subtitle = $('results-subtitle');
  if (subtitle) subtitle.textContent = data.processing_mode === 'cloud'
    ? 'Processed by your selected cloud API provider'
    : data.processing_mode === 'heuristic' ? 'Processed on-device with Instant Rules' : 'Processed on-device with local AI';
  if (subtitle && data.notice) subtitle.textContent += `. ${data.notice}`;

  const countNY = (data.needs_you || []).length;
  const countAct = (data.action_items || []).length;
  const countDec = (data.decisions || []).length;
  const countQues = (data.open_questions || []).length;

  // Update Metric summary bar
  if (dom.countNeedsYou) dom.countNeedsYou.textContent = countNY;
  if (dom.countActions) dom.countActions.textContent = countAct;
  if (dom.countDecisions) dom.countDecisions.textContent = countDec;
  if (dom.countQuestions) dom.countQuestions.textContent = countQues;

  // Update Tab count badges
  const bNY = $('badge-needs-you'); if (bNY) bNY.textContent = countNY;
  const bAct = $('badge-actions'); if (bAct) bAct.textContent = countAct;
  const bDec = $('badge-decisions'); if (bDec) bDec.textContent = countDec;
  const bQues = $('badge-questions'); if (bQues) bQues.textContent = countQues;

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

  // Reset to Overview tab
  switchTab('overview');
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
        item.completed = checkbox.checked;
        card.classList.toggle('completed', checkbox.checked);
      });

      const body = document.createElement('div');
      body.className = 'task-card-content';

      row.appendChild(checkbox);
      row.appendChild(body);
      card.appendChild(row);
      textWrapper = body;
    }

    // Top Header Row for text & owner
    const headerRow = document.createElement('div');
    headerRow.className = 'finding-header-row';

    // Cleaned primary text
    const textEl = document.createElement('p');
    textEl.className = 'finding-text';
    textEl.textContent = cleanFindingText(item.text); // Safe
    headerRow.appendChild(textEl);

    // Owner badge (action items)
    if (showOwner && item.owner) {
      const ownerEl = document.createElement('span');
      ownerEl.className = 'finding-owner';
      ownerEl.textContent = `@${item.owner}`; // Safe
      headerRow.appendChild(ownerEl);
    }
    textWrapper.appendChild(headerRow);

    // Meta row (Quote + Reference)
    const meta = document.createElement('div');
    meta.className = 'finding-meta';
    if (isActionItem) {
      const status = document.createElement('span');
      status.className = 'finding-ref';
      status.textContent = item.status === 'requested' ? 'Requested · awaiting acceptance' : 'Confirmed';
      meta.appendChild(status);
    }

    // Show quote only if it differs from the primary text
    const cleaned = cleanFindingText(item.text);
    const hasDistinctQuote = item.quote && item.quote.trim() && item.quote.trim() !== cleaned;
    if (hasDistinctQuote) {
      const quoteEl = document.createElement('span');
      quoteEl.className = 'finding-quote';
      quoteEl.textContent = `“${item.quote}”`; // Safe
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
    if (item.confirmation) {
      const confirmation = document.createElement('p');
      confirmation.className = 'finding-quote';
      confirmation.textContent = `Confirmed by “${item.confirmation.quote}” · ${item.confirmation.source_id}`;
      textWrapper.appendChild(confirmation);
    }
    container.appendChild(card);
  });
}

// ══════════════
// Markdown Export & Sharing
// ══════════════
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

// Wire View Switcher Tabs
document.querySelectorAll('.switcher-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabId = tab.getAttribute('data-tab');
    if (tabId) switchTab(tabId);
  });
});

// Wire Metric Pills to switch tabs
document.querySelectorAll('.metric-pill').forEach(pill => {
  pill.addEventListener('click', () => {
    const target = pill.getAttribute('data-target');
    if (target) switchTab(target);
  });
  pill.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const target = pill.getAttribute('data-target');
      if (target) switchTab(target);
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

// ══════════════
// Engine Mode Switcher Wiring & Persistence
// ══════════════
if (dom.optModeLocal) {
  dom.optModeLocal.addEventListener('click', () => setEngineMode('local'));
}
if (dom.optModeCloud) {
  dom.optModeCloud.addEventListener('click', () => setEngineMode('cloud'));
}
if (dom.optModeHeuristic) {
  dom.optModeHeuristic.addEventListener('click', () => setEngineMode('heuristic'));
}

// Provider select change
if (dom.cloudProviderSelect) {
  const savedProvider = localStorage.getItem('catchup_cloud_provider') || 'gemini';
  dom.cloudProviderSelect.value = savedProvider;
  dom.cloudProviderSelect.addEventListener('change', () => {
    localStorage.setItem('catchup_cloud_provider', dom.cloudProviderSelect.value);
    updateKeyStatusDisplay();
  });
}

// Custom endpoint input change
if (dom.cloudCustomEndpoint) {
  const savedEndpoint = localStorage.getItem('catchup_custom_endpoint') || '';
  dom.cloudCustomEndpoint.value = savedEndpoint;
  dom.cloudCustomEndpoint.addEventListener('input', () => {
    localStorage.setItem('catchup_custom_endpoint', dom.cloudCustomEndpoint.value.trim());
  });
}

// Save Key Button
if (dom.saveApiKeyBtn && dom.cloudApiKey) {
  dom.saveApiKeyBtn.addEventListener('click', () => {
    const provider = dom.cloudProviderSelect ? dom.cloudProviderSelect.value : 'gemini';
    const key = dom.cloudApiKey.value.trim();
    if (!key) {
      dom.inputHint.textContent = 'Please enter a valid API key.';
      return;
    }
    saveApiKey(provider, key);
    dom.inputHint.textContent = '';
    dom.saveApiKeyBtn.textContent = '✓ Saved!';
    setTimeout(() => {
      if (dom.saveApiKeyBtn) dom.saveApiKeyBtn.textContent = 'Save Key';
    }, 2000);
  });

  dom.cloudApiKey.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dom.saveApiKeyBtn.click();
    }
  });
}

// Clear Key Button
if (dom.clearApiKeyBtn) {
  dom.clearApiKeyBtn.addEventListener('click', () => {
    const provider = dom.cloudProviderSelect ? dom.cloudProviderSelect.value : 'gemini';
    saveApiKey(provider, '');
    dom.cloudApiKey.value = '';
    dom.inputHint.textContent = '';
  });
}

// Key Visibility Toggle
if (dom.keyToggleBtn && dom.cloudApiKey) {
  dom.keyToggleBtn.addEventListener('click', () => {
    const isPw = dom.cloudApiKey.type === 'password';
    dom.cloudApiKey.type = isPw ? 'text' : 'password';
    dom.keyToggleBtn.textContent = isPw ? '🔒' : '👁️';
  });
}

// Initial engine mode setup
if (dom.cloudProviderSelect) {
  const geminiOption = dom.cloudProviderSelect.querySelector('option[value="gemini"]');
  if (geminiOption) geminiOption.textContent = `Google Gemini (${DEFAULT_GEMINI_MODEL}) — Recommended`;
}
setEngineMode(currentEngineMode);
updateKeyStatusDisplay();

// Check WebGPU hardware capabilities silently
checkWebGPUSupport().then(gpu => {
  if (!gpu.supported) {
    console.info('WebGPU not detected:', gpu.reason);
    if (dom.hardwareAlertBanner && dom.hardwareAlertText) {
      dom.hardwareAlertBanner.classList.remove('hidden');
      dom.hardwareAlertText.textContent = `WebGPU not available on this browser (${gpu.reason}). Defaulting to Instant Rule Engine or Cloud Turbo.`;
    }
    if (currentEngineMode === 'local') {
      setEngineMode('heuristic');
    }
  }
}).catch(err => {
  console.warn('WebGPU check threw:', err);
});

updateCharCount();
