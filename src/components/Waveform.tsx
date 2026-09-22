import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LoudnessSegment } from '../audio/loudness';
import type { Chapter, Peaks } from '../types';
import { clamp, formatTime } from '../utils/time';

const RULER_H = 24;
const SNAP_PX = 10;
const EDGE_PX = 6;
const MIN_ZOOM = 2; // px per second
const MAX_ZOOM = 800;
/** mouse movement below which a press counts as a click (band preview) */
const CLICK_PX = 4;

const QUIET_FILL = 'rgba(240, 196, 25, 0.16)';
const QUIET_STRIP = 'rgba(240, 196, 25, 0.9)';
const LOUD_FILL = 'rgba(255, 107, 157, 0.18)';
const LOUD_STRIP = 'rgba(255, 107, 157, 0.95)';

interface WaveformProps {
  peaks: Peaks;
  chapters: Chapter[];
  selectedId: string | null;
  playhead: number;
  pxPerSec: number;
  follow: boolean;
  /** silence-split candidate boundaries (preview markers) */
  suggestions: number[];
  /** continuous 过轻/过响 ranges to color on the waveform */
  loudnessSegments: LoudnessSegment[];
  onZoom: (pxPerSec: number) => void;
  onSeek: (t: number) => void;
  /** click an abnormal band: start previewing from that time */
  onPreviewSegment: (t: number) => void;
  onSelect: (id: string | null) => void;
  onCreateFromDrag: (a: number, b: number, snap: number) => string | null;
  onMove: (id: string, start: number, snap: number) => void;
  onResize: (id: string, edge: 'start' | 'end', t: number, snap: number) => void;
}

type DragState =
  | { mode: 'maybe-create'; startT: number }
  | { mode: 'create'; startT: number; curT: number }
  | { mode: 'move'; id: string; grabOffset: number }
  | { mode: 'resize'; id: string; edge: 'start' | 'end' };

function niceStep(pxPerSec: number): number {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  for (const s of steps) {
    if (s * pxPerSec >= 70) return s;
  }
  return 7200;
}

