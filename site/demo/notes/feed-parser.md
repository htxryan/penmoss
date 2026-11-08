How Driftwood turns an RSS or Atom document into articles. Linked from [[Driftwood 0.4]]. #driftwood #design

> [!tip] One parser for both formats
> RSS 2.0 and Atom both map onto the same `Article` shape, so the inbox never needs to know which.

```ts
interface Article {
  id: string; // the feed's guid, or a hash of the link and title
  published: Date;
  html: string; // sanitised before it is stored
}
```

Articles are sorted newest first, with ties broken by title.
