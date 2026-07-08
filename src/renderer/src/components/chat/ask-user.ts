import type { ChatMessage } from '@shared/types';

export interface AskUserOption {
  label: string;
  description?: string;
}
export interface AskUserQuestion {
  id: string;
  question: string;
  options: AskUserOption[];
  allowOther: boolean;
}
export interface AskUserPayload {
  intro?: string;
  questions: AskUserQuestion[];
}

const ASK_USER_RE = /<orkestral:ask-user[^>]*>([\s\S]*?)<\/orkestral:ask-user>/gi;

// Marcador da mensagem de respostas do wizard. O CEO lê o texto (decisões em
// linguagem natural), mas a bolha é ESCONDIDA do chat (MessageList filtra), pra
// não aparecer um "Minhas decisões" cru. As decisões viram um card no wizard.
export const PLANNING_DECISIONS_HIDDEN = '[[PLANNING_DECISIONS_HIDDEN]]';

/**
 * A mensagem de respostas do wizard deve sumir do chat (roda oculta por trás). Pega
 * tanto as novas (com o marker) quanto as LEGADAS, enviadas antes do marker existir,
 * que começam com o cabeçalho de decisões, pra limpar sessões antigas também.
 */
export function isHiddenPlanningMessage(text: string): boolean {
  if (text.includes(PLANNING_DECISIONS_HIDDEN)) return true;
  return /^\s*(Minhas decis[õo]es|My decisions)\s*:/i.test(text);
}

// O usuário odeia em-dash (—). O modelo às vezes coloca um na descrição/pergunta;
// trocamos por vírgula no que é exibido, pra garantir o estilo independente do CEO.
const clean = (s: string): string => s.replace(/\s*—\s*/g, ', ').trim();

function normalizeOption(raw: unknown): AskUserOption | null {
  if (typeof raw === 'string') {
    const label = clean(raw);
    return label ? { label } : null;
  }
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    // O CEO pode emitir a opção como string ou como objeto {label|value, description}.
    const label =
      typeof o.label === 'string'
        ? clean(o.label)
        : typeof o.value === 'string'
          ? clean(o.value)
          : '';
    if (!label) return null;
    const description = typeof o.description === 'string' ? clean(o.description) : undefined;
    return { label, description };
  }
  return null;
}

function normalizePayload(raw: unknown): AskUserPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.questions)) return null;
  const questions: AskUserQuestion[] = [];
  o.questions.forEach((q, i) => {
    if (!q || typeof q !== 'object') return;
    const qo = q as Record<string, unknown>;
    const question = typeof qo.question === 'string' ? clean(qo.question) : '';
    if (!question) return;
    const options = Array.isArray(qo.options)
      ? qo.options.map(normalizeOption).filter((x): x is AskUserOption => x !== null)
      : [];
    const id = typeof qo.id === 'string' && qo.id.trim() ? qo.id.trim() : `q${i + 1}`;
    // "Escreva a sua" fica disponível por padrão (escape hatch), some só se o CEO
    // mandar allowOther:false explicitamente.
    questions.push({ id, question, options, allowOther: qo.allowOther !== false });
  });
  if (questions.length === 0) return null;
  const intro = typeof o.intro === 'string' && o.intro.trim() ? clean(o.intro) : undefined;
  return { intro, questions };
}

/**
 * Extrai o bloco `<orkestral:ask-user>` (JSON com perguntas+opções) do texto do
 * assistant e devolve o payload normalizado + o texto SEM o bloco. Só dispara em
 * mensagem do assistant; JSON malformado vira `null` (sem deixar o bloco cru
 * aparecer). O stream parcial já é escondido pelo `orkestralComponentCut`.
 */
export function parseAskUserBlock(
  text: string,
  role: ChatMessage['role'],
): { payload: AskUserPayload | null; cleanedText: string } {
  // Guard case-insensitive pra bater com o regex /gi: uma tag em maiúsculas
  // (<ORKESTRAL:ASK-USER>) não pode escapar daqui e vazar o JSON cru no chat.
  if (!text.toLowerCase().includes('<orkestral:ask-user'))
    return { payload: null, cleanedText: text };
  let payload: AskUserPayload | null = null;
  const cleanedText = text
    .replace(ASK_USER_RE, (_full, body: string) => {
      if (role === 'assistant' && !payload) {
        try {
          payload = normalizePayload(JSON.parse(String(body).trim()));
        } catch {
          // JSON malformado: não renderiza o wizard, mas o bloco cru também não vaza.
        }
      }
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { payload, cleanedText };
}

// --- Persistência do wizard (sobrevive reload) + detecção na sessão ---------

export type PersistedWizard = { outcome: 'sent' | 'skipped'; answers: Record<string, string> };

const WIZARD_STORAGE_PREFIX = 'orkestral:planning-wizard:';

/** Chave ESTÁVEL por sessão + conjunto de perguntas (hash). Não muda entre
 *  re-renders, pra o wizard não reabrir na "Pergunta 1" depois de respondido. */
export function wizardKey(sessionId: string, payload: AskUserPayload): string {
  const raw = sessionId + '|' + payload.questions.map((q) => q.id + ':' + q.question).join('|');
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (Math.imul(h, 31) + raw.charCodeAt(i)) | 0;
  return `${sessionId}:${h}`;
}

export function readWizardPersisted(key: string): PersistedWizard | null {
  try {
    const raw = localStorage.getItem(WIZARD_STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedWizard>;
    if (parsed?.outcome === 'sent' || parsed?.outcome === 'skipped') {
      return { outcome: parsed.outcome, answers: parsed.answers ?? {} };
    }
  } catch {
    // localStorage indisponível ou JSON inválido: trata como não-resolvido.
  }
  return null;
}

export function writeWizardPersisted(key: string, data: PersistedWizard): void {
  try {
    localStorage.setItem(WIZARD_STORAGE_PREFIX + key, JSON.stringify(data));
  } catch {
    // sem persistência: o estado em memória ainda vale nesta sessão.
  }
}

export function clearWizardPersisted(key: string): void {
  try {
    localStorage.removeItem(WIZARD_STORAGE_PREFIX + key);
  } catch {
    // ignore
  }
}

/** Já resolveu (respondeu ou pulou) este conjunto de perguntas? */
export function isWizardResolved(sessionId: string, payload: AskUserPayload): boolean {
  return readWizardPersisted(wizardKey(sessionId, payload)) !== null;
}

/** Último bloco <orkestral:ask-user> emitido na sessão (o wizard ativo), ou null. */
export function findLatestAskUserPayload(messages: ChatMessage[]): AskUserPayload | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const part = m.parts.find((p) => p.type === 'text');
    const text = part?.type === 'text' ? part.text : '';
    const { payload } = parseAskUserBlock(text, m.role);
    if (payload) return payload;
  }
  return null;
}
