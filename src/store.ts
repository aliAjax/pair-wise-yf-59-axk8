import { combineReducers, configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  LedgerEntry,
  LedgerVersion,
  Protest,
  ProtestStatus,
  Race,
  RaceEntry,
  RescheduleDraft,
  RescheduleFailure,
  RouteDef,
  SlotRef,
  TimelineEvent
} from './types';
import { raceApi } from './api';
import { applyReschedule, slotRange, startsAtFor } from './scheduler';

export interface AppState {
  races: Race[];
  routes: RouteDef[];
  entries: RaceEntry[];
  protests: Protest[];
  timeline: TimelineEvent[];
  ledger: { version: number; history: LedgerVersion[] };
  drafts: RescheduleDraft[];
  failures: RescheduleFailure[];
}

const now = new Date();
const raceDate = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
  .map((part) => String(part).padStart(2, '0'))
  .join('-');

const initialRoutes: RouteDef[] = [
  { id: 'route-a', name: 'A 航线 · 迎风/顺风', slotMinutes: 40, firstSlot: '09:00', slotsPerDay: 12 },
  { id: 'route-b', name: 'B 航线 · 三角绕标', slotMinutes: 40, firstSlot: '09:00', slotsPerDay: 12 },
  { id: 'route-c', name: 'C 航线 · 长距离', slotMinutes: 40, firstSlot: '09:00', slotsPerDay: 12 }
];

function makeRace(id: string, name: string, fleet: string, course: string, routeId: string, slotIndex: number): Race {
  const route = initialRoutes.find((item) => item.id === routeId)!;
  return { id, name, fleet, course, routeId, date: raceDate, slotIndex, startsAt: startsAtFor(route, raceDate, slotIndex), status: 'scheduled' };
}

const initialRaces: Race[] = [
  makeRace('race-1', '公开组 A 轮', '统一级', 'W2 / 东北风 12节', 'route-a', 0),
  makeRace('race-2', '公开组 B 轮', '统一级', 'W2 / 东北风 12节', 'route-a', 1),
  makeRace('race-3', '女子组', '统一级', 'W2 / 东北风 10节', 'route-a', 2),
  makeRace('race-4', '青少年组', 'OP 级', '三角 / 东北风 10节', 'route-b', 0),
  makeRace('race-5', '大师组', '激光级', '三角 / 东北风 10节', 'route-b', 1),
  makeRace('race-6', '长距离组', '公开级', '海湾环线', 'route-c', 0)
];

const initialEntries: RaceEntry[] = [
  { id: 'entry-1', raceId: 'race-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', elapsedSeconds: 3168, penaltySeconds: 0, resultStatus: 'provisional', note: '' },
  { id: 'entry-2', raceId: 'race-1', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', elapsedSeconds: 3194, penaltySeconds: 30, resultStatus: 'provisional', note: '标记争议' },
  { id: 'entry-3', raceId: 'race-1', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', elapsedSeconds: 3210, penaltySeconds: 0, resultStatus: 'official', note: '' },
  { id: 'entry-4', raceId: 'race-2', boat: '疾风号', sailNo: 'CHN 311', skipper: '王麒', elapsedSeconds: 3090, penaltySeconds: 0, resultStatus: 'provisional', note: '' },
  { id: 'entry-5', raceId: 'race-2', boat: '听澜号', sailNo: 'CHN 542', skipper: '苏橹', elapsedSeconds: 3120, penaltySeconds: 15, resultStatus: 'corrected', note: '计时复核' },
  { id: 'entry-6', raceId: 'race-3', boat: '白鸥号', sailNo: 'CHN 090', skipper: '韩笑', elapsedSeconds: 3305, penaltySeconds: 0, resultStatus: 'provisional', note: '' }
];

const genesisEntries: LedgerEntry[] = initialRaces.map((race) => ({
  groupId: race.id,
  routeId: race.routeId,
  date: race.date,
  slotIndex: race.slotIndex
}));

const initialState: AppState = {
  races: initialRaces,
  routes: initialRoutes,
  entries: initialEntries,
  protests: [{ id: 'protest-1', raceId: 'race-1', entryId: 'entry-2', reason: '起航后发生舷侧接触', rule: 'RRS 14', status: 'reviewing', decision: '', createdAt: now.toISOString() }],
  timeline: [
    { id: 'event-1', time: now.toISOString(), type: 'schedule', message: '排程账本 v1 初始排程已入账' },
    { id: 'event-2', time: new Date(now.getTime() + 2000).toISOString(), type: 'protest', message: '远岚号抗议进入复核' }
  ],
  ledger: { version: 1, history: [{ version: 1, at: now.toISOString(), by: '系统', note: '初始排程', entries: genesisEntries }] },
  drafts: [],
  failures: []
};

function pushTimeline(state: AppState, type: TimelineEvent['type'], message: string) {
  state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), type, message });
}

