import type { SnapshotRetentionPolicy } from '@/lib/adapters';

export const SNAPSHOT_RETENTION_POLICIES: Record<
  'standard' | 'extended' | 'forever',
  SnapshotRetentionPolicy
> = {
  standard: { keepAllDays: 1, keepHourlyDays: 7, keepDailyDays: 90 },
  extended: { keepAllDays: 7, keepHourlyDays: 30, keepDailyDays: 365 },
  forever: { keepAllDays: 0, keepHourlyDays: 0, keepDailyDays: 0, forever: true },
};

interface DatedSnapshot {
  id: string;
  createdAt: string;
}

function weekKey(date: Date): string {
  const monday = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = monday.getUTCDay() || 7;
  monday.setUTCDate(monday.getUTCDate() - day + 1);
  return monday.toISOString().slice(0, 10);
}

/**
 * Return the ids to retain under the hourly → daily → weekly policy.
 *
 * Buckets deliberately keep the newest entry in each period. The caller
 * supplies `now` so pruning is deterministic in tests and on the Rust side.
 */
export function retainedSnapshotIds(
  snapshots: DatedSnapshot[],
  policy: SnapshotRetentionPolicy,
  now = new Date(),
): Set<string> {
  if (policy.forever) return new Set(snapshots.map((snapshot) => snapshot.id));

  const sorted = [...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const retained = new Set<string>();
  const buckets = new Set<string>();
  const dayMs = 86_400_000;

  for (const snapshot of sorted) {
    const date = new Date(snapshot.createdAt);
    const ageDays = Math.max(0, (now.getTime() - date.getTime()) / dayMs);
    if (ageDays <= policy.keepAllDays) {
      retained.add(snapshot.id);
      continue;
    }

    const bucket =
      ageDays <= policy.keepHourlyDays
        ? `hour:${snapshot.createdAt.slice(0, 13)}`
        : ageDays <= policy.keepDailyDays
          ? `day:${snapshot.createdAt.slice(0, 10)}`
          : `week:${weekKey(date)}`;
    if (!buckets.has(bucket)) {
      buckets.add(bucket);
      retained.add(snapshot.id);
    }
  }
  return retained;
}
