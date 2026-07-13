import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  X,
  CircleAlert,
  Inbox,
  MessageSquare,
  ArrowDownToLine,
  Settings,
  EyeOff,
  AppWindow,
} from 'lucide-react';
import type { SettingsRecord } from '@shared/types';
import { PetSprite } from './PetSprite';
import {
  INITIAL_PET_STATE,
  reducePetState,
  derivePetVisual,
  type PetEvent,
  type PetState,
} from './pet-state';
import {
  addCard,
  expireCards,
  dismissCard,
  visibleCards,
  queuedCount,
  CARD_TTL_MS,
  type PetCard,
  type PetCardSource,
} from './pet-cards';
import { petMessages, type PetMessages } from './pet-i18n';
import { playPetSound } from './pet-sound';

type PetSettings = SettingsRecord['pet'];

/**
 * App do pet. A janela nasce click-through (setIgnoreMouseEvents true+forward);
 * as ÁREAS INTERATIVAS (sprite, cards, botões) ligam a interação no hover e
 * devolvem o click-through ao sair — por isso todo elemento visível recebe os
 * handlers de zone(). Fora deles, o clique atravessa pro app de baixo.
 */

function setIgnoreMouse(ignore: boolean): void {
  void window.orkestral['pet:set-ignore-mouse']({ ignore }).catch(() => {});
}

function openTarget(hash: string | null, openSettings?: boolean): void {
  void window.orkestral['pet:open-target']({ hash, openSettings }).catch(() => {});
}

/** Handlers de hover das áreas interativas (contador cobre sobreposição de zonas). */
function useInteractiveZone(): { onMouseEnter: () => void; onMouseLeave: () => void } {
  const depth = useRef(0);
  return useMemo(
    () => ({
      onMouseEnter: () => {
        depth.current += 1;
        if (depth.current === 1) setIgnoreMouse(false);
      },
      onMouseLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setIgnoreMouse(true);
      },
    }),
    [],
  );
}

const CARD_ICONS: Record<PetCard['tone'], typeof Check> = {
  success: Check,
  error: CircleAlert,
  info: MessageSquare,
};
const SOURCE_ICONS: Partial<Record<PetCardSource, typeof Check>> = {
  inbox: Inbox,
  update: ArrowDownToLine,
};

