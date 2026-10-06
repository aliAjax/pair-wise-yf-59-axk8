import { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp, Alert, Badge, Button, Card, Col, Descriptions, Empty, Form, Input, Layout, List, Menu, Row, Select, Space, Statistic, Table, Tag, Timeline, Typography, message } from 'antd';
import { CalendarOutlined, ClockCircleOutlined, FlagOutlined, PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { addProtest, rescheduleRace, saveResult, setRaceStatus, transitionProtest, type AppDispatch, type RootState } from './store';
import { useGetOfficialsQuery } from './api';
import { slotsOverlap, type Placement } from './ledger';
import type { Race, RaceEntry } from './types';

const { Header, Content, Sider } = Layout;

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

const DAY_START_HOUR = 8;
const DAY_SPAN_MIN = 12 * 60; // 08:00–20:00 泳道窗口

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function courseNameOf(courses: { id: string; name: string }[], courseId: string) {
  return courses.find((c) => c.id === courseId)?.name ?? courseId;
}

function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const race = useSelector((state: RootState) => state.regatta.races[0]);
  const races = useSelector((state: RootState) => state.regatta.races);
  const courses = useSelector((state: RootState) => state.regatta.schedule.courses);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const sorted = useMemo(() => [...entries].sort((a, b) => a.elapsedSeconds + a.penaltySeconds - b.elapsedSeconds - b.penaltySeconds), [entries]);
  const upcoming = useMemo(() => [...races].sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()), [races]);
  const collisionIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of races) {
      const placement: Placement = { courseId: r.courseId, startsAt: new Date(r.startsAt).getTime() };
      const course = courses.find((c) => c.id === r.courseId);
      if (!course) continue;
      if (races.some((o) => o.id !== r.id && slotsOverlap(placement, { courseId: o.courseId, startsAt: new Date(o.startsAt).getTime() }, course.slotMinutes))) set.add(r.id);
    }
    return set;
  }, [races, courses]);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card className="hero-card">
            <Badge status={race.status === 'running' ? 'processing' : 'success'} text={`比赛状态：${race.status}`} />
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{courseNameOf(courses, race.courseId)}</Descriptions.Item>
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
              { title: '状态', render: (_v, r: RaceEntry) => <Tag color={r.resultStatus === 'official' ? 'green' : r.resultStatus === 'corrected' ? 'orange' : 'default'}>{r.resultStatus}{r.invalidated ? ' · 作废待重算' : ''}</Tag> }
            ]} />
          </Card>
        </Col>
      </Row>
      <Card title="航线排程一览" extra={<Button type="link" onClick={() => navigate('/schedule')}>进入排程账 →</Button>}>
        <List dataSource={upcoming} renderItem={(item: Race) => (
          <List.Item actions={[collisionIds.has(item.id) ? <Tag key="c" color="red">时段碰撞</Tag> : <Tag key="c" color="green">已排</Tag>]}>
            <List.Item.Meta title={item.name} description={`${courseNameOf(courses, item.courseId)} · ${new Date(item.startsAt).toLocaleTimeString()} 起航`} />
          </List.Item>
        )} />
      </Card>
    </Space>
  );
}

function ResultsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const races = useSelector((state: RootState) => state.regatta.races);
  const [api, contextHolder] = message.useMessage();
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof resultSchema>>({
    resolver: zodResolver(resultSchema),
    defaultValues: { id: entries[0]?.id, elapsedSeconds: 3200, penaltySeconds: 0, note: '' }
  });
  const raceNameOf = (raceId: string) => races.find((r) => r.id === raceId)?.name ?? raceId;
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
          <Card title="成绩更正（起航时间变动后需先重算）">
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
                <List.Item.Meta
                  title={<Space>{entry.boat} · {entry.elapsedSeconds + entry.penaltySeconds} 秒{entry.invalidated ? <Tag color="red">作废 · 待重算</Tag> : null}</Space>}
                  description={`${raceNameOf(entry.raceId)} · ${entry.note || '无更正说明'}`}
                />
                <Tag color={entry.resultStatus === 'official' ? 'green' : entry.resultStatus === 'corrected' ? 'orange' : 'default'}>{entry.resultStatus}</Tag>
              </List.Item>
            )} />
          </Card>
        </Col>
      </Row>
    </>
  );
}