function syncRacesFromLedger(state: AppState, version: LedgerVersion) {
  for (const entry of version.entries) {
    const race = state.races.find((item) => item.id === entry.groupId);
    const route = state.routes.find((item) => item.id === entry.routeId);
    if (race && route) {
      race.routeId = entry.routeId;
      race.date = entry.date;
      race.slotIndex = entry.slotIndex;
      race.startsAt = startsAtFor(route, entry.date, entry.slotIndex);
    }
  }
}

/** 起航时间一变，未发布名次作废待重算；正式发布的保持原样，返回作废数量 */
function invalidateUnpublished(state: AppState, groupIds: string[]): number {
  let count = 0;
  for (const entry of state.entries) {
    if (groupIds.includes(entry.raceId) && entry.resultStatus !== 'official') {
      entry.resultStatus = 'invalidated';
      entry.note = '起航时间变更，名次作废待重算';
      count += 1;
    }
  }
  return count;
}

function groupName(state: AppState, id: string): string {
  return state.races.find((race) => race.id === id)?.name ?? id;
}

function runReschedule(state: AppState, payload: { groupId: string; target: SlotRef; by: string; baseVersion: number; draftId?: string }) {
  const race = state.races.find((item) => item.id === payload.groupId);
  if (!race) return;
  const current = state.ledger.history[0];
  const outcome = applyReschedule({
    ledger: current,
    routes: state.routes,
    cmd: payload,
    now: new Date().toISOString(),
    makeId: () => crypto.randomUUID()
  });

  if (outcome.kind === 'conflict') {
    state.drafts.unshift(outcome.draft);
    pushTimeline(state, 'schedule', `${payload.by} 改期 ${race.name} 基于旧版本 v${payload.baseVersion}，已被 v${outcome.currentVersion} 抢先，方案存为草稿`);
    return;
  }

  if (outcome.kind === 'failed') {
    state.failures.unshift({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      by: payload.by,
      groupId: payload.groupId,
      reason: outcome.reason,
      unplacedGroupIds: outcome.unplacedGroupIds,
      restoredVersion: outcome.restoredVersion
    });
    const unplaced = outcome.unplacedGroupIds.map((id) => groupName(state, id)).join('、');
    pushTimeline(state, 'schedule', `${race.name} 改期失败：${outcome.reason}，已恢复 v${outcome.restoredVersion}，未落地：${unplaced}`);
    return;
  }

  const route = state.routes.find((item) => item.id === payload.target.routeId);
  outcome.version.note = `${payload.by} 将 ${race.name} 改期到 ${route?.name ?? payload.target.routeId} ${route ? slotRange(route, payload.target.slotIndex) : ''}`;
  state.ledger.history.unshift(outcome.version);
  state.ledger.version = outcome.version.version;
  syncRacesFromLedger(state, outcome.version);
  const invalidated = invalidateUnpublished(state, outcome.movedGroupIds);
  if (payload.draftId) state.drafts = state.drafts.filter((draft) => draft.id !== payload.draftId);
  const postponed = outcome.postponedGroupIds.map((id) => groupName(state, id));
  pushTimeline(
    state,
    'schedule',
    `${race.name} 改期生效（v${outcome.version.version}）${postponed.length ? `，顺延：${postponed.join('、')}` : ''}${invalidated ? `，${invalidated} 条未发布名次作废待重算` : ''}`
  );
}

