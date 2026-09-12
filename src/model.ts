// Shared block model used by both the HTML and Markdown extractors and by the comparison core.

export type BlockType = 'heading' | 'paragraph' | 'listItem' | 'table' | 'code';

export interface Link {
  /** Visible anchor text, strictly normalized. */
  text: string;
  /** Href as the parser returned it, with character references decoded, before resolution against a base URL. */
  rawHref: string;
  /** Href resolved against the document base, or null when it could not be resolved. */
  resolved: string | null;
}

export interface Location {
  /** 1-based line in the source text when the parser supplied a position. */
  line?: number;
  /** For HTML: a tag path such as main > p:nth-of-type(3). */
  path?: string;
  /** 0-based index of the block within the extracted block list. */
  blockIndex: number;
}

export interface Block {
  type: BlockType;
  /** Comparison text after strictNormalize: case kept, NFC applied, ZERO_WIDTH characters removed, whitespace collapsed. */
  text: string;
  /** Loosely normalized text, used for alignment and to classify minor text differences. */
  loose: string;
  /** Heading depth 1..6 for headings. */
  depth?: number;
  /** Table cells row by row, strictly normalized. Only for type 'table'. */
  cells?: string[][];
  /** Code content after normalizeCode: line endings normalized to LF and trailing newlines removed. Only for type 'code'. */
  code?: string;
  links: Link[];
  numbers: string[];
  location: Location;
}

export interface Extraction {
  blocks: Block[];
  /** How the main content was selected. */
  strategy: string;
  /** high: user selector / main / article. low: body fallback. */
  confidence: 'high' | 'low';
  /** Non-fatal notes from the extractor. */
  notes: string[];
  /** Coverage issues that must be visible in the report: content the extractor parsed unusually or skipped. */
  issues: ExtractionIssue[];
}

export interface ExtractionIssue {
  code: string;
  severity: 'warning' | 'info';
  message: string;
  line?: number;
  excerpt?: string;
}

export type Severity = 'error' | 'warning' | 'info';
export type Direction = 'html_only' | 'markdown_only' | 'both';

export interface FindingSide {
  line?: number;
  path?: string;
  blockIndex?: number;
  excerpt?: string;
}

export interface Finding {
  code: string;
  severity: Severity;
  direction: Direction;
  message: string;
  html?: FindingSide;
  markdown?: FindingSide;
  before?: string;
  after?: string;
}
