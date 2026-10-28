// dsh-agent-groups — Host 半边。
//
// 职责：
//   1. 维护“协作群”状态（成员、时间线、投递游标），并持久化到 DSH 数据目录；
//   2. 监听成员会话的 turn/end，只取该轮最后一条 assistant 文本作为“最终输出”；
//   3. 把其他成员在此期间产生的输出合并成一份时间线，等目标成员空闲时用 followup 统一送达；
//   4. 处理【退出会话】、暂停/恢复、自动结束、成员增删；
//   5. 通过 systemPrompt 动态 section 给成员注入群协议与角色设定；
//   6. 通过一个只读 HTTP 路由为 Client 面板提供状态与操作入口。
//
// 设计取舍：
//   - 只接收 live 会话（必须已有 Agent 才能被 followup）；未打开的会话请先在浏览器打开。
//   - 一个会话同一时间只能属于一个未结束的群，避免同一份输出被广播到多个群。
//   - 插件不写会话日志，也不新增事件类型；所有群状态都是插件自己的数据。

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const ROUTE = '/plugins/dsh-agent-groups/api';
const EXIT_KEYWORD = '【退出会话】';
const SILENT_KEYWORD = '【静默】';
const USER_SPEAKER_NAME = '发起者';
const STATE_VERSION = 1;
const DEFAULT_MAX_MESSAGES = 80;
const MAX_TEXT_CHARS = 20000;
const MAX_TIMELINE_ENTRIES = 2000;
const MAX_DIGEST_CHARS = 48000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 固定的群协议；用户只能看，不能改。 */
const PROTOCOL_RULES = [
  '你代表自己（{self}）的职责与判断，不因其他成员坚持而放弃职责；可以基于理由修正方案，但不要顺从。',
  '只输出你希望其他成员看到的最终结论。工具调用、命令输出、文件读写、内部思考过程不要写进回复，也不要说“我正在……”之类的过程话。',
  '你的每条最终输出会被自动转达给群内其他成员；其他成员在你处理期间说的话，会在你本轮结束后合并成一份时间线送达。',
  `不要发没有信息量的占位消息，例如“收到”“继续待命”“我在”。本轮没有需要你说的话，就只输出 ${SILENT_KEYWORD}，不要为了刷存在感而发言。`,
  `只有当你明确在等某个成员的输出、并且知道自己在等什么时，才留在群里静默等待。如果你不清楚自己为什么还留在群里、或者留下也不会产生价值，只输出 ${EXIT_KEYWORD}，不要占位置。`,
  `群聊的发起者（用户）也会直接发言，标记为「${USER_SPEAKER_NAME}」。发起者的输入需要被认真对待，但它不替代你对自己职责的判断。`,
  `任务彻底结束后，只输出 ${EXIT_KEYWORD} 这四个字，不要附加任何其他文字；退出后你不再收发群消息。`,
  '不要冒充其他成员，也不要替其他成员做决定。',
];

/** 新建成员时的默认角色设定；用户可以在建群时改写。 */
const PERSONA_TEMPLATE = `你是「{name}」，在本次协作中代表这个会话原本的职责与立场。

你的目标：继续推进你原本的任务。如果原本没有明确任务，就先判断你在这次协作里最该负责的那一件事，并在发言里说清楚。

你的完成标准：当你负责的部分已经完成，或群内讨论已经不需要你再参与时，输出【退出会话】。

你的坚持：不因为其他成员坚持而放弃自己的职责；只有当对方给出你也认可的依据时，才调整自己的方案。`;

export const inject = ['agents', 'sessions', 'sessionTitle', 'systemPrompt', 'webServer'];

