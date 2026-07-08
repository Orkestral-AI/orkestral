import { useCallback, useEffect, useRef, useState } from 'react';
import { ZoomIn, Minus, Maximize2, RotateCcw, Sparkles } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { useT } from '@renderer/i18n';
import { KbHud } from './KbHud';
import type { KbGraph, KbGraphNode } from '@shared/types';

interface KbGalaxyViewProps {
  graph: KbGraph;
  onNodeClick?: (nodeId: string, kind: 'page' | 'entity') => void;
}

/**
 * Galaxy view — port direto do GraphView do orkestral_v1.
 * Canvas 2D com física force-directed + render layered (nebulosas, estrelas,
 * dust, bodies como buraco negro/lua/estrela/galáxia/nebulosa/cometa,
 * conexões curvas com labels e particles flowing).
 */
export function KbGalaxyView({ graph, onNodeClick }: KbGalaxyViewProps) {
  const { t } = useT();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodiesRef = useRef<Body[]>([]);
  const connsRef = useRef<Conn[]>([]);
  const starsRef = useRef<Star[]>([]);
  const meteorsRef = useRef<Meteor[]>([]);
  const animRef = useRef(0);
  const sizeRef = useRef({ w: 800, h: 600 });
  const hovRef = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const warmupDoneRef = useRef(false);
  const dragRef = useRef<{ id: string; ox: number; oy: number } | null>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const panStartRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const zoomRef = useRef(1);

  const [zoomValue, setZoomValue] = useState(1);
  const [filter, setFilter] = useState<'all' | 'pages' | 'entities'>('all');
  const filterRef = useRef<'all' | 'pages' | 'entities'>(filter);
  // Toggle "mostrar entidades" no modo Tudo (default off → galáxia limpa de
  // páginas). Ao ligar, as entidades surgem com efeito supernova (nascem no
  // centro com velocidade de saída).
  const [showEntities, setShowEntities] = useState(false);

  // Label do nó central (buraco negro), traduzido. Mantido em ref pra não
  // adicionar `t` às deps do effect de rebuild.
  const centerLabelRef = useRef(t('knowledge.title'));

  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);

  useEffect(() => {
    centerLabelRef.current = t('knowledge.title');
  }, [t]);

  const setZoom = useCallback((next: number) => {
    zoomRef.current = next;
    setZoomValue(next);
  }, []);

  // Rebuild bodies+conns quando graph muda
  useEffect(() => {
    // Mede o tamanho REAL do canvas aqui (o effect roda após o DOM montar) — sem
    // isso a galáxia nasce dimensionada pro {800,600} default e depois "arrasta"
    // pro tamanho/centro certos quando o resize chega.
    const rect = canvasRef.current?.parentElement?.getBoundingClientRect();
    if (rect && rect.width > 2 && rect.height > 2) {
      sizeRef.current = { w: rect.width, h: rect.height };
    }
    const { w, h } = sizeRef.current;
    const cx = w / 2;
    const cy = h / 2;

    const filtered = filterGraph(graph, filterRef.current, showEntities);

    // Adiciona um nó sintético "Base de conhecimento" central (buraco negro)
    // que conecta a páginas raiz e entidades órfãs — é o que dá o efeito
    // gravitacional do v1.
    const CENTER_ID = '__kb_center__';
    const centerNode: KbGraphNode = {
      id: CENTER_ID,
      kind: 'page',
      label: centerLabelRef.current,
      subtype: 'knowledge',
      degree: 999,
    };

    const allNodes: KbGraphNode[] = [centerNode, ...filtered.nodes];
    const existing = new Map(bodiesRef.current.map((b) => [b.id, b]));

    // Classificação em tiers
    const tierItems: Array<
      Array<{
        id: string;
        label: string;
        kind: 'page' | 'entity';
        subtype: string;
        mass: number;
        color: string;
        form: string;
        tier: number;
      }>
    > = [[], [], [], []];

    // Mapeamento subtype v2 → "tipo v1" (pra escolher form/color)
    function mapped(n: KbGraphNode): {
      type: string;
      mass: number;
      color: string;
      form: string;
    } {
      if (n.id === CENTER_ID) {
        return { type: 'knowledge', mass: 34, color: COL.knowledge, form: 'blackhole' };
      }
      if (n.kind === 'page') {
        // Só o node do REPOSITÓRIO (raiz com sourceId, ou título "Repo: …") vira
        // PLANETA. Todo o resto continua lua.
        if ((n.parentId == null && n.sourceId != null) || n.label.startsWith('Repo:')) {
          return { type: 'planet', mass: 20, color: planetKindFor(n.id), form: 'planet' };
        }
        if (n.subtype === 'index') {
          return { type: 'knowledge', mass: 20, color: COL.knowledge, form: 'blackhole' };
        }
        if (n.subtype === 'auto-generated') {
          return { type: 'document', mass: 14, color: COL.document, form: 'moon' };
        }
        if (n.subtype === 'agent-memory') {
          return { type: 'agent-spec', mass: 16, color: COL['agent-spec'], form: 'nebula' };
        }
        return { type: 'document', mass: 14, color: COL.document, form: 'moon' };
      }
      // entity
      const sub = n.subtype || 'concept';
      const v1Type =
        sub === 'tech'
          ? 'technology'
          : sub === 'person'
            ? 'person'
            : sub === 'tool'
              ? 'tool'
              : sub === 'service'
                ? 'service'
                : sub === 'project'
                  ? 'project'
                  : sub === 'pattern'
                    ? 'concept'
                    : 'concept';
      return {
        type: v1Type,
        // Entidades = estrelinhas BEM pequenas (pontos), bem menores que as
        // páginas (14-20) e o planeta do repo. Só crescem um tiquinho com grau.
        mass: Math.min(2.5 + n.degree * 0.4, 5),
        color: COL[v1Type] ?? '#9aa0aa',
        form: FORMS[v1Type] ?? 'star',
      };
    }

    for (const n of allNodes) {
      const m = mapped(n);
      const tier =
        n.id === CENTER_ID
          ? 0
          : n.kind === 'entity'
            ? 3
            : n.subtype === 'index'
              ? 1
              : n.subtype === 'agent-memory'
                ? 2
                : 1;
      tierItems[tier].push({
        id: n.id,
        label: n.label,
        kind: n.kind,
        subtype: m.type,
        mass: m.mass,
        color: m.color,
        form: m.form,
        tier,
      });
    }

    // Mapa de posição prévia pra reusar
    const peerPositions = new Map<string, { x: number; y: number }>();
    for (const b of bodiesRef.current) peerPositions.set(b.id, { x: b.x, y: b.y });

    const bb: Body[] = [];
    for (let tier = 0; tier < tierItems.length; tier++) {
      const items = tierItems[tier];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const prev = existing.get(item.id);
        if (prev) {
          bb.push({
            ...prev,
            label: item.label,
            targetMass: item.mass,
            color: item.color,
            form: item.form,
            tier,
          });
        } else {
          // Corpos NOVOS nascem NO CENTRO (com um micro-jitter) e a física +
          // tier-attraction os expande pra fora — efeito "bloom do centro", igual
          // a uma página sendo criada. Nada mais de "arrastar da esquerda".
          const isCenter = item.id === CENTER_ID;
          const a = Math.random() * Math.PI * 2;
          const d = isCenter ? 0 : Math.random() * 26;
          // Entidades (tier 3) nascem com VELOCIDADE de saída forte = supernova:
          // explodem do centro pra fora e a física as segura depois. Páginas
          // mantêm o bloom suave (v=0).
          const burst = tier === 3 ? 6 + Math.random() * 7 : 0;
          bb.push({
            ...item,
            x: cx + Math.cos(a) * d,
            y: cy + Math.sin(a) * d,
            vx: Math.cos(a) * burst,
            vy: Math.sin(a) * burst,
            ph: Math.random(),
            pinned: isCenter,
            // Pinned bodies nascem com mass completa — physics não incrementa
            // age neles, então sem isso ficariam invisíveis.
            mass: isCenter ? item.mass : 0,
            targetMass: item.mass,
            tier,
            age: isCenter ? SPAWN_FRAMES : 0,
          });
        }
      }
    }

    // Conexões — parent→child (já vem em edges com kind='wikilink' label='contém'),
    // wikilinks explícitos, relations. Tudo já vem no `filtered.edges`.
    const bodyIds = new Set(bb.map((b) => b.id));
    const cc: Conn[] = [];
    const addConn = (src: string, tgt: string, label: string, faint = false) => {
      if (!src || !tgt || src === tgt) return;
      if (!bodyIds.has(src) || !bodyIds.has(tgt)) return;
      if (
        cc.some(
          (c) => (c.source === src && c.target === tgt) || (c.source === tgt && c.target === src),
        )
      ) {
        return;
      }
      cc.push({ source: src, target: tgt, label, faint });
    };

    // Arestas sintéticas repo→entidade têm label 'menciona' → faint (sem linha).
    for (const e of filtered.edges) {
      addConn(e.source, e.target, e.label ?? '', e.label === 'menciona');
    }

    // Conecta nó central a páginas raiz e entidades órfãs (igual v1)
    const connectedIds = new Set<string>();
    for (const c of cc) {
      connectedIds.add(c.source);
      connectedIds.add(c.target);
    }
    // Raízes: páginas sem nenhum edge ainda OU explicitamente raiz no graph
    // (não temos parentId aqui, então usamos "sem conexões" como heurística)
    for (const n of filtered.nodes) {
      if (!connectedIds.has(n.id)) {
        const label = n.kind === 'entity' ? 'conhece' : 'pertence a';
        addConn(CENTER_ID, n.id, label, n.kind === 'entity');
      }
    }

    bodiesRef.current = bb;
    connsRef.current = cc;

    if (existing.size === 0 && bb.length > 0) {
      warmupDoneRef.current = false;
    }
    // `filter` nas deps: sem isso, trocar Tudo/Páginas/Entidades não re-roda o
    // layout e nada filtra.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, filter, showEntities]);

  // 800 estrelas distantes
  useEffect(() => {
    const s: Star[] = [];
    for (let i = 0; i < 800; i++) {
      s.push({
        x: Math.random() * 4000 - 500,
        y: Math.random() * 3000 - 500,
        s: Math.random() < 0.02 ? Math.random() * 2.2 + 1 : Math.random() * 0.7 + 0.1,
        b: Math.random(),
        sp: Math.random() * 2 + 0.3,
        spike: Math.random() < 0.03,
      });
    }
    starsRef.current = s;
  }, []);

  // Meteoros ocasionais
  useEffect(() => {
    const iv = setInterval(() => {
      const w = sizeRef.current.w;
      const h = sizeRef.current.h;
      if (Math.random() < 0.15) {
        meteorsRef.current.push({
          x: Math.random() * w,
          y: Math.random() * h * 0.2,
          a: Math.PI * (0.1 + Math.random() * 0.3),
          sp: 3 + Math.random() * 5,
          len: 50 + Math.random() * 80,
          life: 35 + Math.random() * 25,
          max: 60,
        });
      }
      meteorsRef.current = meteorsRef.current.filter((m) => m.life > 0);
    }, 4000);
    return () => clearInterval(iv);
  }, []);

  // Animation loop
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      const r = c.parentElement?.getBoundingClientRect();
      if (!r) return;
      const dpr = window.devicePixelRatio || 1;
      c.width = r.width * dpr;
      c.height = r.height * dpr;
      c.style.width = `${r.width}px`;
      c.style.height = `${r.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sizeRef.current = { w: r.width, h: r.height };
    };
    resize();
    const obs = new ResizeObserver(resize);
    if (c.parentElement) obs.observe(c.parentElement);

    // Sem warmup: os corpos nascem no centro e a expansão acontece VISÍVEL no
    // loop (bloom do centro). O warmup pré-assentava tudo escondido — era o que
    // tirava a animação de "aparecer do centro".

    let run = true;
    let frameCount = 0;
    const FADE_FRAMES = 60;

    const loop = () => {
      if (!run) return;
      frameCount++;
      // Re-ancora o sistema no centro: move a GALÁXIA INTEIRA junto com o núcleo
      // (translação rígida), em vez de só o núcleo. Assim, se o layout nasceu num
      // centro errado (tamanho medido antes do canvas assentar), o 1º frame
      // recentraliza tudo de uma vez — nada de "arrastar da esquerda".
      const center = bodiesRef.current.find((b) => b.id === '__kb_center__');
      if (center) {
        const dx = sizeRef.current.w / 2 - center.x;
        const dy = sizeRef.current.h / 2 - center.y;
        if (dx || dy) {
          for (const b of bodiesRef.current) {
            b.x += dx;
            b.y += dy;
          }
        }
        center.vx = 0;
        center.vy = 0;
      }
      const warmth = Math.min(frameCount / 120, 1);
      physics(
        bodiesRef.current,
        connsRef.current,
        sizeRef.current.w,
        sizeRef.current.h,
        Math.max(warmth, 0.5),
        frameCount,
      );
      const fadeIn = Math.min(frameCount / FADE_FRAMES, 1);
      try {
        render(
          ctx,
          bodiesRef.current,
          connsRef.current,
          starsRef.current,
          meteorsRef.current,
          sizeRef.current.w,
          sizeRef.current.h,
          hovRef.current,
          selectedRef.current,
          panRef.current.x,
          panRef.current.y,
          zoomRef.current,
          performance.now(),
          fadeIn,
        );
      } catch (err) {
        // Nunca deixa um erro de canvas derrubar a UI inteira (error boundary).
        console.error('[kb-galaxy] erro no render:', err);
      }
      animRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => {
      run = false;
      cancelAnimationFrame(animRef.current);
      obs.disconnect();
    };
  }, []);

  // Interação
  const toG = useCallback((sx: number, sy: number) => {
    return {
      x: (sx - panRef.current.x) / zoomRef.current,
      y: (sy - panRef.current.y) / zoomRef.current,
    };
  }, []);
  const findB = useCallback(
    (sx: number, sy: number): Body | null => {
      const { x, y } = toG(sx, sy);
      for (let i = bodiesRef.current.length - 1; i >= 0; i--) {
        const s = bodiesRef.current[i];
        const dx = x - s.x;
        const dy = y - s.y;
        const radius = s.mass * 3 + 12;
        if (dx * dx + dy * dy < radius * radius) return s;
      }
      return null;
    },
    [toG],
  );
  const onDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const r = canvasRef.current?.getBoundingClientRect();
      if (!r) return;
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const s = findB(sx, sy);
      if (s) {
        const { x, y } = toG(sx, sy);
        dragRef.current = { id: s.id, ox: s.x - x, oy: s.y - y };
        s.pinned = true;
      } else {
        panStartRef.current = {
          x: e.clientX,
          y: e.clientY,
          px: panRef.current.x,
          py: panRef.current.y,
        };
      }
    },
    [findB, toG],
  );
  const onMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const r = canvasRef.current?.getBoundingClientRect();
      if (!r) return;
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      if (dragRef.current) {
        const { x, y } = toG(sx, sy);
        const s = bodiesRef.current.find((n) => n.id === dragRef.current!.id);
        if (s) {
          s.x = x + dragRef.current.ox;
          s.y = y + dragRef.current.oy;
          s.vx = 0;
          s.vy = 0;
        }
        return;
      }
      if (panStartRef.current) {
        panRef.current = {
          x: panStartRef.current.px + (e.clientX - panStartRef.current.x),
          y: panStartRef.current.py + (e.clientY - panStartRef.current.y),
        };
        return;
      }
      const s = findB(sx, sy);
      hovRef.current = s?.id ?? null;
      if (canvasRef.current) {
        canvasRef.current.style.cursor = s ? 'grab' : 'default';
      }
    },
    [findB, toG],
  );
  const onUp = useCallback(() => {
    if (dragRef.current) {
      const s = bodiesRef.current.find((n) => n.id === dragRef.current!.id);
      if (s && s.id !== '__kb_center__') s.pinned = false;
      dragRef.current = null;
    }
    panStartRef.current = null;
  }, []);
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const d = e.deltaY > 0 ? 0.92 : 1.08;
    const nz = Math.max(0.3, Math.min(3, zoomRef.current * d));
    const r = canvasRef.current?.getBoundingClientRect();
    if (r) {
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      panRef.current.x = cx - (cx - panRef.current.x) * (nz / zoomRef.current);
      panRef.current.y = cy - (cy - panRef.current.y) * (nz / zoomRef.current);
    }
    zoomRef.current = nz;
    setZoomValue(nz);
  }, []);
  const onClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (panStartRef.current) return;
      const r = canvasRef.current?.getBoundingClientRect();
      if (!r) return;
      const s = findB(e.clientX - r.left, e.clientY - r.top);
      if (s) {
        if (s.id === '__kb_center__') return;
        selectedRef.current = selectedRef.current === s.id ? null : s.id;
        if (s.kind === 'page' && onNodeClick) onNodeClick(s.id, 'page');
        else if (s.kind === 'entity' && onNodeClick) onNodeClick(s.id, 'entity');
      } else {
        selectedRef.current = null;
      }
    },
    [findB, onNodeClick],
  );

  const handleReset = useCallback(() => {
    setZoom(1);
    panRef.current = { x: 0, y: 0 };
    selectedRef.current = null;
    bodiesRef.current = bodiesRef.current.map((s) =>
      s.id === '__kb_center__' ? s : { ...s, pinned: false },
    );
  }, [setZoom]);

  return (
    <div className="relative h-full w-full">
      {/* Filter chips */}
      <div className="pointer-events-auto absolute left-3 top-3 z-10 flex items-center gap-1 rounded-md border border-hairline bg-background/80 p-1 backdrop-blur">
        {(['all', 'pages', 'entities'] as const).map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => setFilter(opt)}
            className={cn(
              'rounded px-2.5 py-1 text-[11.5px] transition-colors',
              filter === opt
                ? 'bg-surface-strong text-text-primary'
                : 'text-text-muted hover:bg-surface-1 hover:text-text-secondary',
            )}
          >
            {opt === 'all'
              ? t('knowledge.graph.filter.all')
              : opt === 'pages'
                ? t('knowledge.graph.filter.pages')
                : t('knowledge.graph.filter.entities')}
          </button>
        ))}
        {/* Toggle "mostrar entidades" — só faz sentido no modo Tudo. Ligar dispara
            o surgimento supernova (entidades explodem do centro). */}
        {filter === 'all' && (
          <button
            type="button"
            onClick={() => setShowEntities((v) => !v)}
            title={t('knowledge.graph.toggleEntities')}
            className={cn(
              'ml-0.5 inline-flex items-center gap-1 rounded px-2 py-1 text-[11.5px] transition-colors',
              showEntities
                ? 'bg-accent/15 text-accent'
                : 'text-text-muted hover:bg-surface-1 hover:text-text-secondary',
            )}
          >
            <Sparkles className="h-3 w-3" />
            {t('knowledge.graph.filter.entities')}
          </button>
        )}
      </div>

      {/* Controls verticais — minimalistas */}
      <div className="pointer-events-auto absolute left-3 top-1/2 z-10 flex -translate-y-1/2 flex-col gap-1 rounded-md border border-hairline bg-background/80 p-1 backdrop-blur">
        <button
          type="button"
          onClick={() => {
            setZoom(Math.min(3, zoomRef.current * 1.2));
          }}
          className="grid h-7 w-7 place-items-center rounded text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary"
          title={t('knowledge.graph.controls.zoomIn')}
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </button>
        <span className="py-0.5 text-center text-[9.5px] font-mono text-text-faint">
          {Math.round(zoomValue * 100)}%
        </span>
        <button
          type="button"
          onClick={() => {
            setZoom(Math.max(0.3, zoomRef.current * 0.8));
          }}
          className="grid h-7 w-7 place-items-center rounded text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary"
          title={t('knowledge.graph.controls.zoomOut')}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <div className="my-0.5 h-px bg-surface-active" />
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            panRef.current = { x: 0, y: 0 };
          }}
          className="grid h-7 w-7 place-items-center rounded text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary"
          title={t('knowledge.graph.controls.center')}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={handleReset}
          className="grid h-7 w-7 place-items-center rounded text-text-muted transition-colors hover:bg-surface-active hover:text-text-primary"
          title={t('knowledge.graph.controls.reset')}
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      </div>

      <canvas
        ref={canvasRef}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={() => {
          onUp();
          hovRef.current = null;
        }}
        onWheel={onWheel}
        onClick={onClick}
        className="block h-full w-full bg-background"
      />

      {/* Cards de indicadores (telemetria) sobrepostos. */}
      <KbHud stats={graph.stats} onFocusNode={onNodeClick} />
    </div>
  );
}

// ============================================================================
// Types
// ============================================================================

interface Body {
  id: string;
  label: string;
  kind: 'page' | 'entity';
  subtype: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  mass: number;
  targetMass: number;
  color: string;
  ph: number;
  pinned: boolean;
  form: string;
  tier: number;
  age: number;
}
interface Conn {
  source: string;
  target: string;
  label: string;
  /** Aresta de entidade (repo→entidade): a física puxa, mas NÃO desenha a linha
   *  (vira poeira de estrelas em vez do leque mecânico). Só aparece no hover/seleção. */
  faint?: boolean;
}
interface Star {
  x: number;
  y: number;
  s: number;
  b: number;
  sp: number;
  spike: boolean;
}
interface Meteor {
  x: number;
  y: number;
  a: number;
  sp: number;
  len: number;
  life: number;
  max: number;
}

// Cores e formas (paleta do v1)
const COL: Record<string, string> = {
  canvas: '#6ea8fe',
  document: '#c9b0ff',
  conversation: '#7ddfb0',
  knowledge: '#ffd666',
  'agent-spec': '#ff8fb8',
  person: '#ffa0a0',
  technology: '#5ce0f0',
  project: '#b8a0ff',
  concept: '#ffb870',
  service: '#60e0d0',
  tool: '#c0e860',
  agent: '#ff9f43',
};
const FORMS: Record<string, string> = {
  canvas: 'galaxy',
  document: 'moon',
  conversation: 'comet',
  knowledge: 'blackhole',
  'agent-spec': 'nebula',
  person: 'star',
  technology: 'moon',
  project: 'galaxy',
  concept: 'nebula',
  service: 'star',
  tool: 'comet',
  agent: 'nebula',
};
const CLUSTER: Record<string, number> = {
  knowledge: 0,
  canvas: 1,
  document: 2,
  conversation: 2,
  'agent-spec': 3,
  agent: 3,
  technology: 4,
  person: 5,
  tool: 5,
  service: 5,
  project: 6,
  concept: 6,
};
const SPAWN_FRAMES = 50;

function filterGraph(
  graph: KbGraph,
  filter: 'all' | 'pages' | 'entities',
  showEntities: boolean,
): KbGraph {
  if (filter === 'all') {
    // "Tudo": páginas sempre; entidades SÓ com o toggle ligado (default off →
    // galáxia limpa de páginas, sem a poeira de dependências). A aba "Entidades"
    // abaixo mostra todas independente do toggle.
    const nodes = graph.nodes.filter((n) => n.kind === 'page' || (showEntities && n.degree > 0));
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
    return { nodes, edges, stats: graph.stats };
  }
  const allowedKind = filter === 'pages' ? 'page' : 'entity';
  const nodes = graph.nodes.filter((n) => n.kind === allowedKind);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  return { nodes, edges, stats: graph.stats };
}

// ============================================================================
// Physics — port v1
// ============================================================================

function physics(
  bb: Body[],
  conns: Conn[],
  w: number,
  h: number,
  warmth = 1,
  frameCount = 0,
): void {
  const cx = w / 2;
  const cy = h / 2;
  const N = bb.length;
  if (N === 0) return;

  const repulsion = 400 + warmth * 220 + Math.min(N * 6, 360);
  const edgeAttraction = 0.0025 - warmth * 0.0008;
  const centerGravity = 0.0005 - warmth * 0.00015;
  const friction = 0.82 + warmth * 0.1;
  const tierAttraction = 0.0005;
  const clusterStrength = 0.00035;

  const minDim = Math.min(w, h);
  const tierRadius = [0, minDim * 0.2, minDim * 0.38, minDim * 0.56];

  const minSep = (b: Body) => b.mass * 2.5 + 18;

  // Repulsão N²
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const a = bb[i];
      const b = bb[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      let d = Math.sqrt(dx * dx + dy * dy) || 1;
      if (d < 50) d = 50;
      const mf = 1 + (a.mass + b.mass) * 0.018;
      const f = (repulsion * mf) / (d * d);
      if (!a.pinned) {
        a.vx -= (dx / d) * f;
        a.vy -= (dy / d) * f;
      }
      if (!b.pinned) {
        b.vx += (dx / d) * f;
        b.vy += (dy / d) * f;
      }
    }
  }

  // Atração spring nas arestas
  const bodyMap = new Map(bb.map((s) => [s.id, s]));
  for (const c of conns) {
    const a = bodyMap.get(c.source);
    const b = bodyMap.get(c.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const ideal = (a.mass + b.mass) * 5 + 120;
    const f = (d - ideal) * edgeAttraction;
    if (!a.pinned) {
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
    }
    if (!b.pinned) {
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    }
  }

  // Centroide por cluster
  const centroids = new Map<number, { sx: number; sy: number; n: number }>();
  for (const s of bb) {
    const cid = CLUSTER[s.subtype] ?? -1;
    if (cid < 0) continue;
    const entry = centroids.get(cid);
    if (entry) {
      entry.sx += s.x;
      entry.sy += s.y;
      entry.n++;
    } else {
      centroids.set(cid, { sx: s.x, sy: s.y, n: 1 });
    }
  }
  for (const s of bb) {
    if (s.pinned) continue;
    const cid = CLUSTER[s.subtype] ?? -1;
    const center = centroids.get(cid);
    if (!center || center.n < 2) continue;
    const gx = center.sx / center.n;
    const gy = center.sy / center.n;
    const dx = gx - s.x;
    const dy = gy - s.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    if (d < 80) continue;
    s.vx += (dx / d) * clusterStrength * d;
    s.vy += (dy / d) * clusterStrength * d;
  }

  // Gravidade central + tier radial + orbital + friction
  const time = frameCount * 0.016;
  for (const s of bb) {
    if (s.pinned) continue;
    const pull = s.subtype === 'knowledge' ? centerGravity * 5 : centerGravity;
    s.vx += (cx - s.x) * pull;
    s.vy += (cy - s.y) * pull;

    if (s.tier > 0) {
      const dx = s.x - cx;
      const dy = s.y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const targetR = tierRadius[s.tier] ?? tierRadius[3];
      const radialError = dist - targetR;
      const rf = radialError * tierAttraction;
      s.vx -= (dx / dist) * rf;
      s.vy -= (dy / dist) * rf;
    }

    if (s.subtype !== 'knowledge') {
      const dx = s.x - cx;
      const dy = s.y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const orbitDir = s.ph > 0.5 ? 1 : -1;
      const orbitSpeed = 0.025 / (1 + dist * 0.004);
      const modulation = 1 + 0.2 * Math.sin(time * 0.3 + s.ph * 20);
      const tangent = orbitSpeed * orbitDir * modulation;
      s.vx += (-dy / dist) * tangent;
      s.vy += (dx / dist) * tangent;

      const breath = 0.004 * Math.sin(time * 0.15 + s.ph * 15);
      s.vx += (dx / dist) * breath;
      s.vy += (dy / dist) * breath;
    }

    s.vx *= friction;
    s.vy *= friction;
    const maxV = 3.5;
    if (s.vx > maxV) s.vx = maxV;
    if (s.vx < -maxV) s.vx = -maxV;
    if (s.vy > maxV) s.vy = maxV;
    if (s.vy < -maxV) s.vy = -maxV;
    s.x += s.vx;
    s.y += s.vy;

    if (s.age < SPAWN_FRAMES) {
      s.age++;
      const t = s.age / SPAWN_FRAMES;
      const ease = t * t * (3 - 2 * t);
      s.mass = s.targetMass * ease;
    }
  }

  // Anti-collision
  for (let iter = 0; iter < 2; iter++) {
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const a = bb[i];
        const b = bb[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.1;
        const needed = minSep(a) + minSep(b);
        if (d >= needed) continue;
        const overlap = (needed - d) * 0.5;
        const nx = dx / d;
        const ny = dy / d;
        if (!a.pinned) {
          a.x -= nx * overlap;
          a.y -= ny * overlap;
        }
        if (!b.pinned) {
          b.x += nx * overlap;
          b.y += ny * overlap;
        }
      }
    }
  }
}

// ============================================================================
// Draw functions — port v1 (apenas as 5 formas que usamos)
// ============================================================================

function drawMoon(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  col: string,
  t: number,
  ph: number,
  hov: boolean,
): void {
  const breath = 1 + Math.sin(t * 0.0015 + ph * 10) * 0.02;
  const R = r * breath;

  // Atmosfera bem sutil
  const atmo = c.createRadialGradient(x, y, R * 0.7, x, y, R * (hov ? 2.5 : 1.6));
  atmo.addColorStop(0, col + '0c');
  atmo.addColorStop(1, 'transparent');
  c.beginPath();
  c.arc(x, y, R * (hov ? 2.5 : 1.6), 0, Math.PI * 2);
  c.fillStyle = atmo;
  c.fill();

  // ── Corpo base: FLAT cinza médio (meio termo, nem claro nem escuro) ──
  c.beginPath();
  c.arc(x, y, R, 0, Math.PI * 2);
  c.fillStyle = '#9a9aa6';
  c.fill();

  // ── Crescent shadow ──
  c.save();
  c.beginPath();
  c.arc(x, y, R, 0, Math.PI * 2);
  c.clip();
  c.beginPath();
  c.arc(x + R * 0.35, y - R * 0.25, R * 1.05, 0, Math.PI * 2);
  c.fillStyle = '#74747f';
  c.fill();
  c.restore();

  // ── Craters: círculos FLAT com tom ALTO contraste pra ficar evidente ──
  c.save();
  c.beginPath();
  c.arc(x, y, R, 0, Math.PI * 2);
  c.clip();
  const craters = [
    { a: 0.0, d: 0.55, s: 0.18 },
    { a: 0.9, d: 0.32, s: 0.13 },
    { a: 2.1, d: 0.58, s: 0.11 },
    { a: 3.3, d: 0.18, s: 0.09 },
    { a: 4.4, d: 0.48, s: 0.15 },
    { a: 5.5, d: 0.65, s: 0.08 },
    { a: 1.5, d: 0.7, s: 0.07 },
  ];
  for (let i = 0; i < craters.length; i++) {
    const k = craters[i];
    const angle = k.a + ph * 6.28;
    const cx2 = x + Math.cos(angle) * R * k.d;
    const cy2 = y + Math.sin(angle) * R * k.d;
    const cr = R * k.s;
    // Sombra interna escura (depressão)
    c.beginPath();
    c.arc(cx2, cy2, cr, 0, Math.PI * 2);
    c.fillStyle = '#1f1f28';
    c.fill();
    // Rim superior iluminado (acentua a borda do cratera)
    c.beginPath();
    c.arc(cx2, cy2 - cr * 0.15, cr * 0.85, 0, Math.PI * 2);
    c.fillStyle = '#3a3a45';
    c.fill();
  }
  c.restore();

  // Hover ring
  if (hov) {
    c.beginPath();
    c.arc(x, y, R + 6, 0, Math.PI * 2);
    c.strokeStyle = col + '50';
    c.lineWidth = 1.2;
    c.setLineDash([3, 4]);
    c.lineDashOffset = -t * 0.01;
    c.stroke();
    c.setLineDash([]);
  }
}

function drawStar(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  col: string,
  t: number,
  ph: number,
  hov: boolean,
): void {
  const hex2 = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  // Brilho INTERMITENTE no tempo, com fase própria por estrela (ph): acende e
  // apaga devagar, fora de sincronia. pow(3) faz passar mais tempo discreto com
  // picos sutis — "piscar" suave em vez de pulso constante. Faixa ~0.5..1.
  const blink = 0.5 + 0.5 * Math.pow(0.5 + 0.5 * Math.sin(t * 0.0011 + ph * 53), 3);
  const pulse = 1 + Math.sin(t * 0.002 + ph * 8) * 0.1;
  const R = r * pulse;
  // Glow suave (luminosidade), modulado pelo piscar — discreto.
  const glowR = R * (hov ? 6 : 3.6);
  const g = c.createRadialGradient(x, y, 0, x, y, glowR);
  g.addColorStop(0, col + hex2(0x2e * blink));
  g.addColorStop(0.16, col + hex2(0x14 * blink));
  g.addColorStop(0.5, col + hex2(0x06 * blink));
  g.addColorStop(1, 'transparent');
  c.beginPath();
  c.arc(x, y, glowR, 0, Math.PI * 2);
  c.fillStyle = g;
  c.fill();
  // Dot mais OPACO/mudo: cor sólida (não branco chapado) + miolo claro discreto
  // que pisca sutil (a luminosidade vem dele + do glow, sem estourar o branco).
  c.beginPath();
  c.arc(x, y, R, 0, Math.PI * 2);
  c.fillStyle = col + 'ff';
  c.fill();
  c.globalAlpha = 0.25 + blink * 0.45;
  c.beginPath();
  c.arc(x, y, R * 0.5, 0, Math.PI * 2);
  c.fillStyle = '#ffffff';
  c.fill();
  c.globalAlpha = 1;
  // Spikes (cruz) só no hover — fora dele, são só pontinhos limpos.
  const showSpikes = hov;
  const spikeLen = R * (hov ? 6 : 3.2);
  const spikeRot = Math.sin(t * 0.0005 + ph) * 0.05;
  for (let i = 0; showSpikes && i < 4; i++) {
    const angle = (i * Math.PI) / 2 + spikeRot;
    const ex = x + Math.cos(angle) * spikeLen;
    const ey = y + Math.sin(angle) * spikeLen;
    const sg = c.createLinearGradient(x, y, ex, ey);
    sg.addColorStop(0, `rgba(255,255,255,${hov ? 0.45 : 0.18})`);
    sg.addColorStop(1, 'transparent');
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(ex, ey);
    c.strokeStyle = sg;
    c.lineWidth = 0.8;
    c.stroke();
  }
}

function drawGalaxy(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  col: string,
  t: number,
  ph: number,
  hov: boolean,
): void {
  const p = 1 + Math.sin(t * 0.0008 + ph * 6) * 0.04;
  const R = r * 1.5;
  c.save();
  c.translate(x, y);
  c.rotate(ph * 3 + t * 0.00005);
  const arms = 2;
  const dots = 60;
  for (let a = 0; a < arms; a++) {
    const baseAngle = a * Math.PI;
    for (let i = 0; i < dots; i++) {
      const frac = i / dots;
      const angle = baseAngle + frac * Math.PI * 3 + t * 0.0001;
      const dist = frac * R * 3 * p;
      const spread = (0.5 + frac * 2) * R * 0.15;
      const dx = Math.cos(angle) * dist + Math.sin(ph * 30 + i) * spread;
      const dy = Math.sin(angle) * dist * 0.35 + Math.cos(ph * 30 + i * 1.3) * spread * 0.35;
      const alpha = (1 - frac * 0.7) * (hov ? 0.5 : 0.3);
      const sz = (1 - frac * 0.5) * R * 0.06;
      c.beginPath();
      c.arc(dx, dy, Math.max(0.3, sz), 0, Math.PI * 2);
      c.fillStyle = `rgba(255,255,255,${alpha})`;
      c.fill();
    }
  }
  const cg = c.createRadialGradient(0, 0, 0, 0, 0, R * 0.8);
  cg.addColorStop(0, '#ffffff40');
  cg.addColorStop(0.2, col + '18');
  cg.addColorStop(1, 'transparent');
  c.beginPath();
  c.arc(0, 0, R * 0.8, 0, Math.PI * 2);
  c.fillStyle = cg;
  c.fill();
  c.beginPath();
  c.arc(0, 0, R * 0.15, 0, Math.PI * 2);
  c.fillStyle = '#ffffffa0';
  c.fill();
  c.restore();
}

function drawBlackhole(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  _col: string,
  t: number,
  _ph: number,
  hov: boolean,
): void {
  const breath = 1 + Math.sin(t * 0.0008) * 0.03;
  const R = r * 1.2 * breath;
  const rot = t * 0.00015;

  // Layer 1: campo gravitacional (branco-azulado, frio)
  const fieldR = R * (hov ? 8 : 6);
  const field = c.createRadialGradient(x, y, R * 0.5, x, y, fieldR);
  field.addColorStop(0, 'rgba(255,255,255,0.05)');
  field.addColorStop(0.3, 'rgba(220,230,255,0.025)');
  field.addColorStop(0.6, 'rgba(180,200,255,0.012)');
  field.addColorStop(1, 'transparent');
  c.beginPath();
  c.arc(x, y, fieldR, 0, Math.PI * 2);
  c.fillStyle = field;
  c.fill();

  // Layer 2: disco de acreção (branco brilhante)
  c.save();
  c.translate(x, y);
  c.rotate(rot * 0.3);
  c.scale(1, 0.28);
  const outerDisk = R * 4.5 * breath;
  const dg1 = c.createRadialGradient(0, 0, R * 2, 0, 0, outerDisk);
  dg1.addColorStop(0, 'rgba(255,255,255,0.14)');
  dg1.addColorStop(0.5, 'rgba(240,245,255,0.07)');
  dg1.addColorStop(1, 'transparent');
  c.beginPath();
  c.arc(0, 0, outerDisk, 0, Math.PI * 2);
  c.fillStyle = dg1;
  c.fill();
  c.beginPath();
  c.arc(0, 0, R * 2.5 * breath, 0, Math.PI * 2);
  c.strokeStyle = 'rgba(255,255,255,0.28)';
  c.lineWidth = R * 0.25;
  c.stroke();
  c.beginPath();
  c.arc(0, 0, R * 1.8 * breath, 0, Math.PI * 2);
  c.strokeStyle = 'rgba(255,255,255,0.5)';
  c.lineWidth = R * 0.08;
  c.stroke();
  c.restore();

  // Layer 3: event horizon (continua preto puro)
  const evR = R * 0.9;
  const evGrad = c.createRadialGradient(x, y, 0, x, y, evR);
  evGrad.addColorStop(0, '#000000');
  evGrad.addColorStop(0.7, '#000000');
  evGrad.addColorStop(1, 'rgba(0,0,0,0.8)');
  c.beginPath();
  c.arc(x, y, evR, 0, Math.PI * 2);
  c.fillStyle = evGrad;
  c.fill();

  // Photon ring (branco brilhante)
  const photonGlow = c.createRadialGradient(x, y, evR * 0.85, x, y, evR * 1.35);
  photonGlow.addColorStop(0, 'transparent');
  photonGlow.addColorStop(0.4, 'rgba(255,255,255,0.4)');
  photonGlow.addColorStop(0.7, 'rgba(255,255,255,0.18)');
  photonGlow.addColorStop(1, 'transparent');
  c.beginPath();
  c.arc(x, y, evR * 1.35, 0, Math.PI * 2);
  c.fillStyle = photonGlow;
  c.fill();
  c.beginPath();
  c.arc(x, y, evR, 0, Math.PI * 2);
  c.strokeStyle = `rgba(255,255,255,${hov ? 0.85 : 0.6})`;
  c.lineWidth = hov ? 2.5 : 1.8;
  c.stroke();

  // Lensing arcs (branco)
  const lensAlpha = hov ? 0.3 : 0.18;
  c.beginPath();
  c.arc(x, y, evR * 1.1, -Math.PI * 0.75, -Math.PI * 0.15);
  c.strokeStyle = `rgba(255,255,255,${lensAlpha})`;
  c.lineWidth = 2.5;
  c.stroke();
  c.beginPath();
  c.arc(x, y, evR * 1.15, Math.PI * 0.2, Math.PI * 0.7);
  c.strokeStyle = `rgba(255,255,255,${lensAlpha * 0.7})`;
  c.lineWidth = 1.5;
  c.stroke();

  // Particles sendo puxadas (branco brilhante)
  const particleCount = hov ? 24 : 16;
  for (let i = 0; i < particleCount; i++) {
    const baseAngle = (Math.PI * 2 * i) / particleCount + rot;
    const spiralProgress = (t * 0.0005 + i * 0.4) % 1;
    const dist = R * (1.5 + spiralProgress * 4);
    const spiralAngle = baseAngle + spiralProgress * 1.5;
    const px = x + Math.cos(spiralAngle) * dist;
    const py = y + Math.sin(spiralAngle) * dist * 0.3;
    const alpha = (1 - spiralProgress) * 0.45;
    const sz = (1 - spiralProgress) * 1.3 + 0.3;
    c.beginPath();
    c.arc(px, py, sz, 0, Math.PI * 2);
    c.fillStyle = `rgba(255,255,255,${alpha})`;
    c.fill();
  }
}

function drawNebula(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  col: string,
  t: number,
  ph: number,
  hov: boolean,
): void {
  for (let i = 0; i < 5; i++) {
    const phase = t * 0.0003 + ph * 5 + i * 1.8;
    const ox = Math.cos(phase) * r * 0.5;
    const oy = Math.sin(phase * 1.3) * r * 0.4;
    const nr = r * (1.2 + i * 0.5) * (1 + Math.sin(t * 0.001 + i) * 0.08);
    const ng = c.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, nr);
    const alpha = (i === 0 ? 0.1 : 0.05) * (hov ? 1.5 : 1);
    ng.addColorStop(
      0,
      col +
        Math.round(alpha * 255)
          .toString(16)
          .padStart(2, '0'),
    );
    ng.addColorStop(0.5, col + '06');
    ng.addColorStop(1, 'transparent');
    c.beginPath();
    c.arc(x + ox, y + oy, nr, 0, Math.PI * 2);
    c.fillStyle = ng;
    c.fill();
  }
  const coreR = r * 0.35;
  const cg = c.createRadialGradient(x, y, 0, x, y, coreR);
  cg.addColorStop(0, '#ffffff50');
  cg.addColorStop(0.5, col + '25');
  cg.addColorStop(1, 'transparent');
  c.beginPath();
  c.arc(x, y, coreR, 0, Math.PI * 2);
  c.fillStyle = cg;
  c.fill();
  c.beginPath();
  c.arc(x, y, r * 0.08, 0, Math.PI * 2);
  c.fillStyle = '#ffffff70';
  c.fill();
}

function drawComet(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  col: string,
  t: number,
  ph: number,
  hov: boolean,
): void {
  const tailA = Math.PI + t * 0.00008 + ph;
  const tailL = r * (hov ? 8 : 5);
  const tg = c.createLinearGradient(x, y, x + Math.cos(tailA) * tailL, y + Math.sin(tailA) * tailL);
  tg.addColorStop(0, 'rgba(255,255,255,0.25)');
  tg.addColorStop(0.5, 'rgba(255,255,255,0.06)');
  tg.addColorStop(1, 'transparent');
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x + Math.cos(tailA) * tailL, y + Math.sin(tailA) * tailL);
  c.strokeStyle = tg;
  c.lineWidth = r * 1.2;
  c.stroke();
  const cg = c.createRadialGradient(x, y, 0, x, y, r * 2);
  cg.addColorStop(0, '#ffffff30');
  cg.addColorStop(0.5, col + '10');
  cg.addColorStop(1, 'transparent');
  c.beginPath();
  c.arc(x, y, r * 2, 0, Math.PI * 2);
  c.fillStyle = cg;
  c.fill();
  c.beginPath();
  c.arc(x, y, r * 0.8, 0, Math.PI * 2);
  c.fillStyle = '#ffffffd0';
  c.fill();
}

// Planetas REAIS — cada repo vira um planeta nomeado (cor/bandas/anéis de
// verdade). A identidade é determinística pelo id; o `color` do corpo carrega o
// `atmo` (cor única por tipo), e o drawPlanet reverte pro def completo.
interface PlanetDef {
  atmo: string;
  cols: [string, string, string]; // [destaque iluminado, meio, sombra]
  bands?: boolean;
  continents?: boolean;
  clouds?: boolean;
  rings?: boolean;
  ringCol?: string;
}
const PLANET_DEFS: PlanetDef[] = [
  // Terra — oceano profundo, continentes verdes/marrons, nuvens (azul realista).
  {
    atmo: '#4f9bff',
    cols: ['#8fc8f0', '#1c5fb0', '#08203e'],
    continents: true,
    clouds: true,
  },
  // Marte
  { atmo: '#e0875a', cols: ['#f2ab7a', '#b5532e', '#5e2a16'] },
  // Júpiter
  { atmo: '#e8c89a', cols: ['#f4e4be', '#caa56e', '#7e5a32'], bands: true },
  // Saturno (com anéis)
  {
    atmo: '#ecd9a0',
    cols: ['#f6ead0', '#dcc28e', '#8a7040'],
    bands: true,
    rings: true,
    ringCol: '228,216,182',
  },
  // Netuno — mundo-oceano azul profundo com continentes e nuvens.
  {
    atmo: '#5a86ff',
    cols: ['#74a6f0', '#1e4ba8', '#0a1f56'],
    continents: true,
    clouds: true,
  },
  // Vênus
  { atmo: '#f0c98a', cols: ['#fdeccc', '#e0bd84', '#9a7842'] },
];
const PLANET_BY_ATMO = new Map(PLANET_DEFS.map((d) => [d.atmo, d]));
function planetKindFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return PLANET_DEFS[Math.abs(h) % PLANET_DEFS.length].atmo;
}

/**
 * Anéis de Saturno — elipse inclinada, dividida back/front pra dar occlusão, com
 * "glints" (partículas) orbitando que dão a sensação dos anéis GIRANDO.
 */
function drawRing(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  R: number,
  rgb: string,
  front: boolean,
  t: number,
): void {
  const ry = 0.34; // achatamento do anel
  c.save();
  c.translate(x, y);
  c.rotate(-0.32);
  const start = front ? 0 : Math.PI;
  const end = front ? Math.PI : Math.PI * 2;
  for (const ring of [
    { ro: 2.25, w: 0.3, a: 0.45 },
    { ro: 1.85, w: 0.34, a: 0.7 },
    { ro: 1.48, w: 0.2, a: 0.4 },
  ]) {
    c.beginPath();
    c.ellipse(0, 0, R * ring.ro, R * ring.ro * ry, 0, start, end);
    c.strokeStyle = `rgba(${rgb},${ring.a * (front ? 1 : 0.55)})`;
    c.lineWidth = Math.max(1, R * ring.w);
    c.stroke();
  }
  // Glints orbitando (anel girando). sin(a)>=0 = metade da frente.
  const spin = t * 0.0009;
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + spin;
    if (Math.sin(a) >= 0 !== front) continue;
    const ro = 1.5 + ((i * 7) % 8) * 0.1; // espalha entre os anéis
    const px = Math.cos(a) * R * ro;
    const py = Math.sin(a) * R * ro * ry;
    c.beginPath();
    c.arc(px, py, Math.max(0.4, R * 0.035), 0, Math.PI * 2);
    c.fillStyle = `rgba(${rgb},${(front ? 0.7 : 0.4) * (0.5 + 0.5 * Math.abs(Math.sin(a)))})`;
    c.fill();
  }
  c.restore();
}

/**
 * Planeta REAL (só pros repos) — esfera iluminada (gradiente de cor do planeta,
 * terminator embutido), bandas (gasosos), continentes (Terra), anéis (Saturno),
 * rim light e specular. `col` carrega o `atmo` que identifica o tipo.
 */
function drawPlanet(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  col: string,
  t: number,
  ph: number,
  hov: boolean,
): void {
  const def = PLANET_BY_ATMO.get(col) ?? PLANET_DEFS[0];
  const breath = 1 + Math.sin(t * 0.0015 + ph * 10) * 0.02;
  const R = r * breath;
  // Durante o "bloom" o corpo nasce com raio ~0 — evita raio negativo no canvas.
  if (R < 1) {
    if (R > 0.2) {
      c.beginPath();
      c.arc(x, y, R, 0, Math.PI * 2);
      c.fillStyle = def.cols[1];
      c.fill();
    }
    return;
  }

  // Atmosfera.
  const aR = R * (hov ? 2.0 : 1.5);
  const atmo = c.createRadialGradient(x, y, R * 0.84, x, y, aR);
  atmo.addColorStop(0, def.atmo + '2e');
  atmo.addColorStop(1, 'transparent');
  c.beginPath();
  c.arc(x, y, aR, 0, Math.PI * 2);
  c.fillStyle = atmo;
  c.fill();

  // Anéis traseiros (Saturno).
  if (def.rings) drawRing(c, x, y, R, def.ringCol ?? '228,216,182', false, t);

  // Esfera iluminada (luz vinda de baixo-esquerda → terminator embutido).
  const lx = x - R * 0.32;
  const ly = y + R * 0.28;
  const g = c.createRadialGradient(lx, ly, R * 0.1, x, y, R * 1.06);
  g.addColorStop(0, def.cols[0]);
  g.addColorStop(0.6, def.cols[1]);
  g.addColorStop(1, def.cols[2]);
  c.beginPath();
  c.arc(x, y, R, 0, Math.PI * 2);
  c.fillStyle = g;
  c.fill();

  // Bandas (gigantes gasosos).
  if (def.bands && R > 5) {
    c.save();
    c.beginPath();
    c.arc(x, y, R, 0, Math.PI * 2);
    c.clip();
    for (let i = 0; i < 4; i++) {
      c.beginPath();
      c.ellipse(x, y + (i - 1.5) * R * 0.34, R, R * 0.12, 0, 0, Math.PI * 2);
      c.fillStyle = i % 2 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
      c.fill();
    }
    c.restore();
  }

  // Continentes (Terra/Netuno) — massas de terra irregulares, espalhadas sem
  // simetria. PRNG determinístico por planeta (seed = fase do corpo): cada
  // continente é um cacho de 2-3 blobs sólidos sobrepostos que se fundem num
  // contorno irregular, com posição/rotação descorrelacionadas (sem "flor").
  if (def.continents && R > 5) {
    const rnd = (n: number): number => {
      const v = Math.sin(ph * 127.1 + n * 311.7) * 43758.5453;
      return v - Math.floor(v);
    };
    c.save();
    c.beginPath();
    c.arc(x, y, R, 0, Math.PI * 2);
    c.clip();
    const LAND = ['#2f7a3c', '#356b2a', '#6b5a30'];
    for (let i = 0; i < 4; i++) {
      const ang = rnd(i * 7 + 1) * Math.PI * 2;
      const dist = (0.06 + rnd(i * 7 + 2) * 0.52) * R;
      const bx = x + Math.cos(ang) * dist;
      const by = y + Math.sin(ang) * dist;
      const base = R * (0.15 + rnd(i * 7 + 3) * 0.12);
      c.fillStyle = LAND[i % LAND.length];
      const blobs = 2 + Math.floor(rnd(i * 7 + 4) * 2);
      for (let j = 0; j < blobs; j++) {
        c.beginPath();
        c.ellipse(
          bx + (rnd(i * 7 + j + 10) - 0.5) * base * 1.4,
          by + (rnd(i * 7 + j + 20) - 0.5) * base * 1.4,
          base * (0.6 + rnd(i * 7 + j + 30) * 0.6),
          base * (0.45 + rnd(i * 7 + j + 40) * 0.5),
          rnd(i * 7 + j + 50) * Math.PI,
          0,
          Math.PI * 2,
        );
        c.fill();
      }
    }
    c.restore();
  }

  // Nuvens (Terra/Netuno) — wisps brancos suaves, espalhados.
  if (def.clouds && R > 5) {
    const rndc = (n: number): number => {
      const v = Math.sin(ph * 91.3 + n * 47.9) * 24634.6345;
      return v - Math.floor(v);
    };
    c.save();
    c.beginPath();
    c.arc(x, y, R, 0, Math.PI * 2);
    c.clip();
    c.globalAlpha = 0.13;
    c.fillStyle = '#ffffff';
    for (let i = 0; i < 5; i++) {
      const ang = rndc(i * 5 + 1) * Math.PI * 2;
      const dist = rndc(i * 5 + 2) * 0.72 * R;
      c.beginPath();
      c.ellipse(
        x + Math.cos(ang) * dist,
        y + Math.sin(ang) * dist,
        R * (0.18 + rndc(i * 5 + 3) * 0.22),
        R * (0.07 + rndc(i * 5 + 4) * 0.08),
        rndc(i * 5 + 5) * Math.PI,
        0,
        Math.PI * 2,
      );
      c.fill();
    }
    c.globalAlpha = 1;
    c.restore();
  }

  // Specular (lado iluminado).
  c.beginPath();
  c.arc(x - R * 0.32, y + R * 0.28, R * 0.13, 0, Math.PI * 2);
  c.fillStyle = 'rgba(255,255,255,0.16)';
  c.fill();

  // Rim light fino no limbo iluminado.
  c.beginPath();
  c.arc(x, y, R - 0.4, Math.PI * 0.42, Math.PI * 1.18);
  c.strokeStyle = 'rgba(255,255,255,0.26)';
  c.lineWidth = 1.3;
  c.stroke();

  // Anéis frontais (Saturno).
  if (def.rings) drawRing(c, x, y, R, def.ringCol ?? '228,216,182', true, t);

  if (hov) {
    c.beginPath();
    c.arc(x, y, R + 6, 0, Math.PI * 2);
    c.strokeStyle = def.atmo + '70';
    c.lineWidth = 1.4;
    c.setLineDash([3, 4]);
    c.lineDashOffset = -t * 0.01;
    c.stroke();
    c.setLineDash([]);
  }
}

const DRAW: Record<
  string,
  (
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    col: string,
    t: number,
    ph: number,
    hov: boolean,
  ) => void
> = {
  moon: drawMoon,
  planet: drawPlanet,
  star: drawStar,
  galaxy: drawGalaxy,
  blackhole: drawBlackhole,
  nebula: drawNebula,
  comet: drawComet,
};

// ============================================================================
// Main render
// ============================================================================

function render(
  ctx: CanvasRenderingContext2D,
  bb: Body[],
  cc: Conn[],
  stars: Star[],
  meteors: Meteor[],
  w: number,
  h: number,
  hov: string | null,
  selected: string | null,
  px: number,
  py: number,
  z: number,
  t: number,
  fadeIn = 1,
): void {
  // Limpa — fundo vem do CSS bg-background (cinza do app); sem vinheta nem
  // gradiente central pra não criar a "mancha oval cinza" no meio.
  ctx.clearRect(0, 0, w, h);

  // Nebulosas SOMENTE nos cantos (longe do centro), bem fracas — só pra dar
  // textura espacial sutil. Removidas as que estavam no meio.
  for (const n of [
    { x: 0.12, y: 0.18, r: 0.35, c: '50,30,90', a: 0.025 },
    { x: 0.88, y: 0.85, r: 0.32, c: '20,55,85', a: 0.022 },
    { x: 0.92, y: 0.12, r: 0.25, c: '60,35,70', a: 0.018 },
    { x: 0.08, y: 0.88, r: 0.28, c: '30,45,65', a: 0.02 },
  ]) {
    const g = ctx.createRadialGradient(w * n.x, h * n.y, 0, w * n.x, h * n.y, w * n.r);
    g.addColorStop(0, `rgba(${n.c},${n.a})`);
    g.addColorStop(0.5, `rgba(${n.c},${n.a * 0.4})`);
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  // Estrelas
  for (const s of stars) {
    const tw = 0.35 + Math.sin(t * 0.0006 * s.sp + s.b * 50) * 0.3;
    const a = Math.max(0, tw * s.b);
    if (a < 0.015) continue;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.s, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(240,245,255,${Math.min(a * 1.3, 1)})`;
    ctx.fill();
    if (s.spike && a > 0.2) {
      const sLen = s.s * 8;
      ctx.strokeStyle = `rgba(255,255,255,${a * 0.35})`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(s.x - sLen, s.y);
      ctx.lineTo(s.x + sLen, s.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - sLen);
      ctx.lineTo(s.x, s.y + sLen);
      ctx.stroke();
    }
  }

  // Meteoros
  for (const m of meteors) {
    if (m.life <= 0) continue;
    const a = (m.life / m.max) * 0.5;
    const ex = m.x + Math.cos(m.a) * m.len;
    const ey = m.y + Math.sin(m.a) * m.len;
    const g = ctx.createLinearGradient(m.x, m.y, ex, ey);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(1, 'transparent');
    ctx.beginPath();
    ctx.moveTo(m.x, m.y);
    ctx.lineTo(ex, ey);
    ctx.strokeStyle = g;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    m.x += Math.cos(m.a) * m.sp;
    m.y += Math.sin(m.a) * m.sp;
    m.life--;
  }

  // Dust particles drifting (sutil)
  const dustCount = 40;
  for (let i = 0; i < dustCount; i++) {
    const seed = i * 137.508;
    const orbit = 80 + (seed % 400);
    const angle = seed + t * 0.00003 * (1 + (i % 3) * 0.5);
    const dx2 = Math.cos(angle) * orbit + w * 0.5;
    const dy2 = Math.sin(angle) * orbit + h * 0.5;
    const sz = 0.3 + (seed % 1.2);
    const dustAlpha = 0.08 + Math.sin(t * 0.001 + seed) * 0.04;
    ctx.beginPath();
    ctx.arc(dx2, dy2, sz, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${dustAlpha})`;
    ctx.fill();
  }

  ctx.save();
  ctx.translate(px, py);
  ctx.scale(z, z);
  ctx.globalAlpha = fadeIn;

  const map = new Map(bb.map((s) => [s.id, s]));

  const hovNeighbors = new Set<string>();
  const selNeighbors = new Set<string>();
  if (hov) {
    for (const c of cc) {
      if (c.source === hov) hovNeighbors.add(c.target);
      if (c.target === hov) hovNeighbors.add(c.source);
    }
  }
  if (selected) {
    for (const c of cc) {
      if (c.source === selected) selNeighbors.add(c.target);
      if (c.target === selected) selNeighbors.add(c.source);
    }
  }

  // Conexões
  for (const c of cc) {
    const a = map.get(c.source);
    const b = map.get(c.target);
    if (!a || !b) continue;

    const isHovConn = hov === a.id || hov === b.id;
    const isSelConn = selected !== null && (a.id === selected || b.id === selected);
    const hi = isHovConn || isSelConn;
    const isBlackHoleConn = a.form === 'blackhole' || b.form === 'blackhole';

    // Aresta de entidade: sem linha (poeira de estrelas). Só desenha no hover/seleção.
    if (c.faint && !hi) continue;

    if (selected && !isSelConn && !isHovConn) {
      ctx.globalAlpha = fadeIn * 0.035;
    } else {
      ctx.globalAlpha = fadeIn;
    }

    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const curveAmount = Math.min(dist * 0.15, 40);
    const nx = -dy / dist;
    const ny = dx / dist;
    const cpx = mx + nx * curveAmount;
    const cpy = my + ny * curveAmount;

    if (hi) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cpx, cpy, b.x, b.y);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cpx, cpy, b.x, b.y);
      ctx.strokeStyle = isBlackHoleConn ? 'rgba(255,200,100,0.35)' : 'rgba(255,255,255,0.3)';
      ctx.lineWidth = isSelConn ? 2 : 1.5;
      ctx.setLineDash([5, 4]);
      ctx.lineDashOffset = -t * 0.015;
      ctx.stroke();
      ctx.setLineDash([]);

      const particleProg = (t * 0.0004) % 1;
      const pt = 1 - particleProg;
      const epx = (1 - pt) * (1 - pt) * a.x + 2 * (1 - pt) * pt * cpx + pt * pt * b.x;
      const epy = (1 - pt) * (1 - pt) * a.y + 2 * (1 - pt) * pt * cpy + pt * pt * b.y;
      ctx.beginPath();
      ctx.arc(epx, epy, 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fill();

      if (c.label) {
        ctx.font = '9px -apple-system,sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.textAlign = 'center';
        ctx.fillText(c.label, cpx, cpy - 7);
      }
    } else {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cpx, cpy, b.x, b.y);
      ctx.strokeStyle = isBlackHoleConn ? 'rgba(255,200,100,0.05)' : 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
    ctx.globalAlpha = fadeIn;
  }

  const connectedIds = new Set<string>();
  for (const c of cc) {
    connectedIds.add(c.source);
    connectedIds.add(c.target);
  }

  // Bodies
  for (const b of bb) {
    const isH = hov === b.id;
    const isHoverNeighbor = hovNeighbors.has(b.id);
    const isSel = selected === b.id;
    const isSelNeighbor = selNeighbors.has(b.id);
    const isOrphan = !connectedIds.has(b.id);
    const spawnAlpha = b.age < SPAWN_FRAMES ? (b.age / SPAWN_FRAMES) * (b.age / SPAWN_FRAMES) : 1;

    let alpha = 1;
    if (selected) {
      if (isSel) alpha = 1;
      else if (isSelNeighbor) alpha = 0.85;
      else if (isH) alpha = 0.7;
      else alpha = 0.1;
    } else if (hov && !isH && !isHoverNeighbor) {
      alpha = 0.25;
    }
    if (isOrphan && !isH && !isSel) alpha = Math.min(alpha, 0.4);
    alpha *= spawnAlpha;

    ctx.globalAlpha = alpha;
    const fn = DRAW[b.form] || drawStar;
    fn(ctx, b.x, b.y, b.mass, b.color, t, b.ph, isH || isSel);

    if (isSel) {
      ctx.globalAlpha = 0.55;
      const selR = b.mass * (b.form === 'galaxy' ? 4 : b.form === 'blackhole' ? 3.5 : 2.5) + 14;
      ctx.beginPath();
      ctx.arc(b.x, b.y, selR, 0, Math.PI * 2);
      ctx.strokeStyle = b.color + '70';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.lineDashOffset = -t * 0.012;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;

    const ly = b.mass * (b.form === 'galaxy' ? 4 : b.form === 'blackhole' ? 3.5 : 2.2) + 10;
    const showLabel = isSel || isH || (z > 0.55 && b.mass > 5) || z > 0.85;
    if (showLabel && alpha > 0.08) {
      const labelAlpha = isSel ? 0.9 : isH ? 0.85 : isSelNeighbor ? 0.55 : Math.min(alpha, 0.5);
      ctx.font = `${isSel || isH ? '500 11px' : '10px'} -apple-system,BlinkMacSystemFont,sans-serif`;
      ctx.fillStyle = `rgba(255,255,255,${labelAlpha})`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(b.label, b.x, b.y + ly);
    }
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}
