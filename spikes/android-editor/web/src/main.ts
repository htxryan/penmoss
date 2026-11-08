// T2 Android editor spike: a bare TipTap editor with instrumentation, exposed to
// the Android shell as `window.penmoss`. Throwaway code, not shipped.

import { markEditorReady, metricsSnapshot, startMetrics, timings } from './metrics';
import { Editor } from '@tiptap/core';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Highlight } from '@tiptap/extension-highlight';
import { Image } from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { StarterKit } from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';
import { TEST_PARAGRAPH, TypingTest, summarize, type CheckResult } from './consistency';
import { fillImages } from './images';
import { attachImeLog, imeLogSnapshot, imeLogTail, logEntry, logMark } from './ime-log';
import { hasNative, postToNative } from './native';
import sampleNote from './sample-note.html?raw';
import './style.css';

startMetrics();

const lowlight = createLowlight(common);
const mount = document.querySelector<HTMLElement>('#editor')!;

const editor = new Editor({
  element: mount,
  extensions: [
    StarterKit.configure({
      codeBlock: false,
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
    }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: 'plaintext' }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Image.configure({ allowBase64: true }),
    Highlight,
  ],
  content: fillImages(sampleNote),
  editorProps: {
    attributes: { class: 'note', spellcheck: 'true', autocapitalize: 'sentences' },
    // Keep the caret comfortably above the bottom edge (the native bar sits below the WebView).
    scrollThreshold: { top: 24, bottom: 72, left: 0, right: 0 },
    scrollMargin: { top: 24, bottom: 72, left: 0, right: 0 },
  },
});

const typingTest = new TypingTest(editor);
attachImeLog(editor);

// ---- Cold open -------------------------------------------------------------

void markEditorReady().then(() => {
  postToNative({ type: 'ready', timings: { ...timings } });
  logMark(`ready editorReady=${timings.editorReady} notePainted=${timings.notePainted}`);
});

// ---- Caret visibility when the keyboard opens --------------------------------
// The shell shrinks the WebView above the IME (imePadding). When the viewport
// shrinks, scroll the selection back into view if the editor has focus.

let lastHeight = window.visualViewport?.height ?? window.innerHeight;
function onViewportResize() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  const shrank = height < lastHeight;
  logEntry({ ev: 'viewport', note: `${Math.round(lastHeight)}->${Math.round(height)}` });
  lastHeight = height;
  if (shrank && editor.isFocused) {
    requestAnimationFrame(() => editor.commands.scrollIntoView());
  }
}
window.visualViewport?.addEventListener('resize', onViewportResize);
window.addEventListener('resize', onViewportResize);

// ---- Formatting state for the native bar ---------------------------------------

let lastState = '';
let statePending = false;
function publishState() {
  if (statePending) return;
  statePending = true;
  requestAnimationFrame(() => {
    statePending = false;
    const active = {
      bold: editor.isActive('bold'),
      italic: editor.isActive('italic'),
      bulletList: editor.isActive('bulletList'),
      taskList: editor.isActive('taskList'),
      codeBlock: editor.isActive('codeBlock'),
      code: editor.isActive('code'),
      link: editor.isActive('link'),
    };
    const message = {
      type: 'state' as const,
      active,
      canUndo: editor.can().undo(),
      canRedo: editor.can().redo(),
    };
    const serialized = JSON.stringify(message);
    if (serialized !== lastState) {
      lastState = serialized;
      postToNative(message);
      updateDebugBar(active);
    }
  });
}
editor.on('transaction', publishState);
editor.on('focus', publishState);

// ---- Commands --------------------------------------------------------------------

export type Command =
  | 'bold'
  | 'italic'
  | 'bulletList'
  | 'taskList'
  | 'codeBlock'
  | 'code'
  | 'highlight'
  | 'link'
  | 'undo'
  | 'redo';

function exec(command: Command, arg?: string): boolean {
  logMark(`exec ${command}${arg ? ` ${arg}` : ''}`);
  const chain = editor.chain().focus(undefined, { scrollIntoView: true });
  switch (command) {
    case 'bold':
      return chain.toggleBold().run();
    case 'italic':
      return chain.toggleItalic().run();
    case 'bulletList':
      return chain.toggleBulletList().run();
    case 'taskList':
      return chain.toggleTaskList().run();
    case 'codeBlock':
      return chain.toggleCodeBlock().run();
    case 'code':
      return chain.toggleCode().run();
    case 'highlight':
      return chain.toggleHighlight().run();
    case 'undo':
      return chain.undo().run();
    case 'redo':
      return chain.redo().run();
    case 'link': {
      if (arg === undefined || arg === '') return chain.extendMarkRange('link').unsetLink().run();
      const href = /^[a-z]+:/i.test(arg) ? arg : `https://${arg}`;
      if (editor.state.selection.empty && !editor.isActive('link')) {
        return chain
          .insertContent({ type: 'text', text: arg, marks: [{ type: 'link', attrs: { href } }] })
          .unsetMark('link')
          .insertContent(' ')
          .run();
      }
      return chain.extendMarkRange('link').setLink({ href }).run();
    }
    default:
      return false;
  }
}

