// @refresh reset
// ↑ força o React Fast Refresh a REMONTAR este componente a cada edição.
// Sem isso, o useEffect com [] mantém o canvas/animation antigos em memória
// e edições no fundo só apareceriam após reabrir o app.

import { useEffect, useRef } from 'react';

/**
 * Fundo de galáxia em estilo cartoon — preto profundo com tons cinza/roxo,
 * estrelas redondas suaves com twinkle leve, parallax em 3 camadas e
 * estrelas cadentes ocasionais cortando a cena.
 *
 * Princípios:
 *  - Sem cruzes / cross-shine — só pontos com halo radial.
 *  - Sem pulsar agressivo na nebulosa — manchas estáticas com derive lento.
 *  - Movimento contínuo: três camadas de estrelas com velocidades diferentes
 *    (parallax) + meteoros raros.
 */
export function GalaxyBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let width = 0;
    let height = 0;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let startTs = 0;

    type Cloud = {
      x: number;
      y: number;
      r: number;
      hue: 'gray' | 'purple' | 'deepPurple';
      vx: number;
      vy: number;
    };

    type Star = {
      x: number;
      y: number;
      r: number;
      base: number;
      twinkle: number;
      phase: number;
      twinkleSpeed: number;
      vx: number; // velocidade de parallax horizontal
      vy: number;
      purple: boolean;
      layer: number; // 0 = distante, 2 = próxima
    };

    type Shooting = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      len: number;
      life: number;
      max: number;
    };

    // "Supernova" — uma erupção de luz lenta, composta de um núcleo central
    // pequeno e vários puffs de nuvem ao redor que vão clareando e dispersando.
    type LightningPuff = {
      dx: number; // offset relativo ao centro
      dy: number;
      r: number;
      phase: number; // 0..1 — atraso pra puff entrar (cascata)
    };
    type Lightning = {
      x: number;
      y: number;
      coreR: number; // raio do núcleo brilhante
      angle: number;
      life: number;
      max: number;
      strength: number;
      purple: boolean;
      puffs: LightningPuff[];
    };

    let clouds: Cloud[] = [];
    let stars: Star[] = [];
    let shootings: Shooting[] = [];
    let lightnings: Lightning[] = [];
    let nextShootingAt = 0;
    let nextLightningAt = 0;

    function rand(min: number, max: number) {
      return Math.random() * (max - min) + min;
    }

    function seed() {
      clouds = [];
      stars = [];
      shootings = [];

      // Nebulosa — agora 100% em tons cinza/neutros (sem roxo) pra combinar
      // com a paleta do dashboard. Profundidade vem de variações de luminância.
      const cloudCount = 26;
      for (let i = 0; i < cloudCount; i++) {
        const sizeRoll = Math.random();
        const r =
          sizeRoll < 0.3
            ? rand(width * 0.45, width * 0.8)
            : sizeRoll < 0.7
              ? rand(width * 0.25, width * 0.45)
              : rand(width * 0.12, width * 0.25);

        clouds.push({
          x: rand(-width * 0.2, width * 1.2),
          y: rand(-height * 0.15, height * 1.15),
          r,
          // Mantemos os 3 buckets de luminância (gray claro / médio / profundo)
          // pra dar profundidade — mas todos em tons neutros, sem matiz roxa.
          hue: Math.random() < 0.5 ? 'gray' : Math.random() < 0.7 ? 'purple' : 'deepPurple',
          vx: rand(-0.035, 0.035),
          vy: rand(-0.022, 0.022),
        });
      }

      // Três camadas de estrelas com velocidades diferentes (parallax) —
      // menos densas e mais discretas pra não competir com a nebulosa
      const density = (width * height) / 8500;
      for (let i = 0; i < density; i++) {
        const layerRoll = Math.random();
        const layer = layerRoll < 0.6 ? 0 : layerRoll < 0.9 ? 1 : 2;
        const layerSpeed = layer === 0 ? 0.04 : layer === 1 ? 0.11 : 0.22;

        stars.push({
          x: rand(0, width),
          y: rand(0, height),
          r: layer === 0 ? rand(0.25, 0.55) : layer === 1 ? rand(0.5, 0.9) : rand(0.9, 1.35),
          base: layer === 0 ? rand(0.12, 0.28) : layer === 1 ? rand(0.22, 0.45) : rand(0.4, 0.62),
          twinkle: rand(0.06, 0.18),
          phase: rand(0, Math.PI * 2),
          twinkleSpeed: rand(0.0006, 0.0016),
          vx: layerSpeed * rand(0.6, 1.2),
          vy: layerSpeed * rand(-0.15, 0.15),
          purple: Math.random() < (layer === 2 ? 0.28 : 0.08),
          layer,
        });
      }

      const now = performance.now();
      nextShootingAt = now + rand(1500, 4500);
      nextLightningAt = now + rand(5000, 9000);
    }

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      const newW = rect.width;
      const newH = rect.height;
      if (newW <= 0 || newH <= 0) return;

      // Sem mudança real? Sair cedo pra não reprocessar.
      if (Math.abs(newW - width) < 0.5 && Math.abs(newH - height) < 0.5) {
        return;
      }

      // Primeira inicialização — semeia entidades
      const firstRun = stars.length === 0;
      if (firstRun) {
        width = newW;
        height = newH;
      }

      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.floor(newW * dpr);
      canvas!.height = Math.floor(newH * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (firstRun) {
        seed();
      } else {
        // Re-escalar posições proporcionalmente — sem regenerar
        const sx = newW / width;
        const sy = newH / height;
        for (const s of stars) {
          s.x *= sx;
          s.y *= sy;
        }
        for (const c of clouds) {
          c.x *= sx;
          c.y *= sy;
          c.r *= sx;
        }
        width = newW;
        height = newH;
      }

      // CRÍTICO pro flicker: mudar canvas.width limpa o buffer pro próximo
      // RAF. Desenhamos UMA frame síncrona aqui pra que a tela nunca apareça
      // vazia/preta durante o drag.
      const t = lastTs ? lastTs - (startTs || lastTs) : 0;
      drawBackground();
      drawClouds(0);
      drawLightnings(performance.now(), 0);
      drawStars(t, 0);
      drawShootings(performance.now());
    }

    function spawnLightning() {
      // 70% roxo, 30% cinza-azulado
      const purple = Math.random() < 0.7;
      const coreR = rand(width * 0.05, width * 0.09);

      // Gera 5–8 puffs ao redor do núcleo com offsets em órbita irregular —
      // dão a sensação de nuvem em volta de uma supernova.
      const puffCount = Math.floor(rand(5, 9));
      const puffs: LightningPuff[] = [];
      for (let i = 0; i < puffCount; i++) {
        const ang = (i / puffCount) * Math.PI * 2 + rand(-0.6, 0.6);
        const dist = coreR * rand(1.5, 4.2);
        puffs.push({
          dx: Math.cos(ang) * dist,
          dy: Math.sin(ang) * dist * rand(0.55, 0.9), // achata vertical
          r: coreR * rand(2.2, 4.0),
          phase: rand(0, 0.35),
        });
      }

      lightnings.push({
        x: rand(width * 0.12, width * 0.88),
        y: rand(height * 0.18, height * 0.82),
        coreR,
        angle: rand(-Math.PI / 5, Math.PI / 5),
        life: 0,
        // Duração mais longa — "respirar" da explosão (4.5–6.5s)
        max: rand(4500, 6500),
        // Bem mais sutil — pico entre 0.07 e 0.12
        strength: rand(0.07, 0.12),
        purple,
        puffs,
      });
    }

    function drawLightnings(now: number, dt: number) {
      if (now > nextLightningAt) {
        spawnLightning();
        // Mais espaçado — 7 a 13 segundos entre supernovas
        nextLightningAt = now + rand(7000, 13000);
      }

      ctx!.globalCompositeOperation = 'screen';
      for (let i = lightnings.length - 1; i >= 0; i--) {
        const l = lightnings[i];
        l.life += dt;
        const p = l.life / l.max;
        if (p >= 1) {
          lightnings.splice(i, 1);
          continue;
        }

        // Curva geral da supernova — sobe devagar (28%), platô curto, cai lento
        const overallCurve =
          p < 0.28 ? Math.pow(p / 0.28, 0.85) : Math.pow(1 - (p - 0.28) / 0.72, 1.4);

        ctx!.save();
        ctx!.translate(l.x, l.y);
        ctx!.rotate(l.angle);

        // Núcleo brilhante — pico no início, some antes dos puffs
        const coreCurve =
          p < 0.18 ? Math.pow(p / 0.18, 0.7) : Math.pow(1 - Math.min(1, (p - 0.18) / 0.45), 1.8);
        const coreAlpha = coreCurve * l.strength * 0.9;
        if (coreAlpha > 0.001) {
          const coreGrad = ctx!.createRadialGradient(0, 0, 0, 0, 0, l.coreR * 2.2);
          // Supernovas em tons branco/cinza neutros — sem matiz roxa
          if (l.purple) {
            coreGrad.addColorStop(0, `rgba(235, 238, 245, ${coreAlpha * 1.2})`);
            coreGrad.addColorStop(0.4, `rgba(180, 185, 200, ${coreAlpha * 0.8})`);
            coreGrad.addColorStop(1, 'rgba(0,0,0,0)');
          } else {
            coreGrad.addColorStop(0, `rgba(220, 222, 230, ${coreAlpha * 1.05})`);
            coreGrad.addColorStop(0.4, `rgba(160, 162, 175, ${coreAlpha * 0.7})`);
            coreGrad.addColorStop(1, 'rgba(0,0,0,0)');
          }
          ctx!.fillStyle = coreGrad;
          ctx!.beginPath();
          ctx!.arc(0, 0, l.coreR * 2.2, 0, Math.PI * 2);
          ctx!.fill();
        }

        // Puffs de nuvem — expandem ao longo do tempo (sensação de explosão lenta)
        for (const puff of l.puffs) {
          // Cada puff entra com pequeno atraso e expande até ~1.6x
          const localP = Math.max(0, Math.min(1, (p - puff.phase * 0.5) / (1 - puff.phase * 0.5)));
          if (localP <= 0) continue;
          const puffCurve =
            localP < 0.32
              ? Math.pow(localP / 0.32, 0.9)
              : Math.pow(1 - (localP - 0.32) / 0.68, 1.5);
          const puffAlpha = puffCurve * l.strength * 0.65 * overallCurve;
          if (puffAlpha < 0.001) continue;

          const expand = 0.85 + localP * 0.75; // 0.85 → 1.6
          const px = puff.dx * expand;
          const py = puff.dy * expand;
          const pr = puff.r * expand;

          const puffGrad = ctx!.createRadialGradient(px, py, 0, px, py, pr);
          // Puffs também 100% cinza — sem matiz roxa
          if (l.purple) {
            puffGrad.addColorStop(0, `rgba(160, 165, 180, ${puffAlpha})`);
            puffGrad.addColorStop(0.4, `rgba(100, 105, 120, ${puffAlpha * 0.55})`);
            puffGrad.addColorStop(0.8, `rgba(55, 58, 70, ${puffAlpha * 0.2})`);
            puffGrad.addColorStop(1, 'rgba(0,0,0,0)');
          } else {
            puffGrad.addColorStop(0, `rgba(140, 142, 155, ${puffAlpha})`);
            puffGrad.addColorStop(0.4, `rgba(85, 87, 100, ${puffAlpha * 0.5})`);
            puffGrad.addColorStop(1, 'rgba(0,0,0,0)');
          }
          ctx!.fillStyle = puffGrad;
          ctx!.beginPath();
          ctx!.arc(px, py, pr, 0, Math.PI * 2);
          ctx!.fill();
        }

        ctx!.restore();
      }
      ctx!.globalCompositeOperation = 'source-over';
    }

    function spawnShooting() {
      // Vem do topo-esquerdo / topo-direito e cruza diagonal
      const fromLeft = Math.random() < 0.5;
      const startX = fromLeft ? rand(-50, width * 0.3) : rand(width * 0.7, width + 50);
      const startY = rand(-30, height * 0.4);
      const speed = rand(7, 12);
      const angle = fromLeft
        ? rand(Math.PI * 0.18, Math.PI * 0.32)
        : rand(Math.PI * 0.68, Math.PI * 0.82);
      shootings.push({
        x: startX,
        y: startY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        len: rand(80, 160),
        life: 0,
        max: rand(60, 110),
      });
    }

    function drawBackground() {
      // Preto absoluto — vinheta forte, sem brilho central
      const base = ctx!.createRadialGradient(
        width * 0.5,
        height * 0.55,
        0,
        width * 0.5,
        height * 0.5,
        Math.max(width, height) * 0.95,
      );
      base.addColorStop(0, '#040308');
      base.addColorStop(0.45, '#020104');
      base.addColorStop(1, '#000000');
      ctx!.fillStyle = base;
      ctx!.fillRect(0, 0, width, height);
    }

    function drawClouds(dt: number) {
      ctx!.globalCompositeOperation = 'screen';
      for (const c of clouds) {
        c.x += c.vx * dt * 0.06;
        c.y += c.vy * dt * 0.06;
        // Wrap
        if (c.x < -c.r) c.x = width + c.r;
        if (c.x > width + c.r) c.x = -c.r;
        if (c.y < -c.r) c.y = height + c.r;
        if (c.y > height + c.r) c.y = -c.r;

        const grad = ctx!.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
        // Três níveis de luminância em tons neutros — sem mais matiz roxa.
        if (c.hue === 'gray') {
          grad.addColorStop(0, 'rgba(140, 142, 150, 0.05)');
          grad.addColorStop(0.4, 'rgba(80, 82, 90, 0.025)');
          grad.addColorStop(1, 'rgba(10, 10, 14, 0)');
        } else if (c.hue === 'purple') {
          // Cinza médio (era roxo)
          grad.addColorStop(0, 'rgba(110, 112, 122, 0.06)');
          grad.addColorStop(0.4, 'rgba(60, 62, 70, 0.03)');
          grad.addColorStop(1, 'rgba(8, 8, 12, 0)');
        } else {
          // Cinza profundo (era roxo profundo)
          grad.addColorStop(0, 'rgba(85, 87, 95, 0.08)');
          grad.addColorStop(0.4, 'rgba(45, 47, 55, 0.035)');
          grad.addColorStop(1, 'rgba(5, 5, 10, 0)');
        }
        ctx!.fillStyle = grad;
        ctx!.beginPath();
        ctx!.arc(c.x, c.y, c.r, 0, Math.PI * 2);
        ctx!.fill();
      }
      ctx!.globalCompositeOperation = 'source-over';
    }

    function drawStars(t: number, dt: number) {
      for (const s of stars) {
        // Parallax drift
        s.x += s.vx * dt * 0.06;
        s.y += s.vy * dt * 0.06;
        if (s.x < -2) s.x = width + 2;
        if (s.x > width + 2) s.x = -2;
        if (s.y < -2) s.y = height + 2;
        if (s.y > height + 2) s.y = -2;

        const a = Math.max(0, s.base + Math.sin(s.phase + t * s.twinkleSpeed) * s.twinkle);
        // Sem mais estrelas roxas — só variações entre branco quente e frio
        // (algumas levemente azuladas, outras puramente brancas).
        const color = s.purple
          ? `rgba(220, 225, 235, ${a})` // branco frio (era roxo claro)
          : `rgba(245, 244, 252, ${a})`;

        if (s.layer === 2) {
          const halo = ctx!.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r * 5);
          halo.addColorStop(
            0,
            s.purple ? `rgba(220, 225, 235, ${a * 0.32})` : `rgba(245, 244, 252, ${a * 0.3})`,
          );
          halo.addColorStop(1, 'rgba(0,0,0,0)');
          ctx!.fillStyle = halo;
          ctx!.beginPath();
          ctx!.arc(s.x, s.y, s.r * 5, 0, Math.PI * 2);
          ctx!.fill();
        }

        ctx!.fillStyle = color;
        ctx!.beginPath();
        ctx!.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx!.fill();
      }
    }

    function drawShootings(now: number) {
      if (now > nextShootingAt) {
        spawnShooting();
        nextShootingAt = now + rand(2200, 6000);
      }

      ctx!.lineCap = 'round';
      for (let i = shootings.length - 1; i >= 0; i--) {
        const s = shootings[i];
        s.x += s.vx;
        s.y += s.vy;
        s.life += 1;

        const t = s.life / s.max;
        const alpha = t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8;
        if (t >= 1 || s.x > width + 200 || s.y > height + 200) {
          shootings.splice(i, 1);
          continue;
        }

        const tailX = s.x - (s.vx / Math.hypot(s.vx, s.vy)) * s.len;
        const tailY = s.y - (s.vy / Math.hypot(s.vx, s.vy)) * s.len;
        const grad = ctx!.createLinearGradient(tailX, tailY, s.x, s.y);
        // Cauda branca neutra — sem matiz roxa
        grad.addColorStop(0, 'rgba(220, 225, 235, 0)');
        grad.addColorStop(0.6, `rgba(230, 232, 240, ${0.45 * alpha})`);
        grad.addColorStop(1, `rgba(255, 255, 255, ${0.95 * alpha})`);
        ctx!.strokeStyle = grad;
        ctx!.lineWidth = 1.6;
        ctx!.beginPath();
        ctx!.moveTo(tailX, tailY);
        ctx!.lineTo(s.x, s.y);
        ctx!.stroke();

        // Cabeça brilhante
        ctx!.fillStyle = `rgba(255,255,255,${alpha})`;
        ctx!.beginPath();
        ctx!.arc(s.x, s.y, 1.6, 0, Math.PI * 2);
        ctx!.fill();
      }
    }

    let lastTs = 0;
    function tick(ts: number) {
      if (!startTs) startTs = ts;
      const dt = lastTs ? ts - lastTs : 16;
      lastTs = ts;
      const t = ts - startTs;

      drawBackground();
      drawClouds(dt);
      drawLightnings(ts, dt);
      drawStars(t, dt);
      drawShootings(ts);

      raf = requestAnimationFrame(tick);
    }

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="absolute inset-0 h-full w-full"
      style={{ display: 'block' }}
    />
  );
}
