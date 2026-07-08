import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@renderer/lib/utils';
import { interpolateMentions, type MentionAgent } from '@renderer/components/chat/mentions';

/**
 * Renderizador de Markdown estruturado e legível — headings hierárquicos,
 * código mono com fundo, listas, checkboxes (GFM task lists), tabelas,
 * blockquote, etc. Usado em descrição de issue, comentários e onde precisar
 * de MD bonito. Texto base em `text-secondary` pra não "lavar" tudo de branco.
 *
 * `mentionAgents`: quando passado, `@<nome de agente>` em parágrafos/itens vira
 * a chip visual com avatar (igual ao chat) — usado nos comentários de issue.
 */
export function Markdown({
  children,
  className,
  mentionAgents,
}: {
  children: string | null | undefined;
  className?: string;
  mentionAgents?: MentionAgent[];
}) {
  if (!children) return null;
  return (
    <div
      className={cn(
        'flex flex-col gap-3 text-[13px] leading-relaxed text-text-secondary',
        // Listas de tarefa (GFM): sem o bullet padrão da <ul>
        '[&_ul.contains-task-list]:ml-1 [&_ul.contains-task-list]:list-none',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className: cls, children: ch, ...props }) {
            const raw = String(ch ?? '').replace(/\n$/, '');
            const langMatch = /language-(\w+)/.exec(cls ?? '');
            const isBlock = (langMatch || raw.includes('\n')) && !('inline' in props);
            if (isBlock) {
              return (
                <pre className="thin-scrollbar overflow-x-auto rounded-lg border border-hairline bg-black/30 p-3">
                  <code className="font-mono text-[12px] leading-relaxed text-text-primary">
                    {raw}
                  </code>
                </pre>
              );
            }
            return (
              <code className="whitespace-pre-wrap break-words rounded bg-accent-purple/[0.12] px-1 py-0.5 font-mono text-[12px] text-accent-purple [box-decoration-break:clone]">
                {ch}
              </code>
            );
          },
          pre({ children: ch }) {
            return <>{ch}</>;
          },
          p({ children: ch }) {
            return (
              <p className="break-words leading-relaxed">
                {interpolateMentions(ch, mentionAgents)}
              </p>
            );
          },
          h1({ children: ch }) {
            return (
              <h1 className="mt-3 text-[17px] font-semibold tracking-tight text-text-primary">
                {ch}
              </h1>
            );
          },
          h2({ children: ch }) {
            return (
              <h2 className="mt-3 border-b border-hairline pb-1 text-[15px] font-semibold tracking-tight text-text-primary">
                {ch}
              </h2>
            );
          },
          h3({ children: ch }) {
            return (
              <h3 className="mt-2 text-[13.5px] font-semibold tracking-tight text-text-primary">
                {ch}
              </h3>
            );
          },
          h4({ children: ch }) {
            return <h4 className="mt-1.5 text-[13px] font-semibold text-text-primary">{ch}</h4>;
          },
          ul({ children: ch }) {
            return <ul className="ml-5 list-disc space-y-1 marker:text-text-faint">{ch}</ul>;
          },
          ol({ children: ch }) {
            return <ol className="ml-5 list-decimal space-y-1 marker:text-text-faint">{ch}</ol>;
          },
          li({ children: ch, className: liCls }) {
            // Item de task list (GFM): sem bullet; o checkbox flui inline com o
            // texto (NÃO usar flex — flex separa código/texto em colunas).
            if ((liCls ?? '').includes('task-list-item')) {
              return (
                <li className="list-none leading-relaxed [&>p]:m-0">
                  {interpolateMentions(ch, mentionAgents)}
                </li>
              );
            }
            return (
              <li className="leading-relaxed [&>p]:m-0">
                {interpolateMentions(ch, mentionAgents)}
              </li>
            );
          },
          input({ checked, type }) {
            if (type !== 'checkbox') return null;
            return (
              <span
                className={cn(
                  'mr-1.5 inline-grid h-3.5 w-3.5 place-items-center rounded border align-[-2px] text-[9px] leading-none',
                  checked
                    ? 'border-accent-green/40 bg-accent-green/20 text-accent-green'
                    : 'border-hairline-ultra text-transparent',
                )}
              >
                {checked ? '✓' : ''}
              </span>
            );
          },
          a({ href, children: ch }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent-blue underline underline-offset-2 hover:text-accent-blue/80"
              >
                {ch}
              </a>
            );
          },
          blockquote({ children: ch }) {
            return (
              <blockquote className="border-l-2 border-accent-purple/40 pl-3 text-text-muted">
                {ch}
              </blockquote>
            );
          },
          table({ children: ch }) {
            return (
              <div className="thin-scrollbar overflow-x-auto rounded-lg border border-hairline">
                <table className="w-full border-collapse text-[12.5px]">{ch}</table>
              </div>
            );
          },
          thead({ children: ch }) {
            return <thead className="bg-surface-hover">{ch}</thead>;
          },
          th({ children: ch }) {
            return (
              <th className="px-2.5 py-1.5 text-left font-semibold text-text-primary">{ch}</th>
            );
          },
          td({ children: ch }) {
            return <td className="border-t border-hairline-faint px-2.5 py-1.5">{ch}</td>;
          },
          hr() {
            return <hr className="my-1 border-hairline" />;
          },
          strong({ children: ch }) {
            return <strong className="font-semibold text-text-primary">{ch}</strong>;
          },
          em({ children: ch }) {
            return <em>{ch}</em>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
