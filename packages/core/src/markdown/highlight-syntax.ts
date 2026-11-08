/**
 * `==highlight==` syntax, adapted from micromark-extension-gfm-strikethrough
 * (MIT, Titus Wormer): the same attention-style pairing with `=` as the marker
 * and an exact run of two.
 */
import type { Extension as FromMarkdownExtension } from 'mdast-util-from-markdown';
import type {
  ConstructName,
  Handle as ToMarkdownHandle,
  Options as ToMarkdownExtension,
} from 'mdast-util-to-markdown';
import { splice } from 'micromark-util-chunked';
import { classifyCharacter } from 'micromark-util-classify-character';
import { resolveAll } from 'micromark-util-resolve-all';
import type {
  Code,
  Event,
  Extension,
  Resolver,
  State,
  Token,
  TokenizeContext,
  Tokenizer,
} from 'micromark-util-types';
import type { Highlight } from './mdast-types';

const EQUALS = 61;

const resolveAllHighlight: Resolver = (events, context) => {
  let index = -1;

  while (++index < events.length) {
    const closer = events[index];
    if (
      closer?.[0] === 'enter' &&
      closer[1].type === 'highlightSequenceTemporary' &&
      closer[1]._close
    ) {
      let open = index;
      while (open--) {
        const opener = events[open];
        if (
          opener?.[0] === 'exit' &&
          opener[1].type === 'highlightSequenceTemporary' &&
          opener[1]._open
        ) {
          opener[1].type = 'highlightSequence';
          closer[1].type = 'highlightSequence';

          const highlight: Token = {
            type: 'highlight',
            start: { ...opener[1].start },
            end: { ...closer[1].end },
          };
          const text: Token = {
            type: 'highlightText',
            start: { ...opener[1].end },
            end: { ...closer[1].start },
          };

          const nextEvents: Event[] = [
            ['enter', highlight, context],
            ['enter', opener[1], context],
            ['exit', opener[1], context],
            ['enter', text, context],
          ];
          const insideSpan = context.parser.constructs.insideSpan.null;
          if (insideSpan) {
            splice(
              nextEvents,
              nextEvents.length,
              0,
              resolveAll(insideSpan, events.slice(open + 1, index), context),
            );
          }
          splice(nextEvents, nextEvents.length, 0, [
            ['exit', text, context],
            ['enter', closer[1], context],
            ['exit', closer[1], context],
            ['exit', highlight, context],
          ]);
          splice(events, open - 1, index - open + 3, nextEvents);
          index = open + nextEvents.length - 2;
          break;
        }
      }
    }
  }

  for (const event of events) {
    if (event[1].type === 'highlightSequenceTemporary') event[1].type = 'data';
  }
  return events;
};

const tokenizeHighlight: Tokenizer = function (this: TokenizeContext, effects, ok, nok) {
  const previous = this.previous;
  const events = this.events;
  let size = 0;
  return start;

  function start(code: Code): State | undefined {
    if (previous === EQUALS && events[events.length - 1]?.[1].type !== 'characterEscape') {
      return nok(code);
    }
    effects.enter('highlightSequenceTemporary');
    return more(code);
  }

  function more(code: Code): State | undefined {
    const before = classifyCharacter(previous);
    if (code === EQUALS) {
      if (size > 1) return nok(code);
      effects.consume(code);
      size++;
      return more;
    }
    if (size < 2) return nok(code);
    const token = effects.exit('highlightSequenceTemporary');
    const after = classifyCharacter(code);
    token._open = !after || (after === 2 && Boolean(before));
    token._close = !before || (before === 2 && Boolean(after));
    return ok(code);
  }
};

const highlightConstruct = {
  name: 'highlight',
  tokenize: tokenizeHighlight,
  resolveAll: resolveAllHighlight,
};

/** micromark syntax for `==highlight==` (exactly two `=` on each side). */
export function highlightSyntax(): Extension {
  return {
    text: { [EQUALS]: highlightConstruct },
    insideSpan: { null: [highlightConstruct] },
    attentionMarkers: { null: [EQUALS] },
  };
}

export function highlightFromMarkdown(): FromMarkdownExtension {
  return {
    canContainEols: ['highlight'],
    enter: {
      highlight(token) {
        const node: Highlight = { type: 'highlight', children: [] };
        this.enter(node, token);
      },
    },
    exit: {
      highlight(token) {
        this.exit(token);
      },
    },
  };
}

/**
 * Highlights serialise through mdast-util-to-markdown's attention mechanism,
 * like strikethrough: it pairs `==` runs the way micromark will and encodes
 * neighbouring characters when a run would not open or close.
 */
function handleHighlight(...[node, , state, info]: Parameters<ToMarkdownHandle>): string {
  const exit = state.enter('phrasing');
  const value = state.containerPhrasing({ type: 'root', children: [node as Highlight] }, info);
  exit();
  return value;
}
handleHighlight.attention = () => ({ construct: 'highlight' as const, markers: ['='], sizes: [2] });
handleHighlight.peek = (): string => '=';

// Constructs in which `=` has no special meaning (mirrors the core "full phrasing spans").
const NOT_IN: ConstructName[] = [
  'autolink',
  'destinationLiteral',
  'destinationRaw',
  'reference',
  'titleQuote',
  'titleApostrophe',
];

export function highlightToMarkdown(): ToMarkdownExtension {
  return {
    handlers: { highlight: handleHighlight },
    // Escape `=` only where `==` could open or close a highlight; `a == b` stays
    // as written. Lookarounds keep matches from consuming neighbouring `=`s.
    // (A `=` touching a highlight's own delimiter is escaped by the text handler, which
    // also re-checks every `==` against the text as written: `escapeAsWritten`.)
    unsafe: [
      { character: '=', inConstruct: 'phrasing', notInConstruct: NOT_IN, after: '(?==[^\\s=])' },
      {
        character: '=',
        inConstruct: 'phrasing',
        notInConstruct: NOT_IN,
        before: '(?<=[^\\s=])',
        after: '(?==)',
      },
    ],
  };
}
