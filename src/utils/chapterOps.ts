import type { Chapter } from '../types';
import { clamp } from './time';

export const MIN_CHAPTER_DURATION = 0.2;

/** Chapters sorted by start time (does not mutate input). */
export function sorted(chapters: Chapter[]): Chapter[] {
  return [...chapters].sort((a, b) => a.start - b.start);
}

/**
 * Neighbor boundaries for a chapter: the end of the previous chapter and
 * the start of the next one. Used to prevent overlap.
 */
export function neighborBounds(
  chapters: Chapter[],
  id: string,
  duration: number,
): { prevEnd: number; nextStart: number } {
  const list = sorted(chapters).filter((c) => c.id !== id);
  const self = chapters.find((c) => c.id === id);
  if (!self) return { prevEnd: 0, nextStart: duration };
  let prevEnd = 0;
  let nextStart = duration;
  for (const c of list) {
    if (c.end <= self.start + 1e-9 && c.end > prevEnd) prevEnd = c.end;
    if (c.start >= self.end - 1e-9 && c.start < nextStart) nextStart = c.start;
  }
  return { prevEnd, nextStart };
}

/** All snap targets: file edges plus every other chapter's edges. */
export function snapTargets(chapters: Chapter[], excludeId: string, duration: number): number[] {
  const targets = [0, duration];
  for (const c of chapters) {
    if (c.id === excludeId) continue;
    targets.push(c.start, c.end);
  }
  return targets;
}

