import { Context } from 'koishi'

export interface UserBinding {
  id: number
  userId: string  // 用户唯一键（优先 koishi:<id>，兼容旧平台原始ID）
  maiUid: string  // 加密后的用户ID
  qrCode: string  // 原始二维码（SGWCMAID...）
  bindTime: Date  // 绑定时间
  userName?: string  // 用户名（从preview获取）
  rating?: string    // Rating（从preview获取）
  fishToken?: string // 水鱼Token
  lxnsCode?: string  // 落雪代码
  alertEnabled?: boolean  // 是否启用播报（默认false）
  lastLoginStatus?: boolean  // 上一次登录状态
  guildId?: string  // 群组ID（用于发送消息）
  channelId?: string  // 频道ID（用于发送消息）
  isLocked?: boolean  // 是否锁定（通过mai锁定指令）
  lockTime?: Date  // 锁定时间
  lockLoginId?: number  // 锁定时的LoginId
  protectionMode?: boolean  // 是否开启保护模式
  lastQrCode?: string  // 最近输入的SGID（用于10分钟内缓存）
  lastQrCodeTime?: Date  // 最近输入SGID的时间戳
  /** 绑定时快照的玩家名，用于与每次 preview 校验 */
  boundPlayerName?: string
  /** 解绑卡兑换累计次数，冷却期内解绑时消耗 */
  unbindCredits?: number
}

export interface MaiBotSetting {
  key: string
  boolValue?: boolean
  updatedAt: Date
}

export interface OperationLog {
  id: number
  refId: string  // 操作引用ID（唯一标识）
  command: string  // 命令名称（如 'mai绑定', 'mai上传B50'）
  userId: string  // 操作人用户ID
  targetUserId?: string  // 目标用户ID（如果是代操作）
  guildId?: string  // 群组ID
  channelId?: string  // 频道ID
  status: 'success' | 'failure' | 'error'  // 操作状态
  result?: string  // 操作结果消息
  errorMessage?: string  // 错误信息
  apiResponse?: string  // API响应（JSON字符串）
  createdAt: Date  // 操作时间
}

export interface MaiBotUserCooldown {
  userId: string
  slot: string
  lastAt: Date
}

/** personal / group / unbind（解绑卡，兑换后为当前绑定账号增加解绑额度） */
export type MaiBotCardKind = 'personal' | 'group' | 'unbind'

export interface MaiBotCardKey {
  id: number
  code: string
  /** 默认 personal（旧数据无此字段时按 personal 处理） */
  cardKind?: MaiBotCardKind
  permanent: boolean
  durationMs: number
  createdAt: Date
  issuerUserId: string
  redeemedAt?: Date
  redeemerUserId?: string
  active: boolean
}

export interface MaiBotPriorityUser {
  userId: string
  expiresAt?: Date
  updatedAt: Date
  /** 为 true 表示由「authority 高于阈值」自动写入的永久优先；权限回落时可安全删除，不影响卡密兑换记录 */
  authorityAuto?: boolean
}

/** 群组优先授权：绑定在 platform:guildId（无 platform 时仅 guildId） */
export interface MaiBotGroupPriority {
  guildKey: string
  expiresAt?: Date
  updatedAt: Date
  /** 可取消/换绑本群群组优先的用户键（制表符分隔，与兑换时写入的账号键一致） */
  managerUserIds?: string
}

/** 群组优先换绑：先在原群发起，再在目标群完成 */
export interface MaiBotGroupRebindPending {
  anchorUserId: string
  matchKeys: string
  fromGuildKey: string
  expiresAt: Date
}

/** 解绑后仍记录上次绑定/解绑时间，用于换绑冷却 */
export interface MaiBotUserRebindState {
  userId: string
  lastBindChangeAt: Date
}

export interface MaiBotUserTerms {
  userId: string
  acceptedAt: Date
  /** 接受时的协议版本号，与配置 termsPolicy.version 比对 */
  termsVersion?: string
}

export interface MaiBotV2Migration {
  userId: string
  migratedAt: Date
}

declare module 'koishi' {
  interface Tables {
    maibot_bindings: UserBinding
    maibot_settings: MaiBotSetting
    maibot_operation_logs: OperationLog
    maibot_user_cooldowns: MaiBotUserCooldown
    maibot_card_keys: MaiBotCardKey
    maibot_priority_users: MaiBotPriorityUser
    maibot_group_priority: MaiBotGroupPriority
    maibot_group_rebind_pending: MaiBotGroupRebindPending
    maibot_user_rebind_state: MaiBotUserRebindState
    maibot_user_terms: MaiBotUserTerms
    maibot_v2_migration: MaiBotV2Migration
  }
}