function CourseLane({ course, races, entries }: { course: { id: string; name: string; slotMinutes: number }; races: Race[]; entries: RaceEntry[] }) {
  const dayStart = new Date();
  dayStart.setHours(DAY_START_HOUR, 0, 0, 0);
  const blocks = races
    .filter((race) => race.courseId === course.id)
    .map((race) => {
      const start = new Date(race.startsAt);
      const leftPct = ((start.getTime() - dayStart.getTime()) / (DAY_SPAN_MIN * 60_000)) * 100;
      const widthPct = (course.slotMinutes / DAY_SPAN_MIN) * 100;
      const collides = races.some((other) => other.id !== race.id && slotsOverlap(
        { courseId: race.courseId, startsAt: start.getTime() },
        { courseId: other.courseId, startsAt: new Date(other.startsAt).getTime() },
        course.slotMinutes
      ));
      const published = entries.some((entry) => entry.raceId === race.id && entry.resultStatus === 'official');
      return { race, leftPct, widthPct, collides, published };
    });
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>{course.name} <Tag>{course.slotMinutes} 分钟/组</Tag></div>
      <div style={{ position: 'relative', height: 58, background: '#f4f8fb', borderRadius: 8, border: '1px solid #d9e6ee', overflow: 'hidden' }}>
        {Array.from({ length: DAY_SPAN_MIN / 60 + 1 }, (_, i) => (
          <div key={i} style={{ position: 'absolute', left: `${(i * 60) / DAY_SPAN_MIN * 100}%`, top: 0, bottom: 0, width: 1, background: '#e2ecf2' }} />
        ))}
        {blocks.map(({ race, leftPct, widthPct, collides, published }) => (
          <div
            key={race.id}
            style={{
              position: 'absolute',
              left: `${leftPct}%`,
              width: `${widthPct}%`,
              top: 8,
              bottom: 8,
              borderRadius: 6,
              padding: '4px 8px',
              fontSize: 12,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              color: '#fff',
              background: collides ? 'repeating-linear-gradient(45deg,#b91c1c,#b91c1c 8px,#dc2626 8px,#dc2626 16px)' : published ? '#15803d' : '#0e7490',
              border: collides ? '2px solid #7f1d1d' : 'none'
            }}
          >
            <b>{race.name}</b> · {new Date(race.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {collides ? <Tag color="red" style={{ marginLeft: 6 }}>碰撞</Tag> : null}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#7a8aa0', marginTop: 2 }}>
        <span>08:00</span><span>12:00</span><span>16:00</span><span>20:00</span>
      </div>
    </div>
  );
}

function SchedulePage() {
  const dispatch = useDispatch<AppDispatch>();
  const races = useSelector((state: RootState) => state.regatta.races);
  const courses = useSelector((state: RootState) => state.regatta.schedule.courses);
  const ledger = useSelector((state: RootState) => state.regatta.schedule.ledger);
  const version = useSelector((state: RootState) => state.regatta.schedule.version);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const { data: officials = [] } = useGetOfficialsQuery();
  const [api, contextHolder] = message.useMessage();

  const [officer, setOfficer] = useState('陈港');
  const [raceId, setRaceId] = useState(races[0]?.id ?? '');
  const [courseId, setCourseId] = useState(races[0]?.courseId ?? courses[0]?.id ?? '');
  const [startLocal, setStartLocal] = useState(() => toLocalInput(new Date(races[0]?.startsAt ?? Date.now())));
  const [draft, setDraft] = useState<{ raceId: string; courseId: string; startLocal: string } | null>(null);
  const pendingRef = useRef<{ raceId: string; at: number } | null>(null);

  const selectedRace = races.find((r) => r.id === raceId);

  // 提交后以账条为准反馈：落账 / 冲突留草稿 / 回滚列未落地组别
  useEffect(() => {
    const pending = pendingRef.current;
    const entry = ledger[0];
    if (!pending || !entry || entry.raceId !== pending.raceId || Date.now() - pending.at > 6000) return;
    pendingRef.current = null;
    if (entry.status === 'landed') {
      api.success(`已落账 v${entry.version}：${entry.raceName} 改期完成${entry.cascaded.length > 0 ? `，${entry.cascaded.length} 个后续组别顺延` : ''}；未发布名次作废重算`);
      setDraft(null);
    } else if (entry.status === 'conflict') {
      api.warning(`冲突：${entry.reason}。当前安排已刷新，你的草稿已保留`);
      setDraft({ raceId: entry.raceId, courseId: entry.toCourseId, startLocal: toLocalInput(new Date(entry.toStartsAt)) });
    } else {
      api.error(`重排失败，已恢复上一版：${entry.reason}${entry.unlanded.length ? `；未落地组别：${entry.unlanded.join('、')}` : ''}`);
    }
  }, [ledger, api]);

  const submit = () => {
    if (!selectedRace) return;
    const startsAt = new Date(startLocal).toISOString();
    pendingRef.current = { raceId: selectedRace.id, at: Date.now() };
    dispatch(rescheduleRace({ raceId: selectedRace.id, courseId, startsAt, baseVersion: version, officer }));
  };

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      {contextHolder}
      <Alert
        type="info"
        showIcon
        message="排程账规则"
        description="同一航线同一时段只放一组；容量满即拒绝原位并顺延后续组别；改期先释放旧占用，起航时间一变，未发布名次作废重算，正式发布的组别保持原样。两个值班员同时提交同一组改期时先到生效，后到的人看到当前安排并留住草稿；重排失败自动恢复上一版，并列出没落地的组别。"
      />
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={14}>
          <Card title="航线时段">
            {courses.map((course) => <CourseLane key={course.id} course={course} races={races} entries={entries} />)}
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card title="组别改期" extra={<Tag color="blue">当前版本 v{version}</Tag>}>
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <div>
                <div style={{ marginBottom: 4 }}>值班员（两个值班员同时提交同一组改期时，先到生效）</div>
                <Select style={{ width: '100%' }} value={officer} onChange={setOfficer} options={officials.map((o) => ({ value: o.name, label: `${o.name} · ${o.role}` }))} />
              </div>
              <div>
                <div style={{ marginBottom: 4 }}>组别</div>
                <Select style={{ width: '100%' }} value={raceId} onChange={(id) => {
                  const race = races.find((r) => r.id === id);
                  setRaceId(id);
                  setCourseId(race?.courseId ?? courseId);
                  setStartLocal(toLocalInput(new Date(race?.startsAt ?? Date.now())));
                }} options={races.map((r) => ({ value: r.id, label: r.name }))} />
              </div>
              <div>
                <div style={{ marginBottom: 4 }}>航线</div>
                <Select style={{ width: '100%' }} value={courseId} onChange={setCourseId} options={courses.map((c) => ({ value: c.id, label: c.name }))} />
              </div>
              <div>
                <div style={{ marginBottom: 4 }}>起航时间</div>
                <Input type="datetime-local" value={startLocal} onChange={(e) => setStartLocal(e.target.value)} />
              </div>
              {draft && draft.raceId === raceId ? (
                <Alert type="warning" showIcon message="草稿未提交" description={`你基于旧版本编辑，当前安排为：${courseNameOf(courses, races.find((r) => r.id === raceId)?.courseId ?? '')} ${new Date(races.find((r) => r.id === raceId)?.startsAt ?? '').toLocaleString()}。可直接再次提交以当前版本重排。`} />
              ) : null}
              <Button type="primary" icon={<CalendarOutlined />} onClick={submit}>提交改期（基于 v{version}）</Button>
            </Space>
          </Card>
        </Col>
      </Row>
      <Card title="排程账（可回滚）">
        {ledger.length === 0 ? <Empty description="暂无改期记录" /> : (
          <Table rowKey="id" size="small" pagination={false} dataSource={ledger} columns={[
            { title: '版本', dataIndex: 'version', render: (v: number) => <Tag>v{v}</Tag>, width: 76 },
            { title: '时间', dataIndex: 'time', render: (t: string) => new Date(t).toLocaleString(), width: 170 },
            { title: '值班员', dataIndex: 'officer', width: 90 },
            { title: '组别', dataIndex: 'raceName', width: 160 },
            {
              title: '改期',
              render: (_v, item) => (
                <Space direction="vertical" size={0}>
                  <span>{courseNameOf(courses, item.fromCourseId)} · {new Date(item.fromStartsAt).toLocaleTimeString()} → {courseNameOf(courses, item.toCourseId)} · {new Date(item.toStartsAt).toLocaleTimeString()}</span>
                </Space>
              )
            },
            {
              title: '顺延后续组别',
              render: (_v, item) => item.cascaded.length === 0 ? '—' : (
                <Space wrap>{item.cascaded.map((c) => <Tag key={c.raceId} color="orange">{c.raceName} {new Date(c.toStartsAt).toLocaleTimeString()}</Tag>)}</Space>
              )
            },
            {
              title: '状态',
              render: (_v, item) => {
                const color = item.status === 'landed' ? 'green' : item.status === 'conflict' ? 'orange' : 'red';
                const text = item.status === 'landed' ? '已落账' : item.status === 'conflict' ? '冲突·草稿保留' : '已回滚';
                return <Tag color={color}>{text}</Tag>;
              },
              width: 130
            },
            { title: '原因 / 未落地组别', render: (_v, item) => item.status === 'rolled-back' ? <span>{item.reason}{item.unlanded.length ? `；未落地：${item.unlanded.join('、')}` : ''}</span> : item.status === 'conflict' ? item.reason : item.reason || '—' }
          ]} />
        )}
      </Card>
    </Space>
  );
}

function ProtestsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const protests = useSelector((state: RootState) => state.regatta.protests);
  const timeline = useSelector((state: RootState) => state.regatta.timeline);
  const entries = useSelector((state: RootState) => state.regatta.entries);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof protestSchema>>({ resolver: zodResolver(protestSchema), defaultValues: { entryId: entries[0]?.id, reason: '', rule: 'RRS 14' } });
  const submit = (values: z.infer<typeof protestSchema>) => {
    dispatch(addProtest({ raceId: 'race-1', ...values }));
    reset({ entryId: entries[0]?.id, reason: '', rule: 'RRS 14' });
  };
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
        <Card title="事件时间线"><Timeline items={timeline.map((event) => ({ color: event.type === 'protest' ? 'orange' : event.type === 'system' ? 'blue' : 'blue', children: <><b>{event.type}</b><div>{event.message}</div><small>{new Date(event.time).toLocaleTimeString()}</small></> }))} /></Card>
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
            { key: '/schedule', label: t('schedule'), icon: <CalendarOutlined /> },
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
