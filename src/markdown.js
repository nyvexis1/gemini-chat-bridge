// Converts Gemini's rendered reply back into markdown.
//
// This function is serialised and executed inside the page, so it must be
// fully self-contained: no imports, no references to outer variables.

export function domToMarkdown(root) {
  const SKIP_TAGS = new Set(['BUTTON', 'MAT-ICON', 'SVG', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SOURCES-CAROUSEL-INLINE']);
  const SKIP_CLASSES = ['code-block-decoration', 'cdk-visually-hidden', 'response-footer', 'source-footnote'];

  function skip(el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    for (const c of SKIP_CLASSES) if (el.classList && el.classList.contains(c)) return true;
    return false;
  }

  function codeLang(el) {
    const host = el.closest('code-block') || el.parentElement;
    const deco = host && host.querySelector('.code-block-decoration');
    if (deco) {
      const label = (deco.querySelector('span') || deco).textContent.trim();
      if (label && label.length < 30 && !/\s/.test(label)) return label.toLowerCase();
    }
    const code = el.tagName === 'CODE' ? el : el.querySelector('code');
    const cls = code && [...code.classList].find((c) => c.startsWith('language-'));
    return cls ? cls.slice('language-'.length) : '';
  }

  // Code blocks are swapped for placeholders so whitespace cleanup below can't touch them.
  const blocks = [];
  function fence(el) {
    const code = el.querySelector('code') || el;
    const text = code.textContent.replace(/\n$/, '');
    const ticks = text.includes('```') ? '````' : '```';
    blocks.push(`${ticks}${codeLang(el)}\n${text}\n${ticks}`);
    return `\n\n\u0000${blocks.length - 1}\u0000\n\n`;
  }

  function inline(el) {
    let out = '';
    for (const n of el.childNodes) out += walk(n, 0);
    return out;
  }

  function list(el, depth, ordered) {
    let i = Number(el.getAttribute('start') || 1);
    let out = '\n';
    for (const li of el.children) {
      if (li.tagName !== 'LI') continue;
      const marker = ordered ? `${i++}. ` : '- ';
      // Indentation is relative: nested lists get indented by the enclosing item.
      const body = blockChildren(li, depth + 1).trim().replace(/\n/g, '\n' + ' '.repeat(marker.length));
      out += marker + body + '\n';
    }
    return out + '\n';
  }

  function table(el) {
    const rows = [...el.querySelectorAll('tr')].map((tr) =>
      [...tr.children].map((c) => inline(c).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()),
    );
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r) => [...r, ...Array(width - r.length).fill('')];
    const lines = [`| ${pad(rows[0]).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`];
    for (const r of rows.slice(1)) lines.push(`| ${pad(r).join(' | ')} |`);
    return `\n\n${lines.join('\n')}\n\n`;
  }

  function blockChildren(el, depth) {
    let out = '';
    for (const n of el.childNodes) out += walk(n, depth);
    return out;
  }

  function walk(node, depth) {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    const el = node;
    if (skip(el)) return '';
    const tag = el.tagName;

    if (tag === 'CODE-BLOCK') {
      const pre = el.querySelector('pre');
      return pre ? fence(pre) : '';
    }
    if (tag === 'PRE') return fence(el);

    switch (tag) {
      case 'BR':
        return '\n';
      case 'HR':
        return '\n\n---\n\n';
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6':
        return `\n\n${'#'.repeat(Number(tag[1]))} ${inline(el).trim()}\n\n`;
      case 'P':
        return `\n\n${inline(el)}\n\n`;
      case 'STRONG':
      case 'B': {
        const t = inline(el);
        return t.trim() ? `**${t}**` : t;
      }
      case 'EM':
      case 'I': {
        const t = inline(el);
        return t.trim() ? `*${t}*` : t;
      }
      case 'DEL':
      case 'S':
        return `~~${inline(el)}~~`;
      case 'CODE': {
        const t = el.textContent;
        return t.includes('`') ? `\`\` ${t} \`\`` : `\`${t}\``;
      }
      case 'A': {
        const t = inline(el);
        const href = el.getAttribute('href');
        return href && !href.startsWith('javascript:') && t.trim() ? `[${t}](${href})` : t;
      }
      case 'UL':
        return list(el, depth, false);
      case 'OL':
        return list(el, depth, true);
      case 'TABLE':
        return table(el);
      case 'BLOCKQUOTE':
        return '\n\n' + blockChildren(el, depth).trim().replace(/^/gm, '> ') + '\n\n';
      case 'IMG': {
        const alt = el.getAttribute('alt') || '';
        const src = el.getAttribute('src') || '';
        return src ? `![${alt}](${src})` : '';
      }
      case 'DIV':
      case 'SECTION':
      case 'ARTICLE':
        return `\n${blockChildren(el, depth)}\n`;
      default:
        return blockChildren(el, depth);
    }
  }

  return walk(root, 0)
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}