export function PetApp() {
  const [petState, setPetState] = useState<PetState>(INITIAL_PET_STATE);
  const [cards, setCards] = useState<readonly PetCard[]>([]);
  const [settings, setSettings] = useState<PetSettings | null>(null);
  const [language, setLanguage] = useState<SettingsRecord['appearance']['language']>('system');
  const [menuOpen, setMenuOpen] = useState(false);
  // relógio de 1s: expira cards e encerra o flash de "done"
  const [now, setNow] = useState(() => Date.now());
  const zone = useInteractiveZone();

  const t: PetMessages = useMemo(() => petMessages(language), [language]);

  const dispatch = useCallback((event: PetEvent) => {
    setPetState((s) => reducePetState(s, event, Date.now()));
  }, []);

  const pushCard = useCallback(
    (card: Omit<PetCard, 'expiresAt'>, petSettings: PetSettings | null) => {
      if (petSettings?.doNotDisturb) return;
      setCards((c) => addCard(c, { ...card, expiresAt: Date.now() + CARD_TTL_MS }));
      if (petSettings?.sound) playPetSound();
    },
    [],
  );

  // settings: hidrata no boot + aplica ao vivo quando mudarem no app
  useEffect(() => {
    void window.orkestral['settings:get']().then((record) => {
      setSettings(record.pet);
      setLanguage(record.appearance.language);
    });
    return window.orkestralEvents.onPetSettingsChanged((pet) => setSettings(pet));
  }, []);

  // fonte de status: execuções de issue (started/finished/error)
  const settingsRef = useRef<PetSettings | null>(null);
  settingsRef.current = settings;
  useEffect(() => {
    return window.orkestralEvents.onIssueExecutionEvent((event) => {
      const s = settingsRef.current;
      if (event.type === 'started') {
        dispatch({ kind: 'exec-started', id: event.issueId });
      } else if (event.type === 'finished') {
        dispatch({ kind: 'exec-finished', id: event.issueId });
        if (s?.notifications?.execution) {
          pushCard(
            {
              id: `exec-${event.issueId}`,
              tone: 'success',
              source: 'execution',
              title: event.issueTitle,
              description: event.agentName
                ? `${t.executionDone} — ${event.agentName}`
                : t.executionDone,
              hash: `#/issues/${event.issueKey}`,
              sticky: false,
            },
            s,
          );
        }
      } else if (event.type === 'error') {
        dispatch({ kind: 'exec-error', id: event.issueId });
        if (s?.notifications?.execution) {
          pushCard(
            {
              id: `exec-${event.issueId}`,
              tone: 'error',
              source: 'execution',
              title: event.issueTitle,
              description: event.error ?? t.executionFailed,
              hash: `#/issues/${event.issueKey}`,
              sticky: true,
            },
            s,
          );
        }
      }
    });
  }, [dispatch, pushCard, t]);

  // sessão de chat preparada em background
  useEffect(() => {
    return window.orkestralEvents.onChatSessionReady((event) => {
      const s = settingsRef.current;
      if (!s?.notifications?.execution) return;
      pushCard(
        {
          id: `session-${event.sessionId}`,
          tone: 'info',
          source: 'session',
          title: t.sessionReady,
          description: t.sessionReadyDescription,
          hash: `#/session/${event.sessionId}`,
          sticky: false,
        },
        s,
      );
    });
  }, [pushCard, t]);

  // proposta nova no inbox → estado attention + card (opt-in)
  useEffect(() => {
    return window.orkestralEvents.onInboxProposal((event) => {
      const s = settingsRef.current;
      dispatch({ kind: 'attention' });
      if (!s?.notifications?.inbox) return;
      pushCard(
        {
          id: `inbox-${event.sourceId}-${event.title}`,
          tone: 'info',
          source: 'inbox',
          title: event.title || t.inboxProposal,
          description: event.sourceLabel,
          hash: '#/inbox',
          sticky: false,
        },
        s,
      );
    });
  }, [dispatch, pushCard, t]);

  // atualização do app baixada
  useEffect(() => {
    return window.orkestralEvents.onUpdateDownloaded(({ version }) => {
      const s = settingsRef.current;
      if (!s?.notifications?.updates) return;
      pushCard(
        {
          id: `update-${version}`,
          tone: 'info',
          source: 'update',
          title: `${t.updateReady} (${version})`,
          description: t.updateReadyDescription,
          hash: null,
          sticky: false,
        },
        s,
      );
    });
  }, [pushCard, t]);

  // tick de 1s só enquanto há algo com prazo (card não-sticky ou flash de done)
  const hasDeadline = cards.some((c) => !c.sticky) || petState.doneUntil > now;
  useEffect(() => {
    if (!hasDeadline) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasDeadline]);
  useEffect(() => {
    setCards((c) => expireCards(c, now));
  }, [now]);

  const handleDismiss = useCallback(
    (card: PetCard) => {
      setCards((c) => dismissCard(c, card.id));
      if (card.tone === 'error') dispatch({ kind: 'error-dismissed' });
      if (card.source === 'inbox') dispatch({ kind: 'attention-cleared' });
    },
    [dispatch],
  );

  const handleOpen = useCallback(
    (card: PetCard) => {
      openTarget(card.hash);
      handleDismiss(card);
    },
    [handleDismiss],
  );

  const toggleCollapsed = useCallback(() => {
    const current = settingsRef.current;
    if (!current) return;
    const next = { ...current, collapsed: !current.collapsed };
    setSettings(next);
    void window.orkestral['settings:update']({ pet: next }).catch(() => {});
  }, []);

  // Drag manual do sprite: mousedown arma; passou de 4px vira drag (main gruda
  // a janela no cursor); soltou sem passar = clique → abre/fecha o menu.
  // Direção horizontal vira a "inclinação de andar" (estilo Codex).
  const [dragging, setDragging] = useState(false);
  const [lean, setLean] = useState<0 | 1 | -1>(0);
  const leanResetTimer = useRef<number | null>(null);

  const handleStageMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.screenX;
    const startY = e.screenY;
    let started = false;
    let lastX = e.screenX;

    const onMove = (ev: MouseEvent): void => {
      if (!started && Math.hypot(ev.screenX - startX, ev.screenY - startY) > 4) {
        started = true;
        setDragging(true);
        setMenuOpen(false);
        void window.orkestral['pet:drag-start']().catch(() => {});
      }
      if (!started) return;
      const dx = ev.screenX - lastX;
      lastX = ev.screenX;
      if (dx > 1) setLean(1);
      else if (dx < -1) setLean(-1);
      // parou de andar na horizontal → endireita depois de um instante
      if (leanResetTimer.current) window.clearTimeout(leanResetTimer.current);
      leanResetTimer.current = window.setTimeout(() => setLean(0), 140);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (started) {
        void window.orkestral['pet:drag-end']().catch(() => {});
        setDragging(false);
        setLean(0);
        if (leanResetTimer.current) window.clearTimeout(leanResetTimer.current);
      } else {
        setMenuOpen((v) => !v);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  const visual = derivePetVisual(petState, now);
  const activeCount = petState.activeIds.length;
  const collapsed = settings?.collapsed ?? false;
  const shown = collapsed ? [] : visibleCards(cards);
  const queued = collapsed ? 0 : queuedCount(cards);
  const stageClasses = [
    'pet-stage',
    settings?.size === 'sm' ? 'pet-stage--sm' : '',
    `pet--${visual}`,
    dragging ? 'pet--dragging' : '',
    lean === 1 ? 'pet--lean-right' : lean === -1 ? 'pet--lean-left' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="pet-root">
      {/* stack de cards, mais recente em cima */}
      {shown.length > 0 && (
        <div className="pet-cards" {...zone}>
          {queued > 0 && (
            <div className="pet-cards-queued">
              +{queued} {t.queued}
            </div>
          )}
          {shown.map((card) => {
            const Icon = SOURCE_ICONS[card.source] ?? CARD_ICONS[card.tone];
            return (
              <div
                key={card.id}
                role="button"
                tabIndex={0}
                className={`pet-card pet-card--${card.tone}`}
                onClick={() => handleOpen(card)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleOpen(card);
                  if (e.key === ' ') {
                    e.preventDefault();
                    handleOpen(card);
                  }
                }}
              >
                <Icon className="pet-card-icon" size={16} aria-hidden />
                <div className="pet-card-body">
                  <div className="pet-card-title">{card.title}</div>
                  {card.description && (
                    <div className="pet-card-description">{card.description}</div>
                  )}
                </div>
                <button
                  type="button"
                  className="pet-card-dismiss"
                  aria-label={t.dismiss}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDismiss(card);
                  }}
                >
                  <X size={14} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="pet-dock">
        {/* sprite: clique abre o menu; segurar (>4px) arrasta; badge = agentes ativos */}
        <div className={stageClasses} {...zone} onMouseDown={handleStageMouseDown}>
          {menuOpen && (
            <div className="pet-menu" onMouseDown={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  openTarget(null);
                }}
              >
                <AppWindow size={14} aria-hidden /> {t.openApp}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  toggleCollapsed();
                }}
              >
                {collapsed ? (
                  <ChevronUp size={14} aria-hidden />
                ) : (
                  <ChevronDown size={14} aria-hidden />
                )}
                {collapsed ? t.expandCards : t.collapseCards}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  openTarget(null, true);
                }}
              >
                <Settings size={14} aria-hidden /> {t.openSettings}
              </button>
              <button
                type="button"
                onClick={() => void window.orkestral['pet:set-enabled']({ enabled: false })}
              >
                <EyeOff size={14} aria-hidden /> {t.hidePet}
              </button>
            </div>
          )}
          {activeCount > 0 && <span className="pet-badge">{activeCount}</span>}
          <PetSprite state={visual} />
        </div>
      </div>
    </div>
  );
}
