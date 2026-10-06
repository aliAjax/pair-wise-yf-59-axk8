import { useEffect, useMemo, useState } from 'react';
import { App as AntApp, Badge, Button, Card, Col, Descriptions, Empty, Form, Input, Layout, List, Menu, Popconfirm, Row, Select, Space, Statistic, Table, Tag, Timeline, Typography, message } from 'antd';
import type { TableProps } from 'antd';
import { ClockCircleOutlined, FlagOutlined, PlusOutlined, RollbackOutlined, SafetyCertificateOutlined, ScheduleOutlined, SwapOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  addProtest,
  discardDraft,
  rescheduleGroup,
  retryDraft,
  rollbackLedger,
  saveResult,
  setRaceStatus,
  store,
  transitionProtest,
  type AppDispatch,
  type RootState
} from './store';
import { slotRange } from './scheduler';
import { useGetOfficialsQuery } from './api';
import type { RaceEntry, ResultStatus } from './types';

const { Header, Content, Sider } = Layout;

const resultColor: Record<ResultStatus, string> = { official: 'green', corrected: 'orange', provisional: 'default', invalidated: 'red' };
const resultLabel: Record<ResultStatus, string> = { official: 'official', corrected: 'corrected', provisional: 'provisional', invalidated: 'invalidated 待重算' };

const resultSchema = z.object({
  id: z.string().min(1),
  elapsedSeconds: z.number().positive(),
  penaltySeconds: z.number().min(0),
  note: z.string().max(120)
});
const protestSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(4),
  rule: z.string().min(2)
});

function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const races = useSelector((state: RootState) => state.regatta.races);
  const routes = useSelector((state: RootState) => state.regatta.routes);
  const allEntries = useSelector((state: RootState) => state.regatta.entries);
  const [raceId, setRaceId] = useState(races[0]?.id ?? '');
  const race = races.find((item) => item.id === raceId) ?? races[0];
  const entries = useMemo(() => allEntries.filter((entry) => entry.raceId === race?.id), [allEntries, race?.id]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const sorted = useMemo(() => [...entries].sort((a, b) => a.elapsedSeconds + a.penaltySeconds - b.elapsedSeconds - b.penaltySeconds), [entries]);
  if (!race) return <Empty />;
  const route = routes.find((item) => item.id === race.routeId);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card className="hero-card">
            <Space style={{ marginBottom: 12, width: '100%', justifyContent: 'space-between' }} wrap>
              <Badge status={race.status === 'running' ? 'processing' : 'success'} text={`比赛状态：${race.status}`} />
              <Select size="small" style={{ minWidth: 160 }} value={race.id} onChange={setRaceId} options={races.map((item) => ({ value: item.id, label: item.name }))} />
            </Space>
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.name} · {race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{route?.name ?? race.course}</Descriptions.Item>
              <Descriptions.Item label="起航时间">{new Date(race.startsAt).toLocaleString()}</Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Button type="primary" icon={<FlagOutlined />} onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'running' }))}>开始比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'finished' }))}>结束比赛</Button>
              <Button onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'scheduled' }))}>重置排队</Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title={t('control')} extra={<Tag color="blue">{sorted.length} 艘参赛船</Tag>}>
            <Table rowKey="id" pagination={false} dataSource={sorted} columns={[
              { title: '排名', render: (_v, _r, index) => index + 1, width: 64 },
              { title: '船名', dataIndex: 'boat' },
              { title: '帆号', dataIndex: 'sailNo' },
              { title: '船长', dataIndex: 'skipper' },
              { title: '当前净用时', render: (_v, r: RaceEntry) => `${r.elapsedSeconds + r.penaltySeconds}s` },
              { title: '状态', render: (_v, r: RaceEntry) => <Tag color={resultColor[r.resultStatus]}>{resultLabel[r.resultStatus]}</Tag> }
            ]} />
          </Card>
        </Col>
      </Row>
    </Space>
  );
}