export function Waveform(props: WaveformProps) {
  const { peaks, chapters, selectedId, playhead, pxPerSec, follow, suggestions, loudnessSegments } =
    props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewportW, setViewportW] = useState(800);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const pendingAnchor = useRef<{ t: number; x: number } | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const duration = peaks.duration;
  const totalWidth = Math.max(1, Math.ceil(duration * pxPerSec));

  // observe viewport size
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportW(el.clientWidth));
    ro.observe(el);
    setViewportW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // apply pending zoom anchor after zoom changes
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pendingAnchor.current) {
      const { t, x } = pendingAnchor.current;
      el.scrollLeft = Math.max(0, t * pxPerSec - x);
      pendingAnchor.current = null;
    }
  }, [pxPerSec]);

  // follow playhead during playback
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !follow) return;
    const px = playhead * pxPerSec;
    if (px < el.scrollLeft || px > el.scrollLeft + el.clientWidth - 40) {
      el.scrollLeft = Math.max(0, px - el.clientWidth / 2);
    }
  }, [playhead, follow, pxPerSec]);

  const timeAtClientX = useCallback(
    (clientX: number): { t: number; x: number } => {
      const canvas = canvasRef.current!;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const t = clamp((scrollRef.current!.scrollLeft + x) / pxPerSec, 0, duration);
      return { t, x };
    },
    [pxPerSec, duration],
  );

  const hitTest = useCallback(
    (t: number, x: number): { chapter: Chapter; edge: 'start' | 'end' | 'body' } | null => {
      const scroll = scrollRef.current?.scrollLeft ?? 0;
      for (const c of chapters) {
        if (t >= c.start && t <= c.end) {
          const startX = c.start * pxPerSec - scroll;
          const endX = c.end * pxPerSec - scroll;
          if (Math.abs(x - startX) <= EDGE_PX) return { chapter: c, edge: 'start' };
          if (Math.abs(x - endX) <= EDGE_PX) return { chapter: c, edge: 'end' };
          return { chapter: c, edge: 'body' };
        }
      }
      return null;
    },
    [chapters, pxPerSec],
  );

  const hitBand = useCallback(
    (t: number): LoudnessSegment | null => {
      for (const s of loudnessSegments) {
        if (t >= s.start && t < s.end) return s;
      }
      return null;
    },
    [loudnessSegments],
  );

  // ---- mouse interactions ----
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const { t, x } = timeAtClientX(e.clientX);
    const hit = hitTest(t, x);
    const band = hitBand(t);
    let next: DragState;
    if (hit) {
      props.onSelect(hit.chapter.id);
      if (hit.edge === 'body') {
        next = { mode: 'move', id: hit.chapter.id, grabOffset: t - hit.chapter.start };
      } else {
        next = { mode: 'resize', id: hit.chapter.id, edge: hit.edge };
      }
    } else {
      next = { mode: 'maybe-create', startT: t };
    }
    dragRef.current = next;
    setDrag(next);

    const onWinMove = (ev: MouseEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const { t: ct } = timeAtClientX(ev.clientX);
      if (cur.mode === 'maybe-create') {
        if (Math.abs(ct - cur.startT) * pxPerSec > 4) {
          const next2: DragState = { mode: 'create', startT: cur.startT, curT: ct };
          dragRef.current = next2;
          setDrag(next2);
        }
      } else if (cur.mode === 'create') {
        const next2 = { ...cur, curT: ct };
        dragRef.current = next2;
        setDrag(next2);
      } else if (cur.mode === 'move') {
        propsRef.current.onMove(cur.id, ct - cur.grabOffset, SNAP_PX / pxPerSec);
      } else if (cur.mode === 'resize') {
        propsRef.current.onResize(cur.id, cur.edge, ct, SNAP_PX / pxPerSec);
      }
    };
    const onWinUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onWinMove);
      window.removeEventListener('mouseup', onWinUp);
      const cur = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!cur) return;
      const { t: ct, x: cx } = timeAtClientX(ev.clientX);
      const isClick = Math.abs(cx - x) <= CLICK_PX;
      if (cur.mode === 'maybe-create') {
        // click on an abnormal band -> preview from there; otherwise seek
        if (isClick && (band || hitBand(ct))) {
          propsRef.current.onPreviewSegment(ct);
        } else {
          propsRef.current.onSeek(ct);
          propsRef.current.onSelect(null);
        }
      } else if (cur.mode === 'move' && isClick && (band || hitBand(ct))) {
        // stationary click on a band inside a chapter -> preview from there
        propsRef.current.onPreviewSegment(ct);
      } else if (cur.mode === 'create') {
        propsRef.current.onCreateFromDrag(cur.startT, ct, SNAP_PX / pxPerSec);
      }
    };
    window.addEventListener('mousemove', onWinMove);
    window.addEventListener('mouseup', onWinUp);
  };

  const onHover = (e: React.MouseEvent) => {
    if (dragRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { t, x } = timeAtClientX(e.clientX);
    const hit = hitTest(t, x);
    if (hit) {
      canvas.style.cursor = hit.edge === 'body' ? 'grab' : 'ew-resize';
    } else {
      canvas.style.cursor = hitBand(t) ? 'pointer' : 'crosshair';
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const { t, x } = timeAtClientX(e.clientX);
    const factor = e.deltaY < 0 ? 1.25 : 0.8;
    const next = clamp(pxPerSec * factor, MIN_ZOOM, MAX_ZOOM);
    if (next === pxPerSec) return;
    pendingAnchor.current = { t, x };
    props.onZoom(next);
  };

  // ---- rendering ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const h = canvas.clientHeight;
    const w = viewportW;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const waveTop = RULER_H;
    const waveH = h - RULER_H;
    const mid = waveTop + waveH / 2;

    // background
    ctx.fillStyle = '#101418';
    ctx.fillRect(0, 0, w, h);

    const t0 = scrollLeft / pxPerSec;
    const t1 = (scrollLeft + w) / pxPerSec;

    // chapter regions (under waveform tint)
    for (const c of chapters) {
      const x0 = c.start * pxPerSec - scrollLeft;
      const x1 = c.end * pxPerSec - scrollLeft;
      if (x1 < 0 || x0 > w) continue;
      const sel = c.id === selectedId;
      ctx.fillStyle = sel ? 'rgba(64, 160, 255, 0.28)' : 'rgba(64, 160, 255, 0.13)';
      ctx.fillRect(x0, waveTop, x1 - x0, waveH);
    }

    // loudness QC bands: continuous 过轻/过响 ranges, distinct colors
    for (const seg of loudnessSegments) {
      const x0 = seg.start * pxPerSec - scrollLeft;
      const x1 = seg.end * pxPerSec - scrollLeft;
      if (x1 < 0 || x0 > w) continue;
      const isQuiet = seg.kind === 'quiet';
      ctx.fillStyle = isQuiet ? QUIET_FILL : LOUD_FILL;
      ctx.fillRect(x0, waveTop, x1 - x0, waveH);
      // solid status strip along the bottom edge of the band
      ctx.fillStyle = isQuiet ? QUIET_STRIP : LOUD_STRIP;
      ctx.fillRect(x0, waveTop + waveH - 5, x1 - x0, 5);
    }

    // drag-create preview
    if (drag && drag.mode === 'create') {
      const a = Math.min(drag.startT, drag.curT) * pxPerSec - scrollLeft;
      const b = Math.max(drag.startT, drag.curT) * pxPerSec - scrollLeft;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.fillRect(a, waveTop, b - a, waveH);
    }

    // waveform
    ctx.strokeStyle = '#7fd4a8';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const { min, max, rate } = peaks;
    for (let x = 0; x < w; x++) {
      const ts = (scrollLeft + x) / pxPerSec;
      const te = (scrollLeft + x + 1) / pxPerSec;
      let i0 = Math.floor(ts * rate);
      let i1 = Math.max(i0 + 1, Math.ceil(te * rate));
      if (i0 >= min.length) break;
      i1 = Math.min(i1, min.length);
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = i0; i < i1; i++) {
        if (min[i] < lo) lo = min[i];
        if (max[i] > hi) hi = max[i];
      }
      if (lo === Infinity) continue;
      const y0 = mid - hi * (waveH / 2) * 0.92;
      const y1 = mid - lo * (waveH / 2) * 0.92;
      ctx.moveTo(x + 0.5, y0);
      ctx.lineTo(x + 0.5, Math.max(y1, y0 + 1));
    }
    ctx.stroke();

    // center line
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();

    // chapter borders, handles, labels
    for (const c of chapters) {
      const x0 = c.start * pxPerSec - scrollLeft;
      const x1 = c.end * pxPerSec - scrollLeft;
      if (x1 < 0 || x0 > w) continue;
      const sel = c.id === selectedId;
      ctx.strokeStyle = sel ? '#5eb1ff' : 'rgba(94, 177, 255, 0.55)';
      ctx.lineWidth = sel ? 2 : 1;
      ctx.strokeRect(x0 + 0.5, waveTop + 0.5, x1 - x0 - 1, waveH - 1);
      // handles
      ctx.fillStyle = sel ? '#5eb1ff' : 'rgba(94, 177, 255, 0.8)';
      ctx.fillRect(x0 - 2, waveTop, 4, 14);
      ctx.fillRect(x1 - 2, waveTop, 4, 14);
      ctx.fillRect(x0 - 2, waveTop + waveH - 14, 4, 14);
      ctx.fillRect(x1 - 2, waveTop + waveH - 14, 4, 14);
      // label
      const label = c.title || '(未命名)';
      ctx.font = '12px system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      if (x1 - x0 > tw + 12) {
        ctx.fillStyle = sel ? '#dceeff' : 'rgba(220, 238, 255, 0.75)';
        ctx.fillText(label, x0 + 6, waveTop + 16);
      }
    }

    // silence-split suggestions: dashed orange markers, distinct from chapters
    if (suggestions.length > 0) {
      ctx.strokeStyle = 'rgba(255, 176, 66, 0.9)';
      ctx.fillStyle = 'rgba(255, 176, 66, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      for (const t of suggestions) {
        const x = t * pxPerSec - scrollLeft;
        if (x < 0 || x > w) continue;
        ctx.beginPath();
        ctx.moveTo(x, waveTop);
        ctx.lineTo(x, waveTop + waveH);
        ctx.stroke();
        // flag triangle at the top of the marker
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(x, waveTop);
        ctx.lineTo(x + 8, waveTop + 5);
        ctx.lineTo(x, waveTop + 10);
        ctx.closePath();
        ctx.fill();
        ctx.setLineDash([5, 4]);
      }
      ctx.setLineDash([]);
    }

    // ruler
    ctx.fillStyle = '#0b0e11';
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(0, RULER_H - 0.5);
    ctx.lineTo(w, RULER_H - 0.5);
    ctx.stroke();
    const step = niceStep(pxPerSec);
    const firstTick = Math.floor(t0 / step) * step;
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    for (let t = firstTick; t <= t1 + step; t += step) {
      if (t < 0 || t > duration + 1e-6) continue;
      const x = t * pxPerSec - scrollLeft;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H - 6);
      ctx.lineTo(x + 0.5, RULER_H);
      ctx.stroke();
      ctx.fillText(formatTime(t), x + 4, RULER_H - 8);
    }

    // playhead
    const px = playhead * pxPerSec - scrollLeft;
    if (px >= -2 && px <= w + 2) {
      ctx.strokeStyle = '#ff5a5a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.fillStyle = '#ff5a5a';
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 8);
      ctx.closePath();
      ctx.fill();
    }
  }, [
    peaks,
    chapters,
    selectedId,
    playhead,
    pxPerSec,
    scrollLeft,
    viewportW,
    drag,
    duration,
    suggestions,
    loudnessSegments,
  ]);

  return (
    <div
      ref={scrollRef}
      className="wave-scroll"
      onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
    >
      <div style={{ width: totalWidth, height: '100%', position: 'relative' }}>
        <canvas
          ref={canvasRef}
          className="wave-canvas"
          style={{ width: viewportW }}
          onMouseDown={onMouseDown}
          onMouseMove={onHover}
          onWheel={onWheel}
        />
      </div>
    </div>
  );
}
