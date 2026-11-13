/**
 * runtime.js —— 子包这边的两样东西：宿主门面，和「自己这份 API」。
 *
 * 子包不 import 主包。鱼的政策（醒着没有、话能不能出去、记一条动作）
 * 由主包 `bindHost` 注进来。测试可以每次调用时传 `host`。
 */

import * as api from './api.js'
import * as auth from './auth.js'

let bound = null

export function bindHost(host) {
  if (host) bound = host
  return bound
}

export function useHost(explicit) {
  return explicit || bound || null
}

export function hostOf(explicit) {
  const host = useHost(explicit)
  if (!host) {
    const error = new Error('知乎子包还没接上宿主')
    error.code = 'ZHIHU_HOST'
    throw error
  }
  return host
}

/** 本包自己的接口。调用方传了 mod / api 就用那一份（测试替身）。 */
export function localApi() {
  return {
    fetchHot: api.fetchHot,
    fetchFollow: api.fetchFollow,
    fetchHistory: api.fetchHistory,
    fetchRecommend: api.fetchRecommend,
    fetchQuestionInvites: api.fetchQuestionInvites,
    fetchQuestionRecommend: api.fetchQuestionRecommend,
    fetchQuestion: api.fetchQuestion,
    fetchAnswer: api.fetchAnswer,
    fetchComments: api.fetchComments,
    fetchChildComments: api.fetchChildComments,
    createComment: api.createComment,
    createAnswer: api.createAnswer,
    probe: api.probe,
    readAuth: auth.readAuth,
    readAccounts: auth.readAccounts,
    resetZhihuWriteRisk: api.resetZhihuWriteRisk,
  }
}

export function errorText(error) {
  return String(error?.message ?? error).slice(0, 200)
}