function snapValue(v: number, targets: number[], threshold: number): number {
  let best = v;
  let bestDist = threshold;
  for (const t of targets) {
    const d = Math.abs(t - v);
    if (d <= bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return best;
}

/**
 * Move a whole chapter, keeping its length. Clamped between neighbors
 * (no overlap) and snapped to nearby boundaries.
 */
export function moveChapter(
  chapters: Chapter[],
  id: string,
  desiredStart: number,
  duration: number,
  snapThreshold: number,
): { start: number; end: number } | null {
  const self = chapters.find((c) => c.id === id);
  if (!self) return null;
  const len = self.end - self.start;
  const { prevEnd, nextStart } = neighborBounds(chapters, id, duration);
  let start = clamp(desiredStart, prevEnd, nextStart - len);
  const targets = snapTargets(chapters, id, duration);
  // snap either edge, prefer the closer one; ignore edges that didn't snap
  const snappedStart = snapValue(start, targets, snapThreshold);
  const snappedEndRaw = snapValue(start + len, targets, snapThreshold);
  const startSnapped = snappedStart !== start;
  const endSnapped = snappedEndRaw !== start + len;
  if (startSnapped || endSnapped) {
    const snappedEnd = snappedEndRaw - len;
    const dStart = startSnapped ? Math.abs(snappedStart - start) : Infinity;
    const dEnd = endSnapped ? Math.abs(snappedEnd - start) : Infinity;
    start = dStart <= dEnd ? snappedStart : snappedEnd;
  }
  start = clamp(start, prevEnd, nextStart - len);
  return { start, end: start + len };
}

/**
 * Resize one edge of a chapter. Clamped between neighbors and the minimum
 * duration, snapped to nearby boundaries.
 */
export function resizeChapter(
  chapters: Chapter[],
  id: string,
  edge: 'start' | 'end',
  desired: number,
  duration: number,
  snapThreshold: number,
): { start: number; end: number } | null {
  const self = chapters.find((c) => c.id === id);
  if (!self) return null;
  const { prevEnd, nextStart } = neighborBounds(chapters, id, duration);
  const targets = snapTargets(chapters, id, duration);
  const snapped = snapValue(desired, targets, snapThreshold);

  if (edge === 'start') {
    const start = clamp(snapped, prevEnd, self.end - MIN_CHAPTER_DURATION);
    return { start, end: self.end };
  }
  const end = clamp(snapped, self.start + MIN_CHAPTER_DURATION, nextStart);
  return { start: self.start, end };
}

/**
 * Create a chapter from a drag range. Shrinks/clamps into the enclosing
 * gap so the result never overlaps existing chapters. Returns null if the
 * available gap is too small.
 */
export function createChapterInGap(
  chapters: Chapter[],
  a: number,
  b: number,
  duration: number,
  snapThreshold: number,
): { start: number; end: number } | null {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const targets = snapTargets(chapters, '__none__', duration);
  let start = snapValue(lo, targets, snapThreshold);
  let end = snapValue(hi, targets, snapThreshold);
  // clamp into the enclosing gap
  for (const c of sorted(chapters)) {
    if (c.end <= start + 1e-9) continue;
    if (c.start >= end - 1e-9) continue;
    // overlaps c: shrink away from it
    if (c.start <= start && c.end >= end) return null; // fully covered
    if (c.end > start && c.end <= end) start = c.end;
    else if (c.start >= start && c.start < end) end = c.start;
  }
  start = clamp(start, 0, duration);
  end = clamp(end, 0, duration);
  if (end - start < MIN_CHAPTER_DURATION) return null;
  return { start, end };
}

/** Find a free gap of the preferred length at/after a time point. */
export function findFreeGap(
  chapters: Chapter[],
  at: number,
  preferredLen: number,
  duration: number,
): { start: number; end: number } | null {
  const list = sorted(chapters);
  let cursor = Math.max(0, at);
  for (const c of list) {
    if (c.end <= cursor) continue;
    if (c.start >= cursor + preferredLen - 1e-9) {
      return { start: cursor, end: cursor + preferredLen };
    }
    cursor = c.end;
  }
  if (cursor + preferredLen <= duration + 1e-9) {
    return { start: cursor, end: Math.min(cursor + preferredLen, duration) };
  }
  // try a shorter fit in the last gap
  if (duration - cursor >= MIN_CHAPTER_DURATION) {
    return { start: cursor, end: duration };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 连锁移动 (chain move)
//
// A gesture on one unlocked chapter translates the boundary displacement onto
// every *following* unlocked chapter as a rigid train: inter-chapter gaps and
// each chapter's duration are preserved. A locked chapter (or the audio edge)
// terminates the train and bounds the whole gesture, so overlaps are
// impossible. Locks live outside chapter data and never reach exports.
// ---------------------------------------------------------------------------

const EPS = 1e-6;

export type ChainBlockKind =
  | 'none'
  | 'locked'
  | 'audio-end'
  | 'audio-start'
  | 'neighbor'
  | 'min-duration';

export type ChainKind = 'move' | 'resize-start' | 'resize-end';

export interface ChainOutcome {
  /** false = the gesture targets a locked chapter and must not start */
  allowed: boolean;
  kind: ChainKind;
  /** full resulting chapter list (order of the input array) */
  chapters: Chapter[];
  /** translated/patched chapter ids, dragged chapter first */
  affectedIds: string[];
  /** displacement actually applied to the train (seconds, signed) */
  delta: number;
  /** displacement the pointer asked for before feasibility clamping */
  desiredDelta: number;
  clamped: boolean;
  blockedBy: ChainBlockKind;
  /** id of the chapter that forms the barrier (when any) */
  blockerId?: string;
}

function lockedOutcome(
  kind: ChainKind,
  chapters: Chapter[],
  id: string,
): ChainOutcome {
  return {
    allowed: false,
    kind,
    chapters,
    affectedIds: [id],
    delta: 0,
    desiredDelta: 0,
    clamped: false,
    blockedBy: 'locked',
    blockerId: id,
  };
}

/** Edges of chapters outside the moving train plus the file edges. */
function fixedTargets(
  list: Chapter[],
  movingIds: ReadonlySet<string>,
  duration: number,
): number[] {
  const targets = [0, duration];
  for (const c of list) {
    if (movingIds.has(c.id)) continue;
    targets.push(c.start, c.end);
  }
  return targets;
}

/**
 * Snap a dragged interval (start + fixed length) against fixed targets only;
 * train chapters move rigidly, so their edges can never be snap targets.
 */
function snapTrainStart(
  start: number,
  len: number,
  targets: number[],
  threshold: number,
): number {
  const snappedStart = snapValue(start, targets, threshold);
  const snappedEndRaw = snapValue(start + len, targets, threshold);
  const startSnapped = snappedStart !== start;
  const endSnapped = snappedEndRaw !== start + len;
  if (!startSnapped && !endSnapped) return start;
  const snappedEnd = snappedEndRaw - len;
  const dStart = startSnapped ? Math.abs(snappedStart - start) : Infinity;
  const dEnd = endSnapped ? Math.abs(snappedEnd - start) : Infinity;
  return dStart <= dEnd ? snappedStart : snappedEnd;
}

/**
 * Move a chapter in chain mode: the chapter plus every consecutive later
 * unlocked chapter form a rigid train preserving all gaps and durations.
 * Bounded backward by the previous chapter (locked or not) / file start and
 * forward by the first later locked chapter / file end.
 */
export function chainMoveChapter(
  chapters: Chapter[],
  lockedIds: ReadonlySet<string>,
  id: string,
  desiredStart: number,
  duration: number,
  snapThreshold: number,
): ChainOutcome | null {
  const list = sorted(chapters);
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  const self = list[idx];
  if (lockedIds.has(id)) return lockedOutcome('move', chapters, id);

  // rigid train: self and every consecutive later unlocked chapter
  let runEnd = idx;
  while (runEnd + 1 < list.length && !lockedIds.has(list[runEnd + 1].id)) runEnd++;
  const train = list.slice(idx, runEnd + 1);
  const trainIds = new Set(train.map((c) => c.id));
  const blocker = list[runEnd + 1]; // exists ⇒ it is locked

  const rawDelta = desiredStart - self.start;
  const targets = fixedTargets(list, trainIds, duration);
  const snappedStart = snapTrainStart(
    desiredStart,
    self.end - self.start,
    targets,
    snapThreshold,
  );

  const minDelta = idx > 0 ? list[idx - 1].end - self.start : -self.start;
  const trainTailEnd = train[train.length - 1].end;
  const maxDelta = blocker ? blocker.start - trainTailEnd : duration - trainTailEnd;
  let delta = clamp(snappedStart - self.start, minDelta, maxDelta);
  if (Math.abs(delta - minDelta) <= EPS) delta = minDelta;
  else if (Math.abs(delta - maxDelta) <= EPS) delta = maxDelta;

  let blockedBy: ChainBlockKind = 'none';
  if (rawDelta > maxDelta + EPS) blockedBy = blocker ? 'locked' : 'audio-end';
  else if (rawDelta < minDelta - EPS) {
    if (idx > 0) blockedBy = lockedIds.has(list[idx - 1].id) ? 'locked' : 'neighbor';
    else blockedBy = 'audio-start';
  }

  const next = chapters.map((c) =>
    trainIds.has(c.id) ? { ...c, start: c.start + delta, end: c.end + delta } : c,
  );
  return {
    allowed: true,
    kind: 'move',
    chapters: next,
    affectedIds: train.map((c) => c.id),
    delta,
    desiredDelta: rawDelta,
    clamped: blockedBy !== 'none',
    blockedBy,
    blockerId:
      blockedBy === 'locked'
        ? rawDelta > 0
          ? blocker!.id
          : list[idx - 1].id
        : blockedBy === 'neighbor'
          ? list[idx - 1].id
          : undefined,
  };
}

/**
 * Resize a chapter edge in chain mode.
 *
 * - `end`: the displacement is handed to every consecutive later unlocked
 *   chapter (the dragged chapter changes duration, followers keep theirs and
 *   the gaps stay constant); bounded by the first later locked chapter / file
 *   end and by the minimum chapter duration.
 * - `start`: the end edge stays put, so nothing follows; the single edge is
 *   clamped to the previous chapter (locked or not), file start and the
 *   minimum duration.
 */
export function chainResizeChapter(
  chapters: Chapter[],
  lockedIds: ReadonlySet<string>,
  id: string,
  edge: 'start' | 'end',
  desired: number,
  duration: number,
  snapThreshold: number,
): ChainOutcome | null {
  const list = sorted(chapters);
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return null;
  const self = list[idx];
  if (lockedIds.has(id)) return lockedOutcome('resize-end', chapters, id);
  const len = self.end - self.start;

  if (edge === 'start') {
    const prev = list[idx - 1];
    const lo = prev ? prev.end : 0;
    const hi = self.end - MIN_CHAPTER_DURATION;
    const targets = snapTargets(list, id, duration);
    const start = clamp(snapValue(desired, targets, snapThreshold), lo, hi);
    let blockedBy: ChainBlockKind = 'none';
    if (desired < lo - EPS) {
      blockedBy = prev ? (lockedIds.has(prev.id) ? 'locked' : 'neighbor') : 'audio-start';
    } else if (desired > hi + EPS) {
      blockedBy = 'min-duration';
    }
    const next = chapters.map((c) => (c.id === id ? { ...c, start } : c));
    return {
      allowed: true,
      kind: 'resize-start',
      chapters: next,
      affectedIds: [id],
      delta: start - self.start,
      desiredDelta: desired - self.start,
      clamped: blockedBy !== 'none',
      blockedBy,
      blockerId: prev && blockedBy === 'locked' ? prev.id : undefined,
    };
  }

  // edge === 'end': followers translate by the same displacement
  let runEnd = idx;
  while (runEnd + 1 < list.length && !lockedIds.has(list[runEnd + 1].id)) runEnd++;
  const followers = list.slice(idx + 1, runEnd + 1);
  const blocker = list[runEnd + 1]; // exists ⇒ it is locked
  const movingIds = new Set([id, ...followers.map((c) => c.id)]);
  const tailEnd = followers.length > 0 ? followers[followers.length - 1].end : self.end;

  const rawDelta = desired - self.end;
  const targets = fixedTargets(list, movingIds, duration);
  const snapped = snapValue(desired, targets, snapThreshold);
  const minDelta = MIN_CHAPTER_DURATION - len;
  const maxDelta = blocker ? blocker.start - tailEnd : duration - tailEnd;
  let delta = clamp(snapped - self.end, minDelta, maxDelta);
  if (Math.abs(delta - minDelta) <= EPS) delta = minDelta;
  else if (Math.abs(delta - maxDelta) <= EPS) delta = maxDelta;

  let blockedBy: ChainBlockKind = 'none';
  if (rawDelta > maxDelta + EPS) blockedBy = blocker ? 'locked' : 'audio-end';
  else if (rawDelta < minDelta - EPS) blockedBy = 'min-duration';

  const next = chapters.map((c) => {
    if (c.id === id) return { ...c, end: c.end + delta };
    if (followers.some((f) => f.id === c.id)) {
      return { ...c, start: c.start + delta, end: c.end + delta };
    }
    return c;
  });
  return {
    allowed: true,
    kind: 'resize-end',
    chapters: next,
    affectedIds: [id, ...followers.map((c) => c.id)],
    delta,
    desiredDelta: rawDelta,
    clamped: blockedBy !== 'none',
    blockedBy,
    blockerId: blockedBy === 'locked' ? blocker!.id : undefined,
  };
}

function chapterTitle(chapters: ReadonlyArray<ChapterLike>, id: string): string {
  const c = chapters.find((x) => x.id === id);
  return c?.title.trim() || '未命名章节';
}

function signed(d: number): string {
  return `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(2)}s`;
}

/** Minimal chapter fields needed for the summary text. */
type ChapterLike = { id: string; title: string };

/** Human-readable chain preview / restriction summary (Chinese UI). */
export function chainOutcomeText(o: ChainOutcome, chapters: ReadonlyArray<ChapterLike>): string {
  const verb = o.kind === 'move' ? '拖动' : '调整边界';
  if (!o.allowed) {
    return `「${chapterTitle(chapters, o.affectedIds[0])}」已锁定，无法${verb}；请先解锁或关闭其锁定状态`;
  }
  let text: string;
  if (o.kind === 'move') {
    const n = o.affectedIds.length;
    text =
      n > 1
        ? `连锁移动：带动其后 ${n - 1} 个未锁定章节，整体位移 ${signed(o.delta)}，间隔与时长保持不变`
        : `移动章节 ${signed(o.delta)}（后方无未锁定章节可带动）`;
  } else if (o.kind === 'resize-end') {
    const self = o.chapters.find((c) => c.id === o.affectedIds[0]);
    const after = self ? self.end - self.start : 0;
    const before = after - o.delta;
    const extra = o.affectedIds.length - 1;
    text =
      `连锁调整终点：本章时长 ${before.toFixed(1)}s → ${after.toFixed(1)}s` +
      (extra > 0 ? `，并带动后方 ${extra} 个章节 ${signed(o.delta)}` : '，后方章节不受影响');
  } else {
    text = '调整起点：仅本章边界改变，后续章节不受影响';
  }
  if (o.clamped) {
    let reason: string;
    switch (o.blockedBy) {
      case 'locked':
        reason = `锁定章节「${chapterTitle(chapters, o.blockerId!)}」`;
        break;
      case 'audio-end':
        reason = '音频结尾';
        break;
      case 'audio-start':
        reason = '音频开头';
        break;
      case 'neighbor':
        reason = `相邻章节「${chapterTitle(chapters, o.blockerId!)}」`;
        break;
      case 'min-duration':
        reason = `章节最短时长 ${MIN_CHAPTER_DURATION}s`;
        break;
      default:
        reason = '边界';
    }
    const dir = o.desiredDelta >= 0 ? '向右' : '向左';
    text += `；已限制在可行范围（${dir}遇到${reason}），未产生重叠`;
  }
  return text;
}
