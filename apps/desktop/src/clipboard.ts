/** Multi-format clipboard entries (T29's clipboard bridge): text, HTML and Markdown. */
import { clipboard, ClipboardItem } from 'electron';

const MAX_CLIPBOARD_CHARS = 64 * 1024 * 1024;

const MARKDOWN_FORMAT: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'electron application/osclipboard;format="net.daringfireball.markdown"',
  linux: 'electron application/osclipboard;format="text/markdown"',
};

/** One clipboard entry with every format the page gave (T29's clipboard bridge). */
export async function writeClipboard(data: unknown): Promise<boolean> {
  if (typeof data !== 'object' || data === null) return false;
  const { text, html, markdown } = data as Record<string, unknown>;
  const valid = (value: unknown) =>
    value === undefined || (typeof value === 'string' && value.length <= MAX_CLIPBOARD_CHARS);
  if (typeof text !== 'string' || !valid(text) || !valid(html) || !valid(markdown)) return false;
  const entry: Record<string, string> = { 'text/plain': text };
  if (typeof html === 'string') entry['text/html'] = html;
  const markdownFormat = MARKDOWN_FORMAT[process.platform];
  if (typeof markdown === 'string' && markdownFormat) entry[markdownFormat] = markdown;
  await clipboard.write([new ClipboardItem(entry)]);
  return true;
}
