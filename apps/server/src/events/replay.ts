import type { StreamEvent } from "@cloud-worker/shared";

/**
 * Drops buffered live events that were already captured in the persisted log
 * snapshot. The task stream route subscribes to the event bus before fetching
 * logs, so any event published while the log fetch is in flight appears in
 * both — sending it twice duplicates agent cards in the UI (React key
 * collisions like "item_6:0"). Replayed logs and buffered events are
 * JSON-identical for the same delivery, so exact-JSON equality is the dedup
 * key; genuinely repeated commands differ in timestamp and survive.
 */
export function dedupeReplayOverlap(
  logs: StreamEvent[],
  buffered: StreamEvent[],
): StreamEvent[] {
  if (buffered.length === 0) {
    return buffered;
  }
  const seen = new Set(logs.map((event) => JSON.stringify(event)));
  return buffered.filter((event) => {
    const key = JSON.stringify(event);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
