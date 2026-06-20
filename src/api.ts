import axios, { AxiosInstance, AxiosError } from 'axios'
import { AsyncLocalStorage } from 'async_hooks'

export interface ApiConfig {
  baseURL: string
  timeout?: number
  retryCount?: number
  retryDelay?: number
  /** team：sw-api `/awmc/api/v1` + 旧私有端点；public：AWMC 网关 `/v1` + Bearer */
  apiStyle?: 'team' | 'public'
  /** apiStyle 为 public 时必填，对应网关 `Authorization: Bearer <令牌>` */
  bearerToken?: string
}

/** B50 上传响应（public 异步任务 / team sw-api 同步完成） */
export interface B50UploadResponse {
  UploadStatus: boolean
  msg: string
  task_id: string
  login_time?: number
  userID?: string
  token?: string
  /** team sw-api：同步上传，无需轮询任务 */
  sync?: boolean
  count?: number
}

export function isSyncB50Upload(result: { sync?: boolean }): boolean {
  return result.sync === true
}

export interface ChargeQueueTask {
  chargeId: number
  userId: string
  keychip: string
  qrToken?: string
  regionId?: number
  placeId?: number
  status: 'pending' | 'processing' | 'done' | 'failed'
  msg: string
  ts: string
}

export function findMatchingChargeTask(
  tasks: ChargeQueueTask[],
  chargeId: number,
  qrText: string,
  clientId?: string,
): ChargeQueueTask | undefined {
  const sorted = [...tasks].sort(
    (a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime(),
  )
  return sorted.find((t) => {
    if (t.chargeId !== chargeId) return false
    const token = (t.qrToken || '').trim()
    const qr = qrText.trim()
    if (token && qr) {
      if (token === qr) return true
      if (qr.startsWith(token) || token.startsWith(qr)) return true
      if (qr.length <= 64 && token.startsWith(qr)) return true
    }
    if (clientId && t.keychip === clientId && !token) return true
    return false
  })
}

export interface UserPreview {
  UserID: string | number
  BanState?: number
  IsLogin?: boolean
  LastLoginDate?: string
  LastPlayDate?: string
  LastPairLoginDate?: string
  Rating?: number
  PlayerOldRating?: number
  PlayerNewRating?: number
  UserName?: string
  DataVersion?: string
  RomVersion?: string
  CourseRank?: number
  ClassRank?: number
  PlayCount?: number
  CurrentPlayCount?: number
  LastRegionName?: string
  TotalAwake?: number
}

export function formatBanStateLabel(banState?: number): string {
  if (banState === 0) return '正常'
  if (banState === 1) return '警告'
  if (banState === 2) return '封禁'
  if (banState == null) return '未知'
  return `异常(${banState})`
}

export function formatAccountStatusBlock(preview: UserPreview): string {
  const ratingText = preview.Rating != null
    ? (preview.PlayerOldRating != null && preview.PlayerNewRating != null
      ? `${preview.Rating} (${preview.PlayerOldRating}+${preview.PlayerNewRating})`
      : String(preview.Rating))
    : '未知'

  const lines = [
    `用户名: ${preview.UserName || '未知'}`,
    `Rating: ${ratingText}`,
  ]
  if (preview.ClassRank != null && preview.CourseRank != null) {
    lines.push(`友人对战等级: ${preview.ClassRank}[${preview.CourseRank}]`)
  }
  if (preview.PlayCount != null) lines.push(`总游玩次数: ${preview.PlayCount}`)
  if (preview.CurrentPlayCount != null) lines.push(`当前版本游玩次数: ${preview.CurrentPlayCount}`)
  if (preview.RomVersion) lines.push(`机台版本: ${preview.RomVersion}`)
  if (preview.DataVersion) lines.push(`数据版本: ${preview.DataVersion}`)
  if (preview.LastLoginDate) lines.push(`上次登录: ${preview.LastLoginDate}`)
  if (preview.LastPlayDate) lines.push(`上次游玩: ${preview.LastPlayDate}`)
  if (preview.LastPairLoginDate) lines.push(`上次拼机: ${preview.LastPairLoginDate}`)
  if (preview.LastRegionName) lines.push(`上次游玩区域: ${preview.LastRegionName}`)
  if (preview.TotalAwake != null) lines.push(`总觉醒次数: ${preview.TotalAwake}`)
  lines.push(`封禁状态: ${formatBanStateLabel(preview.BanState)}`)

  return `\n📊 账号信息：\n${lines.join('\n')}\n`
}

export interface ChargeResult {
  ChargeStatus: boolean
  LoginStatus: boolean
  LogoutStatus: boolean
  QrStatus: boolean
  userChargeList?: Array<{
    chargeId: number
    extNum1: number
    purchaseDate: string
    stock: number
    validDate: string
  }>
  userFreeChargeList?: Array<{
    chargeId: number
    stock: number
  }>
}

export interface GetPreviewOptions {
  regionId?: number
  placeId?: number
  token?: string
}

export interface GetChargeOptions {
  userId?: string
}

export function formatChargeTaskStatus(task: ChargeQueueTask): string {
  const statusLabel: Record<ChargeQueueTask['status'], string> = {
    pending: '排队中',
    processing: '处理中',
    done: '已完成',
    failed: '失败',
  }
  const base = `${task.chargeId} 倍 · ${statusLabel[task.status]}`
  if (task.msg?.trim()) return `${base}（${task.msg.trim()}）`
  return base
}

/** 调试上下文：在 API 调用栈中传递「来源是否为调试会话」的标记 */
export const debugContextStorage = new AsyncLocalStorage<{ fromDebugSession: boolean }>()

/** 获取当前调用是否处于调试会话 */
export function isFromDebugSession(): boolean {
  return debugContextStorage.getStore()?.fromDebugSession === true
}

export class MaiBotAPI {
  private client: AxiosInstance
  private retryCount: number
  private retryDelay: number
  private apiStyle: 'team' | 'public'
  /** 调试钩子：开启后打印每次 API 请求/响应详情；由 index.ts 注入。fromDebugSession 标记此次调用是否源自调试群命令 */
  public debugLogger: ((tag: string, payload: any, fromDebugSession: boolean) => void) | null = null

  constructor(config: ApiConfig) {
    this.retryCount = config.retryCount ?? 3
    this.retryDelay = config.retryDelay ?? 1000
    this.apiStyle = config.apiStyle ?? 'team'
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (this.apiStyle === 'public' && config.bearerToken) {
      headers.Authorization = `Bearer ${config.bearerToken}`
    }
    this.client = axios.create({
      baseURL: config.baseURL || 'http://localhost:5566',
      timeout: config.timeout || 30000,
      headers,
    })
    this.setupDebugInterceptor()
    this.setupRetry()
  }

  private setupDebugInterceptor(): void {
    this.client.interceptors.request.use((cfg) => {
      if (this.debugLogger) {
        try {
          // 记录开始时间用于计算耗时
          ;(cfg as any).__startTime = Date.now()
          // 把当前 AsyncLocalStorage 中的 fromDebugSession 标记冻结到 cfg 上，
          // 避免响应/错误回调时已脱离该上下文（axios 拦截器内可能已不在 store 内）
          ;(cfg as any).__fromDebugSession = isFromDebugSession()
          this.debugLogger('API REQUEST', {
            method: cfg.method?.toUpperCase(),
            baseURL: cfg.baseURL,
            url: cfg.url,
            fullUrl: (cfg.baseURL || '') + (cfg.url || ''),
            params: cfg.params,
            data: cfg.data,
            headers: cfg.headers,
            timeout: cfg.timeout,
          }, (cfg as any).__fromDebugSession === true)
        } catch { /* 忽略 */ }
      }
      return cfg
    })
    this.client.interceptors.response.use(
      (response) => {
        if (this.debugLogger) {
          try {
            const startTime = (response.config as any)?.__startTime
            const elapsed = startTime ? Date.now() - startTime : undefined
            const fromDebug = (response.config as any)?.__fromDebugSession === true
            // 提取服务器 IP（部分平台支持）
            const remoteAddress = (response.request?.socket?.remoteAddress)
              || (response.request?.res?.connection?.remoteAddress)
              || (response.request?.connection?.remoteAddress)
              || undefined
            const remotePort = (response.request?.socket?.remotePort)
              || (response.request?.res?.connection?.remotePort)
              || (response.request?.connection?.remotePort)
              || undefined
            this.debugLogger('API RESPONSE', {
              status: response.status,
              statusText: response.statusText,
              method: response.config?.method?.toUpperCase(),
              baseURL: response.config?.baseURL,
              url: response.config?.url,
              fullUrl: (response.config?.baseURL || '') + (response.config?.url || ''),
              params: response.config?.params,
              requestData: response.config?.data,
              responseHeaders: response.headers,
              data: response.data,
              elapsedMs: elapsed,
              remoteAddress,
              remotePort,
            }, fromDebug)
          } catch { /* 忽略 */ }
        }
        return response
      },
      (error) => {
        if (this.debugLogger) {
          try {
            const cfg = error?.config
            const startTime = cfg?.__startTime
            const elapsed = startTime ? Date.now() - startTime : undefined
            const fromDebug = cfg?.__fromDebugSession === true
            const remoteAddress = (error?.request?.socket?.remoteAddress)
              || (error?.response?.request?.socket?.remoteAddress)
              || (error?.request?.connection?.remoteAddress)
              || undefined
            const remotePort = (error?.request?.socket?.remotePort)
              || (error?.response?.request?.socket?.remotePort)
              || (error?.request?.connection?.remotePort)
              || undefined
            this.debugLogger('API ERROR', {
              code: error?.code,
              status: error?.response?.status,
              statusText: error?.response?.statusText,
              method: cfg?.method?.toUpperCase(),
              baseURL: cfg?.baseURL,
              url: cfg?.url,
              fullUrl: (cfg?.baseURL || '') + (cfg?.url || ''),
              params: cfg?.params,
              requestData: cfg?.data,
              message: error?.message,
              responseHeaders: error?.response?.headers,
              data: error?.response?.data,
              elapsedMs: elapsed,
              remoteAddress,
              remotePort,
            }, fromDebug)
          } catch { /* 忽略 */ }
        }
        return Promise.reject(error)
      }
    )
  }

  private setupRetry(): void {
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalConfig = error?.config as (typeof error.config & {
          __retryCount?: number
          __fromDebugSession?: boolean
        })
        if (!originalConfig) {
          return Promise.reject(error)
        }

        const status = error?.response?.status as number | undefined
        const code = error?.code as string | undefined
        const shouldRetry =
          code === 'ECONNABORTED'
          || code === 'ECONNRESET'
          || code === 'ETIMEDOUT'
          || code === 'ERR_NETWORK'
          || code === 'ENOTFOUND'
          || code === 'EAI_AGAIN'
          || status === 408
          || status === 429
          || (status != null && status >= 500)
          || (error?.request && status == null)

        const currentRetry = originalConfig.__retryCount ?? 0
        if (!shouldRetry || currentRetry >= this.retryCount) {
          return Promise.reject(error)
        }

        originalConfig.__retryCount = currentRetry + 1
        const delayMs = this.retryDelay * originalConfig.__retryCount

        if (this.debugLogger) {
          try {
            this.debugLogger('API RETRY', {
              attempt: originalConfig.__retryCount,
              maxRetries: this.retryCount,
              delayMs,
              status,
              code,
              method: originalConfig.method?.toUpperCase(),
              url: originalConfig.url,
              fullUrl: (originalConfig.baseURL || '') + (originalConfig.url || ''),
            }, originalConfig.__fromDebugSession === true)
          } catch { /* 忽略 */ }
        }

        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
        return this.client.request(originalConfig)
      },
    )
  }

  private swPath(suffix: string): string {
    return `/awmc/api/v1${suffix}`
  }

  private swQrBody(qrcode: string, keychip: string): Record<string, unknown> {
    return { qrcode, keychip }
  }

  private swKeychipBody(
    qrcode: string,
    keychip: string,
    regionId?: number,
    placeId?: number,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { qrcode, keychip }
    if (regionId != null) body.regionId = regionId
    if (placeId != null) body.placeId = placeId
    return body
  }

  private extractSwError(error: unknown): string {
    const err = error as AxiosError<{ error?: string; msg?: string }>
    return err.response?.data?.error
      || err.response?.data?.msg
      || err.message
      || '未知错误'
  }

  private parseSwWrappedResponse(data: unknown): Record<string, unknown> {
    if (data == null || typeof data !== 'object') {
      return {}
    }
    const record = data as Record<string, unknown>
    if (record.userId != null || record.userData != null) {
      return record
    }
    if (record.code != null && Number(record.code) < 0) {
      throw new Error(String(record.msg || record.error || 'sw-api 请求失败'))
    }
    if (record.error != null && record.code == null) {
      throw new Error(String(record.error))
    }
    if (record.msg != null) {
      if (typeof record.msg === 'object') {
        return record.msg as Record<string, unknown>
      }
      if (typeof record.msg === 'string' && record.msg.trim()) {
        try {
          return JSON.parse(record.msg) as Record<string, unknown>
        } catch {
          throw new Error(`sw-api 响应解析失败: ${record.msg}`)
        }
      }
    }
    return record
  }

  private static readonly SW_USER_DATA_TIMEOUT_MS = 120000

  private async postSwUserApi(
    path: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    const response = await this.client.post(this.swPath(path), body, {
      timeout: timeoutMs ?? this.client.defaults.timeout,
    })
    return this.parseSwWrappedResponse(response.data)
  }

  private numField(raw: Record<string, unknown>, ...keys: string[]): number | undefined {
    for (const key of keys) {
      const v = raw[key]
      if (typeof v === 'number' && !Number.isNaN(v)) return v
      if (v != null && v !== '') {
        const n = Number(v)
        if (!Number.isNaN(n)) return n
      }
    }
    return undefined
  }

  private normalizePreviewFromPayload(raw: Record<string, unknown>): UserPreview {
    const ud = (raw.userData ?? raw.userPreview ?? raw.userPreviewData ?? raw) as Record<string, unknown>
    const userId = raw.userId ?? raw.UserID ?? ud.userId ?? ud.UserID ?? ud.userID
    const returnCode = raw.returnCode ?? ud.returnCode
    if (returnCode === 0 || returnCode === -1 || userId === -1 || userId === '-1') {
      return { UserID: -1 }
    }
    if (userId == null) {
      return { UserID: -1 }
    }

    const banState = this.numField(raw, 'banState', 'BanState')
      ?? this.numField(ud, 'banState', 'BanState')
    const isLogin = ud.isLogin ?? ud.IsLogin

    return {
      UserID: userId as string | number,
      BanState: banState,
      IsLogin: typeof isLogin === 'boolean' ? isLogin : undefined,
      LastLoginDate: (ud.lastLoginDate ?? ud.LastLoginDate) as string | undefined,
      LastPlayDate: (ud.lastPlayDate ?? ud.LastPlayDate) as string | undefined,
      LastPairLoginDate: (ud.lastPairLoginDate ?? ud.LastPairLoginDate) as string | undefined,
      Rating: this.numField(ud, 'playerRating', 'PlayerRating', 'Rating', 'rating'),
      PlayerOldRating: this.numField(ud, 'playerOldRating', 'PlayerOldRating'),
      PlayerNewRating: this.numField(ud, 'playerNewRating', 'PlayerNewRating'),
      UserName: (ud.userName ?? ud.UserName) as string | undefined,
      DataVersion: (ud.lastDataVersion ?? ud.LastDataVersion ?? ud.dataVersion ?? ud.DataVersion) as string | undefined,
      RomVersion: (ud.lastRomVersion ?? ud.LastRomVersion ?? ud.romVersion ?? ud.RomVersion) as string | undefined,
      CourseRank: this.numField(ud, 'courseRank', 'CourseRank'),
      ClassRank: this.numField(ud, 'classRank', 'ClassRank'),
      PlayCount: this.numField(ud, 'playCount', 'PlayCount'),
      CurrentPlayCount: this.numField(ud, 'currentPlayCount', 'CurrentPlayCount'),
      LastRegionName: (ud.lastRegionName ?? ud.LastRegionName) as string | undefined,
      TotalAwake: this.numField(ud, 'totalAwake', 'TotalAwake'),
    }
  }

  private normalizeChargeFromPayload(raw: Record<string, unknown>): ChargeResult {
    const ud = (raw.userCharge ?? raw) as Record<string, unknown>
    const returnCode = this.numField(raw, 'returnCode', 'ReturnCode')
      ?? this.numField(ud, 'returnCode', 'ReturnCode')
    const chargeStatus = ud.chargeStatus ?? ud.ChargeStatus ?? raw.chargeStatus ?? raw.ChargeStatus
    const loginStatus = ud.loginStatus ?? ud.LoginStatus ?? raw.loginStatus ?? raw.LoginStatus
    const logoutStatus = ud.logoutStatus ?? ud.LogoutStatus ?? raw.logoutStatus ?? raw.LogoutStatus
    const qrStatus = ud.qrStatus ?? ud.QrStatus ?? raw.qrStatus ?? raw.QrStatus

    const normalizeTicketList = (list: unknown) => {
      if (!Array.isArray(list)) return undefined
      return list.map((t: Record<string, unknown>) => ({
        chargeId: Number(t.chargeId ?? t.ChargeId ?? 0),
        extNum1: Number(t.extNum1 ?? t.ExtNum1 ?? 0),
        purchaseDate: String(t.purchaseDate ?? t.PurchaseDate ?? ''),
        stock: Number(t.stock ?? t.Stock ?? 0),
        validDate: String(t.validDate ?? t.ValidDate ?? ''),
      }))
    }

    const normalizeFreeTicketList = (list: unknown) => {
      if (!Array.isArray(list)) return undefined
      return list.map((t: Record<string, unknown>) => ({
        chargeId: Number(t.chargeId ?? t.ChargeId ?? 0),
        stock: Number(t.stock ?? t.Stock ?? 0),
      }))
    }

    const userChargeList = ud.userChargeList ?? ud.UserChargeList ?? raw.userChargeList ?? raw.UserChargeList
    const userFreeChargeList =
      ud.userFreeChargeList ?? ud.UserFreeChargeList ?? raw.userFreeChargeList ?? raw.UserFreeChargeList

    return {
      ChargeStatus: chargeStatus === true || chargeStatus === 1 || returnCode === 1,
      LoginStatus: loginStatus === true || loginStatus === 1,
      LogoutStatus: logoutStatus === true || logoutStatus === 1,
      QrStatus: qrStatus === true || qrStatus === 1,
      userChargeList: normalizeTicketList(userChargeList),
      userFreeChargeList: normalizeFreeTicketList(userFreeChargeList),
    }
  }

  /** sw-api 同步 B50 上传可能耗时较长 */
  private static readonly SW_B50_TIMEOUT_MS = 600000

  /**
   * 机台 Ping / 健康检查
   * team: GET /awmc/api/v1/health
   * public: GET /v1/mai_ping
   */
  async maiPing(): Promise<{
    returnCode?: number
    serverTime?: number
    result?: string
    status?: string
  }> {
    if (this.apiStyle === 'public') {
      const response = await this.client.get('/v1/mai_ping')
      return response.data
    }
    const response = await this.client.get(this.swPath('/health'))
    return response.data
  }

  /**
   * 查看用户信息（预览）
   * public: GET /v1/get_preview?qr_text=...
   * team: POST /awmc/api/v1/user/data（仅 qrcode + keychip，扫码拉取账号信息）
   */
  async getPreview(
    clientId: string,
    qrText: string,
    _options?: GetPreviewOptions,
  ): Promise<UserPreview> {
    if (this.apiStyle === 'public') {
      if (!qrText) throw new Error('getPreview 需要 qr_text')
      const response = await this.client.get('/v1/get_preview', { params: { qr_text: qrText } })
      return response.data
    }

    if (!qrText) {
      throw new Error('team 模式请提供二维码查询账号信息')
    }
    const raw = await this.postSwUserApi(
      '/user/data',
      this.swQrBody(qrText, clientId),
      MaiBotAPI.SW_USER_DATA_TIMEOUT_MS,
    )
    return this.normalizePreviewFromPayload(raw)
  }

  /**
   * 上传水鱼 B50
   * team: POST /awmc/api/v1/update-fish（同步）
   * public: POST /v1/upload_b50（异步任务）
   */
  async uploadB50(
    regionId: number,
    clientId: string,
    placeId: number,
    qrText: string,
    fishToken: string
  ): Promise<B50UploadResponse> {
    if (this.apiStyle === 'public') {
      const response = await this.client.post('/v1/upload_b50', null, {
        params: { qr_text: qrText, fish_token: fishToken },
      })
      return response.data
    }

    try {
      const response = await this.client.post(
        this.swPath('/update-fish'),
        {
          token: fishToken,
          ...this.swKeychipBody(qrText, clientId, regionId, placeId),
        },
        { timeout: MaiBotAPI.SW_B50_TIMEOUT_MS },
      )
      const data = response.data as { userId?: string | number; count?: number; result?: { message?: string } }
      return {
        UploadStatus: true,
        msg: data.result?.message ?? 'ok',
        task_id: '',
        sync: true,
        userID: data.userId != null ? String(data.userId) : undefined,
        count: data.count,
      }
    } catch (error) {
      return {
        UploadStatus: false,
        msg: this.extractSwError(error),
        task_id: '',
      }
    }
  }

  /**
   * 查询水鱼 B50 任务状态
   * GET /api/public/get_b50_task_status
   * 需要: mai_uid
   */
  async getB50TaskStatus(maiUid: string): Promise<{
    code: number
    alive_task_id: string | number
    alive_task_time: number
    task_id?: number
    task_status?: string
  }> {
    const path =
      this.apiStyle === 'public' ? '/v1/get_b50_task_status' : '/api/public/get_b50_task_status'
    const response = await this.client.get(path, {
      params: { mai_uid: maiUid },
    })
    return response.data
  }

  /**
   * 根据任务 ID 查询水鱼 B50 任务
   * GET /api/public/get_b50_task_byid
   * 需要: task_id
   * @param taskId 任务ID
   * @param timeout 可选的请求超时时间（毫秒）
   */
  async getB50TaskById(taskId: string, timeout?: number): Promise<{
    code: number
    alive_task_id: string | number
    alive_task_time: number
    alive_task_end_time?: number | null
    error?: string | null
    logout_status?: boolean | null
    done: boolean
  }> {
    const path =
      this.apiStyle === 'public' ? '/v1/get_b50_task_byid' : '/api/public/get_b50_task_byid'
    const response = await this.client.get(path, {
      params: { task_id: taskId },
      ...(timeout ? { timeout } : {}),
    })
    return response.data
  }

  /**
   * 上传落雪 B50
   * team: POST /awmc/api/v1/update-lx（同步，`key` 为落雪导入 Token）
   * public: POST /v1/upload_lx_b50（异步任务）
   */
  async uploadLxB50(
    regionId: number,
    clientId: string,
    placeId: number,
    qrText: string,
    lxImportToken: string
  ): Promise<B50UploadResponse> {
    if (this.apiStyle === 'public') {
      const response = await this.client.post('/v1/upload_lx_b50', null, {
        params: { qr_text: qrText, lxns_code: lxImportToken },
      })
      return response.data
    }

    try {
      const response = await this.client.post(
        this.swPath('/update-lx'),
        {
          key: lxImportToken,
          type: 'maimai',
          ...this.swKeychipBody(qrText, clientId, regionId, placeId),
        },
        { timeout: MaiBotAPI.SW_B50_TIMEOUT_MS },
      )
      const data = response.data as { userId?: string | number; count?: number; result?: { message?: string } }
      return {
        UploadStatus: true,
        msg: data.result?.message ?? 'ok',
        task_id: '',
        sync: true,
        userID: data.userId != null ? String(data.userId) : undefined,
        count: data.count,
      }
    } catch (error) {
      return {
        UploadStatus: false,
        msg: this.extractSwError(error),
        task_id: '',
      }
    }
  }

  /**
   * 查询落雪 B50 任务状态
   * GET /api/public/get_lx_b50_task_status
   * 需要: mai_uid
   */
  async getLxB50TaskStatus(maiUid: string): Promise<{
    code: number
    alive_task_id: string | number
    alive_task_time: number
    task_id?: number
    task_status?: string
  }> {
    const path =
      this.apiStyle === 'public'
        ? '/v1/get_lx_b50_task_status'
        : '/api/public/get_lx_b50_task_status'
    const response = await this.client.get(path, {
      params: { mai_uid: maiUid },
    })
    return response.data
  }

  /**
   * 根据任务 ID 查询落雪 B50 任务
   * GET /api/public/get_lx_b50_task_byid
   * 需要: task_id
   * @param taskId 任务ID
   * @param timeout 可选的请求超时时间（毫秒）
   */
  async getLxB50TaskById(taskId: string, timeout?: number): Promise<{
    code: number
    alive_task_id: string | number
    alive_task_time: number
    alive_task_end_time?: number | null
    error?: string | null
    logout_status?: boolean | null
    done: boolean
  }> {
    const path =
      this.apiStyle === 'public'
        ? '/v1/get_lx_b50_task_byid'
        : '/api/public/get_lx_b50_task_byid'
    const response = await this.client.get(path, {
      params: { task_id: taskId },
      ...(timeout ? { timeout } : {}),
    })
    return response.data
  }

  /**
   * 测试登录
   * POST /api/private/test_login
   * 需要: region_id, client_id, place_id, qr_text
   */
  async testLogin(
    regionId: number,
    clientId: string,
    placeId: number,
    qrText: string
  ): Promise<{
    login_time?: number
    login_result?: {
      Result: {
        returnCode: number
      }
      Cookie: string
    }
    QrStatus?: boolean
    LoginStatus?: boolean
    LogoutStatus?: boolean
    TicketStatus?: boolean
  }> {
    const response = await this.client.post('/api/private/test_login', null, {
      params: {
        region_id: regionId,
        client_id: clientId,
        place_id: placeId,
        qr_text: qrText,
      },
    })
    return response.data
  }

  /**
   * 获取选项文件
   * GET /api/private/get_opt
   * 需要: title_ver, client_id
   */
  async getOpt(titleVer: string, clientId: string): Promise<{
    app_url: string[]
    opt_url: string[]
    latest_app_time?: string | null
    latest_opt_time?: string | null
    error?: string
  }> {
    const response = await this.client.get('/api/private/get_opt', {
      params: {
        title_ver: titleVer,
        client_id: clientId,
      },
    })
    return response.data
  }

  /**
   * 获取密钥信息
   * GET /api/private/get_keyinfo
   * 需要: title_ver, client_id
   */
  async getKeyInfo(titleVer: string, clientId: string): Promise<{
    clientId: string
    placeId: number
    placeName: string
    regionId: number
    regionName: string
    error?: string
  }> {
    const response = await this.client.get('/api/private/get_keyinfo', {
      params: {
        title_ver: titleVer,
        client_id: clientId,
      },
    })
    return response.data
  }

  /**
   * 获取功能票
   * team: POST /awmc/api/v1/charge（异步入队）
   * public: POST /v1/get_ticket
   */
  async getTicket(
    regionId: number | undefined,
    clientId: string | undefined,
    placeId: number | undefined,
    ticketId: number,
    qrText: string
  ): Promise<{
    QrStatus: boolean
    LoginStatus: boolean
    LogoutStatus: boolean
    TicketStatus: boolean
    queueMsg?: string
  }> {
    if (this.apiStyle === 'public') {
      const response = await this.client.post('/v1/get_ticket', null, {
        params: { ticket_id: ticketId, qr_text: qrText },
      })
      return response.data
    }

    if (!clientId) {
      return {
        QrStatus: false,
        LoginStatus: false,
        LogoutStatus: false,
        TicketStatus: false,
        queueMsg: '缺少 keychip 配置',
      }
    }

    try {
      const response = await this.client.post(this.swPath('/charge'), {
        charge: ticketId,
        ...this.swKeychipBody(qrText, clientId, regionId, placeId),
      })
      const data = response.data as { code?: number; msg?: string }
      if (data.code !== 0) {
        return {
          QrStatus: false,
          LoginStatus: false,
          LogoutStatus: false,
          TicketStatus: false,
          queueMsg: data.msg ?? '发票入队失败',
        }
      }
      return {
        QrStatus: true,
        LoginStatus: true,
        LogoutStatus: true,
        TicketStatus: true,
        queueMsg: data.msg,
      }
    } catch (error) {
      return {
        QrStatus: false,
        LoginStatus: false,
        LogoutStatus: false,
        TicketStatus: false,
        queueMsg: this.extractSwError(error),
      }
    }
  }

  /**
   * 查询发票充值队列状态
   * GET /awmc/api/v1/charge/queue（仅 team sw-api）
   */
  async getChargeQueue(): Promise<{
    code: number
    workers: number
    tasks: ChargeQueueTask[]
  }> {
    const response = await this.client.get(this.swPath('/charge/queue'))
    return response.data
  }

  /**
   * 调整发票充值队列 worker 数量
   * POST /awmc/api/v1/charge/queue/config（仅 team sw-api）
   */
  async setChargeQueueWorkers(workers: number): Promise<{ code: number; msg: string }> {
    const response = await this.client.post(this.swPath('/charge/queue/config'), { workers })
    return response.data
  }

  /**
   * 获取用户功能票
   * public: GET /v1/get_charge?qr_text=...
   * team: POST /awmc/api/v1/user/charge（userId + keychip）
   */
  async getCharge(
    regionId: number,
    clientId: string,
    placeId: number,
    qrText: string,
    options?: GetChargeOptions,
  ): Promise<ChargeResult> {
    if (this.apiStyle === 'public') {
      const response = await this.client.get('/v1/get_charge', { params: { qr_text: qrText } })
      return response.data
    }

    let userId = options?.userId
    if (!userId && qrText) {
      const preview = await this.getPreview(clientId, qrText, { regionId, placeId })
      if (preview.UserID === -1 || preview.UserID === '-1') {
        return {
          ChargeStatus: false,
          LoginStatus: false,
          LogoutStatus: false,
          QrStatus: false,
        }
      }
      userId = String(preview.UserID)
    }
    if (!userId) {
      throw new Error('team 模式 getCharge 需要 userId 或 qrcode')
    }

    const raw = await this.postSwUserApi('/user/charge', {
      userId,
      keychip: clientId,
    })
    return this.normalizeChargeFromPayload(raw)
  }

  /**
   * 获取收藏品
   * POST /api/private/get_item
   * 需要: region_id, region_name, client_id, place_id, place_name, item_id, item_kind, item_stock, qr_text
   */
  async getItem(
    regionId: number,
    regionName: string,
    clientId: string,
    placeId: number,
    placeName: string,
    itemId: number,
    itemKind: number,
    itemStock: number,
    qrText: string
  ): Promise<{
    QrStatus: boolean
    LoginStatus: boolean
    LogoutStatus: boolean
    UserAllStatus: boolean
  }> {
    const response = await this.client.post('/api/private/get_item', null, {
      params: {
        region_id: regionId,
        region_name: regionName,
        client_id: clientId,
        place_id: placeId,
        place_name: placeName,
        item_id: itemId,
        item_kind: itemKind,
        item_stock: itemStock,
        qr_text: qrText,
      },
    })
    return response.data
  }

  /**
   * 修改账号游戏版本号
   * POST /api/private/edit_ver
   * 需要: region_id, region_name, client_id, place_id, place_name, rom_ver, data_ver, qr_text
   */
  async editVer(
    regionId: number,
    regionName: string,
    clientId: string,
    placeId: number,
    placeName: string,
    romVer: string,
    dataVer: string,
    qrText: string
  ): Promise<{
    QrStatus: boolean
    LoginStatus: boolean
    LogoutStatus: boolean
    UserAllStatus: boolean
  }> {
    const response = await this.client.post('/api/private/edit_ver', null, {
      params: {
        region_id: regionId,
        region_name: regionName,
        client_id: clientId,
        place_id: placeId,
        place_name: placeName,
        rom_ver: romVer,
        data_ver: dataVer,
        qr_text: qrText,
      },
    })
    return response.data
  }

  /**
   * 手动上传单曲成绩
   * POST /api/private/upload_score_manual
   * public: POST /v1/upload_score_manual
   * 需要: qr_code, musicId, levelId, achievement, combo, sync, dxScore, rank
   */
  async uploadScoreManual(
    qrText: string,
    musicId: number,
    levelId: number,
    achievement: number,
    combo: number,
    sync: number,
    dxScore: number,
    rank: number,
    playcount?: number,
    iscover?: number,
    isforce?: number,
    detailmode?: number,
  ): Promise<{
    success: boolean
    result?: {
      returnCode: number
      apiName: string
    }
    msg?: string
  }> {
    const path =
      this.apiStyle === 'public' ? '/v1/upload_score_manual' : '/api/private/upload_score_manual'
    const response = await this.client.post(path, {
      qr_code: qrText,
      musicId,
      levelId,
      achievement,
      combo,
      sync,
      dxScore,
      rank,
      playcount: playcount ?? 1,
      iscover: iscover ?? 0,
      isforce: isforce ?? 0,
      detailmode: detailmode ?? 0,
    })
    return response.data
  }

  /**
   * 手动批量上传成绩
   * POST /api/private/batch_upload_score_manual
   * public: POST /v1/batch_upload_score_manual
   * 需要: qr_code, musicId, level_range, combo, sync, dxScore
   */
  async batchUploadScoreManual(
    qrText: string,
    musicId: number,
    levelRange: number[],
    combo: number,
    sync: number,
    dxScore: number,
  ): Promise<{
    success: boolean
    result?: {
      returnCode: number
      apiName: string
    }
    msg?: string
  }> {
    const path =
      this.apiStyle === 'public'
        ? '/v1/batch_upload_score_manual'
        : '/api/private/batch_upload_score_manual'
    const response = await this.client.post(path, {
      qr_code: qrText,
      musicId,
      level_range: levelRange,
      combo,
      sync,
      dxScore,
    })
    return response.data
  }

  /**
   * 手动解锁单个物品
   * POST /api/private/unlock_single_item_manual
   * public: POST /v1/unlock_single_item_manual
   * 需要: qr_code, item_id, item_kind, item_stock
   */
  async unlockSingleItemManual(
    qrText: string,
    itemId: number,
    itemKind: number,
    itemStock: number = 1,
  ): Promise<{
    success: boolean
    result?: {
      returnCode: number
      apiName: string
    }
    msg?: string
  }> {
    const path =
      this.apiStyle === 'public'
        ? '/v1/unlock_single_item_manual'
        : '/api/private/unlock_single_item_manual'
    const response = await this.client.post(path, {
      qr_code: qrText,
      item_id: itemId,
      item_kind: itemKind,
      item_stock: itemStock,
    })
    return response.data
  }

  /**
   * 手动解锁单首乐曲
   * POST /api/private/unlock_music_manual
   * public: POST /v1/unlock_music_manual
   * 需要: qr_code, music_id, item_stock, remaster
   */
  async unlockMusicManual(
    qrText: string,
    musicId: number,
    itemStock: number = 1,
    remaster: number = 0,
  ): Promise<{
    success: boolean
    result?: {
      returnCode: number
      apiName: string
    }
    msg?: string
  }> {
    const path =
      this.apiStyle === 'public' ? '/v1/unlock_music_manual' : '/api/private/unlock_music_manual'
    const response = await this.client.post(path, {
      qr_code: qrText,
      music_id: musicId,
      item_stock: itemStock,
      remaster,
    })
    return response.data
  }

  /**
   * 删除乐曲成绩
   * POST /api/private/delete_score_manual
   * public: POST /v1/delete_score_manual
   * 需要: qr_code, musicId, levelId
   * levelId: 0=Basic, 1=Advanced, 2=Expert, 3=Master, 4=Re:Master
   */
  async deleteScoreManual(qrText: string, musicId: number, levelId: number): Promise<any> {
    const path =
      this.apiStyle === 'public' ? '/v1/delete_score_manual' : '/api/private/delete_score_manual'
    const response = await this.client.post(path, {
      qr_code: qrText,
      musicId,
      levelId,
    })
    return response.data
  }

  // ========== 以下为旧API，已不再支持，保留用于兼容性 ==========

  /**
   * @deprecated 旧API，已不再支持
   * 二维码转用户ID - 现在使用 getPreview 代替
   */
  async qr2userid(qrText: string): Promise<{ QRStatus: boolean; UserID: string }> {
    // 尝试使用新API获取用户信息
    // 注意：这个方法需要client_id，但旧代码可能没有提供
    // 为了兼容性，这里保留但标记为deprecated
    throw new Error('qr2userid已废弃，请使用getPreview代替')
  }

  /**
   * @deprecated 旧API，已不再支持
   * 用户状态预览 - 现在使用 getPreview 代替（需要qr_text）
   */
  async preview(maiUid: string): Promise<{
    UserID: string
    BanState: string
    IsLogin: string
    LastLoginDate: string
    LastPlayDate: string
    Rating: string
    UserName: string
    DataVersion?: string
    RomVersion?: string
  }> {
    throw new Error('preview已废弃，请使用getPreview代替（需要qr_text）')
  }

  // ========== 以下功能在新API中未提供，已注释 ==========

  /*
  // 清空功能票 - 新API未提供
  async clearTicket(...) { ... }

  // 用户登录（锁号）- 锁定功能已注释
  async login(...) { ... }

  // 用户登出 - 解锁功能已注释
  async logout(...) { ... }

  // 获取1.5倍票 - 新API未提供
  async get15Ticket(...) { ... }

  // 清收藏品 - 新API未提供
  async clearItem(...) { ... }

  // 舞里程签到 / 发舞里程 - 新API未提供
  async maimile(...) { ... }

  // 查询票券情况 - 新API未提供
  async getCharge(...) { ... }

  // 上传游戏乐曲成绩 - 新API未提供
  async uploadScore(...) { ... }
  */
}
