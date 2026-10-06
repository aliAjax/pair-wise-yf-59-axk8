export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
export type ResultStatus = 'provisional' | 'corrected' | 'official' | 'invalidated';

/** 航线定义：一条航线一天被切分为若干等长时段，每个时段只放一组 */
export interface RouteDef {
  id: string;
  name: string;
  slotMinutes: number;
  firstSlot: string; // 当天首个时段起点 'HH:mm'
  slotsPerDay: number;
}

/** 组别（一场次比赛），当前占用由排程账本决定，routeId/date/slotIndex/startsAt 为账本的展示冗余 */
export interface Race {
  id: string;
  name: string;
  fleet: string;
  course: string;
  routeId: string;
  date: string; // YYYY-MM-DD
  slotIndex: number;
  startsAt: string;
  status: RaceStatus;
}

export interface RaceEntry {
  id: string;
  raceId: string;
  boat: string;
  sailNo: string;
  skipper: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  resultStatus: ResultStatus;
  note: string;
}

export interface Protest {
  id: string;
  raceId: string;
  entryId: string;
  reason: string;
  rule: string;
  status: ProtestStatus;
  decision: string;
  createdAt: string;
}

/** 航线时段坐标 */
export interface SlotRef {
  routeId: string;
  date: string;
  slotIndex: number;
}

/** 账本条目：某组占用某航线某时段 */
export interface LedgerEntry extends SlotRef {
  groupId: string;
}

/** 排程账本的一个已提交版本 */
export interface LedgerVersion {
  version: number;
  at: string;
  by: string;
  note: string;
  entries: LedgerEntry[];
}

/** 改期冲突时保留的草稿 */
export interface RescheduleDraft {
  id: string;
  by: string;
  groupId: string;
  target: SlotRef;
  baseVersion: number;
  keptAt: string;
}

/** 重排失败记录：已自动恢复上一版，并记下没落地的组别 */
export interface RescheduleFailure {
  id: string;
  at: string;
  by: string;
  groupId: string;
  reason: string;
  unplacedGroupIds: string[];
  restoredVersion: number;
}

export interface TimelineEvent {
  id: string;
  time: string;
  type: 'race' | 'result' | 'protest' | 'schedule' | 'system';
  message: string;
}
