// The markdown codec (T3, A9): the schema it builds, parse and serialise, frontmatter, and the
// codec's context. Apps load it lazily (`import('@penmoss/core')`), so a note that never needs
// markdown never downloads it. Everything else in core comes from its own subpath
// (`@penmoss/core/ids`, `/links`, `/periodic`, `/fuzzy`, `/wikilinks` and the rest), and
// `/schema` is the schema alone, for code that must not load the codec.
export {
  describeSchema,
  markSpecs,
  nodeSpecs,
  schema,
  type MarkName,
  type NodeName,
} from './schema';
export {
  KNOWN_FRONTMATTER_KEYS,
  createFrontmatter,
  frontmatterKeys,
  parseFrontmatter,
  readNoteMeta,
  serializeFrontmatter,
  setFrontmatterFields,
  type Frontmatter,
  type NoteMeta,
} from './frontmatter';
export { unresolvedLinks, type CodecContext, type LinkResolver } from './markdown/context';
export {
  parseMarkdown,
  parseMarkdownWithLines,
  type BlockLines,
  type LinedNote,
  type LineSpan,
  type ParsedNote,
} from './markdown/parse';
export { serializeMarkdown, type NoteContent } from './markdown/serialize';
