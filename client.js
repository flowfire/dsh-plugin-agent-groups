// dsh-agent-groups — Client 半边：侧边栏入口 + 主面板。
//
// 面板只用宿主主题 token（--dsw-alias-*）和自己的控件，不 import 任何 Harness Client 包。
// Host 通过 /plugins/dsh-agent-groups/api 暴露只读状态与群操作；面板定时轮询刷新。
window.__ModuleLoader__.load({
  id: 'dsh-agent-groups',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    const API = '/plugins/dsh-agent-groups/api';
    const PANEL_ID = 'agent-groups';
    const POLL_MS = 1800;
    const TIMELINE_WINDOW = 300;

    // ── 共享样式 ──────────────────────────────────────────────────────────
    const S = {
      root: {
        display: 'flex',
        height: '100%',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: 1.6,
      },
      sidebar: {
        flex: '0 0 236px',
        minWidth: 200,
        borderRight: '1px solid var(--dsw-alias-border-l1)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      sideHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '14px 12px 10px',
      },
      sideTitle: { fontSize: 14, fontWeight: 650, letterSpacing: 0.2 },
      groupList: { flex: '1 1 auto', overflowY: 'auto', padding: '0 8px 12px' },
      groupItem: {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: '1px solid transparent',
        background: 'transparent',
        borderRadius: 8,
        padding: '8px 10px',
        marginBottom: 4,
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        font: 'inherit',
      },
      groupItemActive: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      groupName: {
        display: 'block',
        fontSize: 13,
        fontWeight: 600,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      groupMeta: {
        display: 'block',
        marginTop: 2,
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-secondary)',
      },
      main: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' },
      detailHead: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 12,
        padding: '16px 20px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      detailTitleRow: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      detailTitle: { fontSize: 15, fontWeight: 650 },
      detailSub: { marginTop: 4, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      headActions: { display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' },
      compactBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      members: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        padding: '12px 20px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        maxHeight: 220,
        overflowY: 'auto',
      },
      memberChip: {
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        fontSize: 12,
      },
      dot: { width: 7, height: 7, borderRadius: 999, flex: '0 0 auto' },
      timeline: { flex: '1 1 auto', overflowY: 'auto', padding: '14px 20px 24px' },
      systemLine: {
        margin: '8px 0',
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-secondary)',
        textAlign: 'center',
      },
      msgCard: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 9,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '9px 12px',
        marginBottom: 9,
        cursor: 'pointer',
      },
      msgCardUser: {
        background: 'var(--dsw-alias-bg-layer-2)',
        borderColor: 'var(--dsw-alias-border-l2)',
      },
      composer: {
        display: 'flex',
        gap: 8,
        alignItems: 'flex-end',
        padding: '10px 20px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      composerInput: {
        flex: '1 1 auto',
        minWidth: 0,
        minHeight: 38,
        maxHeight: 120,
        resize: 'vertical',
        boxSizing: 'border-box',
        padding: '7px 9px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: 1.5,
        font: 'inherit',
      },
      msgHead: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4, flexWrap: 'wrap' },
      msgName: { fontSize: 12.5, fontWeight: 650 },
      msgTime: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      msgMeta: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      msgText: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 },
      msgMore: { marginTop: 4, fontSize: 11.5, color: 'var(--dsw-alias-brand-primary)' },
      msgDetail: {
        marginTop: 8,
        paddingTop: 8,
        borderTop: '1px dashed var(--dsw-alias-border-l1)',
        fontSize: 11.5,
        color: 'var(--dsw-alias-label-secondary)',
        display: 'grid',
        gap: 3,
      },
      linkBtn: {
        justifySelf: 'start',
        marginTop: 4,
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        fontSize: 12,
        cursor: 'pointer',
        font: 'inherit',
      },
      btn: {
        padding: '5px 11px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12.5,
        cursor: 'pointer',
        font: 'inherit',
        whiteSpace: 'nowrap',
      },
      primaryBtn: {
        padding: '5px 11px',
        borderRadius: 7,
        border: '1px solid transparent',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#ffffff',
        fontSize: 12.5,
        cursor: 'pointer',
        font: 'inherit',
        whiteSpace: 'nowrap',
      },
      dangerBtn: {
        padding: '5px 11px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 12.5,
        cursor: 'pointer',
        font: 'inherit',
        whiteSpace: 'nowrap',
      },
      ghostBtn: {
        padding: '3px 8px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 11.5,
        cursor: 'pointer',
        font: 'inherit',
      },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '1px 8px',
        borderRadius: 999,
        fontSize: 11,
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
        background: 'var(--dsw-alias-bg-base)',
      },
      scrollPage: { flex: '1 1 auto', overflowY: 'auto', padding: '16px 20px 28px' },
      pageTitle: { margin: '0 0 4px', fontSize: 15, fontWeight: 650 },
      pageDesc: { margin: '0 0 14px', color: 'var(--dsw-alias-label-secondary)', fontSize: 12.5 },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px 14px',
        marginBottom: 12,
      },
      cardTitle: { margin: '0 0 8px', fontSize: 13, fontWeight: 650 },
      field: { display: 'grid', gap: 5, marginBottom: 10 },
      label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 9px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        font: 'inherit',
      },
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 92,
        resize: 'vertical',
        padding: '7px 9px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 12.5,
        lineHeight: 1.65,
        font: 'inherit',
      },
      sessionRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 8px',
        borderRadius: 8,
        border: '1px solid transparent',
        cursor: 'pointer',
      },
      sessionRowDisabled: { opacity: 0.55, cursor: 'not-allowed' },
      sessionTitle: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      sessionMeta: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      error: {
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 12,
        margin: '6px 0',
        whiteSpace: 'pre-wrap',
      },
      toast: {
        margin: '0 20px 8px',
        padding: '6px 10px',
        borderRadius: 7,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      empty: {
        padding: '40px 20px',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12.5,
        lineHeight: 1.8,
      },
      protocol: {
        margin: '0 20px 16px',
        padding: '8px 12px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      protocolSummary: { cursor: 'pointer', fontSize: 12.5, color: 'var(--dsw-alias-label-primary)' },
      rules: { margin: '8px 0 0', paddingLeft: 20, display: 'grid', gap: 5 },
      loading: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 13,
      },
      rowBetween: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
      inlineForm: {
        marginTop: 6,
        padding: '9px 10px',
        borderRadius: 8,
        border: '1px dashed var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        display: 'grid',
        gap: 8,
      },
      tiny: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' },
      countBadge: {
        display: 'inline-block',
        minWidth: 18,
        padding: '0 5px',
        borderRadius: 999,
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 10.5,
        textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary)',
      },
    };

    // ── 小工具 ────────────────────────────────────────────────────────────
    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    function fmtTime(ms) {
      const date = new Date(Number.isFinite(ms) ? ms : Date.now());
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
    }

    function fmtDateTime(ms) {
      const date = new Date(Number.isFinite(ms) ? ms : Date.now());
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${fmtTime(ms)}`;
    }

    function groupStatusLabel(status) {
      if (status === 'active') return '进行中';
      if (status === 'paused') return '已暂停';
      if (status === 'ended') return '已结束';
      return status;
    }

    function groupStatusColor(status) {
      if (status === 'active') return 'var(--dsw-alias-state-success-primary)';
      if (status === 'paused') return 'var(--dsw-alias-state-warn-primary)';
      return 'var(--dsw-alias-label-secondary)';
    }

    function memberLabel(member) {
      if (member.status === 'exited') return '已退出';
      if (member.status === 'removed') return '已移出';
      if (!member.live || member.agentStatus === 'offline') return '未连接';
      if (member.agentStatus === 'running') return '运行中';
      return '空闲';
    }

    function memberColor(member) {
      if (member.status === 'exited' || member.status === 'removed') return 'var(--dsw-alias-label-secondary)';
      if (!member.live || member.agentStatus === 'offline') return 'var(--dsw-alias-state-warn-primary)';
      if (member.agentStatus === 'running') return 'var(--dsw-alias-state-success-primary)';
      return 'var(--dsw-alias-label-secondary)';
    }

    function shortId(id) {
      return String(id || '').slice(0, 8);
    }

    function sessionTitle(sessions, sessionId) {
      const found = (sessions || []).find((item) => item.id === sessionId);
      return found ? found.title : shortId(sessionId);
    }

    function personaFor(template, name) {
      return String(template || '').replaceAll('{name}', name);
    }

    const DRAFT_KEY = 'dsh-agent-groups:draft';

    function readDraft() {
      try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.selected)) return null;
        return parsed;
      } catch {
        return null;
      }
    }

    function writeDraft(draft) {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      } catch {
        // 隐私模式下 localStorage 可能不可写，忽略即可。
      }
    }

    function clearDraft() {
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        // 同上。
      }
    }

    function request(method, body) {
      return fetch(API, {
        method,
        headers:
          method === 'GET'
            ? { accept: 'application/json' }
            : { 'content-type': 'application/json', accept: 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify(body),
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload.ok === false) {
          throw new Error(payload && payload.message ? payload.message : `HTTP ${response.status}`);
        }
        return payload;
      });
    }

    // ── 侧边栏图标 ────────────────────────────────────────────────────────
    function GroupIcon({ size }) {
      const edge = size || 18;
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: edge,
          height: edge,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('path', { d: 'M4 5.5h9.5a2 2 0 0 1 2 2v4.6a2 2 0 0 1-2 2H9l-3.2 2.6v-2.6H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z' }),
        h('path', { d: 'M12.2 9.2h6.8a1 1 0 0 1 1 1v4.4a1 1 0 0 1-1 1h-1.4v2.2l-2.8-2.2h-2.6a1 1 0 0 1-1-1v-4.4a1 1 0 0 1 1-1Z' }),
        h('circle', { cx: 7.2, cy: 9.8, r: 0.75, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 10, cy: 9.8, r: 0.75, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 15.2, cy: 12.7, r: 0.75, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 18.2, cy: 12.7, r: 0.75, fill: 'currentColor', stroke: 'none' }),
      );
    }

    // ── 主面板 ────────────────────────────────────────────────────────────
    function GroupPanel(props) {
      const api = props.api;
      const [data, setData] = useState(null);
      const [loadError, setLoadError] = useState('');
      const [actionError, setActionError] = useState('');
      const [toast, setToast] = useState('');
      const [busy, setBusy] = useState(false);
      const [view, setView] = useState(() =>
        props.compact === true ? 'group' : readDraft() ? 'create' : 'group',
      );
      const [selectedId, setSelectedId] = useState(null);

      const refresh = useCallback(async () => {
        try {
          const next = await api.getState();
          setData(next);
          setLoadError('');
          setSelectedId((current) => {
            const groups = Array.isArray(next.groups) ? next.groups : [];
            if (current && groups.some((group) => group.id === current)) return current;
            return groups.length > 0 ? groups[0].id : null;
          });
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      }, [api]);

      useEffect(() => {
        let alive = true;
        const tick = () => {
          if (alive) void refresh();
        };
        tick();
        const timer = setInterval(tick, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [refresh]);

      useEffect(() => {
        if (toast === '') return undefined;
        const timer = setTimeout(() => setToast(''), 2200);
        return () => clearTimeout(timer);
      }, [toast]);

      const run = useCallback(
        async (operation) => {
          setBusy(true);
          setActionError('');
          try {
            const result = await operation();
            if (result && result.state) setData(result.state);
            return result;
          } catch (error) {
            setActionError(error instanceof Error ? error.message : String(error));
            return null;
          } finally {
            setBusy(false);
          }
        },
        [],
      );

      const groups = data && Array.isArray(data.groups) ? data.groups : [];
      const sessions = data && Array.isArray(data.sessions) ? data.sessions : [];
      const defaults = data ? data.defaults : {};
      const selected = groups.find((group) => group.id === selectedId) || null;

      const onCreate = useCallback(
        async (draft) => {
          const result = await run(() => api.create(draft));
          if (result && result.ok) {
            clearDraft();
            setSelectedId(result.groupId || null);
            setView('group');
            setToast('群聊已创建');
          }
        },
        [api, run],
      );

      if (!data) {
        return h('div', { style: S.loading }, loadError ? `加载失败：${loadError}` : '正在加载协作群…');
      }

      const sidebar = h(
        'aside',
        { style: S.sidebar },
        h(
          'div',
          { style: S.sideHeader },
          h('div', { style: S.sideTitle }, '协作群'),
          h(
            'button',
            {
              style: S.primaryBtn,
              onClick: () => {
                setView('create');
                setActionError('');
              },
            },
            '＋ 新建群',
          ),
        ),
        h(
          'div',
          { style: S.groupList },
          groups.length === 0
            ? h('div', { style: S.empty }, '还没有群。', h('br'), '点右上角「新建群」开始。')
            : groups.map((group) => {
                const active = group.id === selectedId && view === 'group';
                const last = group.timeline && group.timeline.length > 0
                  ? group.timeline[group.timeline.length - 1]
                  : null;
                const activeMembers = group.members.filter((member) => member.status === 'active').length;
                return h(
                  'button',
                  {
                    key: group.id,
                    style: active ? { ...S.groupItem, ...S.groupItemActive } : S.groupItem,
                    onClick: () => {
                      setSelectedId(group.id);
                      setView('group');
                      setActionError('');
                    },
                  },
                  h('span', { style: S.groupName }, group.name),
                  h(
                    'span',
                    { style: S.groupMeta },
                    `${groupStatusLabel(group.status)} · ${activeMembers} 人 · ${
                      last ? fmtTime(last.time) : '暂无消息'
                    }`,
                  ),
                );
              }),
        ),
      );

      let content;
      if (view === 'create') {
        content = h(CreateView, {
          key: 'create',
          sessions,
          defaults,
          groups,
          busy,
          error: actionError,
          onCancel: () => {
            setView('group');
            setActionError('');
          },
          onSubmit: onCreate,
        });
      } else if (selected) {
        content = h(GroupDetail, {
          key: selected.id,
          group: selected,
          sessions,
          defaults,
          busy,
          error: actionError,
          api,
          run,
          onToast: setToast,
          onOpenRightbar: props.onOpenRightbar,
        });
      } else {
        content = h(
          'div',
          {
            style: {
              ...S.empty,
              flex: '1 1 auto',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '60px 20px',
            },
          },
          '创建一个协作群，把多个现有会话拉到一起。',
          h('br'),
          '建群后，每个成员只输出最终结论；它们的输出会按时间线自动转达给彼此。',
          h('br'),
          '成员输出「【退出会话】」即可退出群聊。',
        );
      }

      if (props.compact === true) {
        return h(
          'div',
          { style: { ...S.root, flexDirection: 'column' } },
          h(
            'div',
            { style: S.compactBar },
            h(
              'select',
              {
                style: { ...S.input, flex: '1 1 auto', minWidth: 0 },
                value: selectedId || '',
                onChange: (event) => {
                  setSelectedId(event.target.value || null);
                  setView('group');
                },
              },
              groups.length === 0 ? h('option', { value: '' }, '还没有群') : null,
              groups.map((group) =>
                h(
                  'option',
                  { key: group.id, value: group.id },
                  `${group.name}（${groupStatusLabel(group.status)}）`,
                ),
              ),
            ),
            h('button', { style: S.btn, onClick: props.onExpand }, '大面板'),
          ),
          toast !== '' ? h('div', { style: S.toast }, toast) : null,
          content,
        );
      }

      return h(
        'div',
        { style: S.root },
        sidebar,
        h(
          'main',
          { style: S.main },
          toast !== '' ? h('div', { style: S.toast }, toast) : null,
          content,
        ),
      );
    }

    // ── 新建群 ────────────────────────────────────────────────────────────
    function CreateView({ sessions, defaults, groups, busy, error, onCancel, onSubmit }) {
      const restored = useMemo(() => readDraft(), []);
      const [groupName, setGroupName] = useState(
        restored && typeof restored.groupName === 'string'
          ? restored.groupName
          : defaults.defaultGroupName || '',
      );
      const [start, setStart] = useState(
        restored && typeof restored.start === 'boolean' ? restored.start : true,
      );
      const [selected, setSelected] = useState(() =>
        restored && Array.isArray(restored.selected)
          ? restored.selected.filter(
              (item) => item && typeof item.sessionId === 'string' && typeof item.name === 'string',
            )
          : [],
      ); // [{sessionId, name, persona, touched}]
      const template = defaults.personaTemplate || '';

      useEffect(() => {
        writeDraft({ groupName, start, selected });
      }, [groupName, start, selected]);

      const toggle = useCallback(
        (session) => {
          setSelected((current) => {
            if (current.some((item) => item.sessionId === session.id)) {
              return current.filter((item) => item.sessionId !== session.id);
            }
            const name = session.title || shortId(session.id);
            return [...current, { sessionId: session.id, name, persona: personaFor(template, name), touched: false }];
          });
        },
        [template],
      );

      const updateMember = useCallback(
        (sessionId, patch) => {
          setSelected((current) =>
            current.map((item) => {
              if (item.sessionId !== sessionId) return item;
              const next = { ...item, ...patch };
              if (patch.name !== undefined) {
                if (!item.touched) next.persona = personaFor(template, patch.name);
              }
              if (patch.persona !== undefined) next.touched = true;
              return next;
            }),
          );
        },
        [template],
      );

      const canSubmit =
        selected.length >= 2 &&
        selected.every((item) => item.name.trim() !== '' && item.persona.trim() !== '') &&
        !busy;

      const cancel = useCallback(() => {
        clearDraft();
        onCancel();
      }, [onCancel]);

      const submit = useCallback(() => {
        if (!canSubmit) return;
        void onSubmit({
          name: groupName.trim(),
          start,
          members: selected.map((item) => ({
            sessionId: item.sessionId,
            name: item.name.trim(),
            persona: item.persona.trim(),
          })),
        });
      }, [canSubmit, groupName, onSubmit, selected, start]);

      const byId = useMemo(() => {
        const map = new Map();
        for (const session of sessions) map.set(session.id, session);
        return map;
      }, [sessions]);

      return h(
        'div',
        { style: S.scrollPage },
        h('h2', { style: S.pageTitle }, '新建协作群'),
        h(
          'p',
          { style: S.pageDesc },
          '从这里可以选择的，是当前已经在浏览器中打开的会话。每个成员会拿到自己的名字、角色设定，以及一份由插件维护的群协议。',
        ),
        error ? h('div', { style: S.error }, error) : null,
        h(
          'div',
          { style: S.card },
          h('div', { style: S.cardTitle }, '群信息'),
          h(
            'div',
            { style: S.field },
            h('label', { style: S.label }, '群名称（可留空自动生成）'),
            h('input', {
              style: S.input,
              value: groupName,
              placeholder: defaults.defaultGroupName || '协作群',
              onChange: (event) => setGroupName(event.target.value),
            }),
          ),
          h(
            'label',
            { style: { ...S.rowBetween, justifyContent: 'flex-start', gap: 8, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: start, onChange: (event) => setStart(event.target.checked) }),
            h('span', { style: S.tiny }, '创建后立即唤醒成员（会立刻开始互相通报；取消勾选则只建群，稍后手动「重新开场」）'),
          ),
        ),
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.rowBetween },
            h('div', { style: S.cardTitle }, '选择会话'),
            h('span', { style: S.tiny }, `已选 ${selected.length} 个，至少 2 个`),
          ),
          sessions.length === 0
            ? h('div', { style: S.tiny }, '当前没有打开的会话。请先在侧边栏打开至少两个会话，再回来建群。')
            : sessions.map((session) => {
                const isSelected = selected.some((item) => item.sessionId === session.id);
                const ownerGroup = groups.find((group) => group.id === session.groupId);
                const disabled = Boolean(ownerGroup);
                return h(
                  'div',
                  {
                    key: session.id,
                    style: disabled
                      ? { ...S.sessionRow, ...S.sessionRowDisabled }
                      : { ...S.sessionRow, background: isSelected ? 'var(--dsw-alias-bg-layer-2)' : 'transparent' },
                    onClick: () => {
                      if (!disabled) toggle(session);
                    },
                  },
                  h('input', {
                    type: 'checkbox',
                    checked: isSelected,
                    disabled,
                    readOnly: true,
                  }),
                  h('span', { style: S.sessionTitle }, session.title || shortId(session.id)),
                  h(
                    'span',
                    { style: S.sessionMeta },
                    disabled
                      ? `已在「${ownerGroup.name}」`
                      : session.agentStatus === 'running'
                        ? '运行中'
                        : '空闲',
                  ),
                );
              }),
        ),
        selected.length > 0
          ? h(
              'div',
              { style: S.card },
              h('div', { style: S.cardTitle }, '成员设定'),
              h(
                'p',
                { style: S.pageDesc },
                '名字就是它在群里的身份。角色设定是它要坚持的立场与目标；默认模板可以直接改。',
              ),
              selected.map((item) =>
                h(
                  'div',
                  { key: item.sessionId, style: { ...S.inlineForm, marginBottom: 10 } },
                  h(
                    'div',
                    { style: S.rowBetween },
                    h('span', { style: S.tiny }, byId.get(item.sessionId)?.title || shortId(item.sessionId)),
                    h(
                      'button',
                      {
                        style: S.ghostBtn,
                        onClick: () => toggle(byId.get(item.sessionId) || { id: item.sessionId }),
                      },
                      '移除',
                    ),
                  ),
                  h(
                    'div',
                    { style: S.field },
                    h('label', { style: S.label }, '群内名字'),
                    h('input', {
                      style: S.input,
                      value: item.name,
                      onChange: (event) => updateMember(item.sessionId, { name: event.target.value }),
                    }),
                  ),
                  h(
                    'div',
                    { style: S.field },
                    h('label', { style: S.label }, '角色设定（这是它可以改、你要尽量写清的部分）'),
                    h('textarea', {
                      style: S.textarea,
                      value: item.persona,
                      onChange: (event) => updateMember(item.sessionId, { persona: event.target.value }),
                    }),
                  ),
                ),
              ),
            )
          : null,
        h(
          'div',
          { style: { ...S.rowBetween, marginTop: 4 } },
          h('button', { style: S.btn, onClick: cancel, disabled: busy }, '取消'),
          h(
            'button',
            { style: S.primaryBtn, onClick: submit, disabled: !canSubmit },
            busy ? '创建中…' : start ? '创建并开始' : '仅创建',
          ),
        ),
      );
    }

    // ── 群详情 ────────────────────────────────────────────────────────────
    function GroupDetail({ group, sessions, defaults, busy, error, api, run, onToast, onOpenRightbar }) {
      const [expanded, setExpanded] = useState(() => new Set());
      const [editing, setEditing] = useState(null);
      const [adding, setAdding] = useState(false);
      const [addDraft, setAddDraft] = useState({ sessionId: '', name: '', persona: '' });
      const [draft, setDraft] = useState('');
      const scrollRef = useRef(null);
      const atBottomRef = useRef(true);

      const visibleTimeline = useMemo(() => {
        const list = Array.isArray(group.timeline) ? group.timeline : [];
        return list.slice(-TIMELINE_WINDOW);
      }, [group.timeline]);

      useEffect(() => {
        const node = scrollRef.current;
        if (!node) return;
        if (atBottomRef.current) node.scrollTop = node.scrollHeight;
      }, [visibleTimeline.length, group.timelineTotal]);

      const onScroll = useCallback(() => {
        const node = scrollRef.current;
        if (!node) return;
        atBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
      }, []);

      const toggleItem = useCallback((seq) => {
        setExpanded((current) => {
          const next = new Set(current);
          if (next.has(seq)) next.delete(seq);
          else next.add(seq);
          return next;
        });
      }, []);

      const activeMembers = group.members.filter((member) => member.status === 'active');
      const availableSessions = sessions.filter(
        (session) => !group.members.some((member) => member.sessionId === session.id),
      );

      const act = useCallback(
        async (operation, message) => {
          const result = await run(operation);
          if (result && result.ok && message) onToast(message);
          return result;
        },
        [onToast, run],
      );

      const send = useCallback(async () => {
        const text = draft.trim();
        if (text === '' || group.status !== 'active' || busy) return;
        const result = await act(() => api.say(group.id, text), null);
        if (result && result.ok) {
          setDraft('');
          atBottomRef.current = true;
          requestAnimationFrame(() => {
            const node = scrollRef.current;
            if (node) node.scrollTop = node.scrollHeight;
          });
        }
      }, [act, api, busy, draft, group.id, group.status]);

      return h(
        'div',
        { style: S.main },
        h(
          'div',
          { style: S.detailHead },
          h(
            'div',
            { style: { minWidth: 0 } },
            h(
              'div',
              { style: S.detailTitleRow },
              h('span', { style: S.detailTitle }, group.name),
              h(
                'span',
                { style: { ...S.pill, color: groupStatusColor(group.status) } },
                groupStatusLabel(group.status),
              ),
            ),
            h(
              'div',
              { style: S.detailSub },
              `${activeMembers.length} 名成员 · ${group.messageCount}/${group.maxMessages} 条成员消息 · 创建于 ${fmtDateTime(group.createdAt)}`,
            ),
          ),
          h(
            'div',
            { style: S.headActions },
            group.status === 'active'
              ? h(
                  'button',
                  {
                    style: S.btn,
                    disabled: busy,
                    onClick: () => void act(() => api.pause(group.id), '群聊已暂停'),
                  },
                  '暂停',
                )
              : null,
            group.status === 'paused'
              ? h(
                  'button',
                  {
                    style: S.btn,
                    disabled: busy,
                    onClick: () => void act(() => api.resume(group.id), '群聊已恢复'),
                  },
                  '恢复',
                )
              : null,
            group.status === 'active'
              ? h(
                  'button',
                  {
                    style: S.btn,
                    disabled: busy,
                    onClick: () => void act(() => api.kickoff(group.id), '已重新开场'),
                  },
                  '重新开场',
                )
              : null,
            onOpenRightbar
              ? h(
                  'button',
                  {
                    style: S.btn,
                    onClick: () => onOpenRightbar(),
                  },
                  '在右侧栏打开',
                )
              : null,
            group.status !== 'ended'
              ? h(
                  'button',
                  {
                    style: S.dangerBtn,
                    disabled: busy,
                    onClick: () => {
                      if (window.confirm('结束这个群？结束后成员不再收发群消息，但时间线仍可查看。')) {
                        void act(() => api.dissolve(group.id), '群聊已结束');
                      }
                    },
                  },
                  '结束群',
                )
              : h(
                  'button',
                  {
                    style: S.dangerBtn,
                    disabled: busy,
                    onClick: () => {
                      if (window.confirm('删除这个群的记录？此操作不可撤销。')) {
                        void act(() => api.remove(group.id), '群记录已删除');
                      }
                    },
                  },
                  '删除记录',
                ),
          ),
        ),
        error ? h('div', { style: { ...S.error, margin: '8px 20px 0' } }, error) : null,
        h(
          'div',
          { style: S.members },
          group.members.map((member) => {
            const editingThis = editing && editing.memberId === member.id;
            return h(
              'div',
              { key: member.id, style: { display: 'grid', gap: 6, width: '100%' } },
              h(
                'div',
                { style: { ...S.memberChip, width: '100%', boxSizing: 'border-box', borderRadius: 8 } },
                h('span', { style: { ...S.dot, background: memberColor(member) } }),
                h('span', { style: { fontWeight: 600 } }, member.name),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 11 } }, memberLabel(member)),
                h('span', { style: { flex: '1 1 auto' } }),
                h(
                  'button',
                  {
                    style: S.ghostBtn,
                    onClick: () => {
                      setEditing(
                        editingThis
                          ? null
                          : { memberId: member.id, name: member.name, persona: member.persona },
                      );
                    },
                  },
                  editingThis ? '收起' : '编辑',
                ),
                h(
                  'button',
                  {
                    style: S.ghostBtn,
                    onClick: () => api.openSession(member.sessionId),
                  },
                  '打开会话',
                ),
                member.status === 'active'
                  ? h(
                      'button',
                      {
                        style: S.ghostBtn,
                        onClick: () => {
                          if (window.confirm(`把「${member.name}」移出群聊？`)) {
                            void act(() => api.removeMember(group.id, member.id), '成员已移出');
                          }
                        },
                      },
                      '移出',
                    )
                  : null,
              ),
              editingThis
                ? h(
                    'div',
                    { style: S.inlineForm },
                    h(
                      'div',
                      { style: S.field },
                      h('label', { style: S.label }, '群内名字'),
                      h('input', {
                        style: S.input,
                        value: editing.name,
                        onChange: (event) => setEditing({ ...editing, name: event.target.value }),
                      }),
                    ),
                    h(
                      'div',
                      { style: S.field },
                      h('label', { style: S.label }, '角色设定'),
                      h('textarea', {
                        style: S.textarea,
                        value: editing.persona,
                        onChange: (event) => setEditing({ ...editing, persona: event.target.value }),
                      }),
                    ),
                    h(
                      'div',
                      { style: { ...S.rowBetween, justifyContent: 'flex-end' } },
                      h('button', { style: S.btn, onClick: () => setEditing(null) }, '取消'),
                      h(
                        'button',
                        {
                          style: S.primaryBtn,
                          disabled: busy,
                          onClick: async () => {
                            const result = await act(
                              () =>
                                api.updateMember(group.id, member.id, {
                                  name: editing.name,
                                  persona: editing.persona,
                                }),
                              '成员设定已更新',
                            );
                            if (result && result.ok) setEditing(null);
                          },
                        },
                        '保存',
                      ),
                    ),
                  )
                : null,
            );
          }),
          h(
            'button',
            {
              style: { ...S.btn, marginTop: 4 },
              onClick: () => {
                setAdding((value) => !value);
                setAddDraft({ sessionId: '', name: '', persona: '' });
              },
            },
            adding ? '取消添加' : '＋ 添加成员',
          ),
          adding
            ? h(
                'div',
                { style: { ...S.inlineForm, width: '100%', boxSizing: 'border-box' } },
                availableSessions.length === 0
                  ? h('div', { style: S.tiny }, '没有可添加的会话（需要先在浏览器打开一个新会话）。')
                  : h(
                      'div',
                      { style: S.field },
                      h('label', { style: S.label }, '选择会话'),
                      h(
                        'select',
                        {
                          style: S.input,
                          value: addDraft.sessionId,
                          onChange: (event) => {
                            const session = availableSessions.find((item) => item.id === event.target.value);
                            const name = addDraft.name || (session ? session.title : '');
                            setAddDraft({
                              sessionId: event.target.value,
                              name,
                              persona: addDraft.persona || personaFor(defaults.personaTemplate || '', name),
                            });
                          },
                        },
                        h('option', { value: '' }, '— 请选择 —'),
                        availableSessions.map((session) =>
                          h('option', { key: session.id, value: session.id }, session.title || shortId(session.id)),
                        ),
                      ),
                    ),
                h(
                  'div',
                  { style: S.field },
                  h('label', { style: S.label }, '群内名字'),
                  h('input', {
                    style: S.input,
                    value: addDraft.name,
                    onChange: (event) => setAddDraft({ ...addDraft, name: event.target.value }),
                  }),
                ),
                h(
                  'div',
                  { style: S.field },
                  h('label', { style: S.label }, '角色设定'),
                  h('textarea', {
                    style: S.textarea,
                    value: addDraft.persona,
                    onChange: (event) => setAddDraft({ ...addDraft, persona: event.target.value }),
                  }),
                ),
                h(
                  'div',
                  { style: { ...S.rowBetween, justifyContent: 'flex-end' } },
                  h('button', { style: S.btn, onClick: () => setAdding(false) }, '取消'),
                  h(
                    'button',
                    {
                      style: S.primaryBtn,
                      disabled: busy || addDraft.sessionId === '' || addDraft.name.trim() === '',
                      onClick: async () => {
                        const result = await act(
                          () =>
                            api.addMember(group.id, {
                              sessionId: addDraft.sessionId,
                              name: addDraft.name,
                              persona: addDraft.persona,
                            }),
                          '成员已加入',
                        );
                        if (result && result.ok) {
                          setAdding(false);
                          setAddDraft({ sessionId: '', name: '', persona: '' });
                        }
                      },
                    },
                    '添加',
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { ref: scrollRef, style: S.timeline, onScroll },
          group.timelineTotal > visibleTimeline.length
            ? h(
                'div',
                { style: S.systemLine },
                `仅显示最近 ${visibleTimeline.length} 条（共 ${group.timelineTotal} 条）`,
              )
            : null,
          visibleTimeline.length === 0
            ? h('div', { style: S.empty }, '群里还没有消息。成员开始输出后，时间线会出现在这里。')
            : visibleTimeline.map((item) =>
                item.kind === 'system'
                  ? h(
                      'div',
                      { key: item.seq, style: S.systemLine },
                      `${fmtTime(item.time)} · ${item.text}`,
                    )
                  : (() => {
                      const isOpen = expanded.has(item.seq);
                      const long = item.text.length > 360;
                      const shown = isOpen || !long ? item.text : `${item.text.slice(0, 360)}…`;
                      return h(
                        'div',
                        {
                          key: item.seq,
                          style: item.kind === 'user' ? { ...S.msgCard, ...S.msgCardUser } : S.msgCard,
                          onClick: () => toggleItem(item.seq),
                        },
                        h(
                          'div',
                          { style: S.msgHead },
                          h('span', { style: S.msgName }, item.name),
                          h('span', { style: S.msgTime }, fmtTime(item.time)),
                          item.turn != null ? h('span', { style: S.msgMeta }, `第 ${item.turn} 轮`) : null,
                        ),
                        h('div', { style: S.msgText }, shown),
                        long ? h('div', { style: S.msgMore }, isOpen ? '收起' : '展开详情') : null,
                        isOpen
                          ? h(
                              'div',
                              { style: S.msgDetail },
                              h('div', null, `来源会话：${sessionTitle(sessions, item.sessionId)}`),
                              h('div', null, `时间：${fmtDateTime(item.time)}`),
                              item.eventSeq != null ? h('div', null, `事件序号：${item.eventSeq}`) : null,
                              h(
                                'button',
                                {
                                  style: S.linkBtn,
                                  onClick: (event) => {
                                    event.stopPropagation();
                                    api.openSession(item.sessionId);
                                  },
                                },
                                '打开这个会话 →',
                              ),
                            )
                          : null,
                      );
                    })(),
            ),
        ),
        h(
          'div',
          { style: S.composer },
          h('textarea', {
            style: S.composerInput,
            value: draft,
            disabled: group.status !== 'active' || busy,
            placeholder:
              group.status === 'active'
                ? '以「发起者」身份在群里说一句…（Enter 发送，Shift+Enter 换行）'
                : '群聊当前不在进行中，不能发言',
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            },
          }),
          h(
            'button',
            {
              style: S.primaryBtn,
              disabled: group.status !== 'active' || busy || draft.trim() === '',
              onClick: () => void send(),
            },
            busy ? '发送中…' : '发送',
          ),
        ),
        h(
          'details',
          { style: S.protocol },
          h(
            'summary',
            { style: S.protocolSummary },
            '内置协作规则（系统维护，只读；不能修改）',
          ),
          h(
            'ol',
            { style: S.rules },
            (defaults.rules || []).map((rule, index) =>
              h('li', { key: index }, String(rule).replaceAll('{self}', '当前成员')),
            ),
          ),
          h(
            'div',
            { style: { ...S.tiny, marginTop: 8 } },
            `退出关键字：${defaults.exitKeyword || '【退出会话】'}（成员输出且仅输出这四个字时离群）。`,
            h('br'),
            `静默关键字：${defaults.silentKeyword || '【静默】'}（本轮不发言，不产生群消息，也不占时间线）。`,
          ),
        ),
      );
    }

    return {
      inject: ['slots', 'locale', 'uiWorkspace', 'layout', 'sidebarRight', 'sidebarRightTabs'],
      apply(ctx) {
        const api = {
          getState: () => request('GET'),
          openRightbar: () => {
            try {
              // 右侧栏需要一个已挂载的会话 surface；先回到对话主面板，再开侧栏。
              ctx.layout.selectPanel(null);
              setTimeout(() => {
                try {
                  ctx.sidebarRight.openTab('agent-groups');
                } catch (error) {
                  console.error('[agent-groups] 打开右侧栏失败', error);
                }
              }, 260);
            } catch (error) {
              console.error('[agent-groups] 打开右侧栏失败', error);
            }
          },
          create: (body) => request('POST', { action: 'create', ...body }),
          pause: (groupId) => request('POST', { action: 'pause', groupId }),
          resume: (groupId) => request('POST', { action: 'resume', groupId }),
          dissolve: (groupId) => request('POST', { action: 'dissolve', groupId }),
          remove: (groupId) => request('POST', { action: 'delete', groupId }),
          kickoff: (groupId) => request('POST', { action: 'kickoff', groupId }),
          say: (groupId, text) => request('POST', { action: 'say', groupId, text }),
          updateMember: (groupId, memberId, patch) =>
            request('POST', { action: 'updateMember', groupId, memberId, ...patch }),
          removeMember: (groupId, memberId) =>
            request('POST', { action: 'removeMember', groupId, memberId }),
          addMember: (groupId, member) =>
            request('POST', { action: 'addMember', groupId, ...member }),
          openSession: (sessionId) => {
            try {
              ctx.uiWorkspace.openSession(sessionId);
            } catch (error) {
              console.error('[agent-groups] 打开会话失败', error);
            }
          },
        };

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              inject: () => ({ api, compact: false, onOpenRightbar: api.openRightbar }),
            },
            GroupPanel,
          ),
        );

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => '多会话协作群',
            },
            GroupIcon,
          ),
        );

        // 右侧栏：会话活动不会抢占这里，适合群聊运行时一直看着。
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: 'agent-groups',
              kind: 'agent-groups',
              priority: 'builtin',
              keepMounted: true,
              title: () => '多会话协作群',
            }),
          'agent-groups: rightbar tab type',
        );

        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: 'agent-groups',
              inject: () => ({
                api,
                compact: true,
                onExpand: () => {
                  try {
                    ctx.layout.selectPanel('agent-groups');
                  } catch (error) {
                    console.error('[agent-groups] 切换主面板失败', error);
                  }
                },
              }),
            },
            GroupPanel,
          ),
        );
      },
    };
  },
});
