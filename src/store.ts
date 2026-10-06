import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { LedgerEntry, Protest, ProtestStatus, Race, RaceEntry, RaceStatus, TimelineEvent } from './types';
import { attemptReschedule } from './ledger';
import { raceApi } from './api';

export interface AppState {
  races: Race[];
  entries: RaceEntry[];
  protests: Protest[];
  timeline: TimelineEvent[];
  schedule: {
    version: number;
    courses: { id: string; name: string; slotMinutes: number }[];
    ledger: LedgerEntry[];
  };
}

const initialEntries: RaceEntry[] = [
  { id: 'entry-1', raceId: 'race-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3168, penaltySeconds: 0, resultStatus: 'provisional', invalidated: false, note: '' },
  { id: 'entry-2', raceId: 'race-1', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3194, penaltySeconds: 30, resultStatus: 'corrected', invalidated: false, note: '标记争议' },
  { id: 'entry-3', raceId: 'race-1', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3210, penaltySeconds: 0, resultStatus: 'official', invalidated: false, note: '' },
  { id: 'entry-4', raceId: 'race-2', boat: '逐浪号', sailNo: 'CHN 312', skipper: '苏野', elapsedSeconds: 3052, penaltySeconds: 0, resultStatus: 'provisional', invalidated: false, note: '' },
  { id: 'entry-5', raceId: 'race-2', boat: '听风号', sailNo: 'CHN 405', skipper: '何苗', elapsedSeconds: 3077, penaltySeconds: 0, resultStatus: 'provisional', invalidated: false, note: '' },
  { id: 'entry-6', raceId: 'race-4', boat: '观澜号', sailNo: 'CHN 518', skipper: '庄岩', elapsedSeconds: 2988, penaltySeconds: 0, resultStatus: 'official', invalidated: false, note: '' },
  { id: 'entry-7', raceId: 'race-4', boat: '破浪号', sailNo: 'CHN 623', skipper: '唐柠', elapsedSeconds: 3015, penaltySeconds: 0, resultStatus: 'provisional', invalidated: false, note: '' }
];

const now = new Date();
// 以整点为基准排布旧表：race-1 与 race-2 在 W2 航线上时段重叠（历史遗留碰撞）
const base = new Date(now);
base.setHours(9, 0, 0, 0);
const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000).toISOString();

