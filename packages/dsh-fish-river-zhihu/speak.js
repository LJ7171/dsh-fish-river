/**
 * speak.js —— `zhihu_speak`
 *
 * 关着的时候说明里不许诺发得出去。开着的时候写明今天点开过才能说，并写清是谁的号。
 * 标成主人也可以发。
 */

import {
  postAnswer,
  postComment,
  postReply,
} from './comment.js'
import { hostOf } from './runtime.js'

let speakState = { comment: false, answer: false, owner: 'owner' }

export function noteZhihuSpeak(state) {
  if (state === true || state === false) {
    speakState = { ...speakState, comment: state === true }
    return
  }
  speakState = {
    comment: state?.comment === true,
    answer: state?.answer === true,
    owner: state?.owner === 'her' ? 'her' : 'owner',
  }
}

function zhihuDescription(state, host) {
  if (!state.comment && !state.answer) {
    return '在知乎说一句话。不想说就不说，没有人等着你回答。'
  }
  const bits = ['在知乎说一句话。']
  if (state.comment) {
    bits.push('可以给你今天点开过的某条回答留一条评论，或者回一句别人留在你评论下面的话。')
  }
  if (state.answer) {
    bits.push(state.comment
      ? '也可以给今天点开过的问题写一个回答。'
      : '可以给今天点开过的问题写一个回答。')
  }
  bits.push(host.whoseAccount('知乎', state.owner))
  bits.push('这是会留下来的东西——别人看得见，你也收不回来。不想说就不说，没有人等着你回答。')
  return bits.join('')
}

function softReason(why) {
  const w = String(why ?? '')
  if (w.includes('没开') || w.includes('权限')) return '现在不方便说。'
  if (w.includes('今天说够') || w.includes('今天回够') || w.includes('今天回答够')) return '今天说得够多了。'
  if (w.includes('不是说话的时候') || w.includes('在睡') || w.includes('人堆')) return '现在不是说话的时候。'
  if (w.includes('没打开') || w.includes('没点开')) {
    if (w.includes('问题')) return '这个问题你今天还没点开过。要打开：zhihu_look（kind 填 question，id 填问题号），或者先点开它下面的一条回答。'
    return '这一条你今天还没点开过。要打开：zhihu_look（kind 填 answer，id 填回答号）。翻了列表、看了别的，都不算这一条。'
  }
  if (w.includes('还没在那条下面')) return '先在那条下面说过话，才能回楼里的人。'
  if (w.includes('只能回自己')) return '只能回自己说过的那条下面。'
  if (w.includes('登录') || w.includes('cookie')) return '说不出去，缺了点什么。'
  if (w.includes('不该说') || w.includes('先不说了')) return w.includes('不该说') ? '这句里有不该说出去的东西。' : '这句先不说了。'
  if (w.includes('太长')) return '这句太长了，先不说。'
  if (w.includes('拦') || w.includes('验证') || w.includes('歇')) return '说了但没送到，等一下再说。'
  if (w.includes('空')) return '没想好说什么，那就先不说。'
  return w.slice(0, 40) || '没说出来。'
}

function withAccount(result, owner, host) {
  const account = host.whoseAccount('知乎', owner)
  const note = result?.note ? `${result.note}${account}` : account
  return { ok: result?.ok === true, said: String(result?.said ?? ''), note }
}

export async function zhihuSpeakOnce(o = {}) {
  const host = hostOf(o.host)
  const root = o.root ?? host.rootDir()
  let owner = 'owner'
  try {
    const { config } = o.config ? { config: o.config } : await host.loadConfig(root)
    owner = config?.zhihu?.owner === 'her' ? 'her' : 'owner'
    const text = String(o.text ?? '').trim()
    if (!text) return withAccount({ ok: false, said: '', note: '没想好说什么，那就先不说。' }, owner, host)
    const screened = host.maySend(text)
    if (!screened.ok) {
      return withAccount({
        ok: false,
        said: '',
        note: screened.why === 'leak' ? '这句里有不该说出去的东西。' : '这句先不说了。',
      }, owner, host)
    }
    const kind = String(o.kind ?? 'comment')
    const shared = {
      root,
      text,
      api: o.api,
      cookie: o.cookie,
      fetchImpl: o.fetchImpl,
      sessionId: o.sessionId,
      dateKey: o.dateKey,
      selfId: o.selfId,
      host,
    }
    const r = kind === 'answer'
      ? await postAnswer({ ...shared, questionId: o.id })
      : kind === 'reply'
        ? await postReply({ ...shared, answerId: o.id, parentId: o.parentId })
        : await postComment({ ...shared, answerId: o.id })
    if (!r.ok) return withAccount({ ok: false, said: '', note: softReason(r.why) }, owner, host)
    return withAccount({ ok: true, said: text, note: '说出去了。' }, owner, host)
  } catch {
    return withAccount({ ok: false, said: '', note: '没说出来。' }, owner, host)
  }
}

export function registerZhihuSpeak(ctx, deps = {}) {
  const host = hostOf(deps.host)
  const root = deps.root ?? host.rootDir()
  if (deps.speak) noteZhihuSpeak(deps.speak)

  return ctx.tools.register(
    host.defineTool({
      name: 'zhihu_speak',
      get description() { return zhihuDescription(speakState, host) },
      parameters: host.toJsonSchema({
        kind: {
          type: 'string',
          required: true,
          enum: ['comment', 'reply', 'answer'],
          description: 'comment=给今天点开过的回答留一条评论；reply=回你自己评论下面的话；answer=给今天点开过的问题写一个回答。',
        },
        id: { type: 'string', required: true, description: '回答号（comment/reply）或问题号（answer）。' },
        text: { type: 'string', required: true, description: '要说的话。说人话。' },
        parentId: { type: 'string', required: false, description: 'kind=reply 时，你要回的是哪一条。' },
      }),
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            said: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'said', 'note'],
        },
        render: (_args, out) => [{ type: 'text', text: out.ok ? `说出去了：「${out.said}」` : `没说：${out.note}` }],
      },
      async execute(args, exec) {
        const who = host.guardWrite(deps.tenant, exec, 'zhihu_speak')
        if (!who.ok) return { ok: false, said: '', note: who.note }
        const { config } = await host.loadConfig(root)
        const owner = config?.zhihu?.owner === 'her' ? 'her' : 'owner'
        noteZhihuSpeak({
          comment: config?.zhihu?.comment?.enabled === true,
          answer: config?.zhihu?.answer?.enabled === true,
          owner,
        })
        const kind = String(args?.kind ?? 'comment')
        const enabled = kind === 'answer'
          ? config?.zhihu?.answer?.enabled === true
          : config?.zhihu?.comment?.enabled === true
        if (!enabled) return withAccount({ ok: false, said: '', note: softReason('没开这个权限') }, owner, host)
        const events = await host.readEvents(root).catch(() => [])
        if (!host.socialOpen(events)) {
          return withAccount({ ok: false, said: '', note: softReason('还没到在人堆里说话的时候') }, owner, host)
        }
        return zhihuSpeakOnce({
          kind,
          id: args?.id,
          text: args?.text,
          parentId: args?.parentId,
          root,
          api: deps.api,
          sessionId: who.sessionId,
          host,
        })
      },
    }),
  )
}

export default { registerZhihuSpeak, zhihuSpeakOnce, noteZhihuSpeak }
