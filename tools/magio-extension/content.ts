import type { PlasmoCSConfig } from 'plasmo';
import { getTrackingEnabledSync, setTrackingEnabled, initStorageListener, loadInitialState, getExtensionTokenSync } from './lib/storage';
import { registerEmail, getPixelUrl, sendTrackedEmail } from './lib/api';
import { getComposeWindows, getComposeBody, getComposeToolbar, getSubject, getRecipient, getToAddresses, getCcAddresses, getBccAddresses, hasAttachments, getSender, getSendButton, getOpenEmailSubject, isInEmailView } from './lib/gmail';
import { renderSidebar, removeSidebar } from './lib/sidebar';
import { processListIcons, invalidateListIconCache } from './lib/listIcons';

export const config: PlasmoCSConfig = {
  matches: ['https://mail.google.com/*'],
  all_frames: false,
  run_at: 'document_idle',
};

const BUTTON_ID = 'magio-toggle';
const INJECTED_ATTR = 'data-magio-injected';
const SENDING_ATTR = 'data-magio-sending';

const EYE_SVG_ON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_SVG_OFF = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

function createToggleButton(): HTMLElement {
  const enabled = getTrackingEnabledSync();

  const wrapper = document.createElement('div');
  wrapper.id = BUTTON_ID;
  wrapper.setAttribute('role', 'button');
  wrapper.setAttribute('tabindex', '0');
  wrapper.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;cursor:pointer;user-select:none;transition:background 0.15s,color 0.15s;margin-left:8px;vertical-align:middle;box-sizing:border-box;';

  const icon = document.createElement('span');
  icon.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;line-height:0;';

  function render(on: boolean) {
    wrapper.style.color = on ? '#1a73e8' : '#5f6368';
    wrapper.style.background = on ? 'rgba(26,115,232,0.08)' : 'transparent';
    wrapper.setAttribute('data-tooltip', on ? 'Tracking enabled' : 'Tracking disabled');
    wrapper.setAttribute('aria-label', on ? 'Tracking enabled' : 'Tracking disabled');
    icon.innerHTML = on ? EYE_SVG_ON : EYE_SVG_OFF;
  }

  render(enabled);
  wrapper.appendChild(icon);

  wrapper.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = !getTrackingEnabledSync();
    setTrackingEnabled(next);
    render(next);
  });

  wrapper.addEventListener('mouseenter', () => {
    const on = getTrackingEnabledSync();
    wrapper.style.background = on ? 'rgba(26,115,232,0.16)' : 'rgba(95,99,104,0.08)';
  });
  wrapper.addEventListener('mouseleave', () => {
    const on = getTrackingEnabledSync();
    wrapper.style.background = on ? 'rgba(26,115,232,0.08)' : 'transparent';
  });

  initStorageListener((on) => render(on));

  return wrapper;
}

async function injectPixelBeforeSend(composeWindow: Element) {
  if (!getTrackingEnabledSync()) return;

  const body = getComposeBody(composeWindow);
  if (!body) return;

  const subject = getSubject(composeWindow);
  const recipient = getRecipient(composeWindow);
  const sender = getSender();

  const email = await registerEmail(subject, recipient, sender);
  if (!email) return;

  const img = document.createElement('img');
  img.src = getPixelUrl(email.id);
  img.width = 1;
  img.height = 1;
  img.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;opacity:0.01;pointer-events:none;';
  body.appendChild(img);
}

// A compose is a reply/forward when its subject is prefixed or it lives inline
// inside the open thread's main pane. We keep replies on the legacy single-pixel
// + Gmail-send path so threading with the original conversation is preserved
// (the server-send path would start a fresh thread among the copies).
function isLikelyReply(composeWindow: Element, subject: string): boolean {
  if (/^\s*(re|fwd|fw|aw|wg)\s*:/i.test(subject)) return true;
  if (composeWindow.closest('div[role="main"]')) return true;
  return false;
}

// Decision returned to the send hook:
//   - 'use-legacy' — ineligible OR the server delivered nothing; fall back to
//                    the safe single-pixel + Gmail-send path.
//   - 'done'       — all copies sent; discard the Gmail draft.
//   - 'halt'       — a copy may already be out; do NOT Gmail-send (avoid dupes),
//                    leave the compose open so the user can decide.
type SendDecision = 'use-legacy' | 'done' | 'halt';

// Attempt the per-recipient server-send (Path A). Eligibility (all required):
//   - an extension token is saved
//   - 2+ distinct recipients across To+Cc
//   - no attachments / inline images
//   - no Bcc (each copy shows the full To/Cc group; Bcc can't be represented)
//   - not a reply/forward
// Any ineligible case returns 'use-legacy' (the server is never contacted).
async function trySendPerRecipient(composeWindow: Element): Promise<SendDecision> {
  const token = getExtensionTokenSync();
  if (!token) return 'use-legacy';

  const subject = getSubject(composeWindow);
  if (isLikelyReply(composeWindow, subject)) return 'use-legacy';

  if (hasAttachments(composeWindow)) return 'use-legacy';
  if (getBccAddresses(composeWindow).length > 0) return 'use-legacy';

  const to = getToAddresses(composeWindow);
  const cc = getCcAddresses(composeWindow);
  // Need the To region to resolve, and 2+ distinct recipients overall.
  if (to.length === 0) return 'use-legacy';
  const distinct = new Set([...to, ...cc]);
  if (distinct.size < 2) return 'use-legacy';

  const body = getComposeBody(composeWindow);
  if (!body) return 'use-legacy';
  const html = body.innerHTML;
  if (!html.trim()) return 'use-legacy';

  const outcome = await sendTrackedEmail({ token, subject, html, to, cc });
  if (outcome.status === 'sent') {
    const n = outcome.recipients.length;
    showToast(
      n > 0
        ? `Sent ${n} tracked copies — opens tracked per person`
        : 'Sent tracked copies — opens tracked per person'
    );
    return 'done';
  }
  if (outcome.status === 'not_sent') {
    // Server reached but delivered nothing (e.g. Google not reconnected for the
    // new send scope) — safe to fall back to the legacy Gmail send.
    return 'use-legacy';
  }
  // 'uncertain' — never auto-resend; a copy may already have gone out.
  showToast(
    'Couldn\u2019t confirm the tracked send. Check your Sent folder before resending to avoid duplicates.'
  );
  return 'halt';
}