const initialState: AppState = {
  races: [
    { id: 'race-1', name: '海湾长距离赛 第1轮', fleet: '统一级', courseId: 'course-w2', startsAt: at(60), status: 'scheduled' },
    { id: 'race-2', name: '海湾长距离赛 第2轮', fleet: '统一级', courseId: 'course-w2', startsAt: at(80), status: 'scheduled' },
    { id: 'race-3', name: '海湾长距离赛 第3轮', fleet: '统一级', courseId: 'course-w2', startsAt: at(115), status: 'scheduled' },
    { id: 'race-4', name: '场地绕标赛', fleet: '公开级', courseId: 'course-w1', startsAt: at(70), status: 'scheduled' }
  ],
  entries: initialEntries,
  protests: [{ id: 'protest-1', raceId: 'race-1', entryId: 'entry-2', reason: '起航后发生舷侧接触', rule: 'RRS 14', status: 'reviewing', decision: '', createdAt: now.toISOString() }],
  timeline: [
    { id: 'event-1', time: now.toISOString(), type: 'race', message: '航线 W2 已发布' },
    { id: 'event-2', time: new Date(now.getTime() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' }
  ],
  schedule: {
    version: 1,
    courses: [
      { id: 'course-w2', name: 'W2 航线（长距离）', slotMinutes: 30 },
      { id: 'course-w1', name: 'W1 航线（场地）', slotMinutes: 30 }
    ],
    ledger: []
  }
};

const slice = createSlice({
  name: 'regatta',
  initialState,
  reducers: {
    setRaceStatus(state, action: PayloadAction<{ id: string; status: Race['status'] }>) {
      const race = state.races.find((item) => item.id === action.payload.id);
      if (race) {
        race.status = action.payload.status;
        state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'race', message: `${race.name} 状态更新为 ${race.status}` });
      }
    },
    saveResult(state, action: PayloadAction<{ id: string; elapsedSeconds: number; penaltySeconds: number; note: string; official: boolean }>) {
      const entry = state.entries.find((item) => item.id === action.payload.id);
      if (!entry) return;
      const changed = entry.elapsedSeconds !== action.payload.elapsedSeconds || entry.penaltySeconds !== action.payload.penaltySeconds;
      entry.elapsedSeconds = action.payload.elapsedSeconds;
      entry.penaltySeconds = action.payload.penaltySeconds;
      entry.note = action.payload.note;
      entry.invalidated = false;
      entry.resultStatus = action.payload.official ? 'official' : changed ? 'corrected' : 'provisional';
      state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'result', message: `${entry.boat} 成绩更正为 ${entry.elapsedSeconds + entry.penaltySeconds} 秒${action.payload.official ? '（正式发布）' : ''}` });
    },
    addProtest(state, action: PayloadAction<{ raceId: string; entryId: string; reason: string; rule: string }>) {
      const protest: Protest = { id: crypto.randomUUID(), ...action.payload, status: 'submitted', decision: '', createdAt: new Date().toISOString() };
      state.protests.unshift(protest);
      state.timeline.unshift({ id: crypto.randomUUID(), time: protest.createdAt, type: 'protest', message: `收到 ${action.payload.rule} 抗议，等待复核` });
    },
    transitionProtest(state, action: PayloadAction<{ id: string; status: ProtestStatus; decision?: string; penaltySeconds?: number }>) {
      const protest = state.protests.find((item) => item.id === action.payload.id);
      if (!protest) return;
      protest.status = action.payload.status;
      protest.decision = action.payload.decision ?? protest.decision;
      if (action.payload.status === 'resolved' && action.payload.penaltySeconds) {
        const entry = state.entries.find((item) => item.id === protest.entryId);
        if (entry) {
          entry.penaltySeconds = action.payload.penaltySeconds;
          entry.resultStatus = 'corrected';
          entry.invalidated = false;
        }
      }
      state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type: 'protest', message: `抗议 ${action.payload.id.slice(0, 6)} 更新为 ${action.payload.status}` });
    },
    /**
     * 排程改期事务：先释放旧占用，再申请新时段；互斥、顺延、作废未发布成绩、
     * 乐观并发先到生效；任何失败都恢复上一版并列出未落地组别。
     */
    rescheduleRace(state, action: PayloadAction<{ raceId: string; courseId: string; startsAt: string; baseVersion: number; officer: string }>) {
      const { raceId, courseId, startsAt, baseVersion, officer } = action.payload;
      const race = state.races.find((item) => item.id === raceId);
      if (!race) return;
      const time = new Date().toISOString();
      const requestedStart = new Date(startsAt).getTime();
      const fromCourseId = race.courseId;
      const fromStartsAt = race.startsAt;

      const outcome = attemptReschedule(state.races, state.entries, state.schedule.courses, state.schedule.version, {
        raceId,
        courseId,
        startsAt: requestedStart,
        baseVersion
      });

      if (outcome.kind === 'conflict') {
        // 后到的提交：不改动任何排程，草稿留在表单，账上记一笔冲突
        state.schedule.ledger.unshift({
          id: crypto.randomUUID(),
          version: state.schedule.version,
          time,
          officer,
          raceId,
          raceName: race.name,
          fromCourseId,
          fromStartsAt,
          toCourseId: courseId,
          toStartsAt: startsAt,
          cascaded: [],
          status: 'conflict',
          reason: outcome.reason,
          unlanded: []
        });
        state.timeline.unshift({ id: crypto.randomUUID(), time, type: 'system', message: `改期冲突：${race.name} 已被先到的值班员改期，当前安排已刷新，${officer} 的草稿保留未提交` });
        return;
      }

      if (outcome.kind === 'rolled-back') {
        // 恢复上一版：race 与 entries 在本 reducer 中尚未被改动，无需回滚；
        // 账上保留失败记录，并列明未落地组别
        const unlandedNames = outcome.unlandedIds
          .map((id) => state.races.find((item) => item.id === id)?.name ?? id)
          .filter((name, index, all) => all.indexOf(name) === index);
        state.schedule.ledger.unshift({
          id: crypto.randomUUID(),
          version: state.schedule.version,
          time,
          officer,
          raceId,
          raceName: race.name,
          fromCourseId,
          fromStartsAt,
          toCourseId: courseId,
          toStartsAt: startsAt,
          cascaded: [],
          status: 'rolled-back',
          reason: `${outcome.reason}；已恢复上一版（v${state.schedule.version}）`,
          unlanded: unlandedNames
        });
        state.timeline.unshift({ id: crypto.randomUUID(), time, type: 'system', message: `重排失败：${outcome.reason}，排程恢复上一版，未落地组别：${unlandedNames.join('、') || '无'}` });
        return;
      }

      // 落账：应用 moves，并对起航时间变动的组别作废未发布名次（正式发布的保持原样）
      const movedRaceIds = new Set<string>();
      for (const move of outcome.moves) {
        const movedRace = state.races.find((item) => item.id === move.raceId);
        if (!movedRace) continue;
        const timeChanged = move.fromStartsAt !== move.toStartsAt || move.fromCourseId !== move.toCourseId;
        movedRace.courseId = move.toCourseId;
        movedRace.startsAt = new Date(move.toStartsAt).toISOString();
        if (timeChanged) movedRaceIds.add(move.raceId);
      }
      for (const entry of state.entries) {
        if (movedRaceIds.has(entry.raceId) && entry.resultStatus !== 'official') {
          entry.resultStatus = 'provisional';
          entry.invalidated = true;
        }
      }

      state.schedule.version = outcome.version;
      const cascaded = outcome.moves
        .filter((move) => move.raceId !== raceId)
        .map((move) => ({
          raceId: move.raceId,
          raceName: state.races.find((item) => item.id === move.raceId)?.name ?? move.raceId,
          fromCourseId: move.fromCourseId,
          fromStartsAt: new Date(move.fromStartsAt).toISOString(),
          toCourseId: move.toCourseId,
          toStartsAt: new Date(move.toStartsAt).toISOString()
        }));

      state.schedule.ledger.unshift({
        id: crypto.randomUUID(),
        version: state.schedule.version,
        time,
        officer,
        raceId,
        raceName: race.name,
        fromCourseId,
        fromStartsAt,
        toCourseId: courseId,
        toStartsAt: startsAt,
        cascaded,
        status: 'landed',
        reason: cascaded.length > 0 ? `容量满，顺延 ${cascaded.length} 个后续组别` : '',
        unlanded: []
      });

      const cascadeNames = cascaded.map((item) => item.raceName).join('、');
      state.timeline.unshift({
        id: crypto.randomUUID(),
        time,
        type: 'system',
        message: `排程落账 v${state.schedule.version}：${race.name} 释放旧占用并改至 ${new Date(startsAt).toLocaleTimeString()}${cascadeNames ? `；后续组别 ${cascadeNames} 顺延` : ''}；未发布名次作废重算`
      });
    }
  }
});

const STORAGE_KEY = 'regatta-control-v2';
const stored = localStorage.getItem(STORAGE_KEY);
const preloadedState = stored ? JSON.parse(stored) as AppState : initialState;

export const { setRaceStatus, saveResult, addProtest, transitionProtest, rescheduleRace } = slice.actions;

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware)
});
store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().regatta)));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