const slice = createSlice({
  name: 'regatta',
  initialState,
  reducers: {
    setRaceStatus(state, action: PayloadAction<{ id: string; status: Race['status'] }>) {
      const race = state.races.find((item) => item.id === action.payload.id);
      if (race) {
        race.status = action.payload.status;
        pushTimeline(state, 'race', `${race.name} 状态更新为 ${race.status}`);
      }
    },
    saveResult(state, action: PayloadAction<{ id: string; elapsedSeconds: number; penaltySeconds: number; note: string; official: boolean }>) {
      const entry = state.entries.find((item) => item.id === action.payload.id);
      if (!entry) return;
      const changed = entry.elapsedSeconds !== action.payload.elapsedSeconds || entry.penaltySeconds !== action.payload.penaltySeconds;
      entry.elapsedSeconds = action.payload.elapsedSeconds;
      entry.penaltySeconds = action.payload.penaltySeconds;
      entry.note = action.payload.note;
      entry.resultStatus = action.payload.official ? 'official' : changed || entry.resultStatus === 'invalidated' ? 'corrected' : 'provisional';
      pushTimeline(state, 'result', `${entry.boat} 成绩更正为 ${entry.elapsedSeconds + entry.penaltySeconds} 秒`);
    },
    addProtest(state, action: PayloadAction<{ raceId: string; entryId: string; reason: string; rule: string }>) {
      const protest: Protest = { id: crypto.randomUUID(), ...action.payload, status: 'submitted', decision: '', createdAt: new Date().toISOString() };
      state.protests.unshift(protest);
      pushTimeline(state, 'protest', `收到 ${action.payload.rule} 抗议，等待复核`);
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
        }
      }
      pushTimeline(state, 'protest', `抗议 ${action.payload.id.slice(0, 6)} 更新为 ${action.payload.status}`);
    },
    rescheduleGroup(state, action: PayloadAction<{ groupId: string; target: SlotRef; by: string; baseVersion: number }>) {
      runReschedule(state, action.payload);
    },
    retryDraft(state, action: PayloadAction<{ draftId: string }>) {
      const draft = state.drafts.find((item) => item.id === action.payload.draftId);
      if (!draft) return;
      runReschedule(state, { groupId: draft.groupId, target: draft.target, by: draft.by, baseVersion: state.ledger.version, draftId: draft.id });
    },
    discardDraft(state, action: PayloadAction<{ draftId: string }>) {
      state.drafts = state.drafts.filter((draft) => draft.id !== action.payload.draftId);
    },
    rollbackLedger(state) {
      if (state.ledger.history.length < 2) return;
      const [current, ...rest] = state.ledger.history;
      const previous = rest[0];
      const before = new Map(current.entries.map((entry) => [entry.groupId, entry]));
      const moved = previous.entries
        .filter((entry) => {
          const prev = before.get(entry.groupId);
          return !prev || prev.routeId !== entry.routeId || prev.date !== entry.date || prev.slotIndex !== entry.slotIndex;
        })
        .map((entry) => entry.groupId);
      state.ledger.history = rest;
      state.ledger.version = previous.version;
      syncRacesFromLedger(state, previous);
      const invalidated = invalidateUnpublished(state, moved);
      pushTimeline(state, 'schedule', `排程回滚到 v${previous.version}，${moved.length} 个组别时段变化${invalidated ? `，${invalidated} 条未发布名次作废待重算` : ''}`);
    }
  }
});

const STORAGE_KEY = 'regatta-control-v2';
const stored = localStorage.getItem(STORAGE_KEY);
const preloadedState = stored ? (JSON.parse(stored) as AppState) : initialState;

export const {
  setRaceStatus,
  saveResult,
  addProtest,
  transitionProtest,
  rescheduleGroup,
  retryDraft,
  discardDraft,
  rollbackLedger
} = slice.actions;

const rootReducer = combineReducers({ regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer });

export const store = configureStore({
  reducer: rootReducer,
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware),
  preloadedState: { regatta: preloadedState } as RootState
});
store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().regatta)));

export type RootState = ReturnType<typeof rootReducer>;
export type AppDispatch = typeof store.dispatch;
