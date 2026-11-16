// A fast drop-in for marked 18.1.3 (default options: gfm on, breaks off, pedantic off,
// async off). parse(markdown) returns exactly the HTML marked renders for the same
// string. Written from the CommonMark 0.31.2 + GFM 0.29 grammar and marked's published
// rule set, with direct rendering (no token tree): blocks are scanned once into light
// records, inline fragments render straight to a string. Dependency-free, deterministic,
// no network, no wall clock, no caching across calls.
//
// Entry: parse.js in the repo root; main.ts drives it over /input/cases.json.

// ---------------------------------------------------------------------------
// Small helpers (escape / unescape / urls / labels / lines)
// ---------------------------------------------------------------------------

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeTest = /[&<>"']/;
const escapeReplace = /[&<>"']/g;
const escapeTestNoEncode = /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const escapeReplaceNoEncode = /[<>\"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const numericRef = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const numericRefOrAmp = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML the way marked does: encode=true escapes & < > " ' outright;
// encode=false leaves a & alone when it already starts a valid entity or
// numeric character reference.
function esc(s, encode) {
  if (encode) {
    return escapeTest.test(s) ? s.replace(escapeReplace, (c) => ENT[c]) : s;
  }
  return escapeTestNoEncode.test(s) ? s.replace(escapeReplaceNoEncode, (c) => ENT[c]) : s;
}

// Decode numeric character references; a bare & becomes &amp;. Named entities
// pass through untouched (they are re-checked by esc() at render time).
function Ie(s) {
  if (!numericRef.test(s)) return s;
  return s.replace(numericRefOrAmp, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// Clean a link/image href the way marked does: encode it, keep % literal.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Normalize a link label for lookup: trim, collapse whitespace, case-fold.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Remove trailing blank lines from a raw block, keeping at most one.
function stripTrailingBlanks(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && /^[ \t]*$/.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

// Remove trailing occurrences of one char (or of any char but it).
function rtrim(s, ch, invert) {
  const n = s.length;
  if (n === 0) return '';
  let cut = 0;
  for (; cut < n;) {
    const c = s.charAt(n - cut - 1);
    if (c === ch && !invert) cut++;
    else if (c !== ch && invert) cut++;
    else break;
  }
  return s.slice(0, n - cut);
}

// Expand tabs to spaces at the given starting column (tab stops of 4).
function expandTabs(s, col) {
  let t = col || 0;
  let out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const w = 4 - (t % 4);
      out += ' '.repeat(w);
      t += w;
    } else {
      out += ch;
      t++;
    }
  }
  return out;
}

// Split a table row into cells, honouring \| and leading/trailing pipes.
function splitCells(row, count) {
  const t = row.replace(/\|/g, (m, off, str) => {
    let escaped = false;
    let p = off;
    for (; --p >= 0 && str[p] === '\\';) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(/ \|/);
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim() && cells.pop(), count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Find the index of the closing paren that matches an opener before the
// string: -1 when there is no paren at all, -2 when one stays open.
function findParen(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && (--depth, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Compensate a fenced code block's content for the fence's own indentation.
function fenceIndent(raw, content) {
  const m = raw.match(/^(\s+)(?:```)/);
  if (m === null) return content;
  const indent = m[1];
  return content.split('\n').map((line) => {
    const lead = line.match(/^\s+/);
    if (lead === null) return line;
    return line.slice(Math.min(lead[0].length, indent.length));
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Grammar: the block and inline rules (CommonMark 0.31.2 + GFM 0.29, as marked
// 18.1.3 applies them). Composite patterns are spliced from fragments; a ^
// inside a spliced fragment is dropped, since only the whole pattern anchors.
// ---------------------------------------------------------------------------

// Splice fragments into a pattern source, dropping a ^ that a fragment carries
// (it would anchor mid-pattern); a ^ right after [ (a negated class) is kept.
function splice(src, ...pairs) {
  let out = src;
  for (let i = 0; i < pairs.length; i += 2) {
    const frag = typeof pairs[i + 1] === 'string' ? pairs[i + 1] : pairs[i + 1].source;
    out = out.split(pairs[i]).join(frag.replace(/(^|[^\[])\^/g, '$1'));
  }
  return out;
}
function re(src, flags) { return new RegExp(src, flags); }

const BLOCK_TAG = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const COMMENT_RE = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// "other" patterns used across the rules
// Memoized indent regexes: marked builds them for the content indent
// minus one, clamped to 0..3 (a bullet at the content indent is nested
// content, not a sibling, so the check allows one fewer space).
function dRegex(fn) {
  const cache = [];
  return (t) => {
    const n = Math.max(0, Math.min(3, t - 1));
    return cache[n] || (cache[n] = fn(n));
  };
}

const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => new RegExp(`^( {0,3}${bull})((?:[\\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: dRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: dRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: dRegex((indent) => new RegExp(`^ {0,${indent}}(?:\\\`\\\`\\\`|~~~)`)),
  headingBeginRegex: dRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: dRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${BLOCK_TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: dRegex((indent) => new RegExp(`^ {0,${indent}}>`)),
};

// Block rules (gfm)
const BULL = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const HR_SRC = ' {0,3}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const FENCES_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const BLOCKQUOTE_SRC = ' {0,3}>';
const HTML_START_SRC = ' {0,3}(?:</?(?:' + BLOCK_TAG + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const TABLE_SRC = ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n';

const BLK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  hr: new RegExp('^' + HR_SRC),
  text: /^[^\n]+/,
  list: new RegExp(splice('^(bull)([ \\t][^\\n]*?)?(?:\\n|$)', 'bull', BULL)),
  def: null, // built below (needs label)
  html: null, // built below
  lheading: null, // built below
  paragraph: null, // built below
  table: null, // built below
  blockquote: null, // built below
};

const LABEL = /(?:\\[\s\S]|[^\[\]\\]|\n(?![ \t]*\n))+/;
const LABEL_NOSP = /(?:\\[\s\S]|[^\[\]\\]|\n(?![ \t]*\n))+/;
BLK.def = new RegExp(splice(
  '^ {0,3}\\[(label)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(title))? *(?:\\n+|$)',
  'label', /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]|\n(?![ \t]*\n))+/,
  'title', /(?:\"(?:\\[\s\S]|[^\"\\])*\"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/));
BLK.html = new RegExp(splice(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
  'comment', COMMENT_RE,
  'tag', BLOCK_TAG,
  'attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/), 'i');

// Setext heading: the heading text must not itself open a block.
const LHEADING_BASE = '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
BLK.lheading = new RegExp(splice(LHEADING_BASE,
  'bull', BULL,
  'blockCode', /(?: {4}| {0,3}\t)/,
  'fences', / {0,3}(?:`{3,}|~{3,})/,
  'blockquote', / {0,3}>/,
  'heading', / {0,3}#{1,6}(?:\s|$)/,
  'hr', / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  'html', / {0,3}<[^\n>]+>\n/,
  'table', TABLE_SRC));

// Table: header row, delimiter row, body rows (which must not open a block).
BLK.table = new RegExp(splice(
  '^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
  'hr', new RegExp(HR_SRC),
  'heading', HEADING_SRC,
  'blockquote', BLOCKQUOTE_SRC,
  'code', /(?: {4}| {0,3}\t)[^\n]/,
  'fences', FENCES_SRC,
  'list', ' {0,3}(?:[*+-]|1[.)])[ \\t]',
  'html', HTML_START_SRC));

// Paragraph: a run of lines, stopping before any line that opens a block.
const PARA_BASE = '^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)';
function paraRegex(listSrc) {
  return new RegExp(splice(PARA_BASE,
    'hr', new RegExp(HR_SRC),
    'heading', HEADING_SRC,
    '|lheading', '',
    'table', BLK.table,
    'blockquote', BLOCKQUOTE_SRC,
    'fences', FENCES_SRC,
    'list', listSrc,
    'html', HTML_START_SRC));
}
BLK.paragraph = paraRegex(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]');
const PARA_BLOCKQUOTE = paraRegex(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)');

// Blockquote: a run of > lines, plus lazy continuation lines (paragraph text).
BLK.blockquote = new RegExp(splice(
  '^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(paragraph)|[^\\n]*)(?:\\n|$))+',
  'paragraph', PARA_BLOCKQUOTE));

// ---------------------------------------------------------------------------
// Inline rules (gfm). The closer-search patterns for emphasis/del are built
// from fragments: notPunctSpace = a char that is not space/punct (or ~),
// punctSpace = space or punct, punct = a punctuation char.
// ---------------------------------------------------------------------------

const PUNCT = /[\p{P}\p{S}]/u;              // $
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;      // j
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u; // X
const YE = /(?!~)[\p{P}\p{S}]/u;            // punct, del-aware
const ST = /(?!~)[\s\p{P}\p{S}]/u;          // punctSpace, del-aware
const IT = /(?:[^\s\p{P}\p{S}]|~)/u;        // notPunctSpace, del-aware
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;

const BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/; // Le
const LABEL_IN_LINK = /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
const LABEL_IN_LINK_RE = new RegExp(splice(LABEL_IN_LINK.source, 'brackets', BRACKETS));
const LABEL_LONG = /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/;
const LABEL_LONG_RE = new RegExp(splice(LABEL_LONG.source, 'brackets', BRACKETS));
const REF_LABEL = /(?:\\[\s\S]|[^\[\]\\]){1,999}/; // be
const REF_LABEL_FULL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]|\n(?![ \t]*\n))+/; // le

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  autolink: new RegExp(splice(
    '^<(scheme:[^\\s\\x00-\\x1f<>]*|email)>',
    'scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/,
    'email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)),
  tag: new RegExp(splice(
    '^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
    'comment', new RegExp(COMMENT_RE.source.replace('(?:-->|$)', '-->')),
    'attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)),
  link: new RegExp(splice(
    '^!?\\[(label)\\]\\([ \\t\\n]*(href)(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(title))?[ \\t\\n]*\\)',
    'label', LABEL_IN_LINK_RE,
    'href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/,
    'title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)),
  reflink: new RegExp(splice('^!?\\[(label)\\]\\[(ref)\\]', 'label', LABEL_IN_LINK_RE, 'ref', REF_LABEL_FULL)),
  nolink: new RegExp(splice('^!?\\[(ref)\\](?:\\[\\])?', 'ref', REF_LABEL_FULL)),
  // Left-delimiter runs: group 1/3 = following punctuation, 2/4 = following
  // non-space (for * and _ respectively).
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  // Right-delimiter search: group 1/2 = a closer after punct / non-punct,
  // 3/4 = after punct-space / space (cannot close), 5/6 = after punct /
  // non-punct where the rule of three may apply.
  emStrongRDelimAst: new RegExp(splice(
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)',
    'notPunctSpace', IT, 'punctSpace', ST, 'punct', YE), 'gu'),
  emStrongRDelimUnd: new RegExp(splice(
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)',
    'notPunctSpace', NOT_PUNCT_SPACE, 'punctSpace', PUNCT_SPACE, 'punct', PUNCT), 'gu'),
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: new RegExp(splice(
    '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)',
    'notPunctSpace', NOT_PUNCT_SPACE, 'punctSpace', PUNCT_SPACE, 'punct', PUNCT), 'gu'),
  url: new RegExp(splice(
    '^emailProtocol|^((?:protocol):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^email',
    'emailProtocol', new RegExp(splice('(?:mailto:email|xmpp:email(?:\\/[A-Za-z0-9@.]+)?)', 'email', /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)),
    'protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,
    'email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)),
  _backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  punctuation: /^((?![*_])[\s\p{P}\p{S}])/u,
  // The text rule: eats plain text up to the next construct that could start
  // an inline token (or a possible autolink / email start).
  text: new RegExp(splice(
    '^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|protocol:\\/\\/|wwwStart|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@))))',
    'emailProtocol', /(?:mailto|xmpp):/,
    'protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/,
    'wwwStart', /(?<![^\s*_~(])www\./)),
  // Masking: replace links, code spans and tags with [aaa...] so the emphasis
  // closer search does not see delimiters inside them.
  blockSkip: new RegExp(splice(
    'link|precode-code|html',
    'link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\(\)]|\((?:\\[\s\S]|[^\(\)])*?\))*?\)/,
    'precode-', '(?<!`)()',
    'code', /(?<b>`+)[^`]+\k<b>(?!`)/,
    'html', /<(?! )[^<>]*?>/), 'g'),
  reflinkSearch: new RegExp(splice(
    'reflink|nolink(?!\\()',
    'reflink', new RegExp(splice('^!?\\[(label)\\]\\[(ref)\\]', 'label', LABEL_LONG_RE, 'ref', REF_LABEL)),
    'nolink', new RegExp(splice('^!?\\[(ref)\\](?:\\[\\])?', 'ref', REF_LABEL))), 'g'),
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
};

// ---------------------------------------------------------------------------
// Inline machinery: masking (so emphasis never sees delimiters inside links,
// code spans or tags), and the last-possible-closer table for * _ ~.
// ---------------------------------------------------------------------------

// Where the last delimiter run of each kind could close, in a masked source:
// the start index of the last run whose preceding char is not whitespace.
function closerInfo(masked) {
  const em = { '*': -1, '_': -1 };
  let del = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const before = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    for (; i < n && masked[i] === r;) i++;
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') {
      if (r === '~') del = s;
      else em[r] = s;
    }
    s = i - 1;
  }
  return { em, del };
}

// Does this text contain a link (inline or reference) that resolves?
function linkInText(text, links) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(INLINE.blockSkip)) {
    if (INLINE.link.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(INLINE.reflinkSearch)) {
    const s = m[0];
    const o = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normLabel(s.slice(o + 1, -1)))) &&
        !(o > 1 && linkInText(s.slice(1, o - 1), links))) return true;
  }
  return false;
}

// Mask a source for emphasis parsing: links, code spans and tags become
// bracketed runs of a's, and backslash-escaped punctuation becomes +.
// Delimiters inside them then cannot act as emphasis openers or closers.
function maskForEmphasis(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const maskRef = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(INLINE.reflinkSearch, maskRef) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(INLINE.reflinkSearch, maskRef);
  }
  t = t.replace(INLINE.anyPunctuationOutsideCode, (m, code, punct) => {
    if (punct) return '+'.repeat(m.length);
    if (code) return code + m.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return m;
  });
  t = t.replace(INLINE.blockSkip, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
  return t;
}

// Does the label text contain an autolink or tag that runs past the label's
// end (so the [ ... ] is not a link at all)? a = full remaining source,
// label = the bracketed text, off = the label's offset inside a.
function labelHasTag(a, label, off) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = INLINE.code.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const rest = a.slice(off + s);
    const m = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

// Render link/image text with tags stripped (the alt text of an image).
function renderInlineText(src, links, st) {
  return renderInline(src, links, st, true);
}

// ---------------------------------------------------------------------------
// Inline rendering: the token scan, emitting HTML straight to a string.
// textOnly renders plain text (the alt text of an image): no tags, no links.
// ---------------------------------------------------------------------------

function makeLink(m, href, title, links, st, textOnly) {
  const text = m[1].replace(O.outputLinkReplace, '$1');
  const isImage = m[0].charAt(0) === '!';
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  const savedRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  // An image's inner text is rendered plain (it becomes the alt text).
  const inner = renderInline(text, links, st, textOnly || isImage);
  const nested = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImage) {
    if (nested) { st.inRawBlock = savedRaw; return undefined; }
    st.linkEmitted = true;
    if (textOnly) return inner;
    const url = cleanUrl(href);
    if (url === null) return inner;
    let out = '<a href="' + esc(url) + '"';
    if (title) out += ' title="' + esc(title) + '"';
    return out + '>' + inner + '</a>';
  }
  if (textOnly) return inner;
  const url = cleanUrl(href);
  if (url === null) return esc(inner);
  let out = '<img src="' + esc(url) + '" alt="' + esc(inner) + '"';
  if (title) out += ' title="' + esc(title) + '"';
  return out + '>';
}

// An inline [text](href "title") — or undefined when it is not a link.
function tryInlineLink(rest, links, st, textOnly) {
  if (st.linkParenPossible === false) return null;
  const m = INLINE.link.exec(rest);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasTag(rest, m[1], bang)) return null;
  let href = m[2].trim();
  if (O.startAngleBracket.test(href)) {
    if (!O.endAngleBracket.test(href)) return null;
    const unesc = rtrim(href.slice(0, -1), '\\');
    if ((href.length - unesc.length) % 2 === 0) return null;
  } else {
    const close = findParen(m[2]);
    if (close === -2) return null;
    if (close > -1) {
      const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
      m[2] = m[2].substring(0, close);
      m[0] = m[0].substring(0, cut).trim();
      m[3] = '';
    }
  }
  const rawTrimmed = rtrim(m[0].slice(0, -1), '\\');
  if ((m[0].length - rawTrimmed.length) % 2 === 0) return null;
  let url = m[2];
  const title = m[3] ? m[3].slice(1, -1) : '';
  url = url.trim();
  if (O.startAngleBracket.test(url)) url = url.slice(1, -1);
  const html = makeLink(m,
    url && url.replace(INLINE.anyPunctuation, '$1'),
    title && title.replace(INLINE.anyPunctuation, '$1'),
    links, st, textOnly);
  return html === undefined ? null : { html, len: m[0].length };
}

// A reference link [text][ref], [text][] or [text] — or a single text char
// when the label does not resolve (the [ or ! is then plain text).
function tryRefLink(rest, links, st, textOnly) {
  const m = INLINE.reflink.exec(rest) || INLINE.nolink.exec(rest);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (labelHasTag(rest, m[1], bang)) return null;
  const ref = links[normLabel(m[2] || m[1])];
  if (!ref) {
    const ch = m[0].charAt(0);
    return { html: textOnly ? ch : esc(ch), len: 1, text: true };
  }
  const html = makeLink(m, ref.href, ref.title, links, st, textOnly);
  return html === undefined ? null : { html, len: m[0].length };
}

// Emphasis / strong: find a closer for the delimiter run at the start of
// rest, honouring the rule of three. Returns {html, len} or null.
function tryEmStrong(rest, masked, prevChar, links, st, getCloser, textOnly) {
  const s = INLINE.emStrongLDelim.exec(rest);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const openPrev = prevChar === r;
  const i = masked.length - rest.length;
  let l = i;
  for (; l > 0 && masked[l - 1] === r;) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!INLINE.punctuation.exec(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h : !!INLINE.punctuation.exec(n);
  if (s[4] && n.match(O.unicodeAlphaNumeric)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let g, b, m = k, f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
    const v = getCloser().em[r];
    const Q = masked.length - rest.length + k;
    if (v < Q) return null;
    const t = masked.slice(-rest.length + k);
    const ee = v - Q;
    let match;
    A.lastIndex = 0;
    while ((match = A.exec(t)) !== null && !(match.index > ee)) {
      g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!g) continue;
      b = [...g].length;
      if (match[3] || match[4]) { m += b; continue; }
      if (match[5] || match[6] || R) {
        if (openPrev && (match[5] || match[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      if ((m -= b) > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...match[0]][0].length;
      const M = rest.slice(0, k + match.index + te + b);
      if (Math.min(k, b) % 2) {
        const inner = M.slice(1, -1);
        return { html: textOnly ? renderInline(inner, links, st, true) : '<em>' + renderInline(inner, links, st, false) + '</em>', len: M.length };
      }
      const inner = M.slice(2, -2);
      return { html: textOnly ? renderInline(inner, links, st, true) : '<strong>' + renderInline(inner, links, st, false) + '</strong>', len: M.length };
    }
  }
  return null;
}

// Strikethrough: ~~text~ or ~text~, closer run must match the opener's length.
function tryDel(rest, masked, prevChar, links, st, getCloser, textOnly) {
  const s = INLINE.delLDelim.exec(rest);
  if (!s) return null;
  if (!(s[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
    const o = [...s[0]].length - 1;
    let l, p = o;
    const A = INLINE.delRDelim;
    const u = getCloser().del;
    const d = masked.length - rest.length + o;
    if (u < d) return null;
    const t = masked.slice(-rest.length + o);
    const k = u - d;
    let match;
    A.lastIndex = 0;
    while ((match = A.exec(t)) !== null && !(match.index > k)) {
      const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!g || (l = [...g].length) !== o) continue;
      if (match[3] || match[4]) { p += l; continue; }
      if ((p -= l) > 0) continue;
      l = Math.min(l, l + p);
      const first = [...match[0]][0].length;
      const raw = rest.slice(0, o + match.index + first + l);
      const inner = raw.slice(o, -o);
      return { html: textOnly ? renderInline(inner, links, st, true) : '<del>' + renderInline(inner, links, st, false) + '</del>', len: raw.length };
    }
  }
  return null;
}

function renderInline(src, links, st, textOnly) {
  const needMask = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = needMask ? maskForEmphasis(src, links) : src;
  let closerCache = null;
  const getCloser = () => closerCache ??= (needMask ? closerInfo(masked) : { em: { '*': -1, '_': -1 }, del: -1 });
  let rest = src;
  let out = '';
  let wasText = false;
  let prev = '';
  let guard = Infinity;
  while (rest) {
    if (rest.length < guard) guard = rest.length;
    else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    if (!wasText) prev = '';
    wasText = false;
    let m;
    if ((m = INLINE.escape.exec(rest))) {
      out += textOnly ? m[1] : esc(m[1]);
      rest = rest.substring(m[0].length);
      continue;
    }
    if ((m = INLINE.tag.exec(rest))) {
      if (!st.inLink && O.startATag.test(m[0])) st.inLink = true;
      else if (st.inLink && O.endATag.test(m[0])) st.inLink = false;
      if (!st.inRawBlock && O.startPreScriptTag.test(m[0])) st.inRawBlock = true;
      else if (st.inRawBlock && O.endPreScriptTag.test(m[0])) st.inRawBlock = false;
      out += m[0];
      rest = rest.substring(m[0].length);
      continue;
    }
    if ((m = tryInlineLink(rest, links, st, textOnly))) {
      out += m.html;
      rest = rest.substring(m.len);
      continue;
    }
    if ((m = tryRefLink(rest, links, st, textOnly))) {
      out += m.html;
      rest = rest.substring(m.len);
      continue;
    }
    if ((m = tryEmStrong(rest, masked, prev, links, st, getCloser, textOnly))) {
      out += m.html;
      rest = rest.substring(m.len);
      continue;
    }
    if ((m = INLINE.code.exec(rest))) {
      let n = m[2].replace(O.newLineCharGlobal, ' ');
      const s = O.nonSpaceChar.test(n);
      const r = O.startingSpaceChar.test(n) && O.endingSpaceChar.test(n);
      if (s && r) n = n.substring(1, n.length - 1);
      out += textOnly ? n : '<code>' + esc(n, true) + '</code>';
      rest = rest.substring(m[0].length);
      continue;
    }
    if ((m = INLINE.br.exec(rest))) {
      out += textOnly ? '' : '<br>';
      rest = rest.substring(m[0].length);
      continue;
    }
    if ((m = tryDel(rest, masked, prev, links, st, getCloser, textOnly))) {
      out += m.html;
      rest = rest.substring(m.len);
      continue;
    }
    if ((m = INLINE.autolink.exec(rest))) {
      const text = m[1];
      if (textOnly) { out += text; rest = rest.substring(m[0].length); continue; }
      const href = m[2] === '@' ? 'mailto:' + text : text;
      const url = cleanUrl(href);
      out += url === null ? esc(text, true)
        : '<a href="' + esc(url, true) + '">' + esc(text, true) + '</a>';
      rest = rest.substring(m[0].length);
      continue;
    }
    if (!st.inLink && (m = INLINE.url.exec(rest))) {
      let text, href;
      if (m[2] === '@') { text = m[0]; href = 'mailto:' + text; }
      else {
        let r;
        do { r = m[0]; m[0] = INLINE._backpedal.exec(m[0])?.[0] ?? ''; } while (r !== m[0]);
        text = m[0];
        href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
      }
      const url = cleanUrl(href);
      out += textOnly ? text : url === null ? esc(text, true)
        : '<a href="' + esc(url, true) + '">' + esc(text, true) + '</a>';
      rest = rest.substring(m[0].length);
      continue;
    }
    if ((m = INLINE.text.exec(rest))) {
      const text = st.inRawBlock ? m[0] : Ie(m[0]);
      out += textOnly ? text : (st.inRawBlock ? text : esc(text));
      if (m[0].slice(-1) !== '_') prev = m[0].slice(-1);
      wasText = true;
      rest = rest.substring(m[0].length);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block rendering. A block loop keeps a "pending" paragraph/text block that
// still accumulates lines (marked merges consecutive text lines, and merges
// an indented code block or a link definition into a preceding paragraph or
// text block). Blocks are built as a tree of nodes; inline content is
// rendered only once, at the end, after every link definition in the
// document has been registered — marked renders a paragraph's inline tokens
// after all block tokens are collected, so a definition that follows a
// paragraph (with another block between) still resolves its links.
// ---------------------------------------------------------------------------

function ge(a) {
  const e = a.split('\n');
  let t = e.length - 1;
  for (; t >= 0 && O.blankLine.test(e[t]);) t--;
  return e.length - t <= 2 ? a : e.slice(0, t + 1).join('\n');
}

function fenceText(raw, content) {
  const n = raw.match(O.indentCodeCompensation);
  if (n === null) return content;
  const s = n[1];
  return content.split('\n').map(r => {
    const o = r.match(O.beginningSpace);
    if (o === null) return r;
    return r.slice(Math.min(o[0].length, s.length));
  }).join('\n');
}

function splitTableCells(a, e) {
  const t = a.replace(O.findPipe, (r, o, i) => {
    let l = false, p = o;
    for (; --p >= 0 && i[p] === '\\';) l = !l;
    return l ? '|' : ' |';
  });
  const n = t.split(O.splitPipe);
  let s = 0;
  if (n[0].trim() || n.shift(), n.length > 0 && !n.at(-1)?.trim() && n.pop(), e) {
    if (n.length > e) n.splice(e);
    else for (; n.length < e;) n.push('');
  }
  for (; s < n.length; s++) n[s] = n[s].trim().replace(O.slashPipe, '|');
  return n;
}

function codeHtml(text, lang) {
  const s = (lang || '').match(O.notSpaceStart)?.[0];
  const r = text ? text.replace(O.endingNewline, '') + '\n' : '';
  return s ? '<pre><code class="language-' + esc(s) + '">' + esc(r, true) + '</code></pre>\n'
    : '<pre><code>' + esc(r, true) + '</code></pre>\n';
}

function newBlockCtx(links, st, top) {
  return { links, st, top, segs: [], pending: null, allowParaMerge: false, checkboxHtml: null, checkboxDone: false, sawBlankSpace: false, loose: false };
}

function flushPending(ctx) {
  if (!ctx.pending) return;
  const p = ctx.pending;
  ctx.pending = null;
  let checkbox = null;
  if (ctx.checkboxHtml && !ctx.checkboxDone && ctx.segs.length === 0) {
    checkbox = ctx.checkboxHtml;
    ctx.checkboxDone = true;
  }
  const kind = p.kind === 'text' && ctx.loose ? 'paragraph' : p.kind;
  ctx.segs.push({ type: kind, text: p.text, checkbox });
}

function pushSeg(ctx, seg) {
  if (ctx.checkboxHtml && !ctx.checkboxDone && ctx.segs.length === 0 && !ctx.pending) {
    ctx.segs.push({ type: 'paragraph', text: '', checkbox: ctx.checkboxHtml });
    ctx.checkboxDone = true;
  }
  ctx.segs.push(seg);
}

function lastBlockType(ctx) {
  if (ctx.pending) return ctx.pending.kind === 'text' && ctx.loose ? 'paragraph' : ctx.pending.kind;
  const s = ctx.segs.at(-1);
  return s ? s.type : null;
}

function lastBlockSeg(ctx) {
  return ctx.segs.at(-1) || null;
}

function renderSegs(segs, links, st) {
  let out = '';
  for (const seg of segs) {
    switch (seg.type) {
      case 'paragraph':
        out += '<p>' + (seg.checkbox || '') + renderInline(seg.text, links, st, false) + '</p>\n';
        break;
      case 'text':
        out += (seg.checkbox || '') + renderInline(seg.text, links, st, false);
        break;
      case 'heading':
        out += '<h' + seg.depth + '>' + renderInline(seg.text, links, st, false) + '</h' + seg.depth + '>\n';
        break;
      case 'code':
      case 'hr':
      case 'html':
        out += seg.html;
        break;
      case 'table': {
        let head = '';
        for (let i = 0; i < seg.header.length; i++) head += tableCell(seg.header[i], true, seg.align[i], links, st);
        let body = '';
        for (const row of seg.rows) {
          let rowHtml = '';
          for (let p = 0; p < row.length; p++) rowHtml += tableCell(row[p], false, seg.align[p], links, st);
          body += '<tr>\n' + rowHtml + '</tr>\n';
        }
        if (body) body = '<tbody>' + body + '</tbody>';
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' + body + '</table>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + blockHtml(seg.ctx) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = seg.ordered ? 'ol' : 'ul';
        const startAttr = seg.ordered && seg.start !== 1 ? ' start="' + seg.start + '"' : '';
        out += '<' + tag + startAttr + '>\n';
        for (const item of seg.items) out += '<li>' + blockHtml(item.ctx) + '</li>\n';
        out += '</' + tag + '>\n';
        break;
      }
    }
  }
  return out;
}

function blockHtml(ctx) {
  flushPending(ctx);
  return renderSegs(ctx.segs, ctx.links, ctx.st);
}

function tableCell(text, header, align, links, st) {
  const tag = header ? 'th' : 'td';
  const inner = renderInline(text, links, st, false);
  return (align ? '<' + tag + ' align="' + align + '">' : '<' + tag + '>') + inner + '</' + tag + '>\n';
}

function renderTable(m) {
  const headerCells = splitTableCells(m[1]);
  const alignParts = m[2].replace(O.tableAlignChars, '').split('|');
  if (headerCells.length !== alignParts.length) return null;
  const align = [];
  for (const a of alignParts) {
    if (O.tableAlignRight.test(a)) align.push('right');
    else if (O.tableAlignCenter.test(a)) align.push('center');
    else if (O.tableAlignLeft.test(a)) align.push('left');
    else align.push(null);
  }
  const rows = m[3]?.trim() ? m[3].replace(O.tableRowBlankLine, '').split('\n') : [];
  return { type: 'table', header: headerCells, align, rows: rows.map(row => splitTableCells(row, headerCells.length)) };
}

function blockLoop(ctx, src) {
  let rest = src;
  let guard = Infinity;
  while (rest) {
    if (rest.length < guard) guard = rest.length;
    else throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    let m;
    if ((m = BLK.newline.exec(rest))) {
      if (O.anyLine.test(m[0])) ctx.sawBlankSpace = true;
      // A blank-line run is its own space token: it ends a pending paragraph
      // or text block (a following definition or code block then stands
      // alone instead of merging into it). A single newline merges into the
      // previous block's raw and does not break it.
      if (m[0].length > 1) flushPending(ctx);
      rest = rest.substring(m[0].length);
      continue;
    }
    if ((m = BLK.code.exec(rest))) {
      const raw = ge(m[0]);
      const text = raw.replace(O.codeRemoveIndent, '');
      if (ctx.pending && (ctx.pending.kind === 'paragraph' || ctx.pending.kind === 'text')) {
        ctx.pending.text += '\n' + text;
      } else {
        flushPending(ctx);
        pushSeg(ctx, { type: 'code', html: codeHtml(text, ''), raw });
      }
      rest = rest.substring(raw.length);
      continue;
    }
    if ((m = BLK.fences.exec(rest))) {
      const lang = m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2];
      flushPending(ctx);
      pushSeg(ctx, { type: 'code', html: codeHtml(fenceText(m[0], m[3] || ''), lang), raw: m[0] });
      rest = rest.substring(m[0].length);
      continue;
    }
    if ((m = BLK.heading.exec(rest))) {
      let n = m[2].trim();
      if (O.endingHash.test(n)) {
        const s = rtrim(n, '#');
        if (!s || O.endingSpaceTabChar.test(s)) n = s.trim();
      }
      flushPending(ctx);
      pushSeg(ctx, { type: 'heading', depth: m[1].length, text: n, raw: rtrim(m[0], '\n') });
      rest = rest.substring(rtrim(m[0], '\n').length);
      continue;
    }
    if ((m = BLK.hr.exec(rest))) {
      flushPending(ctx);
      pushSeg(ctx, { type: 'hr', html: '<hr>\n', raw: rtrim(m[0], '\n') });
      rest = rest.substring(rtrim(m[0], '\n').length);
      continue;
    }
    if ((m = BLK.blockquote.exec(rest))) {
      const bq = renderBlockquote(ctx.links, ctx.st, rest);
      flushPending(ctx);
      pushSeg(ctx, { type: 'blockquote', ctx: bq.ctx, raw: bq.raw, text: bq.text });
      rest = rest.substring(bq.raw.length);
      continue;
    }
    if ((m = BLK.list.exec(rest))) {
      const lst = renderList(ctx.links, ctx.st, rest);
      if (lst) {
        flushPending(ctx);
        pushSeg(ctx, { type: 'list', ordered: lst.ordered, start: lst.start, items: lst.items, raw: lst.raw });
        rest = rest.substring(lst.raw.length);
        continue;
      }
    }
    if ((m = BLK.html.exec(rest))) {
      const raw = ge(m[0]);
      flushPending(ctx);
      pushSeg(ctx, { type: 'html', html: raw, raw });
      rest = rest.substring(raw.length);
      continue;
    }
    if ((m = BLK.def.exec(rest))) {
      if (!O.startAngleBracket.test(m[2]) && findParen(m[2]) !== -1) {
        // not a definition: fall through to the paragraph/text rules
      } else {
        const tag = normLabel(m[1]);
        const href = m[2] ? m[2].replace(O.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
        const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1') : m[3];
        const raw = rtrim(m[0], '\n');
        if (ctx.pending && (ctx.pending.kind === 'paragraph' || ctx.pending.kind === 'text')) {
          ctx.pending.text += '\n' + raw;
        } else {
          if (!ctx.links[tag]) ctx.links[tag] = { href, title };
        }
        rest = rest.substring(raw.length);
        continue;
      }
    }
    if ((m = BLK.table.exec(rest))) {
      if (O.tableDelimiter.test(m[2])) {
        const tbl = renderTable(m);
        if (tbl) {
          flushPending(ctx);
          pushSeg(ctx, tbl);
          rest = rest.substring(rtrim(m[0], '\n').length);
          continue;
        }
      }
    }
    if ((m = BLK.lheading.exec(rest))) {
      const n = m[1].trim();
      flushPending(ctx);
      pushSeg(ctx, { type: 'heading', depth: m[2].charAt(0) === '=' ? 1 : 2, text: n, raw: rtrim(m[0], '\n') });
      rest = rest.substring(rtrim(m[0], '\n').length);
      continue;
    }
    if (ctx.top && (m = BLK.paragraph.exec(rest))) {
      const n = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      if (ctx.allowParaMerge && ctx.pending && ctx.pending.kind === 'paragraph') {
        ctx.pending.text += '\n' + n;
      } else {
        flushPending(ctx);
        ctx.pending = { kind: 'paragraph', text: n };
      }
      ctx.allowParaMerge = false;
      rest = rest.substring(m[0].length);
      continue;
    }
    if ((m = BLK.text.exec(rest))) {
      if (ctx.pending && ctx.pending.kind === 'text') {
        ctx.pending.text += '\n' + m[0];
      } else {
        flushPending(ctx);
        ctx.pending = { kind: 'text', text: m[0] };
      }
      rest = rest.substring(m[0].length);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
}

function renderBlockquote(links, st, src) {
  const m = BLK.blockquote.exec(src);
  if (!m) return null;
  let lines = rtrim(m[0], '\n').split('\n');
  let s = '';
  let r = '';
  const ctx = newBlockCtx(links, st, true);
  while (lines.length > 0) {
    let started = false;
    const chunk = [];
    let p = 0;
    for (p = 0; p < lines.length; p++) {
      if (O.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); started = true; }
      else if (!started) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = chunk.join('\n');
    const u = h.replace(O.blockquoteMarkerWhitespace, (g, b, mm) => b + expandTabs(mm, b.length))
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    s = s ? s + '\n' + h + '\n' : h;
    r = r ? r + '\n' + u + '\n' : u;
    ctx.allowParaMerge = true;
    blockLoop(ctx, u);
    if (lines.length === 0) break;
    const kType = lastBlockType(ctx);
    if (kType === 'code' || kType === 'heading' || kType === 'hr' || kType === 'html' || kType === 'table') break;
    if (kType === 'blockquote') {
      const g = lastBlockSeg(ctx);
      const b = lines.join('\n');
      const mm = g.raw + '\n' + b.replace(O.blockquoteSetextReplace2, '');
      const f = renderBlockquote(links, st, mm);
      ctx.segs[ctx.segs.length - 1] = { type: 'blockquote', ctx: f.ctx, raw: f.raw, text: f.text };
      const y = mm.substring(f.raw.length).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) s = s + '\n' + A.join('\n') + '\n';
      r = r.substring(0, r.length - g.text.length) + f.text;
      lines = lines.slice(A.length);
      if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (kType === 'list') {
      const g = lastBlockSeg(ctx);
      const b = g.raw + '\n' + lines.join('\n');
      const mm = renderList(links, st, b);
      ctx.segs[ctx.segs.length - 1] = { type: 'list', ordered: mm.ordered, start: mm.start, items: mm.items, raw: mm.raw };
      const f = mm.raw.length > g.raw.length ? b.slice(g.raw.length + 1, mm.raw.length).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        s = s + '\n' + y + '\n';
        r = r + '\n' + y + '\n';
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { ctx, raw: s, text: r };
}

function renderList(links, st, src) {
  let t = BLK.list.exec(src);
  if (!t) return null;
  const n = src;
  let e = src;
  const s = () => n.length - e.length;
  let r = t[1].trim();
  const ordered = r.length > 1;
  const list = { ordered, start: ordered ? +r.slice(0, -1) : '', loose: false, items: [] };
  r = ordered ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
  const l = O.listItemRegex(r);
  let p = false;
  while (e) {
    let u = false;
    let d = '';
    if (!(t = l.exec(e)) || BLK.hr.test(e)) break;
    const k = s();
    e = e.substring(t[0].length);
    const g = t[2].split('\n', 1)[0];
    const b = t[1].length;
    let m = g.replace(O.leadingSpaceTab, v => expandTabs(v, b));
    let f = e.split('\n', 1)[0];
    let y = !m.trim();
    let R = 0;
    if (y) R = b + 1;
    else {
      R = m.search(O.nonSpaceChar);
      R = R > 4 ? 1 : R;
      d = m.slice(R);
      R += b;
    }
    if (y && O.blankLine.test(f)) { e = e.substring(f.length + 1); u = true; }
    if (!u) {
      const v = O.nextBulletRegex(R);
      const Q = O.hrRegex(R);
      const ee = O.fencesBeginRegex(R);
      const te = O.headingBeginRegex(R);
      const M = O.htmlBeginRegex(R);
      const ne = O.blockquoteBeginRegex(R);
      while (e) {
        const U = e.split('\n', 1)[0];
        let Z;
        f = U;
        Z = f.replace(O.leadingSpaceTab, me => expandTabs(me));
        if (ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f)) break;
        if (Z.search(O.nonSpaceChar) >= R || !f.trim()) d += '\n' + Z.slice(R);
        else {
          if (y || m.replace(O.tabCharGlobal, '    ').search(O.nonSpaceChar) >= 4 || ee.test(m) || te.test(m) || M.test(m) || Q.test(m)) break;
          const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && BLK.lheading.test(m + '\n' + f)
            ? '    ' + Z.replace(/^ {0,3}/, '') : f;
          d += '\n' + qe;
        }
        y = !f.trim();
        e = e.substring(U.length + 1);
        m = Z.slice(R);
      }
    }
    const A = n.slice(k, s());
    if (!list.loose) {
      if (p) list.loose = true;
      else if (O.doubleBlankLine.test(A)) p = true;
    }
    list.items.push({ raw: A, task: O.listIsTask.test(d), text: d });
  }
  const h = list.items.at(-1);
  if (!h) return null;
  h.raw = h.raw.trimEnd();
  h.text = h.text.trimEnd();
  const raw = n.slice(0, s()).trimEnd();
  const items = [];
  for (const item of list.items) {
    let task = item.task;
    let checked = false;
    let text = item.text;
    if (task) {
      const ck = O.listTaskCheckbox.exec(item.raw);
      checked = !!ck && ck[0] !== '[ ]';
      text = text.replace(O.listReplaceTask, '');
    }
    const ctx = newBlockCtx(links, st, false);
    if (task) ctx.checkboxHtml = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    blockLoop(ctx, text);
    if (!list.loose && ctx.sawBlankSpace) list.loose = true;
    items.push({ ctx, task, text });
  }
  // A loose list renders its items' text blocks as paragraphs. The items
  // are already tokenized above; just flip the built 'text' segments to
  // 'paragraph' and mark the ctx loose so a pending tail flushes as one
  // too, instead of re-running blockLoop for every item.
  if (list.loose) {
    for (const it of items) {
      it.ctx.loose = true;
      for (const seg of it.ctx.segs) if (seg.type === 'text') seg.type = 'paragraph';
    }
  }
  return { ordered: list.ordered, start: list.start, items, raw };
}

// ---------------------------------------------------------------------------
// Public entry point: marked.parse(markdown) with marked's default options
// (gfm true, breaks false, pedantic false, async false).
// ---------------------------------------------------------------------------
export function parse(markdown) {
  const src = markdown.replace(O.carriageReturn, '\n');
  const links = Object.create(null);
  const st = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
  const ctx = newBlockCtx(links, st, true);
  blockLoop(ctx, src);
  return blockHtml(ctx);
}