function getStats() {
  const doc = editor.state.doc;
  const text = doc.textBetween(0, doc.content.size, ' ', ' ');
  return {
    ...metricsSnapshot(),
    document: {
      words: text.split(/\s+/).filter(Boolean).length,
      characters: text.length,
      nodes: doc.nodeSize,
      blocks: doc.childCount,
    },
    ime: { entries: imeLogSnapshot().count, dropped: imeLogSnapshot().dropped },
    typingTests: typingTest.results.map(({ ops: _ops, ...rest }) => rest),
    environment: {
      userAgent: navigator.userAgent,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio,
      },
      editorVersion: 'tiptap 3.32.0',
    },
  };
}

function buildExport() {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    testParagraph: TEST_PARAGRAPH,
    stats: getStats(),
    typingTests: typingTest.results,
    imeLog: imeLogSnapshot(),
  });
}

function startTest(label: string) {
  typingTest.begin(label);
  hideResult();
}

function checkTest(): CheckResult | null {
  const result = typingTest.check();
  if (result) {
    showResult(result);
    postToNative({ type: 'testResult', summary: summarize(result) });
  }
  return result;
}

const api = {
  exec,
  getJSON: () => editor.getJSON(),
  getText: () => editor.getText(),
  getStats,
  isReady: () => timings.notePainted !== null,
  testParagraph: TEST_PARAGRAPH,
  startTest,
  checkTest,
  getTestText: () => typingTest.text(),
  getTestJSON: () => typingTest.json(),
  /** Native side asks for an export; the payload arrives via the `export` message. */
  requestExport: (mode: 'share' | 'copy' = 'share') => {
    const payload = buildExport();
    if (hasNative()) postToNative({ type: 'export', mode, payload });
    return payload.length;
  },
  exportLog: buildExport,
  logNative: (note: string) => logEntry({ ev: 'native', note }),
  imeLogTail,
  focusEnd: () => editor.chain().focus('end').scrollIntoView().run(),
};

declare global {
  interface Window {
    penmoss: typeof api;
    __editor: Editor;
  }
}
window.penmoss = api;
window.__editor = editor;

// ---- Result overlay (shown in both shells) -------------------------------------

const resultPanel = document.querySelector<HTMLElement>('#result')!;

function escapeHtml(text: string) {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

function showResult(result: CheckResult) {
  const diff = result.ops
    .map((o) => {
      const text = escapeHtml(o.text).replace(/ /g, '·').replace(/\n/g, '⏎');
      return o.op === 'equal'
        ? `<span>${escapeHtml(o.text)}</span>`
        : `<mark class="${o.op}" title="${o.op}">${text}</mark>`;
    })
    .join('');
  resultPanel.innerHTML = `
    <div class="result-head ${result.exact ? 'ok' : 'bad'}">
      <strong>${escapeHtml(summarize(result))}</strong>
      <button type="button" data-close>Close</button>
    </div>
    <p class="legend"><mark class="lost">lost</mark> <mark class="duplicated">duplicated</mark> <mark class="extra">extra</mark></p>
    <p class="diff" data-testid="diff">${diff}</p>`;
  resultPanel.hidden = false;
  resultPanel.querySelector('[data-close]')!.addEventListener('click', hideResult);
}

function hideResult() {
  resultPanel.hidden = true;
}

// ---- Browser-only debug bar (the Android app has a native bar instead) ----------

const debugBar = document.querySelector<HTMLElement>('#debug-bar')!;

function updateDebugBar(active: Record<string, boolean>) {
  debugBar.querySelectorAll<HTMLButtonElement>('[data-cmd]').forEach((button) => {
    button.classList.toggle('active', Boolean(active[button.dataset.cmd!]));
  });
}

if (!hasNative()) {
  debugBar.hidden = false;
  document.body.classList.add('with-debug-bar');
  debugBar.addEventListener('mousedown', (e) => e.preventDefault()); // keep editor focus
  debugBar.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest('button');
    if (!button) return;
    const { cmd, action } = button.dataset;
    if (cmd === 'link') exec('link', window.prompt('Link URL') ?? undefined);
    else if (cmd) exec(cmd as Command);
    else if (action === 'start') startTest('browser');
    else if (action === 'check') checkTest();
    else if (action === 'copy') void navigator.clipboard?.writeText(buildExport());
  });
}