export function extendDatabase(ctx: Context) {
  ctx.model.extend('maibot_bindings', {
    id: 'unsigned',
    userId: 'string',
    maiUid: 'string',
    qrCode: 'string',
    bindTime: 'timestamp',
    userName: 'string',
    rating: 'string',
    fishToken: 'string', // 水鱼Token
    lxnsCode: 'string',  // 落雪代码
    alertEnabled: 'boolean',  // 是否启用播报
    lastLoginStatus: 'boolean',  // 上一次登录状态
    guildId: 'string',  // 群组ID
    channelId: 'string',  // 频道ID
    isLocked: 'boolean',  // 是否锁定
    lockTime: 'timestamp',  // 锁定时间
    lockLoginId: 'unsigned',  // 锁定时的LoginId
    protectionMode: 'boolean',  // 是否开启保护模式
    lastQrCode: 'string',  // 最近输入的SGID（用于10分钟内缓存）
    lastQrCodeTime: 'timestamp',  // 最近输入SGID的时间戳
    boundPlayerName: 'string',
    unbindCredits: 'unsigned',
  }, {
    primary: 'id',
    autoInc: true,
    // userName、rating、fishToken、lxnsCode、alertEnabled、lastLoginStatus、guildId、channelId、lastQrCode、lastQrCodeTime 可以为空
    unique: ['userId'], // 每个用户只能绑定一个账号
  })

  // 插件全局设置（用于持久化管理员开关等状态）
  ctx.model.extend('maibot_settings', {
    key: 'string',
    boolValue: 'boolean',
    updatedAt: 'timestamp',
  }, {
    primary: 'key',
  })

  // 操作记录表
  ctx.model.extend('maibot_operation_logs', {
    id: 'unsigned',
    refId: 'string',
    command: 'string',
    userId: 'string',
    targetUserId: 'string',
    guildId: 'string',
    channelId: 'string',
    status: 'string',  // 'success' | 'failure' | 'error'
    result: 'text',
    errorMessage: 'text',
    apiResponse: 'text',
    createdAt: 'timestamp',
  }, {
    primary: 'id',
    autoInc: true,
    // targetUserId, guildId, channelId, result, errorMessage, apiResponse 可以为空
    unique: ['refId'], // refId 必须唯一
  })

  ctx.model.extend('maibot_user_cooldowns', {
    userId: 'string',
    slot: 'string',
    lastAt: 'timestamp',
  }, {
    primary: ['userId', 'slot'],
  })

  ctx.model.extend('maibot_card_keys', {
    id: 'unsigned',
    code: 'string',
    cardKind: 'string',
    permanent: 'boolean',
    durationMs: 'unsigned',
    createdAt: 'timestamp',
    issuerUserId: 'string',
    redeemedAt: 'timestamp',
    redeemerUserId: 'string',
    active: 'boolean',
  }, {
    primary: 'id',
    autoInc: true,
    unique: ['code'],
  })

  ctx.model.extend('maibot_priority_users', {
    userId: 'string',
    expiresAt: 'timestamp',
    updatedAt: 'timestamp',
    authorityAuto: 'boolean',
  }, {
    primary: 'userId',
  })

  ctx.model.extend('maibot_group_priority', {
    guildKey: 'string',
    expiresAt: 'timestamp',
    updatedAt: 'timestamp',
    managerUserIds: 'text',
  }, {
    primary: 'guildKey',
  })

  ctx.model.extend('maibot_group_rebind_pending', {
    anchorUserId: 'string',
    matchKeys: 'text',
    fromGuildKey: 'string',
    expiresAt: 'timestamp',
  }, {
    primary: 'anchorUserId',
  })

  ctx.model.extend('maibot_user_rebind_state', {
    userId: 'string',
    lastBindChangeAt: 'timestamp',
  }, {
    primary: 'userId',
  })

  ctx.model.extend('maibot_user_terms', {
    userId: 'string',
    acceptedAt: 'timestamp',
    termsVersion: 'string',
  }, {
    primary: 'userId',
  })

  ctx.model.extend('maibot_v2_migration', {
    userId: 'string',
    migratedAt: 'timestamp',
  }, {
    primary: 'userId',
  })
}

