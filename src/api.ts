import axios, { AxiosInstance } from 'axios'

export interface ApiConfig {
  baseURL: string
  timeout?: number
  retryCount?: number
  retryDelay?: number
  /** team：自建服务 `/api/public`；public：AWMC 网关 `/v1` + Bearer */
  apiStyle?: 'team' | 'public'
  /** apiStyle 为 public 时必填，对应网关 `Authorization: Bearer <令牌>` */
  bearerToken?: string
}

export class MaiBotAPI {
  private client: AxiosInstance
  private retryCount: number
  private retryDelay: number
  private apiStyle: 'team' | 'public'

  constructor(config: ApiConfig) {
    this.retryCount = config.retryCount ?? 5
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
    this.setupRetry()
  }

  private setupRetry(): void {
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalConfig = error?.config as (typeof error.config & {
          __retryCount?: number
        })
        if (!originalConfig) {
          return Promise.reject(error)
        }

        const shouldRetry =
          error?.code === 'ECONNRESET' || error?.response?.status === 504

        const currentRetry = originalConfig.__retryCount ?? 0
        if (!shouldRetry || currentRetry >= this.retryCount) {
          return Promise.reject(error)
        }

        originalConfig.__retryCount = currentRetry + 1
        if (this.retryDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.retryDelay))
        }
        return this.client.request(originalConfig)
      }
    )
  }

  /**
   * 机台 Ping
   * GET /api/public/mai_ping
   */
  async maiPing(): Promise<{
    returnCode?: number
    serverTime?: number
    result?: string
  }> {
    const path = this.apiStyle === 'public' ? '/v1/mai_ping' : '/api/public/mai_ping'
    const response = await this.client.get(path)
    return response.data
  }

  /**
   * 查看用户信息（预览）
   * GET /api/public/get_preview
   * 需要: client_id, qr_text
   */
  async getPreview(clientId: string, qrText: string): Promise<{
    UserID: string | number
    BanState?: number
    IsLogin?: boolean
    LastLoginDate?: string
    LastPlayDate?: string
    Rating?: number
    UserName?: string
    DataVersion?: string
    RomVersion?: string
  }> {
    const path = this.apiStyle === 'public' ? '/v1/get_preview' : '/api/public/get_preview'
    const params =
      this.apiStyle === 'public'
        ? { qr_text: qrText }
        : { client_id: clientId, qr_text: qrText }
    const response = await this.client.get(path, { params })
    return response.data
  }

  /**
   * 上传水鱼 B50
   * POST /api/public/upload_b50
   * 需要: region_id, client_id, place_id, qr_text, fish_token
   */
  async uploadB50(
    regionId: number,
    clientId: string,
    placeId: number,
    qrText: string,
    fishToken: string
  ): Promise<{
    UploadStatus: boolean
    msg: string
    task_id: string
    login_time?: number
    userID?: string
    token?: string
  }> {
    const path = this.apiStyle === 'public' ? '/v1/upload_b50' : '/api/public/upload_b50'
    const params =
      this.apiStyle === 'public'
        ? { qr_text: qrText, fish_token: fishToken }
        : {
            region_id: regionId,
            client_id: clientId,
            place_id: placeId,
            qr_text: qrText,
            fish_token: fishToken,
          }
    const response = await this.client.post(path, null, { params })
    return response.data
  }

  /**
   * 查询水鱼 B50 任务状态
   * GET /api/public/get_b50_task_status
   * 需要: mai_uid (加密的用户ID)
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
   * POST /api/public/upload_lx_b50
   * 需要: region_id, client_id, place_id, qr_text, lxns_code
   */
  async uploadLxB50(
    regionId: number,
    clientId: string,
    placeId: number,
    qrText: string,
    lxnsCode: string
  ): Promise<{
    UploadStatus: boolean
    msg: string
    task_id: string
    login_time?: number
    userID?: string
    token?: string
  }> {
    const path = this.apiStyle === 'public' ? '/v1/upload_lx_b50' : '/api/public/upload_lx_b50'
    const params =
      this.apiStyle === 'public'
        ? { qr_text: qrText, lxns_code: lxnsCode }
        : {
            region_id: regionId,
            client_id: clientId,
            place_id: placeId,
            qr_text: qrText,
            lxns_code: lxnsCode,
          }
    const response = await this.client.post(path, null, { params })
    return response.data
  }

  /**
   * 查询落雪 B50 任务状态
   * GET /api/public/get_lx_b50_task_status
   * 需要: mai_uid (加密的用户ID)
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
   * POST /api/private/get_ticket
   * 需要: region_id, client_id, place_id, ticket_id, qr_text
   */
  async getTicket(
    regionId: number,
    clientId: string,
    placeId: number,
    ticketId: number,
    qrText: string
  ): Promise<{
    QrStatus: boolean
    LoginStatus: boolean
    LogoutStatus: boolean
    TicketStatus: boolean
  }> {
    const response = await this.client.post('/api/private/get_ticket', null, {
      params: {
        region_id: regionId,
        client_id: clientId,
        place_id: placeId,
        ticket_id: ticketId,
        qr_text: qrText,
      },
    })
    return response.data
  }

  /**
   * 获取用户功能票
   * GET /api/public/get_charge
   * 需要: region_id, client_id, place_id, qr_text
   */
  async getCharge(
    regionId: number,
    clientId: string,
    placeId: number,
    qrText: string
  ): Promise<{
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
  }> {
    const path = this.apiStyle === 'public' ? '/v1/get_charge' : '/api/public/get_charge'
    const params =
      this.apiStyle === 'public'
        ? { qr_text: qrText }
        : {
            region_id: regionId,
            client_id: clientId,
            place_id: placeId,
            qr_text: qrText,
          }
    const response = await this.client.get(path, { params })
    return response.data
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