function SchedulePage() {
  const dispatch = useDispatch<AppDispatch>();
  const races = useSelector((state: RootState) => state.regatta.races);
  const routes = useSelector((state: RootState) => state.regatta.routes);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const ledger = useSelector((state: RootState) => state.regatta.ledger);
  const drafts = useSelector((state: RootState) => state.regatta.drafts);
  const failures = useSelector((state: RootState) => state.regatta.failures);
  const { data: officials = [] } = useGetOfficialsQuery();
  const [api, contextHolder] = message.useMessage();

  const current = ledger.history[0];
  const raceDate = races[0]?.date ?? '';
  const groupNameOf = (id: string) => races.find((race) => race.id === id)?.name ?? id;

  const occupancy = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of current.entries) {
      if (entry.date === raceDate) map.set(`${entry.routeId}|${entry.slotIndex}`, entry.groupId);
    }
    return map;
  }, [current, raceDate]);

  const invalidatedGroups = useMemo(() => {
    const set = new Set<string>();
    for (const entry of entries) if (entry.resultStatus === 'invalidated') set.add(entry.raceId);
    return set;
  }, [entries]);

  const [officer, setOfficer] = useState('陈港');
  const [groupId, setGroupId] = useState(races[0]?.id ?? '');
  const [routeId, setRouteId] = useState(routes[0]?.id ?? '');
  const [slotIndex, setSlotIndex] = useState(0);
  // 表单打开时快照的账本版本：他人先提交后，本表单即为“后到的提交”
  const [baseVersion, setBaseVersion] = useState(ledger.version);

  const pickGroup = (id: string) => {
    setGroupId(id);
    const slot = current.entries.find((entry) => entry.groupId === id);
    if (slot) {
      setRouteId(slot.routeId);
      setSlotIndex(slot.slotIndex);
    }
  };

  const submit = () => {
    const versionBefore = ledger.version;
    const draftsBefore = drafts.length;
    dispatch(rescheduleGroup({ groupId, target: { routeId, date: raceDate, slotIndex }, by: officer, baseVersion }));
    const after = store.getState().regatta;
    if (after.ledger.version !== versionBefore) {
      setBaseVersion(after.ledger.version);
      api.success(`改期已入账（v${after.ledger.version}）：${after.ledger.history[0].note}`);
    } else if (after.drafts.length > draftsBefore) {
      api.warning('版本冲突：已有值班员先提交，当前安排见草稿区，你的方案已保留为草稿');
    } else {
      api.error('重排失败：当日时段不足，已恢复上一版，未落地组别见失败记录');
    }
  };

  const targetRoute = routes.find((route) => route.id === routeId);
  const slotOptions = targetRoute
    ? Array.from({ length: targetRoute.slotsPerDay }, (_, index) => {
        const occupant = occupancy.get(`${targetRoute.id}|${index}`);
        return { value: index, label: `${slotRange(targetRoute, index)} · ${occupant ? `占用：${groupNameOf(occupant)}` : '空闲'}` };
      })
    : [];

  const gridColumns: TableProps<{ slotIndex: number }>['columns'] = [
    { title: '时段', width: 110, render: (_v, row) => (routes[0] ? slotRange(routes[0], row.slotIndex) : '') },
    ...routes.map((route) => ({
      title: route.name,
      render: (_v: unknown, row: { slotIndex: number }) => {
        const gid = occupancy.get(`${route.id}|${row.slotIndex}`);
        if (!gid) return <Tag>空闲</Tag>;
        return (
          <Space size={4} wrap>
            <Tag color="geekblue">{groupNameOf(gid)}</Tag>
            {invalidatedGroups.has(gid) && <Tag color="red">待重算</Tag>}
          </Space>
        );
      }
    }))
  ];

  return (
    <>
      {contextHolder}
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Row gutter={[18, 18]}>
          <Col xs={24} lg={15}>
            <Card title={`航线时段占用（${raceDate}）`} extra={<Tag color="blue">账本 v{ledger.version}</Tag>}>
              <Table rowKey="slotIndex" pagination={false} size="small" dataSource={Array.from({ length: routes[0]?.slotsPerDay ?? 0 }, (_, index) => ({ slotIndex: index }))} columns={gridColumns} />
            </Card>
          </Col>
          <Col xs={24} lg={9}>
            <Card
              title="组别改期"
              extra={
                <Space>
                  <Tag color={baseVersion === ledger.version ? 'green' : 'orange'}>基于 v{baseVersion}</Tag>
                  <Button size="small" disabled={baseVersion === ledger.version} onClick={() => setBaseVersion(ledger.version)}>同步最新 v{ledger.version}</Button>
                </Space>
              }
            >
              <Form layout="vertical" onFinish={submit}>
                <Form.Item label="值班员">
                  <Select value={officer} onChange={setOfficer} options={officials.map((item) => ({ value: item.name, label: `${item.name} · ${item.role}` }))} />
                </Form.Item>
                <Form.Item label="组别">
                  <Select value={groupId} onChange={pickGroup} options={races.map((race) => ({ value: race.id, label: race.name }))} />
                </Form.Item>
                <Form.Item label="目标航线">
                  <Select value={routeId} onChange={(id) => { setRouteId(id); setSlotIndex(0); }} options={routes.map((route) => ({ value: route.id, label: route.name }))} />
                </Form.Item>
                <Form.Item label={`目标时段（${raceDate}）`}>
                  <Select value={slotIndex} onChange={setSlotIndex} options={slotOptions} />
                </Form.Item>
                <Button type="primary" htmlType="submit" icon={<SwapOutlined />}>提交改期</Button>
              </Form>
            </Card>
          </Col>
        </Row>
        <Row gutter={[18, 18]}>
          <Col xs={24} lg={9}>
            <Card title="改期草稿（冲突保留）">
              {drafts.length === 0 ? <Empty /> : (
                <List
                  dataSource={drafts}
                  renderItem={(draft) => {
                    const slot = current.entries.find((entry) => entry.groupId === draft.groupId);
                    const slotRoute = routes.find((route) => route.id === slot?.routeId);
                    const draftRoute = routes.find((route) => route.id === draft.target.routeId);
                    return (
                      <List.Item
                        actions={[
                          <Button key="retry" type="primary" size="small" onClick={() => dispatch(retryDraft({ draftId: draft.id }))}>按当前版本重新提交</Button>,
                          <Button key="drop" size="small" danger onClick={() => dispatch(discardDraft({ draftId: draft.id }))}>放弃</Button>
                        ]}
                      >
                        <List.Item.Meta
                          title={`${groupNameOf(draft.groupId)} → ${draftRoute?.name ?? ''} ${draftRoute ? slotRange(draftRoute, draft.target.slotIndex) : ''}`}
                          description={`${draft.by} 基于 v${draft.baseVersion} 提交 · 当前安排：${slotRoute?.name ?? '-'} ${slot && slotRoute ? slotRange(slotRoute, slot.slotIndex) : ''}（v${ledger.version}）`}
                        />
                      </List.Item>
                    );
                  }}
                />
              )}
            </Card>
          </Col>
          <Col xs={24} lg={7}>
            <Card title="重排失败记录">
              {failures.length === 0 ? <Empty /> : (
                <List
                  dataSource={failures}
                  renderItem={(failure) => (
                    <List.Item>
                      <List.Item.Meta
                        title={`${groupNameOf(failure.groupId)} 改期失败 · 已恢复 v${failure.restoredVersion}`}
                        description={
                          <>
                            <div>{failure.reason}</div>
                            <div>未落地组别：{failure.unplacedGroupIds.map(groupNameOf).join('、')}</div>
                            <small>{failure.by} · {new Date(failure.at).toLocaleTimeString()}</small>
                          </>
                        }
                      />
                    </List.Item>
                  )}
                />
              )}
            </Card>
          </Col>
          <Col xs={24} lg={8}>
            <Card
              title="排程账本"
              extra={
                <Popconfirm title="回滚到上一版？" description="时段变化将使未发布名次作废重算" onConfirm={() => dispatch(rollbackLedger())}>
                  <Button size="small" icon={<RollbackOutlined />} disabled={ledger.history.length < 2}>回滚上一版</Button>
                </Popconfirm>
              }
            >
              <Timeline items={ledger.history.map((version) => ({ color: version.version === ledger.version ? 'green' : 'gray', children: <><b>v{version.version}</b> {version.note}<div><small>{version.by} · {new Date(version.at).toLocaleString()}</small></div></> }))} />
            </Card>
          </Col>
        </Row>
      </Space>
    </>
  );
}

function ResultsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const races = useSelector((state: RootState) => state.regatta.races);
  const [api, contextHolder] = message.useMessage();
  const raceNameOf = (id: string) => races.find((race) => race.id === id)?.name ?? id;
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof resultSchema>>({
    resolver: zodResolver(resultSchema),
    defaultValues: { id: entries[0]?.id, elapsedSeconds: 3200, penaltySeconds: 0, note: '' }
  });
  const submit = (values: z.infer<typeof resultSchema>) => {
    dispatch(saveResult({ ...values, official: false }));
    api.success('成绩已更正并进入待发布状态');
    reset();
  };
  return (
    <>
      {contextHolder}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card title="成绩更正 / 重算">
            <Form layout="vertical" onFinish={handleSubmit(submit)}>
              <Form.Item label="参赛船" validateStatus={errors.id ? 'error' : undefined} help={errors.id?.message}>
                <select {...register('id')} className="native-select">{entries.map((entry) => <option key={entry.id} value={entry.id}>{raceNameOf(entry.raceId)} · {entry.boat} / {entry.sailNo}</option>)}</select>
              </Form.Item>
              <Form.Item label="净用时（秒）"><Input type="number" {...register('elapsedSeconds', { valueAsNumber: true })} /></Form.Item>
              <Form.Item label="处罚秒数"><Input type="number" {...register('penaltySeconds', { valueAsNumber: true })} /></Form.Item>
              <Form.Item label="更正原因"><Input.TextArea rows={3} {...register('note')} /></Form.Item>
              <Button htmlType="submit" type="primary">保存更正</Button>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card title="临时与正式成绩">
            <List dataSource={entries} renderItem={(entry) => (
              <List.Item actions={[
                <Button key="publish" size="small" type="link" onClick={() => dispatch(saveResult({ id: entry.id, elapsedSeconds: entry.elapsedSeconds, penaltySeconds: entry.penaltySeconds, note: entry.note, official: true }))}>发布正式</Button>
              ]}>
                <List.Item.Meta title={`${entry.boat} · ${entry.elapsedSeconds + entry.penaltySeconds} 秒`} description={<><Tag>{raceNameOf(entry.raceId)}</Tag>{entry.note || '无更正说明'}</>} />
                <Tag color={resultColor[entry.resultStatus]}>{resultLabel[entry.resultStatus]}</Tag>
              </List.Item>
            )} />
          </Card>
        </Col>
      </Row>
    </>
  );
}

function ProtestsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const timeline = useSelector((state: RootState) => state.regatta.timeline);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const races = useSelector((state: RootState) => state.regatta.races);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof protestSchema>>({ resolver: zodResolver(protestSchema), defaultValues: { entryId: entries[0]?.id, reason: '', rule: 'RRS 14' } });
  const submit = (values: z.infer<typeof protestSchema>) => {
    const entry = entries.find((item) => item.id === values.entryId);
    dispatch(addProtest({ raceId: entry?.raceId ?? races[0]?.id ?? '', ...values }));
    reset({ entryId: entries[0]?.id, reason: '', rule: 'RRS 14' });
  };
  const timelineColor: Record<string, string> = { protest: 'orange', schedule: 'purple', result: 'green', race: 'blue', system: 'gray' };
  return (
    <Row gutter={[18, 18]}>
      <Col xs={24} lg={9}>
        <Card title="提交抗议">
          <Form layout="vertical" onFinish={handleSubmit(submit)}>
            <Form.Item label="参赛船" validateStatus={errors.entryId ? 'error' : undefined}>
              <select className="native-select" {...register('entryId')}>{entries.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat}</option>)}</select>
            </Form.Item>
            <Form.Item label="适用规则" validateStatus={errors.rule ? 'error' : undefined} help={errors.rule?.message}><Input {...register('rule')} /></Form.Item>
            <Form.Item label="事件描述" validateStatus={errors.reason ? 'error' : undefined} help={errors.reason?.message}><Input.TextArea rows={4} {...register('reason')} /></Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>登记抗议</Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={9}>
        <Card title="冲突复核队列">
          {protests.length === 0 ? <Empty /> : <List dataSource={protests} renderItem={(item) => (
            <List.Item>
              <List.Item.Meta
                title={<Space><Tag color={item.status === 'reviewing' ? 'processing' : 'default'}>{item.status}</Tag>{item.rule}</Space>}
                description={<><div>{item.reason}</div><small>{entries.find((entry) => entry.id === item.entryId)?.boat}</small></>}
              />
              <Space direction="vertical">
                <Button size="small" onClick={() => dispatch(transitionProtest({ id: item.id, status: 'reviewing' }))}>进入复核</Button>
                <Button size="small" type="primary" onClick={() => dispatch(transitionProtest({ id: item.id, status: 'resolved', decision: '接受抗议并处以30秒处罚', penaltySeconds: 30 }))}>接受并处罚</Button>
                <Button size="small" danger onClick={() => dispatch(transitionProtest({ id: item.id, status: 'rejected', decision: '证据不足，维持原成绩' }))}>驳回</Button>
              </Space>
            </List.Item>
          )} />}
        </Card>
      </Col>
      <Col xs={24} lg={6}>
        <Card title="事件时间线"><Timeline items={timeline.map((event) => ({ color: timelineColor[event.type] ?? 'blue', children: <><b>{event.type}</b><div>{event.message}</div><small>{new Date(event.time).toLocaleTimeString()}</small></> }))} /></Card>
      </Col>
    </Row>
  );
}

function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { data = [] } = useGetOfficialsQuery();
  return (
    <AntApp>
      <Layout className="shell">
      <Header className="header">
        <Space><SafetyCertificateOutlined style={{ fontSize: 24 }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>{t('title')}</Typography.Title></Space>
        <Space><Tag>{data.length} 名值班人员</Tag><Button ghost onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}>{t('language')}</Button></Space>
      </Header>
      <Layout>
        <Sider width={210} breakpoint="lg" collapsedWidth="0" theme="light">
          <Menu mode="inline" selectedKeys={[location.pathname]} onClick={({ key }) => navigate(key)} items={[
            { key: '/', label: t('control'), icon: <FlagOutlined /> },
            { key: '/schedule', label: t('schedule'), icon: <ScheduleOutlined /> },
            { key: '/results', label: t('results'), icon: <ClockCircleOutlined /> },
            { key: '/protests', label: t('protests'), icon: <SafetyCertificateOutlined /> }
          ]} />
        </Sider>
        <Content className="content"><Routes>
          <Route path="/" element={<ControlPage />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/protests" element={<ProtestsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes></Content>
      </Layout>
      </Layout>
    </AntApp>
  );
}

export default function App() { return <BrowserRouter><Shell /></BrowserRouter>; }
