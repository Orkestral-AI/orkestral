import type { ChatMessage, MessagePart } from '../../shared/types';
import {
  SessionContextRepository,
  type SessionContextSnapshot,
} from '../db/repositories/session-context.repo';
import { MessageRepository } from '../db/repositories/message.repo';
import { trace } from './log-bus';

const RECENT_TURNS_TO_KEEP = 12;
const MIN_COMPACTABLE_TURNS = 24;
const CONTEXT_TOKEN_BUDGET = 1_000_000;
const COMPACT_AT_CONTEXT_RATIO = 0.8;
const COMPACT_AT_TOKEN_ESTIMATE = Math.floor(CONTEXT_TOKEN_BUDGET * COMPACT_AT_CONTEXT_RATIO);
const FORCE_COMPACT_AT_TOKEN_ESTIMATE = CONTEXT_TOKEN_BUDGET;
const MAX_SUMMARY_CHARS = 8000;
const MAX_BULLETS_PER_SECTION = 8;

const contextRepo = new SessionContextRepository();
const messageRepo = new MessageRepository();

interface CompactableTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

interface CompactionCandidate {
  turns: CompactableTurn[];
  compactedTurns: CompactableTurn[];
  totalChars: number;
  totalTokens: number;
  lastMessageId: string | null;
  shouldCompact: boolean;
  reason: 'below-budget' | 'soft-budget' | 'hard-budget' | 'already-current' | 'too-few-turns';
}

export interface SessionCompactionResult {
  snapshot: SessionContextSnapshot;
  created: boolean;
}

export function getSessionContextSnapshot(sessionId: string): SessionContextSnapshot | null {
  return contextRepo.getBySession(sessionId);
}

export function buildCompactedContextBlock(sessionId: string): string {
  const snapshot = contextRepo.getBySession(sessionId);
  if (!snapshot?.summary.trim()) return '';
  return [
    '## Compacted conversation context',
    '',
    'This is the stable handoff memory for this chat. Use it together with the recent turns below.',
    'It exists so Orkestral can switch between Forge local and the selected CLI without losing decisions, goals or execution state.',
    '',
    snapshot.summary.trim(),
  ].join('\n');
}

export function shouldCompactSessionContext(input: {
  sessionId: string;
  excludeMessageId?: string | null;
}): boolean {
  return analyzeCompactionCandidate(input.sessionId, input.excludeMessageId).shouldCompact;
}

export function maybeCompactSessionContext(input: {
  sessionId: string;
  workspaceId: string;
  excludeMessageId?: string | null;
}): SessionCompactionResult | null {
  const candidate = analyzeCompactionCandidate(input.sessionId, input.excludeMessageId);
  if (!candidate.shouldCompact) return null;

  const previous = contextRepo.getBySession(input.sessionId);
  if (previous?.lastMessageId === candidate.lastMessageId) {
    return { snapshot: previous, created: false };
  }

  const summary = buildExtractiveSummary(candidate.compactedTurns);
  const charCount = candidate.compactedTurns.reduce((sum, turn) => sum + turn.text.length, 0);
  const snapshot = contextRepo.upsert({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    summary,
    messageCount: candidate.compactedTurns.length,
    charCount,
    tokenEstimate: estimateTokens(charCount),
    lastMessageId: candidate.lastMessageId,
  });

  trace({
    level: 'success',
    source: 'chat',
    scope: 'context',
    workspaceId: input.workspaceId,
    message: `[compact] session=${input.sessionId} reason=${candidate.reason} messages=${snapshot.messageCount} tokens_est=${snapshot.tokenEstimate}/${CONTEXT_TOKEN_BUDGET}`,
  });

  return { snapshot, created: true };
}

function analyzeCompactionCandidate(
  sessionId: string,
  excludeMessageId?: string | null,
): CompactionCandidate {
  const turns = listCompactableTurns(sessionId, excludeMessageId);
  const totalChars = turns.reduce((sum, turn) => sum + turn.text.length, 0);
  const totalTokens = estimateTokens(totalChars);
  const compactedTurns = turns.slice(0, Math.max(0, turns.length - RECENT_TURNS_TO_KEEP));
  const lastMessageId = compactedTurns[compactedTurns.length - 1]?.id ?? null;
  const previous = contextRepo.getBySession(sessionId);

  if (compactedTurns.length < MIN_COMPACTABLE_TURNS) {
    return {
      turns,
      compactedTurns,
      totalChars,
      totalTokens,
      lastMessageId,
      shouldCompact: false,
      reason: 'too-few-turns',
    };
  }

  if (previous?.lastMessageId === lastMessageId) {
    return {
      turns,
      compactedTurns,
      totalChars,
      totalTokens,
      lastMessageId,
      shouldCompact: false,
      reason: 'already-current',
    };
  }

  if (totalTokens >= FORCE_COMPACT_AT_TOKEN_ESTIMATE) {
    return {
      turns,
      compactedTurns,
      totalChars,
      totalTokens,
      lastMessageId,
      shouldCompact: true,
      reason: 'hard-budget',
    };
  }

  if (totalTokens >= COMPACT_AT_TOKEN_ESTIMATE) {
    return {
      turns,
      compactedTurns,
      totalChars,
      totalTokens,
      lastMessageId,
      shouldCompact: true,
      reason: 'soft-budget',
    };
  }

  return {
    turns,
    compactedTurns,
    totalChars,
    totalTokens,
    lastMessageId,
    shouldCompact: false,
    reason: 'below-budget',
  };
}

