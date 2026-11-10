/**
 * index.js —— 知乎子包的出口
 *
 * 主包只认这几个函数；子包自己管「怎么登录、怎么请求、怎么解析」。
 * 这样知乎改接口 / 加签名时，改动都留在这个目录里。
 */

export {
  fetchHot, fetchFollow, fetchHistory, fetchRecommend, fetchQuestion, fetchAnswer, fetchComments,
  fetchChildComments, createComment, createAnswer, resetZhihuWriteRisk, htmlToText, extractImages, probe, ENDPOINTS,
} from './api.js'
export {
  createQr,
  pollQr,
  saveCookie,
  readAuth,
  loadCookie,
  clearAuth,
  credentialPath,
} from './auth.js'

import {
  fetchHot, fetchFollow, fetchHistory, fetchRecommend, fetchQuestion, fetchAnswer, fetchComments,
  fetchChildComments, createComment, createAnswer, resetZhihuWriteRisk, htmlToText, extractImages, probe,
} from './api.js'
import { createQr, pollQr, saveCookie, readAuth, loadCookie, clearAuth, credentialPath } from './auth.js'

export default {
  fetchHot,
  fetchFollow,
  fetchHistory,
  fetchRecommend,
  fetchQuestion,
  fetchAnswer,
  fetchComments,
  fetchChildComments,
  createComment,
  createAnswer,
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
}
