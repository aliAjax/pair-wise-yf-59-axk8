export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';
export type ResultStatus = 'provisional' | 'corrected' | 'official';

export interface Course {
  id: string;
  name: string;
  /** 每个组别占用航线的时长（分钟），同一航线时段不可重叠 */
  slotMinutes: number;
}

export interface Race {
  id: string;
  name: string;
  fleet: string;
  courseId: string;
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
  /** 起航时间变动后，未发布名次作废、等待重算 */
  invalidated: boolean;
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

export interface TimelineEvent {
  id: string;
  time: string;
  type: 'race' | 'result' | 'protest' | 'system';
  message: string;
}

/** 排程账条目：每一次改期事务都留痕，可核对、可回滚 */
export type LedgerStatus = 'landed' | 'conflict' | 'rolled-back';

export interface LedgerCascade {
  raceId: string;
  raceName: string;
  fromCourseId: string;
  fromStartsAt: string;
  toCourseId: string;
  toStartsAt: string;
}

export interface LedgerEntry {
  id: string;
  /** 落账后的排程版本；冲突/回滚不升版 */
  version: number;
  time: string;
  officer: string;
  raceId: string;
  raceName: string;
  fromCourseId: string;
  fromStartsAt: string;
  toCourseId: string;
  toStartsAt: string;
  /** 被顺延的后续组别 */
  cascaded: LedgerCascade[];
  status: LedgerStatus;
  reason: string;
  /** 重排失败后未能落地的组别 */
  unlanded: string[];
}

export interface ScheduleState {
  /** 排程版本号，乐观并发：先到生效 */
  version: number;
  courses: Course[];
  ledger: LedgerEntry[];
}
