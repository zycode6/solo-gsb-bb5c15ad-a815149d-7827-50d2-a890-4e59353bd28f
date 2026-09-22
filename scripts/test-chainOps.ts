import {
  chainMoveChapter,
  chainResizeChapter,
  chainOutcomeText,
} from '../src/utils/chapterOps';
import type { Chapter } from '../src/types';

const D = 100;
const mk = (id: string, start: number, end: number): Chapter => ({ id, title: id, start, end });
let failures = 0;
function check(cond: boolean, msg: string) {
  if (!cond) {
    failures++;
    console.error(`FAIL ${msg}`);
  } else {
    console.log(`ok ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, `${msg}${a === e ? '' : `: expected ${e}, got ${a}`}`);
}
function ranges(cs: Chapter[], ids: string[]) {
  const by = new Map(cs.map((c) => [c.id, [c.start, c.end]]));
  return ids.map((id) => by.get(id));
}

// --- chain move: later unlocked chapters follow, gaps + durations kept ---
{
  const cs = [mk('a', 0, 10), mk('b', 20, 30), mk('c', 30, 40)];
  const o = chainMoveChapter(cs, new Set(), 'a', 5, D, 0)!;
  check(o.allowed && !o.clamped, 'move: allowed, not clamped');
  eq(o.delta, 5, 'move: applied delta');
  eq(o.affectedIds, ['a', 'b', 'c'], 'move: train is all later unlocked');
  eq(ranges(o.chapters, ['a', 'b', 'c']), [[5, 15], [25, 35], [35, 45]], 'move: rigid translate');
}

// --- chain move: locked follower stops the train and bounds the gesture ---
{
  const cs = [mk('a', 0, 10), mk('b', 20, 30), mk('c', 40, 50), mk('d', 60, 70)];
  const locked = new Set(['c']);
  const o = chainMoveChapter(cs, locked, 'a', 20, D, 0)!;
  check(o.clamped && o.blockedBy === 'locked' && o.blockerId === 'c', 'move: blocked by locked c');
  eq(o.delta, 10, 'move: clamped to just before locked chapter (train end meets c.start)');
  eq(ranges(o.chapters, ['a', 'b', 'c', 'd']), [[10, 20], [30, 40], [40, 50], [60, 70]], 'move: locked c and d untouched, no overlap');
}

// --- chain move: audio end bounds the train ---
{
  const cs = [mk('a', 80, 90), mk('b', 90, 95)];
  const o = chainMoveChapter(cs, new Set(), 'a', 100, D, 0)!;
  check(o.clamped && o.blockedBy === 'audio-end', 'move: clamped by audio end');
  eq(o.delta, 5, 'move: tail ends exactly at duration');
  eq(ranges(o.chapters, ['a', 'b']), [[85, 95], [95, 100]], 'move: fits at audio end');
}

// --- chain move: backward bounded by previous (locked) chapter ---
{
  const cs = [mk('a', 10, 20), mk('b', 30, 40)];
  const o = chainMoveChapter(cs, new Set(['a']), 'b', 5, D, 0)!;
  check(o.clamped && o.blockedBy === 'locked' && o.blockerId === 'a', 'move: locked prev barrier');
  eq(ranges(o.chapters, ['a', 'b']), [[10, 20], [20, 30]], 'move: pulled back to prev end');
}

// --- chain move: backward bounded by an unlocked previous chapter ---
{
  const cs = [mk('a', 10, 20), mk('b', 30, 40)];
  const o = chainMoveChapter(cs, new Set(), 'b', 0, D, 0)!;
  check(o.clamped && o.blockedBy === 'neighbor' && o.blockerId === 'a', 'move: unlocked prev neighbor barrier');
  eq(ranges(o.chapters, ['a', 'b']), [[10, 20], [20, 30]], 'move: no backward crossing');
}

// --- chain move: backward bounded by audio start ---
{
  const cs = [mk('a', 2, 10), mk('b', 20, 30)];
  const o = chainMoveChapter(cs, new Set(), 'a', -50, D, 0)!;
  check(o.clamped && o.blockedBy === 'audio-start', 'move: clamped by audio start');
  eq(o.delta, -2, 'move: first chapter starts at 0');
  eq(ranges(o.chapters, ['a', 'b']), [[0, 8], [18, 28]], 'move: followers keep gap');
}

// --- chain move: gap before a locked follower of zero forbids forward motion ---
{
  const cs = [mk('a', 0, 10), mk('b', 10, 20)]; // adjacent, b locked
  const o = chainMoveChapter(cs, new Set(['b']), 'a', 1, D, 0)!;
  eq(o.delta, 0, 'move: zero gap to locked means no forward range');
  check(o.blockedBy === 'locked', 'move: locked reason preserved');
  eq(o.chapters, cs, 'move: no-op chapters unchanged');
}

// --- chain move on a locked chapter is rejected ---
{
  const cs = [mk('a', 0, 10)];
  const o = chainMoveChapter(cs, new Set(['a']), 'a', 5, D, 0)!;
  check(!o.allowed && o.blockedBy === 'locked', 'move: locked target rejected');
}

// --- chain move: snaps to a fixed (locked) edge within threshold ---
{
  const cs = [mk('a', 0, 10), mk('b', 20, 30), mk('c', 30, 40)];
  // dragging a to start 19.7 near locked c.start=30 via b.end? b is in the
  // train so its edges aren't targets; the train end (b.end=30) near c.start
  // is already touching. Snap the tail to nothing here; snap a start to file 0
  const o = chainMoveChapter(cs, new Set(['c']), 'a', 0.1, D, 0.5)!;
  eq(o.delta, 0, 'move: snaps start back to 0');
}

// --- chain resize end: followers translate, duration changes only on self ---
{
  const cs = [mk('a', 0, 10), mk('b', 12, 20), mk('c', 30, 40)];
  const o = chainResizeChapter(cs, new Set(), 'a', 'end', 15, D, 0)!;
  check(!o.clamped, 'resize-end: free motion');
  eq(o.kind, 'resize-end', 'resize-end: kind');
  eq(ranges(o.chapters, ['a', 'b', 'c']), [[0, 15], [17, 25], [35, 45]], 'resize-end: self grows, followers shift');
}

// --- chain resize end: bounded by locked follower ---
{
  const cs = [mk('a', 0, 10), mk('b', 12, 20), mk('c', 30, 40)];
  const o = chainResizeChapter(cs, new Set(['c']), 'a', 'end', 50, D, 0)!;
  check(o.clamped && o.blockedBy === 'locked' && o.blockerId === 'c', 'resize-end: locked barrier');
  eq(ranges(o.chapters, ['a', 'b', 'c']), [[0, 20], [22, 30], [30, 40]], 'resize-end: self end grows by 10, b shifts +10, c fixed');
}

// --- chain resize end: bounded by audio end ---
{
  const cs = [mk('a', 80, 90), mk('b', 90, 95)];
  const o = chainResizeChapter(cs, new Set(), 'a', 'end', 100, D, 0)!;
  check(o.blockedBy === 'audio-end' && o.clamped, 'resize-end: audio-end barrier');
  eq(ranges(o.chapters, ['a', 'b']), [[80, 95], [95, 100]], 'resize-end: tail to duration');
}

// --- chain resize end: min duration bounds shrinking ---
{
  const cs = [mk('a', 0, 10), mk('b', 20, 30)];
  const o = chainResizeChapter(cs, new Set(), 'a', 'end', -100, D, 0)!;
  check(o.clamped && o.blockedBy === 'min-duration', 'resize-end: min duration');
  check(Math.abs(o.chapters[0].end - o.chapters[0].start - 0.2) < 1e-9, 'resize-end: floored at MIN_CHAPTER_DURATION');
  eq(ranges(o.chapters, ['b']), [[10.2, 20.2]], 'resize-end: follower shifts with end edge');
}

// --- chain resize start: only self changes, clamp to locked prev ---
{
  const cs = [mk('a', 10, 20), mk('b', 30, 40)];
  const o = chainResizeChapter(cs, new Set(['a']), 'b', 'start', 5, D, 0)!;
  check(o.kind === 'resize-start' && o.clamped, 'resize-start: clamped');
  check(o.blockedBy === 'locked' && o.blockerId === 'a', 'resize-start: locked prev reason');
  eq(ranges(o.chapters, ['a', 'b']), [[10, 20], [20, 40]], 'resize-start: pulled to locked prev end');
  eq(o.affectedIds, ['b'], 'resize-start: no followers');
}

// --- chain resize start: min duration ---
{
  const cs = [mk('a', 10, 20)];
  const o = chainResizeChapter(cs, new Set(), 'a', 'start', 19.99, D, 0)!;
  check(o.blockedBy === 'min-duration' && o.clamped, 'resize-start: min duration reason');
  eq([o.chapters[0].start, o.chapters[0].end], [19.8, 20], 'resize-start: floored');
}

// --- chain resize on a locked chapter is rejected ---
{
  const cs = [mk('a', 0, 10)];
  const o = chainResizeChapter(cs, new Set(['a']), 'a', 'end', 5, D, 0)!;
  check(!o.allowed && o.blockedBy === 'locked', 'resize: locked target rejected');
}

// --- unknown chapter returns null ---
{
  check(chainMoveChapter([], new Set(), 'x', 1, D, 0) === null, 'move unknown null');
  check(chainResizeChapter([], new Set(), 'x', 'end', 1, D, 0) === null, 'resize unknown null');
}

// --- summary text mentions lock reason and never claims overlap ---
{
  const cs = [mk('a', 0, 10), mk('b', 10, 20)];
  const o = chainMoveChapter(cs, new Set(['b']), 'a', 20, D, 0)!;
  const text = chainOutcomeText(o, cs);
  check(text.includes('锁定章节') && text.includes('未产生重叠'), `summary text: ${text}`);
  const rej = chainMoveChapter(cs, new Set(['a']), 'a', 5, D, 0)!;
  check(chainOutcomeText(rej, cs).includes('已锁定'), 'rejected summary says locked');
}

// --- invariant sweep: random-ish trains never overlap and stay in range ---
{
  const cs = [
    mk('0', 0, 5),
    mk('1', 6, 12),
    mk('2', 14, 20),
    mk('3', 25, 30),
    mk('4', 40, 44),
  ];
  const lockedSets = [new Set<string>(), new Set(['2']), new Set(['1', '4']), new Set(['0', '3'])];
  let bad = 0;
  for (const locked of lockedSets) {
    for (const id of cs.map((c) => c.id)) {
      if (locked.has(id)) continue;
      for (const target of [-50, -5, 0, 3, 17, 60, 200]) {
        const o = chainMoveChapter(cs, locked, id, target, D, 0)!;
        if (!o.allowed) continue;
        const list = [...o.chapters].sort((a, b) => a.start - b.start);
        for (let i = 1; i < list.length; i++) {
          if (list[i].start < list[i - 1].end - 1e-6) bad++;
        }
        if (list[0].start < -1e-6 || list[list.length - 1].end > D + 1e-6) bad++;
      }
    }
  }
  check(bad === 0, `sweep: no overlaps/out-of-range (${bad} violations)`);
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