function getDiscardButton(composeWindow: Element): HTMLElement | null {
  const selectors = [
    'div[role="button"][aria-label*="Discard draft" i]',
    'div[role="button"][data-tooltip*="Discard" i]',
    'div[role="button"][aria-label*="Discard" i]',
  ];
  for (const s of selectors) {
    const el = composeWindow.querySelector<HTMLElement>(s);
    if (el) return el;
  }
  return null;
}

// After a successful server-send the message already lives in the sender's Sent
// folder (the Gmail API saves it), so we discard the local draft to avoid a
// duplicate send / a lingering draft.
function discardDraft(composeWindow: Element) {
  const btn = getDiscardButton(composeWindow);
  if (btn) btn.click();
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToast(message: string) {
  const existing = document.getElementById('magio-toast');
  if (existing) existing.remove();
  if (toastTimer) clearTimeout(toastTimer);

  const toast = document.createElement('div');
  toast.id = 'magio-toast';
  toast.textContent = message;
  toast.style.cssText = [
    'position:fixed',
    'left:24px',
    'bottom:24px',
    'z-index:2147483647',
    'background:#202124',
    'color:#fff',
    'padding:12px 18px',
    'border-radius:8px',
    'font:13px/1.4 system-ui,sans-serif',
    'box-shadow:0 2px 10px rgba(0,0,0,0.3)',
    'max-width:340px',
  ].join(';');
  document.body.appendChild(toast);
  toastTimer = setTimeout(() => toast.remove(), 4000);
}

function hookSendButton(composeWindow: Element) {
  const sendBtn = getSendButton(composeWindow);
  if (!sendBtn || sendBtn.hasAttribute(INJECTED_ATTR)) return;
  sendBtn.setAttribute(INJECTED_ATTR, 'true');

  sendBtn.addEventListener('click', async (e) => {
    if (sendBtn.hasAttribute(SENDING_ATTR)) return;
    if (!getTrackingEnabledSync()) return;

    e.stopImmediatePropagation();
    e.stopPropagation();
    e.preventDefault();

    // Prefer the per-recipient server-send path.
    const decision = await trySendPerRecipient(composeWindow);
    if (decision === 'done') {
      // All copies sent server-side — drop the duplicate Gmail draft.
      discardDraft(composeWindow);
      return;
    }
    if (decision === 'halt') {
      // A copy may already be out — do NOT Gmail-send (would duplicate). Leave
      // the compose open so the user can check Sent and decide.
      return;
    }

    // 'use-legacy' — ineligible or nothing was sent; safe single-pixel path.
    await injectPixelBeforeSend(composeWindow);

    sendBtn.setAttribute(SENDING_ATTR, 'true');
    sendBtn.click();
    requestAnimationFrame(() => sendBtn.removeAttribute(SENDING_ATTR));
  }, true);
}

function processComposeWindows() {
  for (const win of getComposeWindows()) {
    if (win.querySelector(`#${BUTTON_ID}`)) continue;
    const toolbar = getComposeToolbar(win);
    if (!toolbar) continue;
    toolbar.appendChild(createToggleButton());
    hookSendButton(win);
  }
}

let lastEmailSubject: string | null = null;

function processEmailView() {
  if (!getTrackingEnabledSync()) {
    removeSidebar();
    lastEmailSubject = null;
    return;
  }

  if (!isInEmailView()) {
    if (lastEmailSubject !== null) {
      removeSidebar();
      lastEmailSubject = null;
    }
    return;
  }

  const subject = getOpenEmailSubject();
  if (!subject || subject === lastEmailSubject) return;

  lastEmailSubject = subject;
  renderSidebar(subject);
}

function cleanupStaleStyles() {
  document.body.removeAttribute('data-magio-margin');
  if (document.body.style.marginRight) {
    document.body.style.marginRight = '';
  }
}

async function init() {
  cleanupStaleStyles();
  await loadInitialState();

  const observer = new MutationObserver(() => {
    processComposeWindows();
    processEmailView();
    processListIcons();
  });

  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('hashchange', () => {
    lastEmailSubject = null;
    invalidateListIconCache();
    processEmailView();
    processListIcons();
  });

  initStorageListener((enabled) => {
    processListIcons();
    if (enabled) {
      processEmailView();
    } else {
      removeSidebar();
      lastEmailSubject = null;
    }
  });

  processComposeWindows();
  processEmailView();
  processListIcons();
}

init();
