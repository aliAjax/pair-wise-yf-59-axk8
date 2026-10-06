import type { Course, Race, RaceEntry } from './types';

/** 某组别的一次航线占用 */
export interface Placement {
  courseId: string;
  /** 起航时间（毫秒时间戳） */
  startsAt: number;
}

export type Placements = Map<string, Placement>;

export function buildPlacements(races: Race[]): Placements {
  return new Map(races.map((race) => [race.id, { courseId: race.courseId, startsAt: new Date(race.startsAt).getTime() }]));
}

/** 同一航线、时段是否重叠（首尾相接不算重叠） */
export function slotsOverlap(a: Placement, b: Placement, slotMinutes: number): boolean {
  if (a.courseId !== b.courseId) return false;
  const span = slotMinutes * 60_000;
  return a.startsAt < b.startsAt + span && b.startsAt < a.startsAt + span;
}

/**
 * 从 fromStart 起，在 courseId 上找下一个不与任何在用占用重叠的时段。
 * 以 slotMinutes 为步长向后顺延；超过 horizon（当日 20:00）仍无空位则返回 null。
 */
export function findNextFreeSlot(
  placements: Placements,
  excludeRaceId: string,
  courseId: string,
  fromStart: number,
  slotMinutes: number,
  horizon: number
): number | null {
  const step = slotMinutes * 60_000;
  let t = fromStart;
  while (t <= horizon) {
    const blocked = [...placements.entries()].some(
      ([id, placement]) => id !== excludeRaceId && slotsOverlap(placement, { courseId, startsAt: t }, slotMinutes)
    );
    if (!blocked) return t;
    t += step;
  }
  return null;
}

export interface Move {
  raceId: string;
  fromCourseId: string;
  fromStartsAt: number;
  toCourseId: string;
  toStartsAt: number;
}

export type RescheduleOutcome =
  | { kind: 'landed'; version: number; moves: Move[] }
  | { kind: 'conflict'; currentVersion: number; reason: string }
  | { kind: 'rolled-back'; reason: string; unlandedIds: string[] };

/**
 * 可回滚的排程事务：
 * 1. 乐观并发校验 baseVersion，先到生效，后到返回 conflict（调用方留住草稿）；
 * 2. 释放目标组别旧占用，尝试落入新时段；
 * 3. 新时段被占则顺延占用组别（容量满即顺延后续组别），但正式发布的组别不可挪动；
 * 4. 顺延失败或撞上已发布组别 → 整单回滚，不产生任何变动。
 *
 * 纯函数：只读取 races/entries/courses，返回结果，不直接改状态。
 * moves 中的 from 为事务前的原始占用，to 为最终落定的占用。
 */
export function attemptReschedule(
  races: Race[],
  entries: RaceEntry[],
  courses: Course[],
  currentVersion: number,
  params: { raceId: string; courseId: string; startsAt: number; baseVersion: number }
): RescheduleOutcome {
  const { raceId, courseId, startsAt, baseVersion } = params;
  const race = races.find((item) => item.id === raceId);
  if (!race) return { kind: 'rolled-back', reason: '组别不存在', unlandedIds: [raceId] };

  // 乐观并发：两个值班员同时改同一组，先到的版本生效
  if (baseVersion !== currentVersion) {
    return {
      kind: 'conflict',
      currentVersion,
      reason: `你基于 v${baseVersion} 提交，当前排程已到 v${currentVersion}，以当前安排为准`
    };
  }

  const targetCourse = courses.find((item) => item.id === courseId);
  if (!targetCourse) return { kind: 'rolled-back', reason: '航线不存在', unlandedIds: [raceId] };
  const slotMinutes = targetCourse.slotMinutes;

  // 当日 20:00 为收线时间；若请求时段已过该点，则顺延到次日 20:00 前仍可排
  const horizon = new Date(startsAt);
  horizon.setHours(20, 0, 0, 0);
  if (startsAt > horizon.getTime()) horizon.setDate(horizon.getDate() + 1);

  // originalPlacements 记录事务前的原始占用（用于 from 账目）；placements 为工作占用图
  const originalPlacements = buildPlacements(races);
  const placements = buildPlacements(races);
  const moves: Move[] = [];
  const unlandedIds: string[] = [];
  const queue: { raceId: string; courseId: string; start: number }[] = [{ raceId, courseId, start: startsAt }];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentRace = races.find((item) => item.id === current.raceId);
    if (!currentRace) continue;
    const from = originalPlacements.get(current.raceId)!;

    // 同一航线同一时段只放一组：找出当前时段的占用者
    const occupantEntry = [...placements.entries()].find(
      ([id, placement]) => id !== current.raceId && slotsOverlap(placement, { courseId: current.courseId, startsAt: current.start }, slotMinutes)
    );

    if (!occupantEntry) {
      // 空位：落入
      placements.set(current.raceId, { courseId: current.courseId, startsAt: current.start });
      moves.push({
        raceId: current.raceId,
        fromCourseId: from.courseId,
        fromStartsAt: from.startsAt,
        toCourseId: current.courseId,
        toStartsAt: current.start
      });
      continue;
    }

    const [occupantId] = occupantEntry;
    const occupantRace = races.find((item) => item.id === occupantId)!;
    const occupantCurrent = placements.get(occupantId)!;

    // 正式发布的组别保持原样，不可被顺延挪动 → 整单回滚
    const occupantPublished = entries.some((entry) => entry.raceId === occupantId && entry.resultStatus === 'official');
    if (occupantPublished) {
      unlandedIds.push(current.raceId, ...queue.map((item) => item.raceId));
      return {
        kind: 'rolled-back',
        reason: `${occupantRace.name} 成绩已正式发布，占用不可挪动`,
        unlandedIds: [...new Set(unlandedIds)]
      };
    }

    // 先把当前组别落入（占用者旧时段被取代），再为占用者找下一个空时段
    placements.set(current.raceId, { courseId: current.courseId, startsAt: current.start });
    moves.push({
      raceId: current.raceId,
      fromCourseId: from.courseId,
      fromStartsAt: from.startsAt,
      toCourseId: current.courseId,
      toStartsAt: current.start
    });

    // 容量满：拒绝其原位，释放旧占用并顺延到下一个空时段
    const nextStart = findNextFreeSlot(placements, occupantId, occupantCurrent.courseId, occupantCurrent.startsAt, slotMinutes, horizon.getTime());
    if (nextStart === null) {
      unlandedIds.push(current.raceId, occupantId, ...queue.map((item) => item.raceId));
      return {
        kind: 'rolled-back',
        reason: `${occupantRace.name} 顺延失败：收线前无可用时段`,
        unlandedIds: [...new Set(unlandedIds)]
      };
    }

    placements.set(occupantId, { courseId: occupantCurrent.courseId, startsAt: nextStart });
    queue.push({ raceId: occupantId, courseId: occupantCurrent.courseId, start: nextStart });
  }

  return { kind: 'landed', version: currentVersion + 1, moves };
}
