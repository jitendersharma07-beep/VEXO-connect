// Column layout for a fixed-width thermal line, and the ASCII fold that keeps
// unrepresentable characters from printing as somebody else's glyph.
//
// Why fold at all: the browser path rasterises the receipt, so `₹`, `é` and `—`
// come out as themselves. The agent prints in ESC/POS *text* mode, where a byte
// above 0x7F means whatever the printer's currently selected code page says it
// means — and that page varies by unit and by firmware. Sending UTF-8 through
// unchanged does not print `₹`; it prints two arbitrary glyphs. So every string
// is folded to 7-bit before it becomes bytes, and anything with no sensible
// ASCII spelling becomes `?` — visible damage rather than silent damage, which
// is the difference between an operator reporting a bug and an operator
// believing the receipt.

const FOLD = new Map(Object.entries({
  '₹': 'Rs.', '₨': 'Rs.', '€': 'EUR', '£': 'GBP', '¥': 'JPY',
  'á': 'a', 'à': 'a', 'â': 'a', 'ä': 'a', 'ã': 'a', 'å': 'a', 'ā': 'a',
  'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e', 'ē': 'e',
  'í': 'i', 'ì': 'i', 'î': 'i', 'ï': 'i', 'ī': 'i',
  'ó': 'o', 'ò': 'o', 'ô': 'o', 'ö': 'o', 'õ': 'o', 'ō': 'o', 'ø': 'o',
  'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u', 'ū': 'u',
  'ñ': 'n', 'ç': 'c', 'ß': 'ss', 'æ': 'ae', 'œ': 'oe',
  'Á': 'A', 'À': 'A', 'Â': 'A', 'Ä': 'A', 'Ã': 'A', 'Å': 'A',
  'É': 'E', 'È': 'E', 'Ê': 'E', 'Ë': 'E',
  'Í': 'I', 'Ì': 'I', 'Î': 'I', 'Ï': 'I',
  'Ó': 'O', 'Ò': 'O', 'Ô': 'O', 'Ö': 'O', 'Õ': 'O', 'Ø': 'O',
  'Ú': 'U', 'Ù': 'U', 'Û': 'U', 'Ü': 'U',
  'Ñ': 'N', 'Ç': 'C',
  '—': '-', '–': '-', '‒': '-', '―': '-', '−': '-',
  '‘': "'", '’': "'", '‚': "'", '‹': '<', '›': '>',
  '“': '"', '”': '"', '„': '"', '«': '<<', '»': '>>',
  '·': '.', '•': '*', '…': '...', '′': "'", '″': '"',
  '×': 'x', '÷': '/', '±': '+/-', '°': 'deg', '©': '(c)', '®': '(r)', '™': '(tm)',
  '½': '1/2', '¼': '1/4', '¾': '3/4', ' ': ' ', '​': '',
}));

// Combining marks left behind by NFD decomposition — dropped, not replaced, so
// "Café" normalises to "Cafe" and not "Cafe?".
const COMBINING = /[̀-ͯ]/g;

export const fold = (input) => {
  const s = String(input ?? '');
  let out = '';
  for (const ch of s.normalize('NFC')) {
    if (ch >= ' ' && ch <= '~') { out += ch; continue; }
    const mapped = FOLD.get(ch);
    if (mapped !== undefined) { out += mapped; continue; }
    const decomposed = ch.normalize('NFD').replace(COMBINING, '');
    if (decomposed && decomposed >= ' ' && decomposed <= '~') { out += decomposed; continue; }
    out += ch === '\n' || ch === '\t' ? ch : '?';
  }
  return out;
};

// en-IN grouping with two decimals, to match frontend/src/lib/pos.js so the two
// print paths cannot disagree about what a number looks like. The symbol is
// separated out because `₹` has no dependable ESC/POS code point.
export const money = (n, symbol = 'Rs.') => {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return `${symbol}0.00`;
  const neg = v < 0;
  const [whole, paise] = Math.abs(v).toFixed(2).split('.');
  // Indian grouping: last three digits, then pairs.
  const head = whole.length > 3 ? whole.slice(0, -3) : '';
  const tail = whole.slice(-3);
  const grouped = (head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},` : '') + tail;
  return `${neg ? '-' : ''}${symbol}${grouped}.${paise}`;
};

export const wrap = (text, width) => {
  const out = [];
  for (const para of fold(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) {
        line = word;
      } else if (line.length + 1 + word.length <= width) {
        line += ` ${word}`;
      } else {
        out.push(line);
        line = word;
      }
      // A single token longer than the roll — an SKU or a URL — is cut into
      // width-sized pieces rather than allowed to run off the paper.
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
};

export const center = (text, width) =>
  wrap(text, width).map((l) => {
    const pad = Math.max(0, Math.floor((width - l.length) / 2));
    return ' '.repeat(pad) + l;
  });

export const rule = (width, ch = '-') => ch.repeat(width);

// Left text with a right-aligned amount. The amount is never wrapped or
// truncated and never shares a line with text it would collide with: if the
// left side is too long it wraps, and the amount stays on the FIRST line, which
// is where a reader looks for it.
export const columns = (left, right, width, indent = 0) => {
  const amount = fold(right ?? '');
  const room = Math.max(1, width - amount.length - 1 - indent);
  const lines = wrap(left, room);
  const pre = ' '.repeat(indent);
  const first = pre + lines[0];
  const gap = Math.max(1, width - first.length - amount.length);
  return [first + ' '.repeat(gap) + amount, ...lines.slice(1).map((l) => pre + l)];
};

export const trimLines = (lines) => {
  const out = [...lines];
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
};