export function apply(ctx, config = {}) {
  const options = {
    maxMessages: clampInt(config.maxMessages, 10, 500, DEFAULT_MAX_MESSAGES),
    deliveryDelayMs: clampInt(config.deliveryDelayMs, 0, 5000, 150),
    storePath:
      typeof config.storePath === 'string' && config.storePath.trim() !== ''
        ? config.storePath.trim()
        : defaultStorePath(),
  };

  const state = { version: STATE_VERSION, groups: [] };
  /** sessionId -> 该会话当前 turn 里最后一条非空 assistant 文本。 */
  const lastAssistant = new Map();
  /** memberId -> 正在投递，防止并发重复。 */
  const delivering = new Set();
  /** groupId -> 合并投递的定时器。 */
  const deliveryTimers = new Map();
  let saveTimer = null;
  let disposed = false;

  loadState();

  // ── 对外路由 ────────────────────────────────────────────────────────────
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: handleHttp,
      }),
    'agent-groups: http route',
  );

  // ── 成员会话事件 ────────────────────────────────────────────────────────
  ctx.effect(() => {
    const offEvent = ctx.on('session/event', onSessionEvent);
    const offStatus = ctx.on('agent/status', onAgentStatus);
    const offCreated = ctx.on('agent/created', onAgentCreated);
    return () => {
      if (typeof offEvent === 'function') offEvent();
      if (typeof offStatus === 'function') offStatus();
      if (typeof offCreated === 'function') offCreated();
    };
  }, 'agent-groups: agent listeners');

  // ── 动态 system prompt：成员身份、角色与协议 ────────────────────────────
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'agent-groups:protocol',
        order: 10050,
        text: (assembly) => {
          const agent = assembly && assembly.agent;
          if (!agent) return '';
          return buildProtocolPrompt(agent);
        },
      }),
    'agent-groups: system prompt section',
  );

  // ── 卸载时清定时器并落盘 ────────────────────────────────────────────────
  ctx.effect(() => () => {
    disposed = true;
    for (const timer of deliveryTimers.values()) clearTimeout(timer);
    deliveryTimers.clear();
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
    saveNow();
  }, 'agent-groups: teardown');

  // ── 重启后补投：活跃群成员若已经空闲，把积压的消息送出去 ─────────────────
  for (const group of state.groups) {
    if (group.status === 'active') scheduleDelivery(group, 0);
  }

  // ======================================================================
  // 事件处理
  // ======================================================================

  function onSessionEvent(session, event) {
    if (disposed || !session || !event) return;
    const group = groupOfSession(session.id);
    if (!group) return;
    const member = group.members.find((item) => item.sessionId === session.id);
    if (!member || member.status !== 'active') {
      lastAssistant.delete(session.id);
      return;
    }

    if (event.type === 'assistant/message') {
      const data = event.data;
      const text = extractAssistantText(data && data.message);
      if (!text) return;
      lastAssistant.set(session.id, {
        turn: data.turn,
        text,
        seq: event.seq,
        time: event.time,
      });
      return;
    }

    if (event.type === 'turn/end') {
      const data = event.data;
      const last = lastAssistant.get(session.id);
      lastAssistant.delete(session.id);
      if (!last || last.turn !== data.turn) return;
      // 加入群之前的轮次不广播，避免把建群前的历史当成群消息。
      if (typeof event.seq === 'number' && event.seq <= member.joinedSeq) return;
      handleMemberOutput(group, member, last.text, {
        turn: data.turn,
        eventSeq: event.seq,
        time: event.time,
      });
    }
  }

  function onAgentStatus(payload) {
    if (disposed || !payload || !payload.agent) return;
    if (payload.status !== 'idle') return;
    const group = groupOfSession(payload.agent.id);
    if (!group) return;
    scheduleDelivery(group, 0);
  }

  function onAgentCreated(payload) {
    if (disposed || !payload || !payload.agent) return;
    const group = groupOfSession(payload.agent.id);
    if (!group) return;
    scheduleDelivery(group, 0);
  }

  function handleMemberOutput(group, member, text, meta) {
    if (group.status !== 'active') return;
    const clean = String(text ?? '').trim();
    if (clean === '') return;

    if (clean === EXIT_KEYWORD) {
      exitMember(group, member);
      return;
    }

    // 成员选择本轮不发言：不进入时间线，不计数，也不触发投递。
    if (clean === SILENT_KEYWORD) return;

    // 同一轮同一事件不重复入线（防御性去重）。
    if (
      group.timeline.some(
        (item) =>
          item.kind === 'member' &&
          item.sessionId === member.sessionId &&
          item.turn === meta.turn &&
          item.eventSeq === meta.eventSeq,
      )
    ) {
      return;
    }

    appendTimeline(group, {
      kind: 'member',
      memberId: member.id,
      name: member.name,
      sessionId: member.sessionId,
      text: clipText(clean, MAX_TEXT_CHARS),
      time: meta.time,
      turn: meta.turn,
      eventSeq: meta.eventSeq,
    });
    member.turns += 1;
    group.messageCount += 1;

    if (group.messageCount >= group.maxMessages) {
      group.status = 'paused';
      group.endedReason = 'limit';
      addSystem(group, `已达到本次群聊的消息上限（${group.maxMessages} 条），群聊自动暂停。`);
    } else {
      scheduleSave();
    }
    scheduleDelivery(group);
  }

  function exitMember(group, member) {
    if (member.status !== 'active') return;
    member.status = 'exited';
    member.exitedAt = Date.now();
    addSystem(group, `${member.name} 退出了群聊。`);
    maybeEndGroup(group);
    scheduleSave();
    scheduleDelivery(group, 0);
  }

  function maybeEndGroup(group) {
    if (group.status === 'ended') return;
    const remaining = group.members.filter((item) => item.status === 'active');
    if (remaining.length >= 2) return;
    group.status = 'ended';
    group.endedReason = 'members';
    addSystem(group, '群聊结束：剩余成员不足两人。');
  }

  // ======================================================================
  // 投递：把未读时间线合并成一份，等成员空闲时统一送达
  // ======================================================================

  function scheduleDelivery(group, delay = options.deliveryDelayMs) {
    if (disposed || group.status !== 'active') return;
    if (deliveryTimers.has(group.id)) return;
    const timer = setTimeout(() => {
      deliveryTimers.delete(group.id);
      void deliverGroup(group);
    }, delay);
    timer.unref?.();
    deliveryTimers.set(group.id, timer);
  }

  async function deliverGroup(group) {
    if (disposed || group.status !== 'active') return;
    for (const member of group.members) {
      if (member.status !== 'active') continue;
      await deliverMember(group, member);
    }
  }

  async function deliverMember(group, member) {
    if (disposed || group.status !== 'active' || member.status !== 'active') return;
    if (delivering.has(member.id)) return;
    const agent = ctx.agents.get(member.sessionId);
    if (!agent) return;
    if (agent.status === 'running') return; // 等这一轮真正结束再送

    const pending = group.timeline.filter(
      (item) => item.seq > member.delivered && item.memberId !== member.id,
    );
    if (pending.length === 0) return;

    const digest = buildDigest(group, member, pending);
    if (!digest) return;

    const lastSeq = group.timeline.length > 0 ? group.timeline[group.timeline.length - 1].seq : member.delivered;
    const previous = member.delivered;
    delivering.add(member.id);
    member.delivered = lastSeq;
    scheduleSave();
    try {
      agent.followup(makeUserMessage(digest));
    } catch (error) {
      member.delivered = previous;
      console.error('[agent-groups] 投递失败', error);
    } finally {
      delivering.delete(member.id);
    }
  }

  function buildDigest(group, member, pending) {
    const header = [
      `【群聊 · ${group.name}】`,
      `你是「${member.name}」。在你处理期间，群里出现了以下发言（按时间顺序）：`,
      '',
    ];
    const tail = [
      '先判断这些发言是否影响你的任务；对方的意见可以作为参考，但你的判断以你自己的职责为准。',
      `- 需要你行动或回应：直接输出结论即可（会自动转达给群内其他成员）。`,
      `- 不需要：只输出 ${SILENT_KEYWORD}，不要发“收到”“继续待命”这类占位话。`,
      `- 你的任务已经结束，或者你在这里已经无事可做：只输出 ${EXIT_KEYWORD}，不要附加任何其他文字。`,
    ];

    // 从最近的消息往前挑，保证整份 digest 不超过上限。
    const blocks = [];
    let size = header.join('\n').length + tail.join('\n').length;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const item = pending[index];
      const block = [
        `--- ${formatTime(item.time)} · ${item.kind === 'system' ? '系统' : item.name} ---`,
        item.text,
        '',
      ].join('\n');
      if (blocks.length > 0 && size + block.length > MAX_DIGEST_CHARS) break;
      blocks.unshift(block);
      size += block.length;
    }
    if (blocks.length < pending.length) {
      blocks.unshift(`（更早的 ${pending.length - blocks.length} 条群消息因长度限制已省略）\n`);
    }
    return [...header, ...blocks, ...tail].join('\n');
  }

  // ======================================================================
  // system prompt / 开场消息
  // ======================================================================

  function buildProtocolPrompt(agent) {
    const group = groupOfSession(agent.id);
    if (!group) return '';
    if (group.status === 'ended') return '';
    const member = group.members.find((item) => item.sessionId === agent.id);
    if (!member || member.status !== 'active') return '';

    const members = group.members.filter((item) => item.status === 'active');
    const lines = [
      '# 多会话协作群',
      '',
      `你正在「${group.name}」这个协作群里，身份是「${member.name}」。`,
      '',
      '## 你的角色设定',
      member.persona || defaultPersona(member.name),
      '',
      '## 群成员',
      ...members.map(
        (item) =>
          `- ${item.name}${item.id === member.id ? '（你）' : ''}：${
            personaSummary(item.persona) || '未填写职责'
          }`,
      ),
      '',
      '## 协作规则（系统维护，不可更改）',
      ...PROTOCOL_RULES.map(
        (rule, index) => `${index + 1}. ${rule.replaceAll('{self}', member.name)}`,
      ),
    ];
    if (group.status === 'paused') {
      lines.push('', '注意：群聊当前处于暂停状态，暂时不会收发群消息。');
    }
    return lines.join('\n');
  }

  function buildKickoff(group, member) {
    const others = group.members.filter(
      (item) => item.status === 'active' && item.id !== member.id,
    );
    return [
      `【群聊 · ${group.name}】`,
      `你已加入一个多会话协作群，你在群里的身份是「${member.name}」。`,
      '',
      others.length > 0 ? '群内还有其他成员：' : '群内暂时没有其他成员。',
      ...others.map(
        (item) => `- ${item.name}：${personaSummary(item.persona) || '未填写职责'}`,
      ),
      '',
      `群里还有「${USER_SPEAKER_NAME}」（发起这个群的用户），会直接发言。`,
      '',
      '请先判断你在这个群里要做什么：',
      `- 有明确任务，或者明确在等谁的输出：继续推进。本轮没有要补充的就只输出 ${SILENT_KEYWORD}，不要发“收到”这类占位话。`,
      `- 不清楚自己为什么在这里，或者留下也不会产生价值：只输出 ${EXIT_KEYWORD}，不要占位置。`,
      '',
      '你的每条最终输出会被自动转达给其他成员；其他成员在你处理期间说的话，会在你本轮结束后合并成一份时间线送达。',
    ].join('\n');
  }

  function kickoff(group, onlyMember) {
    const targets = onlyMember ? [onlyMember] : group.members;
    for (const member of targets) {
      if (member.status !== 'active') continue;
      const agent = ctx.agents.get(member.sessionId);
      if (!agent) continue;
      try {
        agent.followup(makeUserMessage(buildKickoff(group, member)));
      } catch (error) {
        console.error(`[agent-groups] 无法唤醒成员 ${member.name}`, error);
      }
    }
  }

  // ======================================================================
  // HTTP
  // ======================================================================

  async function handleHttp(req, res) {
    try {
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === 'GET') {
        sendJson(res, 200, snapshot());
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, message: '只支持 GET / POST' });
        return;
      }
      const body = await readJsonBody(req);
      const outcome = await dispatch(body);
      const payload = outcome.ok
        ? { ...outcome, state: snapshot() }
        : outcome;
      sendJson(res, outcome.ok ? 200 : 400, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { ok: false, message });
    }
  }

  async function dispatch(body) {
    const action = typeof body?.action === 'string' ? body.action : '';
    switch (action) {
      case 'create':
        return createGroup(body);
      case 'pause':
        return pauseGroup(body);
      case 'resume':
        return resumeGroup(body);
      case 'dissolve':
        return dissolveGroup(body);
      case 'delete':
        return deleteGroup(body);
      case 'rename':
        return renameGroup(body);
      case 'updateMember':
        return updateMember(body);
      case 'removeMember':
        return removeMember(body);
      case 'addMember':
        return addMember(body);
      case 'kickoff':
        return reKickoff(body);
      case 'say':
        return postUserMessage(body);
      default:
        return { ok: false, message: `未知操作：${action || '（空）'}` };
    }
  }

  // ======================================================================
  // 群操作
  // ======================================================================

  function createGroup(input) {
    const rawMembers = Array.isArray(input.members) ? input.members : [];
    if (rawMembers.length < 2) return { ok: false, message: '至少选择两个会话' };

    const seen = new Set();
    const members = [];
    for (const raw of rawMembers) {
      const sessionId = String(raw?.sessionId ?? '').trim();
      if (!sessionId) return { ok: false, message: '成员会话不能为空' };
      if (seen.has(sessionId)) return { ok: false, message: '同一个会话不能被重复拉入' };
      seen.add(sessionId);

      const session = ctx.sessions.get(sessionId);
      if (!session) {
        return { ok: false, message: `会话 ${sessionId.slice(0, 8)} 不在线，请先在浏览器里打开它` };
      }
      if (session.header?.origin === 'subagent') {
        return { ok: false, message: '子会话不能拉入协作群' };
      }
      if (groupOfSession(sessionId)) {
        return {
          ok: false,
          message: `会话「${titleOf(session)}」已经在另一个协作群里，请先让它退出或解散那个群`,
        };
      }
      const agent = ctx.agents.get(sessionId);
      if (!agent) {
        return { ok: false, message: `会话「${titleOf(session)}」没有活动的 Agent，请先打开它` };
      }

      const name = uniqueMemberName(
        members,
        normalizeMemberName(raw?.name) || titleOf(session) || shortId(sessionId),
      );
      members.push({
        id: `m_${randomUUID()}`,
        sessionId,
        name,
        persona: normalizePersona(raw?.persona, name),
        joinedAt: Date.now(),
        status: 'active',
        delivered: 0,
        turns: 0,
        joinedSeq: typeof session.seq === 'number' ? session.seq : 0,
      });
    }

    const group = {
      id: `g_${randomUUID()}`,
      name: normalizeGroupName(input?.name),
      createdAt: Date.now(),
      status: 'active',
      endedReason: null,
      maxMessages: options.maxMessages,
      messageCount: 0,
      nextSeq: 1,
      timeline: [],
      members,
    };
    addSystem(group, `群聊已创建，成员：${members.map((item) => item.name).join('、')}。`);
    state.groups.push(group);
    scheduleSave();

    if (input?.start !== false) {
      kickoff(group);
      scheduleDelivery(group, 0);
    } else {
      // 仅创建：不唤醒任何成员，也不投递建群系统消息。
      for (const member of group.members) member.delivered = group.nextSeq - 1;
      scheduleSave();
    }
    return { ok: true, groupId: group.id };
  }

  function pauseGroup(input) {
    const group = requireGroup(input?.groupId);
    if (!group.ok) return group;
    if (group.value.status !== 'active') return { ok: false, message: '只有进行中的群可以暂停' };
    group.value.status = 'paused';
    addSystem(group.value, '群聊已暂停：期间不再转发或投递消息。');
    scheduleSave();
    return { ok: true };
  }

  function resumeGroup(input) {
    const group = requireGroup(input?.groupId);
    if (!group.ok) return group;
    if (group.value.status !== 'paused') return { ok: false, message: '只有已暂停的群可以恢复' };
    group.value.status = 'active';
    group.value.endedReason = null;
    addSystem(group.value, '群聊已恢复：继续转发消息。');
    scheduleSave();
    scheduleDelivery(group.value, 0);
    return { ok: true };
  }

  function dissolveGroup(input) {
    const group = requireGroup(input?.groupId);
    if (!group.ok) return group;
    if (group.value.status === 'ended') return { ok: false, message: '群聊已经结束' };
    group.value.status = 'ended';
    group.value.endedReason = 'dissolved';
    addSystem(group.value, '群聊已由发起者结束。');
    scheduleSave();
    return { ok: true };
  }

  function deleteGroup(input) {
    const group = requireGroup(input?.groupId);
    if (!group.ok) return group;
    group.value.status = 'ended';
    const index = state.groups.findIndex((item) => item.id === group.value.id);
    if (index >= 0) state.groups.splice(index, 1);
    scheduleSave();
    return { ok: true };
  }

  function renameGroup(input) {
    const group = requireGroup(input?.groupId);
    if (!group.ok) return group;
    const name = normalizeGroupName(input?.name, group.value.name);
    if (name === group.value.name) return { ok: true };
    const previous = group.value.name;
    group.value.name = name;
    addSystem(group.value, `群名称由「${previous}」改为「${name}」。`);
    scheduleSave();
    return { ok: true };
  }

  function updateMember(input) {
    const group = requireGroup(input?.groupId);
    if (!group.ok) return group;
    const member = group.value.members.find((item) => item.id === input?.memberId);
    if (!member) return { ok: false, message: '成员不存在' };

    let changed = false;
    if (typeof input?.name === 'string') {
      const nextName = normalizeMemberName(input.name);
      if (nextName && nextName !== member.name) {
        const previous = member.name;
        member.name = uniqueMemberName(
          group.value.members.filter((item) => item.id !== member.id),
          nextName,
        );
        addSystem(group.value, `${previous} 改名为 ${member.name}。`);
        changed = true;
      }
    }
    if (typeof input?.persona === 'string') {
      const nextPersona = input.persona.trim();
      if (nextPersona !== '' && nextPersona !== member.persona) {
        member.persona = nextPersona;
        changed = true;
      }
    }
    if (changed) scheduleSave();
    return { ok: true };
  }

  function removeMember(input) {
    const group = requireGroup(input?.groupId);
    if (!group.ok) return group;
    const member = group.value.members.find((item) => item.id === input?.memberId);
    if (!member) return { ok: false, message: '成员不存在' };
    if (member.status !== 'active') return { ok: false, message: '该成员已经不在群里' };
    member.status = 'removed';
    member.exitedAt = Date.now();
    addSystem(group.value, `${member.name} 被移出了群聊。`);
    maybeEndGroup(group.value);
    scheduleSave();
    scheduleDelivery(group.value, 0);
    return { ok: true };
  }

  function addMember(input) {
    const group = requireGroup(input?.groupId);
    if (!group.ok) return group;
    if (group.value.status === 'ended') return { ok: false, message: '群聊已经结束，不能继续加人' };

    const sessionId = String(input?.sessionId ?? '').trim();
    if (!sessionId) return { ok: false, message: '缺少会话' };
    const session = ctx.sessions.get(sessionId);
    if (!session) return { ok: false, message: '该会话不在线，请先打开它' };
    if (session.header?.origin === 'subagent') return { ok: false, message: '子会话不能拉入协作群' };
    const owner = groupOfSession(sessionId);
    if (owner) return { ok: false, message: `该会话已经在「${owner.name}」里` };
    if (!ctx.agents.get(sessionId)) return { ok: false, message: '该会话没有活动的 Agent' };

    const name = uniqueMemberName(
      group.value.members,
      normalizeMemberName(input?.name) || titleOf(session) || shortId(sessionId),
    );
    const member = {
      id: `m_${randomUUID()}`,
      sessionId,
      name,
      persona: normalizePersona(input?.persona, name),
      joinedAt: Date.now(),
      status: 'active',
      delivered: 0,
      turns: 0,
      joinedSeq: typeof session.seq === 'number' ? session.seq : 0,
    };
    group.value.members.push(member);
    addSystem(group.value, `${member.name} 加入了群聊。`);
    scheduleSave();
    if (group.value.status === 'active') {
      kickoff(group.value, member);
      scheduleDelivery(group.value, 0);
    }
    return { ok: true, memberId: member.id };
  }

  function reKickoff(input) {
    const group = requireGroup(input?.groupId);
    if (!group.ok) return group;
    if (group.value.status !== 'active') return { ok: false, message: '只有进行中的群可以重新开场' };
    kickoff(group.value);
    return { ok: true };
  }

  /** 发起者发言：与成员输出走同一条时间线、同一套合并投递，只是不占成员轮次。 */
  function postUserMessage(input) {
    const group = requireGroup(input?.groupId);
    if (!group.ok) return group;
    if (group.value.status !== 'active') {
      return { ok: false, message: '群聊当前不在进行中，不能发言' };
    }
    const text = typeof input?.text === 'string' ? input.text.trim() : '';
    if (text === '') return { ok: false, message: '发言内容不能为空' };
    appendTimeline(group.value, {
      kind: 'user',
      name: USER_SPEAKER_NAME,
      text: clipText(text, MAX_TEXT_CHARS),
      time: Date.now(),
    });
    scheduleSave();
    scheduleDelivery(group.value, 0);
    return { ok: true };
  }

  function requireGroup(groupId) {
    const id = typeof groupId === 'string' ? groupId : '';
    const group = state.groups.find((item) => item.id === id);
    if (!group) return { ok: false, message: '群不存在' };
    return { ok: true, value: group };
  }

  // ======================================================================
  // 状态快照
  // ======================================================================

  function snapshot() {
    return {
      ok: true,
      now: Date.now(),
      groups: state.groups.map(publicGroup),
      sessions: listLiveSessions(),
      defaults: {
        exitKeyword: EXIT_KEYWORD,
        silentKeyword: SILENT_KEYWORD,
        protocolTitle: '多会话协作群',
        rules: PROTOCOL_RULES,
        personaTemplate: PERSONA_TEMPLATE,
        defaultGroupName: defaultGroupName(),
        maxMessages: options.maxMessages,
        deliveryDelayMs: options.deliveryDelayMs,
      },
    };
  }

  function publicGroup(group) {
    return {
      id: group.id,
      name: group.name,
      status: group.status,
      endedReason: group.endedReason ?? null,
      createdAt: group.createdAt,
      messageCount: group.messageCount,
      maxMessages: group.maxMessages,
      members: group.members.map((member) => {
        const agent = ctx.agents.get(member.sessionId);
        return {
          id: member.id,
          sessionId: member.sessionId,
          name: member.name,
          persona: member.persona,
          status: member.status,
          turns: member.turns,
          joinedAt: member.joinedAt,
          live: Boolean(agent),
          agentStatus: agent ? agent.status : 'offline',
          delivered: member.delivered,
        };
      }),
      timelineTotal: group.timeline.length,
      timeline: group.timeline.slice(-500).map((item) => ({ ...item })),
    };
  }

  function listLiveSessions() {
    const rows = [];
    for (const session of ctx.sessions.list()) {
      if (!session || session.header?.origin === 'subagent') continue;
      const agent = ctx.agents.get(session.id);
      if (!agent) continue;
      const owner = groupOfSession(session.id);
      rows.push({
        id: session.id,
        title: titleOf(session),
        live: true,
        agentStatus: agent.status,
        cwd: typeof session.header?.cwd === 'string' ? session.header.cwd : '',
        createdAt: session.header?.createdAt ?? 0,
        groupId: owner ? owner.id : null,
        groupName: owner ? owner.name : null,
      });
    }
    rows.sort((left, right) => {
      if (left.groupId === null && right.groupId !== null) return -1;
      if (left.groupId !== null && right.groupId === null) return 1;
      return (right.createdAt ?? 0) - (left.createdAt ?? 0);
    });
    return rows;
  }

  // ======================================================================
  // 工具函数
  // ======================================================================

  function groupOfSession(sessionId) {
    for (const group of state.groups) {
      if (group.status === 'ended') continue;
      const member = group.members.find((item) => item.sessionId === sessionId);
      if (member && member.status === 'active') return group;
    }
    return undefined;
  }

  function titleOf(session) {
    try {
      const snapshotTitle = ctx.sessionTitle.get(session);
      if (snapshotTitle && typeof snapshotTitle.title === 'string' && snapshotTitle.title.trim() !== '') {
        return snapshotTitle.title.trim();
      }
    } catch {
      // 标题缺失不影响主流程
    }
    return shortId(session.id);
  }

  function addSystem(group, text) {
    if (group.timeline.length >= MAX_TIMELINE_ENTRIES) {
      group.timeline.splice(0, group.timeline.length - MAX_TIMELINE_ENTRIES + 1);
    }
    group.timeline.push({
      seq: group.nextSeq++,
      kind: 'system',
      name: '系统',
      text: clipText(String(text ?? ''), MAX_TEXT_CHARS),
      time: Date.now(),
    });
  }

  function appendTimeline(group, entry) {
    if (group.timeline.length >= MAX_TIMELINE_ENTRIES) {
      group.timeline.splice(0, group.timeline.length - MAX_TIMELINE_ENTRIES + 1);
    }
    group.timeline.push({ seq: group.nextSeq++, ...entry });
  }

  function scheduleSave() {
    if (disposed) return;
    if (saveTimer !== null) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow();
    }, 120);
    saveTimer.unref?.();
  }

  function saveNow() {
    try {
      mkdirSync(dirname(options.storePath), { recursive: true });
      const payload = JSON.stringify(
        { version: STATE_VERSION, groups: state.groups },
        null,
        2,
      );
      const temporary = `${options.storePath}.tmp`;
      writeFileSync(temporary, payload, 'utf8');
      renameSync(temporary, options.storePath);
    } catch (error) {
      console.error('[agent-groups] 保存群状态失败', error);
    }
  }

  function loadState() {
    try {
      if (!existsSync(options.storePath)) return;
      const raw = JSON.parse(readFileSync(options.storePath, 'utf8'));
      if (!raw || !Array.isArray(raw.groups)) return;
      state.groups = raw.groups.map(normalizeLoadedGroup).filter(Boolean);
    } catch (error) {
      console.error('[agent-groups] 读取群状态失败', error);
    }
  }

  function normalizeLoadedGroup(raw) {
    if (!raw || typeof raw !== 'object') return undefined;
    const members = Array.isArray(raw.members)
      ? raw.members
          .filter((member) => member && typeof member.sessionId === 'string')
          .map((member) => ({
            id: typeof member.id === 'string' ? member.id : `m_${randomUUID()}`,
            sessionId: member.sessionId,
            name: normalizeMemberName(member.name) || shortId(member.sessionId),
            persona:
              typeof member.persona === 'string' && member.persona.trim() !== ''
                ? member.persona
                : defaultPersona(normalizeMemberName(member.name) || shortId(member.sessionId)),
            joinedAt: Number.isFinite(member.joinedAt) ? member.joinedAt : Date.now(),
            status: ['active', 'exited', 'removed'].includes(member.status)
              ? member.status
              : 'active',
            delivered: Number.isFinite(member.delivered) ? member.delivered : 0,
            turns: Number.isFinite(member.turns) ? member.turns : 0,
            joinedSeq: Number.isFinite(member.joinedSeq) ? member.joinedSeq : 0,
          }))
      : [];
    if (members.length === 0) return undefined;
    const timeline = Array.isArray(raw.timeline)
      ? raw.timeline
          .filter((item) => item && typeof item.text === 'string' && Number.isFinite(item.seq))
          .map((item) => ({
            seq: item.seq,
            kind: item.kind === 'system' ? 'system' : 'member',
            memberId: typeof item.memberId === 'string' ? item.memberId : undefined,
            name: typeof item.name === 'string' ? item.name : '系统',
            sessionId: typeof item.sessionId === 'string' ? item.sessionId : undefined,
            text: item.text,
            time: Number.isFinite(item.time) ? item.time : Date.now(),
            turn: Number.isFinite(item.turn) ? item.turn : undefined,
            eventSeq: Number.isFinite(item.eventSeq) ? item.eventSeq : undefined,
          }))
      : [];
    const maxSeq = timeline.reduce((max, item) => Math.max(max, item.seq), 0);
    const status = ['active', 'paused', 'ended'].includes(raw.status) ? raw.status : 'paused';
    return {
      id: typeof raw.id === 'string' ? raw.id : `g_${randomUUID()}`,
      name: normalizeGroupName(raw.name),
      createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
      status,
      endedReason: typeof raw.endedReason === 'string' ? raw.endedReason : null,
      maxMessages: Number.isFinite(raw.maxMessages) ? raw.maxMessages : options.maxMessages,
      messageCount: Number.isFinite(raw.messageCount) ? raw.messageCount : 0,
      nextSeq: Math.max(Number.isFinite(raw.nextSeq) ? raw.nextSeq : 1, maxSeq + 1),
      timeline,
      members,
    };
  }
}

