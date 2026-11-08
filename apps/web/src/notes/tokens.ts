/**
 * A note's Token Count (feedback of 6 Nov 2026): about how many tokens a language model reads
 * for the note's text, counted with gpt-tokenizer's o200k_base encoding (GPT-4o's). Other models'
 * tokenizers differ by a little, so it is an estimate, not any one agent's exact cost. The
 * encoding's tables are large, so they load the first time a count is wanted, in a chunk of
 * their own, never with the app's first page.
 */

type Count = (text: string) => number;

let loading: Promise<Count> | null = null;

/** The counter, loaded once. */
export function loadTokenCounter(): Promise<Count> {
  loading ??= import('gpt-tokenizer/encoding/o200k_base').then(
    ({ countTokens }) =>
      // Text that spells a special token (`<|endoftext|>`) is counted as text, not refused.
      (text: string) =>
        countTokens(text, { disallowedSpecial: new Set() }),
  );
  return loading;
}

const number = new Intl.NumberFormat('en');

/** `1,204 tokens`, `1 token`. */
export const tokensLabel = (count: number) =>
  `${number.format(count)} ${count === 1 ? 'token' : 'tokens'}`;
