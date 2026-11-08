/** The Factory UI's single page: static HTML that renders the view from `/events`. */
import { readFileSync } from 'node:fs';

export function pageHtml(): string {
  return readFileSync(new URL('./page.html', import.meta.url), 'utf8');
}
