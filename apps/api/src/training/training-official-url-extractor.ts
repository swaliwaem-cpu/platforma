import {
  TRAINING_OFFICIAL_URL_MAX_EXTRACTED_CHARACTERS,
  TRAINING_OFFICIAL_URL_MAX_EXTRACTION_SEGMENTS,
} from './training-official-url.config';

type HtmlNode = {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  value?: string;
};

export type TrainingOfficialUrlSegment = {
  locator: {
    url: string;
    block: number;
    heading: string | null;
    tag: string;
  };
  start: number;
  end: number;
};

export type TrainingOfficialUrlExtraction = {
  text: string;
  segments: TrainingOfficialUrlSegment[];
  title: string | null;
  truncated: boolean;
  needsManualText: boolean;
};

const IGNORED_TAGS = new Set([
  'canvas',
  'dialog',
  'form',
  'iframe',
  'noscript',
  'script',
  'style',
  'svg',
  'template',
]);
const FALLBACK_IGNORED_TAGS = new Set(['aside', 'footer', 'header', 'nav']);
const CONTENT_BLOCK_TAGS = new Set([
  'blockquote',
  'dd',
  'dt',
  'figcaption',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'p',
  'pre',
  'td',
  'th',
]);

export async function extractTrainingOfficialUrlText(
  html: string,
  normalizedUrl: string,
): Promise<TrainingOfficialUrlExtraction> {
  const { parse } = await import('parse5');
  const document = parse(html) as unknown as HtmlNode;
  const titleNode = findFirstElement(document, 'title');
  const title = titleNode ? normalizeText(collectText(titleNode, false)) : '';
  const root =
    findFirstElement(document, 'main') ??
    findFirstElement(document, 'article') ??
    findFirstElement(document, 'body') ??
    document;
  const usingBodyFallback = root.tagName === 'body' || root === document;
  const accumulator = new HtmlExtractionAccumulator(normalizedUrl);
  let currentHeading: string | null = null;

  walkElements(root, (node) => {
    const tag = node.tagName ?? '';
    if (
      IGNORED_TAGS.has(tag) ||
      (usingBodyFallback && FALLBACK_IGNORED_TAGS.has(tag)) ||
      isHiddenElement(node)
    ) {
      return 'skip';
    }
    if (!CONTENT_BLOCK_TAGS.has(tag)) {
      return 'continue';
    }

    const text = normalizeText(collectText(node, usingBodyFallback));
    if (/^h[1-6]$/u.test(tag) && text) {
      currentHeading = text.slice(0, 500);
    }
    accumulator.append(text, tag, currentHeading);
    return 'skip';
  });

  if (accumulator.isEmpty()) {
    accumulator.append(
      normalizeText(collectText(root, usingBodyFallback)),
      root.tagName ?? 'document',
      null,
    );
  }

  return accumulator.finish(title || null);
}

class HtmlExtractionAccumulator {
  private text = '';
  private readonly segments: TrainingOfficialUrlSegment[] = [];
  private readonly seenBlocks = new Set<string>();
  private truncated = false;

  constructor(private readonly normalizedUrl: string) {}

  append(value: string, tag: string, heading: string | null) {
    if (
      !value ||
      this.truncated ||
      this.segments.length >= TRAINING_OFFICIAL_URL_MAX_EXTRACTION_SEGMENTS
    ) {
      if (this.segments.length >= TRAINING_OFFICIAL_URL_MAX_EXTRACTION_SEGMENTS) {
        this.truncated = true;
      }
      return;
    }

    const duplicateKey = value.toLocaleLowerCase('ru-RU');
    if (this.seenBlocks.has(duplicateKey)) return;
    this.seenBlocks.add(duplicateKey);

    const separator = this.text ? '\n\n' : '';
    const available =
      TRAINING_OFFICIAL_URL_MAX_EXTRACTED_CHARACTERS -
      this.text.length -
      separator.length;
    if (available <= 0) {
      this.truncated = true;
      return;
    }

    const safeValue = value.slice(0, available);
    const start = this.text.length + separator.length;
    this.text += separator + safeValue;
    this.segments.push({
      locator: {
        url: this.normalizedUrl,
        block: this.segments.length + 1,
        heading,
        tag,
      },
      start,
      end: start + safeValue.length,
    });
    if (safeValue.length < value.length) {
      this.truncated = true;
    }
  }

  isEmpty() {
    return this.text.length === 0;
  }

  finish(title: string | null): TrainingOfficialUrlExtraction {
    return {
      text: this.text,
      segments: this.segments,
      title,
      truncated: this.truncated,
      needsManualText: this.text.trim().length === 0,
    };
  }
}

function walkElements(
  root: HtmlNode,
  visitor: (node: HtmlNode) => 'continue' | 'skip',
) {
  for (const child of root.childNodes ?? []) {
    if (!child.tagName) {
      if (child.childNodes) walkElements(child, visitor);
      continue;
    }
    if (visitor(child) === 'skip') continue;
    walkElements(child, visitor);
  }
}

function findFirstElement(root: HtmlNode, tagName: string): HtmlNode | null {
  if (root.tagName === tagName) return root;
  for (const child of root.childNodes ?? []) {
    const found = findFirstElement(child, tagName);
    if (found) return found;
  }
  return null;
}

function collectText(root: HtmlNode, ignoreFallbackChrome: boolean): string {
  if (root.nodeName === '#text') {
    return root.value ?? '';
  }
  if (
    (root.tagName && IGNORED_TAGS.has(root.tagName)) ||
    (ignoreFallbackChrome &&
      root.tagName &&
      FALLBACK_IGNORED_TAGS.has(root.tagName)) ||
    isHiddenElement(root)
  ) {
    return '';
  }
  return (root.childNodes ?? [])
    .map((child) => collectText(child, ignoreFallbackChrome))
    .filter(Boolean)
    .join(' ');
}

function isHiddenElement(node: HtmlNode) {
  return (node.attrs ?? []).some(
    (attribute) =>
      attribute.name === 'hidden' ||
      (attribute.name === 'aria-hidden' &&
        attribute.value.toLocaleLowerCase('en-US') === 'true'),
  );
}

function normalizeText(value: string) {
  return value
    .replace(/\u0000/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}