// ========================================================================
// 模块级工具
// ========================================================================

function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

function extractAssistantText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function defaultStorePath() {
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : join(homedir(), '.dsh');
  return join(home, 'storages', 'agent-groups', 'state.json');
}

function defaultPersona(name) {
  return PERSONA_TEMPLATE.replaceAll('{name}', name);
}

function normalizePersona(value, name) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text === '' ? defaultPersona(name) : text;
}

function normalizeMemberName(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return text.length > 40 ? text.slice(0, 40) : text;
}

function normalizeGroupName(value, fallback) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (text !== '') return text.length > 60 ? text.slice(0, 60) : text;
  if (typeof fallback === 'string' && fallback.trim() !== '') return fallback.trim();
  return defaultGroupName();
}

function defaultGroupName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `协作群 · ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function uniqueMemberName(existing, candidate) {
  const used = new Set(existing.map((member) => member.name));
  if (!used.has(candidate)) return candidate;
  let index = 2;
  while (used.has(`${candidate} ${index}`)) index += 1;
  return `${candidate} ${index}`;
}

function personaSummary(persona) {
  const lines = String(persona ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const goal = lines.find((line) => line.startsWith('你的目标') || line.startsWith('目标'));
  const source = goal ?? lines[0] ?? '';
  return clipText(source.replace(/^你的目标[:：]\s*/, ''), 60);
}

function shortId(id) {
  return String(id ?? '').slice(0, 8);
}

function clipText(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}\n…（已截断）`;
}

function formatTime(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}