function listCompactableTurns(
  sessionId: string,
  excludeMessageId?: string | null,
): CompactableTurn[] {
  const messages = messageRepo.listBySession(sessionId);
  return messages.flatMap((message) => {
    if (message.id === excludeMessageId) return [];
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    if (message.status === 'streaming' || message.status === 'cancelled') return [];
    const text = textFromMessage(message);
    if (!text) return [];
    return [{ id: message.id, role: message.role, text }];
  });
}

function textFromMessage(message: ChatMessage): string {
  return message.parts
    .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
    .map((part) => normalizeWhitespace(part.text))
    .join('\n')
    .trim();
}

function buildExtractiveSummary(turns: CompactableTurn[]): string {
  const sections = [
    ['User goals and constraints', pickLines(turns, GOAL_PATTERNS)],
    ['Decisions already made', pickLines(turns, DECISION_PATTERNS)],
    ['Implementation state and pending work', pickLines(turns, WORK_PATTERNS)],
    ['Files, sources and tools referenced', pickLines(turns, REFERENCE_PATTERNS)],
  ] as const;

  const lines: string[] = [
    `Compacted ${turns.length} older messages (~${estimateTokens(
      turns.reduce((sum, turn) => sum + turn.text.length, 0),
    )} tokens estimated, budget ${CONTEXT_TOKEN_BUDGET.toLocaleString('en-US')} tokens).`,
    '',
  ];

  for (const [title, bullets] of sections) {
    lines.push(`### ${title}`);
    if (bullets.length === 0) {
      lines.push('- No durable item detected in the compacted window.');
    } else {
      for (const bullet of bullets) lines.push(`- ${bullet}`);
    }
    lines.push('');
  }

  lines.push('### Recent continuity rule');
  lines.push(
    '- Treat this compacted summary as memory, but prefer fresh repository reads, KB search and current files before making claims or edits.',
  );

  return truncateAtBoundary(lines.join('\n').trim(), MAX_SUMMARY_CHARS);
}

function pickLines(turns: CompactableTurn[], patterns: RegExp[]): string[] {
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const turn of turns) {
    for (const sentence of splitSentences(turn.text)) {
      if (!patterns.some((pattern) => pattern.test(sentence))) continue;
      const clean = cleanBullet(sentence);
      const key = clean.toLowerCase();
      if (clean.length < 24 || seen.has(key)) continue;
      seen.add(key);
      matches.push(`${turn.role === 'user' ? 'User' : 'Assistant'}: ${clean}`);
      if (matches.length >= MAX_BULLETS_PER_SECTION) return matches;
    }
  }
  return matches;
}

function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function cleanBullet(text: string): string {
  return truncateAtBoundary(
    normalizeWhitespace(text)
      .replace(/^[-*]\s+/, '')
      .replace(/^#+\s+/, '')
      .trim(),
    420,
  );
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const boundary = Math.max(
    slice.lastIndexOf('\n'),
    slice.lastIndexOf('. '),
    slice.lastIndexOf('; '),
  );
  return `${slice.slice(0, boundary > maxChars * 0.72 ? boundary : maxChars).trim()}...`;
}

function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

const GOAL_PATTERNS = [
  /\bobjetiv|\bgoal\b|\bpreciso\b|\bquero\b|\bgarantir\b|\bmust\b|\bshould\b/i,
  /\bcontexto\b|\bnao perder\b|\bnão perder\b|\beconomia\b|\btokens?\b/i,
];

const DECISION_PATTERNS = [
  /\bdecid|\baprov|\bmodo\b|\bmodelo local\b|\bforge\b|\bcli\b|\bclaude\b|\bcodex\b/i,
  /\barchitecture\b|\barquitetura\b|\bdesign system\b|\bpolicy\b|\bregra\b/i,
];

const WORK_PATTERNS = [
  /\bfeito\b|\bconclu|\bpendente\b|\bfalta\b|\bbug\b|\bcorrig|\bimplement|\bcommit\b/i,
  /\bsmoke\b|\bteste\b|\bvalid|\btrace\b|\bmetric\b|\bprogresso\b/i,
];

const REFERENCE_PATTERNS = [
  /\bsrc\/|\bapp\/|\bcomponents?\/|\bpages?\/|\brepo\b|\breposit/i,
  /\bgithub\b|\bazure\b|\blocal folder\b|\bkb\b|\brag\b|\bembedding\b|\bagents\.md\b/i,
];
