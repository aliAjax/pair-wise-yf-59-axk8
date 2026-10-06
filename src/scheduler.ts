import type { LedgerEntry, LedgerVersion, RescheduleDraft, RouteDef, SlotRef } from './types';

export interface RescheduleCommand {
  groupId: string;
  target: SlotRef;
  by: string;
  /** 提交人看到的账本版本，用于先到先得的乐观并发控制 */
  baseVersion: number;
}

export type RescheduleOutcome =
  | { kind: 'committed'; version: LedgerVersion; movedGroupIds: string[]; postponedGroupIds: string[] }
  | { kind: 'conflict'; currentVersion: number; currentSlot: SlotRef | null; draft: RescheduleDraft }
  | { kind: 'failed'; restoredVersion: number; unplacedGroupIds: string[]; reason: string };

export function slotTime(route: RouteDef, slotIndex: number): string {
  const [h, m] = route.firstSlot.split(':').map(Number);
  const total = h * 60 + m + slotIndex * route.slotMinutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function slotRange(route: RouteDef, slotIndex: number): string {
  return `${slotTime(route, slotIndex)}–${slotTime(route, slotIndex + 1)}`;
}

export function startsAtFor(route: RouteDef, date: string, slotIndex: number): string {
  return new Date(`${date}T${slotTime(route, slotIndex)}:00`).toISOString();
}

export const sameSlot = (a: SlotRef, b: SlotRef): boolean =>
  a.routeId === b.routeId && a.date === b.date && a.slotIndex === b.slotIndex;

/**
 * 改期入账：
 * 1. 版本不符 → 冲突，先到者已生效，保留草稿并回传当前安排；
 * 2. 先释放该组旧占用，再占用目标时段；
 * 3. 目标时段已满 → 拒绝重叠，占用者顺延到下一时段，级联顺推后续组别；
 * 4. 顺延超出当日末班 → 整体失败，账本保持上一版，列出没落地的组别。
 */
export function applyReschedule(args: {
  ledger: LedgerVersion;
  routes: RouteDef[];
  cmd: RescheduleCommand;
  now: string;
  makeId: () => string;
}): RescheduleOutcome {
  const { ledger, routes, cmd, now, makeId } = args;

  if (cmd.baseVersion !== ledger.version) {
    return {
      kind: 'conflict',
      currentVersion: ledger.version,
      currentSlot: ledger.entries.find((entry) => entry.groupId === cmd.groupId) ?? null,
      draft: { id: makeId(), by: cmd.by, groupId: cmd.groupId, target: cmd.target, baseVersion: cmd.baseVersion, keptAt: now }
    };
  }

  // 先释放旧占用
  const placed: LedgerEntry[] = ledger.entries.filter((entry) => entry.groupId !== cmd.groupId);
  let cursor: { groupId: string; slot: SlotRef } = { groupId: cmd.groupId, slot: cmd.target };

  for (;;) {
    const route = routes.find((item) => item.id === cursor.slot.routeId);
    if (!route) {
      return { kind: 'failed', restoredVersion: ledger.version, unplacedGroupIds: [cursor.groupId], reason: '目标航线不存在' };
    }
    if (cursor.slot.slotIndex < 0 || cursor.slot.slotIndex >= route.slotsPerDay) {
      return { kind: 'failed', restoredVersion: ledger.version, unplacedGroupIds: [cursor.groupId], reason: '当日时段已满，顺延超出末班' };
    }
    const occupantIndex = placed.findIndex((entry) => sameSlot(entry, cursor.slot));
    const occupant = occupantIndex >= 0 ? placed[occupantIndex] : undefined;
    placed.push({ groupId: cursor.groupId, ...cursor.slot });
    if (!occupant) break;
    // 容量满：拒绝重叠，占用者顺延到下一时段
    placed.splice(occupantIndex, 1);
    cursor = { groupId: occupant.groupId, slot: { ...cursor.slot, slotIndex: cursor.slot.slotIndex + 1 } };
  }

  const before = new Map(ledger.entries.map((entry) => [entry.groupId, entry]));
  const movedGroupIds = placed
    .filter((entry) => {
      const prev = before.get(entry.groupId);
      return !prev || !sameSlot(prev, entry);
    })
    .map((entry) => entry.groupId);

  const version: LedgerVersion = {
    version: ledger.version + 1,
    at: now,
    by: cmd.by,
    note: '',
    entries: placed
  };
  return { kind: 'committed', version, movedGroupIds, postponedGroupIds: movedGroupIds.filter((id) => id !== cmd.groupId) };
}
