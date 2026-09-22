import { useCallback, useMemo, useRef, useState } from 'react';
import type { Chapter } from '../types';
import { uid } from '../utils/time';
import {
  createChapterInGap,
  findFreeGap,
  moveChapter,
  resizeChapter,
  sorted,
} from '../utils/chapterOps';
import { emptyHistory, record, undo as undoStep, redo as redoStep, type History } from '../utils/history';

function sameChapter(a: Chapter, b: Chapter): boolean {
  return a.id === b.id && a.title === b.title && a.start === b.start && a.end === b.end;
}

function chaptersEqual(a: Chapter[], b: Chapter[]): boolean {
  if (a === b || a.length !== b.length) return a === b;
  return a.every((c, i) => sameChapter(c, b[i]));
}

export function useChapters(duration: number) {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // mirror of `chapters` so commits can read fresh state without putting
  // history side effects inside a setState updater (StrictMode-safe)
  const chaptersRef = useRef<Chapter[]>(chapters);
  const historyRef = useRef<History<Chapter[]>>(emptyHistory<Chapter[]>());

  /**
   * Apply a new chapter list and record it as one reversible step. Edits
   * carrying the same mergeKey within the merge window collapse into one
   * step (mouse drag, held nudge key, typing a title). No-op transitions
   * are not recorded.
   */
  const commit = useCallback((next: Chapter[], mergeKey?: string) => {
    const prev = chaptersRef.current;
    if (chaptersEqual(prev, next)) return;
    historyRef.current = record(historyRef.current, {
      before: prev,
      after: next,
      mergeKey,
      time: Date.now(),
    });
    chaptersRef.current = next;
    setChapters(next);
  }, []);

  const addChapter = useCallback(
    (start: number, end: number, title?: string): string => {
      const id = uid();
      const n = chaptersRef.current.length + 1;
      commit([...chaptersRef.current, { id, title: title ?? `章节 ${n}`, start, end }]);
      setSelectedId(id);
      return id;
    },
    [commit],
  );

  /** Append several chapters at once, as a single undoable step (apply all). */
  const addMany = useCallback(
    (ranges: { start: number; end: number }[]) => {
      if (ranges.length === 0) return;
      const prev = chaptersRef.current;
      const next = [...prev];
      ranges.forEach((r, i) => {
        next.push({
          id: uid(),
          title: `章节 ${prev.length + i + 1}`,
          start: r.start,
          end: r.end,
        });
      });
      commit(next);
    },
    [commit],
  );

  /** Create from a drag range; returns new id or null if no room. */
  const createFromDrag = useCallback(
    (a: number, b: number, snapThreshold: number): string | null => {
      const range = createChapterInGap(chaptersRef.current, a, b, duration, snapThreshold);
      if (!range) return null;
      return addChapter(range.start, range.end);
    },
    [duration, addChapter],
  );

  /** Create a chapter of default length at the playhead. */
  const createAtPlayhead = useCallback(
    (at: number, len = 5): string | null => {
      const gap = findFreeGap(chaptersRef.current, at, len, duration);
      if (!gap) return null;
      return addChapter(gap.start, gap.end);
    },
    [duration, addChapter],
  );

  const move = useCallback(
    (id: string, desiredStart: number, snapThreshold: number) => {
      const prev = chaptersRef.current;
      const r = moveChapter(prev, id, desiredStart, duration, snapThreshold);
      if (!r) return;
      commit(prev.map((c) => (c.id === id ? { ...c, ...r } : c)), `move:${id}`);
    },
    [duration, commit],
  );

  const resize = useCallback(
    (id: string, edge: 'start' | 'end', desired: number, snapThreshold: number) => {
      const prev = chaptersRef.current;
      const r = resizeChapter(prev, id, edge, desired, duration, snapThreshold);
      if (!r) return;
      commit(prev.map((c) => (c.id === id ? { ...c, ...r } : c)), `resize:${id}:${edge}`);
    },
    [duration, commit],
  );

  const rename = useCallback(
    (id: string, title: string) => {
      // keystrokes in one editing run form a single undo step
      commit(
        chaptersRef.current.map((c) => (c.id === id ? { ...c, title } : c)),
        `rename:${id}`,
      );
    },
    [commit],
  );

  const remove = useCallback(
    (id: string) => {
      commit(chaptersRef.current.filter((c) => c.id !== id));
      setSelectedId((sel) => (sel === id ? null : sel));
    },
    [commit],
  );

  /** Restore the previous chapter state. Playback is never touched. */
  const undo = useCallback(() => {
    const result = undoStep(historyRef.current);
    if (!result) return;
    historyRef.current = result.history;
    chaptersRef.current = result.state;
    setChapters(result.state);
    setSelectedId((sel) =>
      sel && result.state.some((c) => c.id === sel) ? sel : null,
    );
  }, []);

  /** Re-apply the next chapter state. Playback is never touched. */
  const redo = useCallback(() => {
    const result = redoStep(historyRef.current);
    if (!result) return;
    historyRef.current = result.history;
    chaptersRef.current = result.state;
    setChapters(result.state);
    setSelectedId((sel) =>
      sel && result.state.some((c) => c.id === sel) ? sel : null,
    );
  }, []);

  const select = useCallback((id: string | null) => setSelectedId(id), []);

  /** New audio import: drop chapters together with the edit history. */
  const reset = useCallback(() => {
    historyRef.current = emptyHistory<Chapter[]>();
    chaptersRef.current = [];
    setChapters([]);
    setSelectedId(null);
  }, []);

  const selected = useMemo(
    () => chapters.find((c) => c.id === selectedId) ?? null,
    [chapters, selectedId],
  );

  const sortedChapters = useMemo(() => sorted(chapters), [chapters]);

  // history mutations always accompany a chapters render, so reading the ref
  // here keeps the toolbar disabled state in sync
  const canUndo = historyRef.current.undoStack.length > 0;
  const canRedo = historyRef.current.redoStack.length > 0;

  return {
    chapters,
    sortedChapters,
    selected,
    selectedId,
    select,
    addChapter,
    addMany,
    createFromDrag,
    createAtPlayhead,
    move,
    resize,
    rename,
    remove,
    undo,
    redo,
    canUndo,
    canRedo,
    reset,
  };
}

export type ChaptersApi = ReturnType<typeof useChapters>;
