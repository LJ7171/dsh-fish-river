/**
 * index.js —— 知乎子包的出口。
 *
 * 主包只通过这里拿函数：登录、请求、解析、素材、点开、说话、工具注册、设置归一。
 * 宿主政策由 bindHost 注进来，本包不 import 主包的 lib/。
 */

export {
  fetchHot, fetchFollow, fetchHistory, fetchRecommend,
  fetchQuestionInvites, fetchQuestionRecommend,
  fetchQuestion, fetchAnswer, fetchComments, fetchChildComments,
  createComment, createAnswer, answerPublishControl,
  resetZhihuWriteRisk, htmlToText, extractImages, probe, ENDPOINTS,
} from './api.js'

export {
  createQr, pollQr, saveCookie, readAuth, loadCookie, clearAuth, credentialPath,
  readAccounts, patchZhihuSlot, publicZhihu, accountsFromAuth,
} from './auth.js'

export { ZHIHU_DEFAULTS, ZHIHU_FIELDS, ZHIHU_COPY, normalizeZhihu } from './config.js'
export { statePath, readState, writeState, runsToday } from './state.js'
export {
  fetchMainBatch, fetchRecommendBatch, renderQuestions, renderMaterial,
  fetchZhihuMaterial, gatherZhihu, zhihuStatus,
} from './material.js'
export { parseTarget, saveImages, zhihuLookOnce, registerZhihuLook } from './look.js'
export {
  MAX_COMMENT, MAX_ANSWER, REPLY_LOOKBACK_DAYS, MAX_SCAN_ROOTS,
  opensToday, commentCountToday, replyCountToday, answerCountToday,
  herComments, herCommentsRecent, seenReplies,
  scanReplies, scanIfAwake, renderReplies, postComment, postReply, postAnswer,
} from './comment.js'
export { noteZhihuSpeak, zhihuSpeakOnce, registerZhihuSpeak } from './speak.js'
export { bindHost } from './runtime.js'

import {
  fetchHot, fetchFollow, fetchHistory, fetchRecommend,
  fetchQuestionInvites, fetchQuestionRecommend,
  fetchQuestion, fetchAnswer, fetchComments, fetchChildComments,
  createComment, createAnswer, answerPublishControl,
  resetZhihuWriteRisk, htmlToText, extractImages, probe,
} from './api.js'
import { createQr, pollQr, saveCookie, readAuth, loadCookie, clearAuth, credentialPath, readAccounts, patchZhihuSlot } from './auth.js'
import { normalizeZhihu } from './config.js'
import { fetchZhihuMaterial, gatherZhihu, renderMaterial, renderQuestions } from './material.js'
import { registerZhihuLook, zhihuLookOnce, parseTarget } from './look.js'
import { postAnswer, postComment, postReply, scanIfAwake, renderReplies } from './comment.js'
import { registerZhihuSpeak, zhihuSpeakOnce, noteZhihuSpeak } from './speak.js'
import { bindHost } from './runtime.js'

export default {
  fetchHot,
  fetchFollow,
  fetchHistory,
  fetchRecommend,
  fetchQuestionInvites,
  fetchQuestionRecommend,
  fetchQuestion,
  fetchAnswer,
  fetchComments,
  fetchChildComments,
  createComment,
  createAnswer,
  answerPublishControl,
  resetZhihuWriteRisk,
  htmlToText,
  extractImages,
  probe,
  createQr,
  pollQr,
  saveCookie,
  readAuth,
  loadCookie,
  clearAuth,
  credentialPath,
  readAccounts,
  patchZhihuSlot,
  normalizeZhihu,
  fetchZhihuMaterial,
  gatherZhihu,
  renderMaterial,
  renderQuestions,
  registerZhihuLook,
  zhihuLookOnce,
  parseTarget,
  postAnswer,
  postComment,
  postReply,
  scanIfAwake,
  renderReplies,
  registerZhihuSpeak,
  zhihuSpeakOnce,
  noteZhihuSpeak,
  bindHost,
}
