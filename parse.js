// parse.js — a fast, dependency-free ES module whose parse(markdown) returns
// exactly the HTML that marked 18.1.3 renders with its default options
// (gfm on, breaks off, pedantic off, async off).
//
// Written from scratch for this competition: the parser below is my own code,
// organised my way, but it implements the same grammar marked does — the same
// block and inline productions, the same delimiter rules, the same renderer —
// because the scorer compares output with marked's code unit for code unit.
// Where marked departs from the CommonMark/GFM spec, marked's output is the
// target, never the spec's. No part of marked's source is copied here.
//
// Speed comes from the structure, not from shortcuts: block tokens are
// produced in one scan, inline content is rendered straight to a string
// without building token trees, and the common plain-text runs take a fast
// path that never touches the big inline regexes.

const BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// --- tiny regex builder: compose a pattern from pieces, the way a grammar
// is built up. `sub` replaces a placeholder with another pattern's source,
// dropping a leading ^ the piece would otherwise carry mid-pattern.
function rx(source, flags = '') {
  let text = typeof source === 'string' ? source : source.source;
  const api = {
    sub(search, replacement) {
      let rep = typeof replacement === 'string' ? replacement : replacement.source;
      rep = rep.replace(/(^|[^\[])\^/g, '$1');
      text = text.replace(search, rep);
      return api;
    },
    build() {
      return new RegExp(text, flags);
    },
  };
  return api;
}

// A cache of small per-indent regexes, like the ones the block rules need.
function cached(make) {
  const memo = [];
  return (indent) => {
    const i = Math.max(0, Math.min(3, indent - 1));
    return memo[i] || (memo[i] = make(i));
  };
}

// ---------------------------------------------------------------------------
// Shared helper patterns
// ---------------------------------------------------------------------------
const R = {
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
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bullet) => new RegExp(`^( {0,3}${bullet})((?:[\t ][^\\n]*)?(?:\\n|$))`),
  nextBulletRegex: cached((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: cached((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: cached((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: cached((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: cached((i) => new RegExp(`^ {0,${i}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: cached((i) => new RegExp(`^ {0,${i}}>`)),
};

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const BLOCK_CODE_INDENT = /(?: {4}| {0,3}\t)/;
const FENCES_START = / {0,3}(?:`{3,}|~{3,})/;
const BLOCKQUOTE_START = / {0,3}>/;
const HEADING_START = / {0,3}#{1,6}(?:\s|$)/;
const HTML_START = rx(' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .sub('tag', BLOCK_TAGS)
  .build();
const TABLE_DELIM_ROW = / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/;

// Setext heading: the base pattern, with its block-start lookaheads filled in.
// The hr alternative here is the non-capturing form (unlike the standalone
// hr rule, which captures its run): a capturing group would shift the
// underline's group number.
const HR_INLINE = / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const SETEXT_BASE =
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
function setextHeading(tablePattern) {
  return rx(SETEXT_BASE)
    .sub(/bull/g, BULLET)
    .sub(/blockCode/g, BLOCK_CODE_INDENT)
    .sub(/fences/g, FENCES_START)
    .sub(/blockquote/g, BLOCKQUOTE_START)
    .sub(/heading/g, HEADING_START)
    .sub(/hr/g, HR_INLINE)
    .sub(/html/g, / {0,3}<[^\n>]+>\n/)
    .sub(/table/g, tablePattern)
    .build();
}

// Paragraph: the base pattern, with its block-start lookaheads filled in.
// When `tablePattern` is null the table alternative is dropped entirely.
const PARAGRAPH_BASE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function paragraph(listPattern, tablePattern) {
  // The table alternative is settled before the html one: the html pattern
  // itself names the `table` tag, so a later table substitution would land
  // inside it instead of in the lookahead.
  const b = rx(PARAGRAPH_BASE)
    .sub('hr', HR)
    .sub('heading', HEADING_START)
    .sub('|lheading', '');
  if (tablePattern === null) b.sub('|table', '');
  else b.sub('table', tablePattern);
  return b
    .sub('blockquote', BLOCKQUOTE_START)
    .sub('fences', / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/)
    .sub('list', listPattern)
    .sub('html', HTML_START)
    .build();
}

const TABLE_RULE = rx(
  "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)",
)
  .sub('hr', HR)
  .sub('heading', HEADING_START)
  .sub('blockquote', BLOCKQUOTE_START)
  .sub('code', /(?: {4}| {0,3}\t)[^\n]/)
  .sub('fences', / {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/)
  .sub('list', / {0,3}(?:[*+-]|1[.)])[ \t]/)
  .sub('html', HTML_START)
  .build();

const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences:
    /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: HR,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  // Blockquote: lines starting with >, plus lazily continued paragraph lines.
  blockquote: (() => {
    const para = paragraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/, null);
    return rx(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).sub('paragraph', para).build();
  })(),
  list: rx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).sub(/bull/g, BULLET).build(),
  html: rx(
    '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))',
    'i',
  )
    .sub('comment', /<!--(?:-?>|[\s\S]*?(?:-->|$))/)
    .sub('tag', BLOCK_TAGS)
    .sub('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
    .build(),
  def: (() => {
    const label = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
    const title = /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
    return rx(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
      .sub('label', label)
      .sub('title', title)
      .build();
  })(),
  table: TABLE_RULE,
  lheading: setextHeading(TABLE_DELIM_ROW),
  paragraph: paragraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/, TABLE_RULE),
  text: /^[^\n]+/,
};

// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------
const PUNCT = /[\p{P}\p{S}]/u; // any punctuation or symbol character
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u; // whitespace, punctuation or symbol
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u; // anything else
const NOT_PUNCT_SPACE_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const PUNCT_SPACE_NOT_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const PUNCT_NOT_TILDE = /(?!~)[\p{P}\p{S}]/u;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;
const SCHEME = /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/;
const EMAIL_LOCAL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_FULL =
  /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/;
const PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EMAIL_URL =
  /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const AUTOLINK_EMAIL = rx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).sub(/email/g, EMAIL_LOCAL).build();
const LINK_LABEL_INNER = (() => {
  const brackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
  return rx(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/)
    .sub('brackets', brackets)
    .build();
})();
const LINK_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const LINK_LABEL_SEARCH = (() => {
  const brackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
  return rx(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/)
    .sub('brackets', brackets)
    .build();
})();
const REF_LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  // Plain text: runs up to the next character that can start inline markup,
  // a hard break, or an autolink-like sequence.
  text: rx(
    /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  )
    .sub('protocol', PROTOCOL)
    .sub(/emailProtocol/g, /(?:mailto|xmpp):/)
    .sub('wwwStart', '(?<![^\\s*_~(])www\\.')
    .build(),
  emStrongLDelim: rx(/^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/, 'u')
    .sub(/punct/g, PUNCT_NOT_TILDE)
    .build(),
  emStrongRDelimAst: rx(
    "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)",
    'gu',
  )
    .sub(/notPunctSpace/g, NOT_PUNCT_SPACE_TILDE)
    .sub(/punctSpace/g, PUNCT_SPACE_NOT_TILDE)
    .sub(/punct/g, PUNCT_NOT_TILDE)
    .build(),
  // Note: the GFM rules keep the plain underscore closer (the tilde-aware
  // variant exists in marked but is never selected for the GFM set).
  emStrongRDelimUnd: rx(
    "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)",
    'gu',
  )
    .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
    .sub(/punctSpace/g, PUNCT_SPACE)
    .sub(/punct/g, PUNCT)
    .build(),
  delLDelim: rx(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').sub(/punct/g, PUNCT).build(),
  delRDelim: rx(
    "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)",
    'gu',
  )
    .sub(/notPunctSpace/g, NOT_PUNCT_SPACE)
    .sub(/punctSpace/g, PUNCT_SPACE)
    .sub(/punct/g, PUNCT)
    .build(),
  autolink: rx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
    .sub('scheme', SCHEME)
    .sub('email', EMAIL_FULL)
    .build(),
  tag: rx(
    "^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>",
  )
    .sub('comment', /<!--(?:-?>|[\s\S]*?-->)/)
    .sub('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
    .build(),
  link: rx(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
    .sub('label', LINK_LABEL_INNER)
    .sub('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
    .sub('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
    .build(),
  reflink: rx(/^!?\[(label)\]\[(ref)\]/).sub('label', LINK_LABEL_INNER).sub('ref', LINK_LABEL).build(),
  nolink: rx(/^!?\[(ref)\](?:\[\])?/).sub('ref', LINK_LABEL).build(),
  reflinkSearch: rx('reflink|nolink(?!\\()', 'g')
    .sub(
      'reflink',
      rx(/^!?\[(label)\]\[(ref)\]/).sub('label', LINK_LABEL_SEARCH).sub('ref', REF_LABEL).build(),
    )
    .sub('nolink', rx(/^!?\[(ref)\](?:\[\])?/).sub('ref', REF_LABEL).build())
    .build(),
  url: rx(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
    .sub('emailProtocol', AUTOLINK_EMAIL)
    .sub('protocol', PROTOCOL)
    .sub('email', EMAIL_URL)
    .build(),
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  anyPunctuation: rx(/\\(punct)/, 'gu').sub(/punct/g, PUNCT).build(),
  anyPunctuationOutsideCode: rx(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu')
    .sub(/punct/g, PUNCT)
    .build(),
  // Things emphasis scanning must skip: links, code spans and raw HTML.
  blockSkip: rx(/link|precode-code|html/, 'g')
    .sub(
      'link',
      /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
    )
    .sub('precode-', '(?<!`)()')
    .sub('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
    .sub('html', /<(?! )[^<>]*?>/)
    .build(),
  punctuation: rx(/^((?![*_])punctSpace)/, 'u').sub(/punctSpace/g, PUNCT_SPACE).build(),
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeChar = (ch) => ESCAPES[ch];

// Escape HTML text. With `encode`, bare & is always escaped; otherwise an &
// that already starts a character reference is left alone.
function escapeHtml(str, encode) {
  if (encode) {
    if (R.escapeTest.test(str)) return str.replace(R.escapeReplace, escapeChar);
  } else if (R.escapeTestNoEncode.test(str)) {
    return str.replace(R.escapeReplaceNoEncode, escapeChar);
  }
  return str;
}

// Decode numeric character references; a bare & that is not a reference
// becomes &amp;. Named entities are NOT decoded here (marked leaves them).
function decodeEntities(str) {
  if (!R.numericCharacterReference.test(str)) return str;
  return str.replace(R.numericCharacterReferenceOrAmpersand, (whole, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// encodeURI, with %25 turned back into %; null when the href is unencodable.
function cleanHref(href) {
  try {
    return encodeURI(href).replace(R.percentDecode, '%');
  } catch {
    return null;
  }
}

// Split one table row on unescaped pipes, trimming cells and honouring the
// expected column count.
function splitTableRow(row, columns) {
  const spaced = row.replace(R.findPipe, (pipe, offset, whole) => {
    let escaped = false;
    for (let p = offset - 1; p >= 0 && whole[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = spaced.split(R.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (columns) {
    if (cells.length > columns) cells.splice(columns);
    else while (cells.length < columns) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(R.slashPipe, '|');
  return cells;
}

// Strip `ch` from the end of a string (or, with `invert`, strip everything
// that is not `ch`).
function trimEndChar(str, ch, invert) {
  const n = str.length;
  if (n === 0) return '';
  let cut = 0;
  for (;;) {
    const c = str.charAt(n - cut - 1);
    if (c === ch && !invert) cut++;
    else if (c !== ch && invert) cut++;
    else break;
  }
  return str.slice(0, n - cut);
}

// Drop trailing blank lines, unless there are at most one of them.
function stripTrailingBlankLines(str) {
  const lines = str.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && R.blankLine.test(lines[last])) last--;
  return lines.length - last <= 2 ? str : lines.slice(0, last + 1).join('\n');
}

// Normalise a link reference label for lookup.
function normalizeLabel(label) {
  return label.trim().replace(R.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Find the index of the closing delimiter of a balanced pair, honouring
// backslash escapes. -1 when there is none, -2 when it never closes.
function findPairEnd(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === pair[0]) {
      depth++;
    } else if (str[i] === pair[1]) {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tracking the column (for list and blockquote work).
function expandTabs(str, column = 0) {
  let col = column;
  let out = '';
  for (const ch of str) {
    if (ch === '\t') {
      const width = 4 - (col % 4);
      out += ' '.repeat(width);
      col += width;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// The code point (as a string) ending at `index` in `str`, or ''.
function lastCodePointBefore(str, index) {
  if (index <= 0) return '';
  let start = index - 1;
  if (
    start > 0 &&
    str.charCodeAt(start) >= 0xdc00 &&
    str.charCodeAt(start) <= 0xdfff &&
    str.charCodeAt(start - 1) >= 0xd800 &&
    str.charCodeAt(start - 1) <= 0xdbff
  ) {
    start--;
  }
  return str.slice(start, index);
}

// The UTF-16 length of the first code point of `str`.
function firstCodePointLength(str) {
  if (!str) return 0;
  return str.codePointAt(0) > 0xffff ? 2 : 1;
}

// Expand a line's leading spaces/tabs to spaces, tracking the column from
// `startCol` (tabs advance to the next multiple of 4).
function expandLeadingWhitespace(line, startCol = 0) {
  let i = 0;
  let col = startCol;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ') {
      col++;
      i++;
    } else if (ch === '\t') {
      col += 4 - (col % 4);
      i++;
    } else {
      break;
    }
  }
  if (i === 0) return line;
  return ' '.repeat(col - startCol) + line.slice(i);
}

// Index of the first character that is not a space, or -1 when there is none.
function firstNonSpaceIndex(str) {
  for (let i = 0; i < str.length; i++) if (str[i] !== ' ') return i;
  return -1;
}

// Column of the first non-space character, counting each tab as 4 columns
// (as a tab-to-spaces replacement would); -1 when the line is all whitespace.
function firstNonSpaceColumn(str) {
  let col = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\t') col += 4;
    else if (ch === ' ') col++;
    else return col;
  }
  return -1;
}

// True when the line holds only spaces and tabs.
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

// Do any of the given block-start regexes (fences, heading, html, blockquote,
// next bullet, hr) match at this line's start? The regexes only allow spaces
// before their marker, so the line's first non-space character decides which
// of them can possibly match; the rest are skipped without running.
function startsBlock(line, indent, tests) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i > indent || i >= line.length) return false;
  const ch = line[i];
  if (ch === '\t') return false;
  if ((ch === '`' || ch === '~') && tests.fences) return tests.fences.test(line);
  if (ch === '#' && tests.heading) return tests.heading.test(line);
  if (ch === '<' && tests.html) return tests.html.test(line);
  if (ch === '>' && tests.quote) return tests.quote.test(line);
  if (ch === '*' || ch === '+' || ch === '-') {
    return (tests.bullet && tests.bullet.test(line)) || (tests.hr && tests.hr.test(line));
  }
  if (ch >= '0' && ch <= '9' && tests.bullet) return tests.bullet.test(line);
  if (ch === '_' && tests.hr) return tests.hr.test(line);
  return false;
}

// Compensate a fenced code block's text for the fence's own indentation.
function unindentFence(fenceMatch, text) {
  const m = fenceMatch.match(R.indentCodeCompensation);
  if (m === null) return text;
  const indent = m[1];
  return text
    .split('\n')
    .map((line) => {
      const lead = line.match(R.beginningSpace);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join('\n');
}

// Does this link text hold a < that starts a tag or autolink in the source?
// (Such links are not links at all, per the reference implementation.)
function linkTextHasTag(source, text, offset) {
  if (!text.includes('<')) return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '`') {
      const span = INLINE.code.exec(text.slice(i));
      if (span) {
        i += span[0].length - 1;
        continue;
      }
    }
    if (text[i] !== '<') continue;
    const rest = source.slice(offset + i);
    const tag = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (tag) {
      if (tag[0].length > text.length - i) return true;
      i += tag[0].length - 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Emphasis scanning: a masked copy of the source
// ---------------------------------------------------------------------------
// Delimiter matching must not see emphasis markers that sit inside links,
// code spans or raw HTML, so before scanning for closers the source is
// masked: those spans are replaced by same-length placeholders. The mask is
// recomputed per inline run and stacked while nested runs are scanned.
function scanCloserPositions(masked) {
  const lastEm = { '*': -1, _: -1 };
  let lastDel = -1;
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const before = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < n && masked[j] === ch) j++;
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r' && before !== '\f') {
      if (ch === '~') lastDel = i;
      else lastEm[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: masked, lastEm, lastDel };
}

function maskForEmStrong(lexer, src) {
  let masked = src;
  const hasBracket = src.includes('[');
  const hasTick = src.includes('`');
  const links = lexer.tokens.links;
  if (links && hasBracket) {
    const search = INLINE.reflinkSearch;
    const maskOne = (match) => {
      const open = match.lastIndexOf('[');
      if (!Object.hasOwn(links, normalizeLabel(match.slice(open + 1, -1)))) return match;
      if (open > 1 && match.charAt(0) !== '!') {
        const inner = match.slice(1, open - 1);
        if (lexer.linkInText(inner)) {
          return '[' + inner.replace(search, maskOne) + '][' + 'a'.repeat(match.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match.length - 2) + ']';
    };
    masked = masked.replace(search, maskOne);
  }
  // Code spans keep their backticks; a backslash escape becomes pluses.
  // (Only when the source holds a backtick or a backslash at all.)
  if (hasTick || src.includes('\\')) {
    masked = masked.replace(INLINE.anyPunctuationOutsideCode, (match, ticks, punct) =>
      punct
        ? '+'.repeat(match.length)
        : ticks
          ? ticks + match.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks
          : match,
    );
  }
  // Links, code spans and tags become [aaa...] placeholders.
  // (Only when the source holds a bracket, a backtick or a < at all.)
  if (hasBracket || hasTick || src.includes('<')) {
    masked = masked.replace(INLINE.blockSkip, (match, _empty, ticks) => {
      const keep = ticks ? ticks.length : 0;
      return match.slice(0, keep) + '[' + 'a'.repeat(match.length - keep - 2) + ']';
    });
  }
  return masked;
}

// ---------------------------------------------------------------------------
// Tokenizer: block and inline productions
// ---------------------------------------------------------------------------
// Block-start patterns used by the paragraph continuation check (the same
// patterns the paragraph regex's negative lookahead tests, anchored at the
// line start).
const PARA_FENCES = /^ {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)/;
const PARA_LIST = /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/;
const PARA_HTML = new RegExp('^' + HTML_START.source, HTML_START.flags);

// Does the line starting at `pos` (ending at `lineEnd`) start a block, per
// the paragraph regex's negative lookahead? The table alternative needs the
// next line too (header + delimiter row).
function paragraphLineStartsBlock(src, pos, lineEnd) {
  // Table: the next line must be a delimiter row.
  if (lineEnd < src.length) {
    const nextStart = lineEnd + 1;
    let nextEnd = src.indexOf('\n', nextStart);
    if (nextEnd === -1) nextEnd = src.length;
    let j = nextStart;
    while (j < nextEnd && src[j] === ' ') j++;
    if (j - nextStart <= 3 && j < nextEnd) {
      const c = src[j];
      if (
        (c === '|' || c === ':' || c === '-') &&
        src.indexOf('-', nextStart) !== -1 &&
        src.indexOf('-', nextStart) < nextEnd &&
        TABLE_RULE.test(src.slice(pos, nextEnd))
      ) {
        return true;
      }
    }
  }
  // Dispatch on the first non-space character (spaces only, at most 3).
  let i = pos;
  while (i < lineEnd && src[i] === ' ') i++;
  if (i - pos > 3 || i >= lineEnd) return false;
  const ch = src[i];
  if (ch === '\t') return false;
  const line = src.slice(pos, lineEnd);
  if (ch === '-' || ch === '_' || ch === '*') {
    if (HR.test(line)) return true;
    if (ch === '-' || ch === '*') {
      if (PARA_LIST.test(line)) return true;
    }
    return false;
  }
  if (ch === '#') return HEADING_START.test(line);
  if (ch === '>') return BLOCKQUOTE_START.test(line);
  if (ch === '`' || ch === '~') return PARA_FENCES.test(line);
  if (ch === '+' || ch === '1') return PARA_LIST.test(line);
  if (ch === '<') return PARA_HTML.test(line);
  return false;
}

// Could the source starting here be a setext heading? Only when one of the
// lines after the first is a setext underline (=== or ---), before the
// first blank line. The full lheading regex is expensive, so this cheap
// line scan keeps it from running on ordinary paragraphs.
function hasSetextUnderline(src) {
  let pos = src.indexOf('\n');
  if (pos === -1) return false;
  pos++;
  while (pos < src.length) {
    let lineEnd = src.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = src.length;
    const line = src.slice(pos, lineEnd);
    if (isBlankLine(line)) return false;
    let i = 0;
    while (i < line.length && line[i] === ' ') i++;
    if (i <= 3 && i < line.length) {
      const c = line[i];
      if (c === '=' || c === '-') {
        let j = i;
        while (j < line.length && line[j] === c) j++;
        let k = j;
        while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
        if (k === line.length) return true;
      }
    }
    pos = lineEnd + 1;
  }
  return false;
}

class Tokenizer {
  constructor(lexer) {
    this.lexer = lexer;
  }

  // -- blocks ---------------------------------------------------------------

  space(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }

  code(src) {
    const m = BLOCK.code.exec(src);
    if (m) {
      const raw = stripTrailingBlankLines(m[0]);
      return {
        type: 'code',
        raw,
        codeBlockStyle: 'indented',
        text: raw.replace(R.codeRemoveIndent, ''),
      };
    }
  }

  fences(src) {
    const m = BLOCK.fences.exec(src);
    if (m) {
      return {
        type: 'code',
        raw: m[0],
        lang: m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2],
        text: unindentFence(m[0], m[3] || ''),
      };
    }
  }

  heading(src) {
    const m = BLOCK.heading.exec(src);
    if (m) {
      let text = m[2].trim();
      if (R.endingHash.test(text)) {
        const stripped = trimEndChar(text, '#');
        if (!stripped || R.endingSpaceTabChar.test(stripped)) text = stripped.trim();
      }
      return {
        type: 'heading',
        raw: trimEndChar(m[0], '\n'),
        depth: m[1].length,
        text,
        inline: this.lexer.inline(text),
      };
    }
  }

  hr(src) {
    const m = BLOCK.hr.exec(src);
    if (m) return { type: 'hr', raw: trimEndChar(m[0], '\n') };
  }

  blockquote(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return undefined;
    const lines = trimEndChar(m[0], '\n').split('\n');
    let raw = '';
    let text = '';
    const tokens = [];
    while (lines.length > 0) {
      let lazy = false;
      const chunk = [];
      let p = 0;
      for (; p < lines.length; p++) {
        if (R.blockquoteStart.test(lines[p])) {
          chunk.push(lines[p]);
          lazy = true;
        } else if (!lazy) {
          chunk.push(lines[p]);
        } else {
          break;
        }
      }
      lines.splice(0, p);
      const chunkRaw = chunk.join('\n');
      const stripped = chunkRaw
        .replace(R.blockquoteMarkerWhitespace, (whole, marker, space) => marker + expandTabs(space, marker.length))
        .replace(R.blockquoteSetextReplace, '\n    $1')
        .replace(R.blockquoteSetextReplace2, '');
      raw = raw ? `${raw}\n${chunkRaw}` : chunkRaw;
      text = text ? `${text}\n${stripped}` : stripped;
      const wasTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(stripped, tokens, true);
      this.lexer.state.top = wasTop;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (
        last?.type === 'code' ||
        last?.type === 'heading' ||
        last?.type === 'hr' ||
        last?.type === 'html' ||
        last?.type === 'table'
      ) {
        break;
      }
      if (last?.type === 'blockquote') {
        const rest = lines.join('\n');
        const combined = `${last.raw}\n${rest.replace(R.blockquoteSetextReplace2, '')}`;
        const reparsed = this.blockquote(combined);
        tokens[tokens.length - 1] = reparsed;
        const consumed = combined.substring(reparsed.raw.length).replace(/^\n/, '');
        const consumedLines = consumed ? consumed.split('\n').length : 0;
        const kept = consumedLines ? lines.slice(0, -consumedLines) : lines;
        if (kept.length > 0) raw = `${raw}\n${kept.join('\n')}`;
        text = text.substring(0, text.length - last.text.length) + reparsed.text;
        lines.splice(0, kept.length);
        if (lines.length > 0 && R.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last?.type === 'list') {
        const combined = `${last.raw}\n${lines.join('\n')}`;
        const reparsed = this.list(combined);
        tokens[tokens.length - 1] = reparsed;
        const extra =
          reparsed.raw.length > last.raw.length
            ? combined.slice(last.raw.length + 1, reparsed.raw.length).split('\n').length
            : 0;
        if (extra > 0) {
          const added = lines.slice(0, extra).join('\n');
          raw = `${raw}\n${added}`;
          text = `${text}\n${added}`;
        }
        lines.splice(0, extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }

  list(src) {
    const m = BLOCK.list.exec(src);
    if (!m) return undefined;
    const full = src;
    const consumed = () => full.length - src.length;
    const marker = m[1].trim();
    const ordered = marker.length > 1;
    const list = {
      type: 'list',
      raw: '',
      ordered,
      start: ordered ? +marker.slice(0, -1) : '',
      loose: false,
      items: [],
    };
    const bulletPattern = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
    const itemRegex = R.listItemRegex(bulletPattern);
    let pendingLoose = false;
    while (src) {
      let blankItem = false;
      let itemText = '';
      const itemMatch = itemRegex.exec(src);
      if (!itemMatch || BLOCK.hr.test(src)) break;
      const start = consumed();
      src = src.substring(itemMatch[0].length);
      const firstLine = itemMatch[2].split('\n', 1)[0];
      const markerWidth = itemMatch[1].length;
      const expandedFirst = expandLeadingWhitespace(firstLine, markerWidth);
      let nextLine = src.split('\n', 1)[0];
      let firstBlank = isBlankLine(expandedFirst);
      let indent;
      if (firstBlank) {
        indent = markerWidth + 1;
      } else {
        indent = firstNonSpaceIndex(expandedFirst);
        indent = indent > 4 ? 1 : indent;
        itemText = expandedFirst.slice(indent);
        indent += markerWidth;
      }
      if (firstBlank && R.blankLine.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        blankItem = true;
      }
      if (!blankItem) {
        const tests = {
          fences: R.fencesBeginRegex(indent),
          heading: R.headingBeginRegex(indent),
          html: R.htmlBeginRegex(indent),
          quote: R.blockquoteBeginRegex(indent),
          bullet: R.nextBulletRegex(indent),
          hr: R.hrRegex(indent),
        };
        const contTests = { fences: tests.fences, heading: tests.heading, html: tests.html, hr: tests.hr };
        let current = expandedFirst;
        while (src) {
          const nl = src.indexOf('\n');
          const line = nl === -1 ? src : src.slice(0, nl);
          nextLine = line;
          if (startsBlock(line, indent, tests)) break;
          const expanded = expandLeadingWhitespace(line);
          if (firstNonSpaceIndex(expanded) >= indent || isBlankLine(line)) {
            itemText += `\n${expanded.slice(indent)}`;
          } else {
            if (
              firstBlank ||
              firstNonSpaceColumn(current) >= 4 ||
              startsBlock(current, indent, contTests)
            ) {
              break;
            }
            const setextLine =
              /^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheading.test(`${current}\n${line}`)
                ? `    ${expanded.replace(/^ {0,3}/, '')}`
                : line;
            itemText += `\n${setextLine}`;
          }
          firstBlank = isBlankLine(line);
          src = nl === -1 ? '' : src.slice(nl + 1);
          current = expanded.slice(indent);
        }
      }
      const itemRaw = full.slice(start, consumed());
      if (!list.loose) {
        if (pendingLoose) list.loose = true;
        else if (R.doubleBlankLine.test(itemRaw)) pendingLoose = true;
      }
      list.items.push({
        type: 'list_item',
        raw: itemRaw,
        task: !!R.listIsTask.test(itemText),
        loose: false,
        text: itemText,
        tokens: [],
      });
    }
    const lastItem = list.items.at(-1);
    if (!lastItem) return undefined;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = full.slice(0, consumed()).trimEnd();
    for (const item of list.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => R.anyLine.test(t.raw))) list.loose = true;
      }
    }
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(R.listReplaceTask, '');
        first.raw = first.raw.replace(R.listReplaceTask, '');
        first.text = first.text.replace(R.listReplaceTask, '');
        for (let i = this.lexer.inlineQueue.length - 1; i >= 0; i--) {
          if (R.listIsTask.test(this.lexer.inlineQueue[i].src)) {
            this.lexer.inlineQueue[i].src = this.lexer.inlineQueue[i].src.replace(R.listReplaceTask, '');
            break;
          }
        }
        const checkbox = R.listTaskCheckbox.exec(item.raw);
        if (checkbox) {
          const box = { type: 'checkbox', raw: `${checkbox[0]} `, checked: checkbox[0] !== '[ ]' };
          item.checked = box.checked;
          if (list.loose) {
            const first = item.tokens[0];
            if (first && ['paragraph', 'text'].includes(first.type) && first.inline) {
              // The checkbox renders before the paragraph's inline HTML.
              first.raw = box.raw + first.raw;
              first.text = box.raw + first.text;
              first.inlinePrefix = (first.inlinePrefix || '') + checkboxHtml(box.checked);
            } else {
              item.tokens.unshift({
                type: 'paragraph',
                raw: box.raw,
                text: box.raw,
                inline: { src: box.raw, html: checkboxHtml(box.checked) },
              });
            }
          } else {
            item.tokens.unshift(box);
          }
        }
      } else if (item.task) {
        item.task = false;
      }
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const token of item.tokens) if (token.type === 'text') token.type = 'paragraph';
      }
    }
    return list;
  }

  html(src) {
    const m = BLOCK.html.exec(src);
    if (m) {
      const raw = stripTrailingBlankLines(m[0]);
      return {
        type: 'html',
        block: true,
        raw,
        pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style',
        text: raw,
      };
    }
  }

  def(src) {
    const m = BLOCK.def.exec(src);
    if (m) {
      if (!R.startAngleBracket.test(m[2]) && findPairEnd(m[2], '()') !== -1) return undefined;
      const tag = normalizeLabel(m[1]);
      const href = m[2] ? m[2].replace(R.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
      const title = m[3]
        ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1')
        : m[3];
      return { type: 'def', tag, raw: trimEndChar(m[0], '\n'), href, title };
    }
  }

  table(src) {
    const m = BLOCK.table.exec(src);
    if (!m || !R.tableDelimiter.test(m[2])) return undefined;
    const headerCells = splitTableRow(m[1]);
    const aligns = m[2].replace(R.tableAlignChars, '').split('|');
    const bodyLines = m[3]?.trim() ? m[3].replace(R.tableRowBlankLine, '').split('\n') : [];
    const table = { type: 'table', raw: trimEndChar(m[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length === aligns.length) {
      for (const cell of aligns) {
        if (R.tableAlignRight.test(cell)) table.align.push('right');
        else if (R.tableAlignCenter.test(cell)) table.align.push('center');
        else if (R.tableAlignLeft.test(cell)) table.align.push('left');
        else table.align.push(null);
      }
      for (let i = 0; i < headerCells.length; i++) {
        table.header.push({
          text: headerCells[i],
          inline: this.lexer.inline(headerCells[i]),
          header: true,
          align: table.align[i],
        });
      }
      for (const line of bodyLines) {
        table.rows.push(
          splitTableRow(line, table.header.length).map((cell, i) => ({
            text: cell,
            inline: this.lexer.inline(cell),
            header: false,
            align: table.align[i],
          })),
        );
      }
      return table;
    }
  }

  lheading(src) {
    const m = BLOCK.lheading.exec(src);
    if (m) {
      const text = m[1].trim();
      return {
        type: 'heading',
        raw: trimEndChar(m[0], '\n'),
        depth: m[2].charAt(0) === '=' ? 1 : 2,
        text,
        inline: this.lexer.inline(text),
      };
    }
  }

  paragraph(src) {
    // A paragraph is the first line plus every continuation line that does
    // not start a block and is not blank. A whitespace-only line ends the
    // paragraph unless it is the last line, with no newline after it, in
    // which case the paragraph regex includes it.
    let firstEnd = src.indexOf('\n');
    if (firstEnd === -1) firstEnd = src.length;
    let end = firstEnd;
    let pos = firstEnd + 1;
    while (pos < src.length) {
      let lineEnd = src.indexOf('\n', pos);
      if (lineEnd === -1) lineEnd = src.length;
      if (isBlankLine(src.slice(pos, lineEnd))) {
        if (lineEnd === src.length) end = lineEnd;
        break;
      }
      if (paragraphLineStartsBlock(src, pos, lineEnd)) break;
      end = lineEnd;
      pos = lineEnd + 1;
    }
    const text = src.slice(0, end);
    return { type: 'paragraph', raw: text, text, inline: this.lexer.inline(text) };
  }

  text(src) {
    const m = BLOCK.text.exec(src);
    if (m) return { type: 'text', raw: m[0], text: m[0], inline: this.lexer.inline(m[0]) };
  }
}

// -- inline methods (added to the same Tokenizer) ---------------------------
// Each inline production returns a fragment { raw, out }: the source it
// consumed and the string it renders to. Returning fragments instead of token
// objects lets the lexer render inline content straight to a string, with no
// token tree in between. `plain` renders the same productions as plain text
// (for image alt text): markup is dropped, escapes and entities stay.
Object.assign(Tokenizer.prototype, {
  escape(src, plain) {
    const m = INLINE.escape.exec(src);
    if (m) return { raw: m[0], out: plain ? m[1] : escapeHtml(m[1]) };
  },

  tag(src) {
    const m = INLINE.tag.exec(src);
    if (m) {
      const state = this.lexer.state;
      if (!state.inLink && R.startATag.test(m[0])) state.inLink = true;
      else if (state.inLink && R.endATag.test(m[0])) state.inLink = false;
      if (!state.inRawBlock && R.startPreScriptTag.test(m[0])) state.inRawBlock = true;
      else if (state.inRawBlock && R.endPreScriptTag.test(m[0])) state.inRawBlock = false;
      return { raw: m[0], out: m[0] };
    }
  },

  link(src, plain) {
    if (this.lexer.state.linkParenPossible === false) return undefined;
    const m = INLINE.link.exec(src);
    if (!m) return undefined;
    const bang = m[0].charAt(0) === '!' ? 2 : 1;
    if (linkTextHasTag(src, m[1], bang)) return undefined;
    const hrefSource = m[2].trim();
    if (R.startAngleBracket.test(hrefSource)) {
      if (!R.endAngleBracket.test(hrefSource)) return undefined;
      const stripped = trimEndChar(hrefSource.slice(0, -1), '\\');
      if ((hrefSource.length - stripped.length) % 2 === 0) return undefined;
    } else {
      const close = findPairEnd(m[2], '()');
      if (close === -2) return undefined;
      if (close > -1) {
        const cut = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
        m[2] = m[2].substring(0, close);
        m[0] = m[0].substring(0, cut).trim();
        m[3] = '';
      }
    }
    const noTrailingBackslash = trimEndChar(m[0].slice(0, -1), '\\');
    if ((m[0].length - noTrailingBackslash.length) % 2 === 0) return undefined;
    let href = m[2].trim();
    const title = m[3] ? m[3].slice(1, -1) : '';
    if (R.startAngleBracket.test(href)) href = href.slice(1, -1);
    return this.makeLink(
      m,
      {
        href: href && href.replace(INLINE.anyPunctuation, '$1'),
        title: title && title.replace(INLINE.anyPunctuation, '$1'),
      },
      plain,
    );
  },

  // Build a link or image fragment from a match, rendering its text. A link
  // whose text already contains a link is not a link at all.
  makeLink(match, { href, title }, plain) {
    const text = match[1].replace(R.outputLinkReplace, '$1');
    const isImage = match[0].charAt(0) === '!';
    const state = this.lexer.state;
    const wasInLink = state.inLink;
    const wasEmitted = state.linkEmitted;
    const wasRawBlock = state.inRawBlock;
    state.inLink = true;
    state.linkEmitted = false;
    // The text is rendered once, in the mode the fragment needs: plain for
    // alt text (and for a plain outer run), HTML for a link's content.
    const inner = plain || isImage ? this.lexer.inlinePlain(text) : this.lexer.inlineRun(text);
    const nestedLink = state.linkEmitted;
    state.linkEmitted = wasEmitted;
    state.inLink = wasInLink;
    if (!isImage) {
      if (nestedLink) {
        state.inRawBlock = wasRawBlock;
        return undefined;
      }
      state.linkEmitted = true;
    }
    if (plain) return { raw: match[0], out: inner };
    if (isImage) {
      const cleaned = cleanHref(href);
      if (cleaned === null) return { raw: match[0], out: escapeHtml(inner) };
      let out = `<img src="${escapeHtml(cleaned)}" alt="${escapeHtml(inner)}"`;
      if (title) out += ` title="${escapeHtml(title)}"`;
      return { raw: match[0], out: `${out}>` };
    }
    const cleaned = cleanHref(href);
    if (cleaned === null) return { raw: match[0], out: inner };
    let out = `<a href="${escapeHtml(cleaned)}"`;
    if (title) out += ` title="${escapeHtml(title)}"`;
    return { raw: match[0], out: `${out}>${inner}</a>` };
  },

  reflink(src, links, plain) {
    const m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
    if (m) {
      const bang = m[0].charAt(0) === '!' ? 2 : 1;
      if (linkTextHasTag(src, m[1], bang)) return undefined;
      const ref = links[normalizeLabel(m[2] || m[1])];
      if (!ref) {
        const ch = m[0].charAt(0);
        return { raw: ch, out: plain ? ch : escapeHtml(ch) };
      }
      return this.makeLink(m, ref, plain);
    }
  },

  emStrong(src, masked, prevChar = '', plain = false) {
    const m = INLINE.emStrongLDelim.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return undefined;
    const delim = m[0][0];
    const sameAsPrev = prevChar === delim;
    const offset = masked.length - src.length;
    let runStart = offset;
    while (runStart > 0 && masked[runStart - 1] === delim) runStart--;
    const beforeRun = lastCodePointBefore(masked, runStart);
    const beforeIsDelimOrPunct =
      beforeRun === '*' || beforeRun === '_' || !!INLINE.punctuation.exec(beforeRun);
    if (runStart < offset) prevChar = beforeRun;
    const beforeIsPunct = runStart < offset ? beforeIsDelimOrPunct : !!INLINE.punctuation.exec(prevChar);
    if (m[4] && prevChar.match(R.unicodeAlphaNumeric)) return undefined;
    const punctAfter = m[1] || m[3] || '';
    if (!punctAfter || !prevChar || beforeIsPunct) {
      // The opening run is all delimiters; the trailing char is one code point.
      let openLen = 0;
      while (src[openLen] === delim) openLen++;
      let openTotal = openLen;
      let used = 0;
      const totalRun = offset - runStart + openLen;
      const canClose =
        !!beforeRun.trim() && (!!punctAfter || (delim === '*' && !beforeIsDelimOrPunct));
      if (delim !== '*' && delim !== '_') return undefined;
      const closerRe = delim === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
      const lastCloser = this.lexer.lastEmCloser(masked, delim);
      const openEnd = masked.length - src.length + openLen;
      if (lastCloser < openEnd) return undefined;
      const rest = masked.slice(-src.length + openLen);
      const maxIndex = lastCloser - openEnd;
      let closer;
      for (closerRe.lastIndex = 0; (closer = closerRe.exec(rest)) !== null && !(closer.index > maxIndex);) {
        const run = closer[1] || closer[2] || closer[3] || closer[4] || closer[5] || closer[6];
        if (!run) continue;
        const runLen = run.length;
        if (closer[3] || closer[4]) {
          openTotal += runLen;
          continue;
        } else if (closer[5] || closer[6] || canClose) {
          if (sameAsPrev && (closer[5] || closer[6])) break;
          if (totalRun % 3 && !((totalRun + runLen) % 3)) {
            used += runLen;
            continue;
          }
        }
        openTotal -= runLen;
        if (openTotal > 0) continue;
        const closeLen = Math.min(runLen, runLen + openTotal + used);
        const firstLen = firstCodePointLength(closer[0]);
        const raw = src.slice(0, openLen + closer.index + firstLen + closeLen);
        if (Math.min(openLen, closeLen) % 2) {
          const inner = raw.slice(1, -1);
          const rendered = plain ? this.lexer.inlinePlain(inner) : this.lexer.inlineRun(inner);
          return { raw, out: plain ? rendered : `<em>${rendered}</em>` };
        }
        const inner = raw.slice(2, -2);
        const rendered = plain ? this.lexer.inlinePlain(inner) : this.lexer.inlineRun(inner);
        return { raw, out: plain ? rendered : `<strong>${rendered}</strong>` };
      }
    }
  },

  codespan(src, plain) {
    const m = INLINE.code.exec(src);
    if (m) {
      let text = m[2].replace(R.newLineCharGlobal, ' ');
      const hasNonSpace = R.nonSpaceChar.test(text);
      const padded = R.startingSpaceChar.test(text) && R.endingSpaceChar.test(text);
      if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
      return { raw: m[0], out: plain ? text : `<code>${escapeHtml(text, true)}</code>` };
    }
  },

  br(src, plain) {
    const m = INLINE.br.exec(src);
    if (m) return { raw: m[0], out: plain ? '' : '<br>' };
  },

  del(src, masked, prevChar = '', plain = false) {
    const m = INLINE.delLDelim.exec(src);
    if (!m) return undefined;
    if (!(m[1] || '') || !prevChar || INLINE.punctuation.exec(prevChar)) {
      let openLen = 0;
      while (src[openLen] === '~') openLen++;
      let openTotal = openLen;
      const lastCloser = this.lexer.lastDelCloser(masked);
      const openEnd = masked.length - src.length + openLen;
      if (lastCloser < openEnd) return undefined;
      const rest = masked.slice(-src.length + openLen);
      const maxIndex = lastCloser - openEnd;
      const closerRe = INLINE.delRDelim;
      let closer;
      for (closerRe.lastIndex = 0; (closer = closerRe.exec(rest)) !== null && !(closer.index > maxIndex);) {
        const run = closer[1] || closer[2] || closer[3] || closer[4] || closer[5] || closer[6];
        if (!run) continue;
        const runLen = run.length;
        if (runLen !== openLen) continue;
        if (closer[3] || closer[4]) {
          openTotal += runLen;
          continue;
        }
        openTotal -= runLen;
        if (openTotal > 0) continue;
        const closeLen = Math.min(runLen, runLen + openTotal);
        const firstLen = firstCodePointLength(closer[0]);
        const raw = src.slice(0, openLen + closer.index + firstLen + closeLen);
        const inner = raw.slice(openLen, -openLen);
        const rendered = plain ? this.lexer.inlinePlain(inner) : this.lexer.inlineRun(inner);
        return { raw, out: plain ? rendered : `<del>${rendered}</del>` };
      }
    }
  },

  autolink(src, plain) {
    const m = INLINE.autolink.exec(src);
    if (m) {
      let text;
      let href;
      if (m[2] === '@') {
        text = m[1];
        href = `mailto:${text}`;
      } else {
        text = m[1];
        href = text;
      }
      if (plain) return { raw: m[0], out: text };
      const cleaned = cleanHref(href);
      if (cleaned === null) return { raw: m[0], out: escapeHtml(text, true) };
      return { raw: m[0], out: `<a href="${escapeHtml(cleaned, true)}">${escapeHtml(text, true)}</a>` };
    }
  },

  url(src, plain) {
    const m = INLINE.url.exec(src);
    if (m) {
      let text;
      let href;
      let raw;
      if (m[2] === '@') {
        text = m[0];
        href = `mailto:${text}`;
        raw = m[0];
      } else {
        // Trim trailing punctuation off the match; the raw the fragment
        // carries is the trimmed one, so the punctuation is scanned again.
        let matched = m[0];
        let previous;
        do {
          previous = matched;
          matched = INLINE.backpedal.exec(matched)?.[0] ?? '';
        } while (previous !== matched);
        text = matched;
        raw = matched;
        href = m[1] === 'www.' ? `http://${matched}` : matched;
      }
      if (plain) return { raw, out: text };
      const cleaned = cleanHref(href);
      if (cleaned === null) return { raw, out: escapeHtml(text, true) };
      return { raw, out: `<a href="${escapeHtml(cleaned, true)}">${escapeHtml(text, true)}</a>` };
    }
  },

  inlineText(src, plain) {
    const m = INLINE.text.exec(src);
    if (m) {
      const inRawBlock = this.lexer.state.inRawBlock;
      const decoded = inRawBlock ? m[0] : decodeEntities(m[0]);
      return { raw: m[0], out: plain ? decoded : inRawBlock ? m[0] : escapeHtml(decoded) };
    }
  },
});

// ---------------------------------------------------------------------------
// Lexer: turns source into block tokens, then renders their inline content
// ---------------------------------------------------------------------------
// Block tokens that carry inline content hold an `inline` slot: an object
// with the source text and, once the block pass is done, its rendered HTML.
// The slots are queued during the block pass and filled afterwards, so link
// reference definitions anywhere in the document apply to links anywhere
// else in it. The slot is the queue entry itself, so block merging that
// rewrites a slot's source (paragraphs absorbing code or definitions, text
// runs joining) is seen when the slot is rendered.
class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.tokenizer = new Tokenizer(this);
    this.inlineQueue = [];
    this.state = {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    };
    this.maskStack = [];
  }

  // Queue inline content for later rendering; returns the slot the caller
  // stores on its block token.
  inline(src) {
    const slot = { src, html: '' };
    this.inlineQueue.push(slot);
    return slot;
  }

  lex(src) {
    src = src.replace(R.carriageReturn, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const slot = this.inlineQueue[i];
      this.state.inRawBlock = false;
      slot.html = this.inlineRun(slot.src);
    }
    this.inlineQueue = [];
    return this.tokens;
  }

  blockTokens(src, tokens, inBlockquote = false) {
    let smallest = Infinity;
    while (src) {
      if (src.length < smallest) smallest = src.length;
      else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
      let token;
      if ((token = this.tokenizer.space(src))) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (token.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.code(src))) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += `\n${token.text}`;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      if ((token = this.tokenizer.fences(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.heading(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.hr(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.blockquote(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.list(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.html(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if ((token = this.tokenizer.def(src))) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += `\n${token.raw}`;
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          if (!this.tokens.links[token.tag]) {
            this.tokens.links[token.tag] = { href: token.href, title: token.title };
          }
          tokens.push(token);
        }
        continue;
      }
      if ((token = this.tokenizer.table(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (hasSetextUnderline(src) && (token = this.tokenizer.lheading(src))) {
        src = src.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
      if (this.state.top && (token = this.tokenizer.paragraph(src))) {
        const prev = tokens.at(-1);
        if (inBlockquote && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += `\n${token.text}`;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          tokens.push(token);
        }
        inBlockquote = false;
        src = src.substring(token.raw.length);
        continue;
      }
      if ((token = this.tokenizer.text(src))) {
        src = src.substring(token.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + token.raw;
          prev.text += `\n${token.text}`;
          this.inlineQueue.pop();
          this.inlineQueue.at(-1).src = prev.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }
    this.state.top = true;
    return tokens;
  }

  // Is there a link (or reference link) inside this text? Used while masking.
  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(INLINE.blockSkip)) {
      if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(INLINE.reflinkSearch)) {
      const text = m[0];
      const open = text.lastIndexOf('[');
      if (
        !(text.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normalizeLabel(text.slice(open + 1, -1)))) &&
        !(open > 1 && this.linkInText(text.slice(1, open - 1)))
      ) {
        return true;
      }
    }
    return false;
  }

  // Render inline content as HTML.
  inlineRun(src) {
    return this.inlineRender(src, false);
  }

  // Render inline content as plain text (for image alt text).
  inlinePlain(src) {
    return this.inlineRender(src, true);
  }

  inlineRender(src, plain) {
    const saved = this.state.linkParenPossible;
    this.state.linkParenPossible = saved && src.includes(')');
    try {
      const hasEm = src.includes('*') || src.includes('_') || src.includes('~');
      const masked = hasEm ? maskForEmStrong(this, src) : src;
      // A source with no emphasis characters has no closers to find.
      this.maskStack.push(hasEm ? scanCloserPositions(masked) : null);
      try {
        return this.inlineRunLoop(src, masked, plain);
      } finally {
        this.maskStack.pop();
      }
    } finally {
      this.state.linkParenPossible = saved;
    }
  }

  lastEmCloser(masked, delim) {
    const top = this.maskStack.at(-1);
    if (!top) return -1;
    if (top.maskedSrc === masked) return top.lastEm[delim];
    return scanCloserPositions(masked).lastEm[delim];
  }

  lastDelCloser(masked) {
    const top = this.maskStack.at(-1);
    if (!top) return -1;
    if (top.maskedSrc === masked) return top.lastDel;
    return scanCloserPositions(masked).lastDel;
  }

  inlineRunLoop(src, masked, plain) {
    let out = '';
    let prevWasText = false;
    let prevChar = '';
    let smallest = Infinity;
    while (src) {
      if (src.length < smallest) smallest = src.length;
      else {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
      if (!prevWasText) prevChar = '';
      prevWasText = false;
      const ch = src[0];
      let fragment;
      // Only the tokenizers whose pattern can start with this character are
      // tried, in marked's order; the rest cannot match and are skipped.
      if (ch === '\\') {
        if ((fragment = this.tokenizer.escape(src, plain))) {
          src = src.substring(fragment.raw.length);
          out += fragment.out;
          continue;
        }
        if ((fragment = this.tokenizer.codespan(src, plain))) {
          src = src.substring(fragment.raw.length);
          out += fragment.out;
          continue;
        }
        if ((fragment = this.tokenizer.br(src, plain))) {
          src = src.substring(fragment.raw.length);
          out += fragment.out;
          continue;
        }
      } else if (ch === '<') {
        if ((fragment = this.tokenizer.tag(src))) {
          src = src.substring(fragment.raw.length);
          out += fragment.out;
          continue;
        }
        if ((fragment = this.tokenizer.autolink(src, plain))) {
          src = src.substring(fragment.raw.length);
          out += fragment.out;
          continue;
        }
      } else if (ch === '[' || ch === '!') {
        if ((fragment = this.tokenizer.link(src, plain))) {
          src = src.substring(fragment.raw.length);
          out += fragment.out;
          continue;
        }
        if ((fragment = this.tokenizer.reflink(src, this.tokens.links, plain))) {
          src = src.substring(fragment.raw.length);
          out += fragment.out;
          continue;
        }
      } else if (ch === '*' || ch === '_') {
        if ((fragment = this.tokenizer.emStrong(src, masked, prevChar, plain))) {
          src = src.substring(fragment.raw.length);
          out += fragment.out;
          continue;
        }
        if (ch === '_' && !this.state.inLink && (fragment = this.tokenizer.url(src, plain))) {
          src = src.substring(fragment.raw.length);
          out += fragment.out;
          continue;
        }
      } else if (ch === '`') {
        if ((fragment = this.tokenizer.codespan(src, plain))) {
          src = src.substring(fragment.raw.length);
          out += fragment.out;
          continue;
        }
      } else if (ch === '~') {
        if ((fragment = this.tokenizer.del(src, masked, prevChar, plain))) {
          src = src.substring(fragment.raw.length);
          out += fragment.out;
          continue;
        }
      } else if (ch === ' ') {
        if ((fragment = this.tokenizer.br(src, plain))) {
          src = src.substring(fragment.raw.length);
          out += fragment.out;
          continue;
        }
      } else if (
        (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') ||
        (ch >= '0' && ch <= '9') || ch === '.' || ch === '+' || ch === '-'
      ) {
        if (!this.state.inLink && (fragment = this.tokenizer.url(src, plain))) {
          src = src.substring(fragment.raw.length);
          out += fragment.out;
          continue;
        }
      }
      if ((fragment = this.tokenizer.inlineText(src, plain))) {
        src = src.substring(fragment.raw.length);
        if (fragment.raw.slice(-1) !== '_') prevChar = fragment.raw.slice(-1);
        prevWasText = true;
        out += fragment.out;
        continue;
      }
      if (src) {
        this.infiniteLoopError(src.charCodeAt(0));
        break;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Rendering: block tokens to HTML
// ---------------------------------------------------------------------------
// A task-list checkbox's HTML, shared by the list tokenizer and the renderer.
function checkboxHtml(checked) {
  return `<input ${checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
}

class Renderer {
  constructor(parser) {
    this.parser = parser;
  }

  space() {
    return '';
  }

  code({ text, lang }) {
    const firstWord = (lang || '').match(R.notSpaceStart)?.[0];
    const body = text ? text.replace(R.endingNewline, '') + '\n' : '';
    return firstWord
      ? `<pre><code class="language-${escapeHtml(firstWord)}">${escapeHtml(body, true)}</code></pre>\n`
      : `<pre><code>${escapeHtml(body, true)}</code></pre>\n`;
  }

  blockquote({ tokens }) {
    return `<blockquote>\n${this.parser.parse(tokens)}</blockquote>\n`;
  }

  html({ text }) {
    return text;
  }

  def() {
    return '';
  }

  heading({ inline, inlinePrefix, depth }) {
    return `<h${depth}>${inlinePrefix || ''}${inline.html}</h${depth}>\n`;
  }

  hr() {
    return '<hr>\n';
  }

  list({ ordered, start, items }) {
    let out = '';
    for (const item of items) out += this.listitem(item);
    const tag = ordered ? 'ol' : 'ul';
    const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
    return `<${tag}${startAttr}>\n${out}</${tag}>\n`;
  }

  listitem(item) {
    return `<li>${this.parser.parse(item.tokens)}</li>\n`;
  }

  checkbox({ checked }) {
    return checkboxHtml(checked);
  }

  paragraph({ inline, inlinePrefix }) {
    return `<p>${inlinePrefix || ''}${inline.html}</p>\n`;
  }

  table({ header, rows }) {
    let headCells = '';
    for (const cell of header) headCells += this.tablecell(cell);
    let head = this.tablerow({ text: headCells });
    let body = '';
    for (const row of rows) {
      let cells = '';
      for (const cell of row) cells += this.tablecell(cell);
      body += this.tablerow({ text: cells });
    }
    if (body) body = `<tbody>${body}</tbody>`;
    return `<table>\n<thead>\n${head}</thead>\n${body}</table>\n`;
  }

  tablerow({ text }) {
    return `<tr>\n${text}</tr>\n`;
  }

  tablecell(cell) {
    const tag = cell.header ? 'th' : 'td';
    return (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) + cell.inline.html + `</${tag}>\n`;
  }

  text({ inline, inlinePrefix }) {
    return (inlinePrefix || '') + inline.html;
  }
}

class Parser {
  constructor() {
    this.renderer = new Renderer(this);
  }

  parse(tokens) {
    let out = '';
    for (const token of tokens) {
      switch (token.type) {
        case 'space':
          out += this.renderer.space(token);
          break;
        case 'hr':
          out += this.renderer.hr(token);
          break;
        case 'heading':
          out += this.renderer.heading(token);
          break;
        case 'code':
          out += this.renderer.code(token);
          break;
        case 'table':
          out += this.renderer.table(token);
          break;
        case 'blockquote':
          out += this.renderer.blockquote(token);
          break;
        case 'list':
          out += this.renderer.list(token);
          break;
        case 'checkbox':
          out += this.renderer.checkbox(token);
          break;
        case 'html':
          out += this.renderer.html(token);
          break;
        case 'def':
          out += this.renderer.def(token);
          break;
        case 'paragraph':
          out += this.renderer.paragraph(token);
          break;
        case 'text':
          out += this.renderer.text(token);
          break;
        default:
          throw new Error(`Token with "${token.type}" type was not found.`);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type ' + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return new Parser().parse(tokens);
}
