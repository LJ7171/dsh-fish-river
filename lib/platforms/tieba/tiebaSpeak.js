/**
 * tiebaSpeak.js —— tieba_speak
 *
 * 跟帖和楼中楼。关着时说明里不许诺发得出去。
 * 开着时写明今天点开过的帖才能说，并写清是谁的号。标成主人也可以发。
 */

import { toJsonSchema } from '../../core/toolschema.js'
import { rootDir, readEvents } from '../../core/store.js'
import { loadConfig } from '../../core/settings.js'
import { postComment, postReply } from './tiebaComment.js'
import { modelOf } from '../../mind/derive.js'
import { evaluateSocialGate } from '../../life/social/socialgate.js'
import { screenOutgoing } from '../../core/guard.js'
import { whoseAccount } from '../../core/ownership.js'
import { defineTool } from '../../core/tool.js'
import { guardWrite } from '../../house/tenant.js'

let speakState = { on: false, owner: 'owner' }

export function noteTiebaSpeak(state) {
  if (state === true || state === false) {
    speakState = { ...speakState, on: state === true }
    return
  }
  speakState = {
    on: state?.on === true || state?.comment === true,
    owner: state?.owner === 'her' ? 'her' : 'owner',
  }
}

function tiebaDescription(state) {
  if (!state.on) return '在贴吧说一句话。不想说就不说，没有人等着你回答。'
  return [
    '在贴吧说一句话。可以给你今天点开过的帖子跟一帖，或者回一句别人留在你那层下面的话。',
    whoseAccount('贴吧', state.owner),
    '这是会留下来的东西——别人看得见，你也收不回来。不想说就不说，没有人等着你回答。',
  ].join('')
}

function softReason(why) {
  const w = String(why ?? '')
  if (w.includes('没开') || w.includes('权限')) return '现在不方便说。'
  if (w.includes('今天说够') || w.includes('今天回够')) return '今天说得够多了。'
  if (w.includes('不是说话的时候') || w.includes('在睡') || w.includes('人堆')) return '现在不是说话的时候。'
  if (w.includes('没打开') || w.includes('没点开')) {
    return '这个帖子你今天还没点开过。要打开：tieba_look（kind 填 thread，id 填帖号）。进了别的帖、只进了吧，都不算这一帖。'
  }
  if (w.includes('还没在那条下面')) return '先在这帖下面说过话，才能回楼里的人。'
  if (w.includes('只能回自己')) return '只能回自己说过的那条下面。'
  if (w.includes('登录') || w.includes('cookie')) return '说不出去，缺了点什么。'
  if (w.includes('不该说')) return '这句里有不该说出去的东西。'
  if (w.includes('先不说了')) return '这句先不说了。'
  if (w.includes('太长')) return '这句太长了，先不说。'
  if (w.includes('拦') || w.includes('验证') || w.includes('歇')) return '说了但没送到，等一下再说。'
  if (w.includes('空')) return '没想好说什么，那就先不说。'
  return w.slice(0, 40) || '没说出来。'
}

function withAccount(result, owner) {
  const account = whoseAccount('贴吧', owner)
  const note = result?.note ? `${result.note}${account}` : account
  return { ok: result?.ok === true, said: String(result?.said ?? ''), note }
}

export async function tiebaSpeakOnce(o = {}) {
  const root = o.root ?? rootDir()
  let owner = 'owner'
  try {
    const { config } = o.config ? { config: o.config } : await loadConfig(root)
    owner = config?.tieba?.owner === 'her' ? 'her' : 'owner'
    const text = String(o.text ?? '').trim()
    if (!text) return withAccount({ ok: false, said: '', note: '没想好说什么，那就先不说。' }, owner)
    const screened = screenOutgoing(text)
    if (!screened.ok) {
      return withAccount({
        ok: false,
        said: '',
        note: screened.why === 'leak' ? '这句里有不该说出去的东西。' : '这句先不说了。',
      }, owner)
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
    }
    const r = kind === 'reply'
      ? await postReply({ ...shared, tid: o.id, parentId: o.parentId })
      : await postComment({ ...shared, tid: o.id })
    if (!r.ok) return withAccount({ ok: false, said: '', note: softReason(r.why) }, owner)
    return withAccount({ ok: true, said: text, note: '说出去了。' }, owner)
  } catch {
    return withAccount({ ok: false, said: '', note: '没说出来。' }, owner)
  }
}

export function registerTiebaSpeak(ctx, deps = {}) {
  const root = deps.root ?? rootDir()
  if (deps.speak) noteTiebaSpeak(deps.speak)

  return ctx.tools.register(
    defineTool({
      name: 'tieba_speak',
      get description() { return tiebaDescription(speakState) },
      parameters: toJsonSchema({
        kind: {
          type: 'string',
          required: true,
          enum: ['comment', 'reply'],
          description: 'comment=给今天点开过的帖子跟一帖；reply=回你自己那层下面的话。',
        },
        id: { type: 'string', required: true, description: '帖子号。' },
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
        const who = guardWrite(deps.tenant, exec, 'tieba_speak')
        if (!who.ok) return { ok: false, said: '', note: who.note }
        const { config } = await loadConfig(root)
        const owner = config?.tieba?.owner === 'her' ? 'her' : 'owner'
        noteTiebaSpeak({ on: config?.tieba?.comment?.enabled === true, owner })
        if (config?.tieba?.comment?.enabled !== true) {
          return withAccount({ ok: false, said: '', note: softReason('没开这个权限') }, owner)
        }
        const { events } = await readEvents(root).catch(() => ({ events: [] }))
        if (!evaluateSocialGate({ model: modelOf(events), events }).open) {
          return withAccount({ ok: false, said: '', note: softReason('还没到在人堆里说话的时候') }, owner)
        }
        return tiebaSpeakOnce({
          kind: args?.kind,
          id: args?.id,
          text: args?.text,
          parentId: args?.parentId,
          root,
          api: deps.api,
          sessionId: who.sessionId,
        })
      },
    }),
  )
}

export default { registerTiebaSpeak, tiebaSpeakOnce, noteTiebaSpeak }
