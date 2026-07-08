import { useMemo, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useT } from '@renderer/i18n';

interface CodeBlockProps {
  code: string;
  lang?: string;
}

/**
 * Code block com syntax highlighting básico via regex.
 * Suporta JS/TS, Python, JSON, bash. Sem libs pesadas — usa só regex
 * tokenization e palette pequena (similar ao tema "One Dark").
 */
export function CodeBlock({ code, lang }: CodeBlockProps) {
  const { t } = useT();
  const lower = (lang ?? '').toLowerCase();
  const flavor =
    lower === 'ts' ||
    lower === 'tsx' ||
    lower === 'js' ||
    lower === 'jsx' ||
    lower === 'javascript' ||
    lower === 'typescript'
      ? 'js'
      : lower === 'py' || lower === 'python'
        ? 'py'
        : lower === 'json'
          ? 'json'
          : lower === 'sh' || lower === 'bash' || lower === 'zsh' || lower === 'shell'
            ? 'sh'
            : null;

  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      console.error('[copy] falhou', err);
    }
  }

  const html = useMemo(() => highlight(code, flavor), [code, flavor]);

  return (
    <div className="group/code relative overflow-hidden rounded-lg border border-hairline bg-[#0d0e10]">
      {/* Header com lang + copy */}
      <div className="flex items-center justify-between border-b border-hairline-soft px-3 py-1.5">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.15em] text-text-faint">
          {lang || t('chat.code.fallbackLang')}
        </span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-6 items-center gap-1 rounded px-1.5 text-[10.5px] text-text-muted opacity-0 transition-all hover:bg-surface-active hover:text-text-primary group-hover/code:opacity-100"
        >
          {copied ? <Check className="h-3 w-3 text-accent-green" /> : <Copy className="h-3 w-3" />}
          {copied ? t('chat.code.copied') : t('chat.code.copy')}
        </button>
      </div>
      <pre className="no-scrollbar overflow-x-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-[12.5px] leading-relaxed">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}

/**
 * Tokenizer regex-based. Substitui matches por <span class="hl-X"> e
 * escapa o restante. Não é perfeito mas é leve e produz resultado bom o
 * suficiente pra uma UI de chat.
 */
function highlight(code: string, flavor: 'js' | 'py' | 'json' | 'sh' | null): string {
  if (!flavor) return escapeHtml(code);

  type Range = { start: number; end: number; cls: string };
  const ranges: Range[] = [];

  function addAll(re: RegExp, cls: string) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length, cls });
      if (m.index === re.lastIndex) re.lastIndex++; // safety
    }
  }

  // Comentários primeiro (têm prioridade)
  if (flavor === 'js') {
    addAll(/\/\/[^\n]*/g, 'hl-comment');
    addAll(/\/\*[\s\S]*?\*\//g, 'hl-comment');
  } else if (flavor === 'py') {
    addAll(/#[^\n]*/g, 'hl-comment');
  } else if (flavor === 'sh') {
    addAll(/#[^\n]*/g, 'hl-comment');
  }

  // Strings (mata greedy mas suficiente)
  addAll(/"(?:[^"\\]|\\.)*"/g, 'hl-string');
  addAll(/'(?:[^'\\]|\\.)*'/g, 'hl-string');
  if (flavor === 'js') addAll(/`(?:[^`\\]|\\.)*`/g, 'hl-string');

  // Números
  addAll(/\b\d+(?:\.\d+)?\b/g, 'hl-number');

  // Keywords por flavor
  if (flavor === 'js') {
    addAll(
      /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|as|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|null|true|false|undefined|this|super|void)\b/g,
      'hl-keyword',
    );
    // Tipos comuns (TS-friendly)
    addAll(
      /\b(string|number|boolean|any|unknown|never|void|object|Array|Promise|Record|Map|Set)\b/g,
      'hl-type',
    );
    // Function calls — identifier seguido de (
    addAll(/\b([A-Za-z_][A-Za-z0-9_]*)(?=\s*\()/g, 'hl-func');
  } else if (flavor === 'py') {
    addAll(
      /\b(def|class|return|if|elif|else|for|while|in|not|and|or|is|None|True|False|import|from|as|with|try|except|finally|raise|pass|break|continue|lambda|yield|global|nonlocal|async|await)\b/g,
      'hl-keyword',
    );
    addAll(/\b([A-Za-z_][A-Za-z0-9_]*)(?=\s*\()/g, 'hl-func');
  } else if (flavor === 'json') {
    addAll(/\b(true|false|null)\b/g, 'hl-keyword');
  } else if (flavor === 'sh') {
    addAll(
      /\b(if|then|else|fi|for|in|do|done|while|case|esac|function|return|exit|export|local|echo|cd)\b/g,
      'hl-keyword',
    );
    addAll(/\$[A-Za-z_][A-Za-z0-9_]*|\$\{[^}]+\}/g, 'hl-var');
  }

  // Resolve overlaps: ordena por start asc + length desc; descarta os que
  // estão DENTRO de um range já adicionado.
  ranges.sort((a, b) => (a.start !== b.start ? a.start - b.start : b.end - a.end));
  const accepted: Range[] = [];
  let cursor = -1;
  for (const r of ranges) {
    if (r.start < cursor) continue;
    accepted.push(r);
    cursor = r.end;
  }

  // Constrói HTML
  let out = '';
  let pos = 0;
  for (const r of accepted) {
    if (r.start > pos) out += escapeHtml(code.slice(pos, r.start));
    out += `<span class="${r.cls}">${escapeHtml(code.slice(r.start, r.end))}</span>`;
    pos = r.end;
  }
  if (pos < code.length) out += escapeHtml(code.slice(pos));
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
