import { Context, h, Schema, Session, type Fragment } from 'koishi'
import {
  ChargeResult,
  MaiBotAPI,
  UserPreview,
  formatAccountStatusBlock,
  findMatchingChargeTask,
  formatChargeTaskStatus,
  isSyncB50Upload,
} from './api'
import {
  formatBindChangeWaitHuman,
  isDxBound,
  isValidLxnsToken,
  lxnsTokenFormatError,
  maskLxnsToken,
  msUntilBindChangeAllowed,
  purgeAllLxnsBindings,
  purgeInvalidLxnsBindings,
  clearUserLxnsBinding,
  LXNS_TOKEN_HINT_URL,
  formatBindingPlayerLabel,
  isNumericMaiUid,
  verifyPreviewMatchesBinding,
  type VerifyPreviewBindingResult,
} from './binding-verify'
import { extendDatabase, UserBinding } from './database'
import {
  adminRemoveGroupPriorityRow,
  adminRemovePersonalPriorityRows,
  adminSetGroupPriorityForGuild,
  adminSetPersonalPriorityForUserIds,
  canonicalGuildPriorityKey,
  checkCommandCooldown,
  clearUserCooldownsForKeys,
  commandToCooldownSlot,
  completeGroupPriorityRebind,
  createCardKeys,
  getGroupPriorityDisplay,
  getPriorityUserDisplayForAnyKey,
  parseCardDurationSpec,
  parsePriorityAdminSpec,
  recordCommandCooldown,
  redeemCardKey,
  startGroupPriorityRebind,
  syncAuthorityAutoPriority,
  userCancelGroupPriority,
  type PriorityCooldownConfig,
} from './priority-cooldown'
import {
  getCanonicalV2UserId,
  hasAnyMaibotUserData,
  hasCompletedV2Migration,
  isV2UserIdFormat,
  markV2MigrationComplete,
  parseMigrationConfirm,
  clearLegacyLxnsBinding,
  performV2UserMigration,
  V2_MIGRATION_CONFIRM_PROMPT,
  V2_MIGRATION_PROMPT,
} from './v2-migration'
import {
  extractSgidFromSession,
  extractSgidFromText,
  formatSgidExtractReport,
  processSGID,
} from './sgid-extract'

export const name = 'maibot'
export const inject = ['database']

export interface MachineInfo {
  clientId: string
  regionId: number
  placeId: number
  placeName: string
  regionName: string
}

export interface Config {
  apiBaseURL: string
  /** team：自建/团队内部网关；public：AWMC 公共网关（/v1 + Bearer，见 wiki） */
  apiMode?: 'team' | 'public'
  /** apiMode 为 public 时必填，登录 https://api.awmc.team 获取 gw_ / JWT 令牌 */
  publicGatewayToken?: string
  apiTimeout?: number
  apiRetryCount?: number
  apiRetryDelay?: number
  /** team 模式必填；public 模式可省略（仅用占位，不参与网关请求） */
  machineInfo?: MachineInfo
  /** team 模式必填；public 模式可省略 */
  turnstileToken?: string
  maintenanceNotice?: {
    enabled: boolean
    startHour: number
    endHour: number
    message: string
  }
  confirmTimeout?: number  // 确认提示超时时间（毫秒）
  rebindTimeout?: number  // 重新绑定超时时间（毫秒），默认60秒
  sgidCacheMinutes?: number  // SGID缓存有效期（分钟），默认10分钟
  protectionCheckInterval?: number  // 保护模式检查间隔（毫秒）
  authLevelForProxy?: number  // 代操作功能需要的auth等级（默认3）
  protectionLockMessage?: string  // 保护模式锁定成功消息（支持占位符：{playerid} 玩家名，{at} @用户）
  maintenanceMode?: boolean  // 维护模式开关
  maintenanceMessage?: string  // 维护模式提示消息
  hideLockAndProtection?: boolean  // 隐藏锁定模式和保护模式功能
  enableMaimile?: boolean  // 舞里程发放功能开关（默认关闭，API暂不可用）
  debug?: {
    enabled: boolean  // 调试模式开关
    /** 调试群列表，支持 "platform:guildId"，默认 onebot:1094443807 */
    groupIds: string[]
  }
  whitelist?: {
    enabled: boolean  // 白名单开关
    guildIds: string[]  // 允许使用的群ID列表（兼容旧配置）
    targets?: string[]  // 允许使用的群列表，支持 "platform:guildId" 或仅 "guildId"
    message: string  // 非白名单群的提示消息
  }
  autoRecall?: boolean  // 仅在交互输入或命令参数时自动撤回敏感消息
  queue?: {
    enabled: boolean  // 发票 Bot 侧并发队列开关
    interval: number  // 处理间隔（毫秒），默认10秒
    message: string  // 发票排队提示模板（{queuePosition} {queueEST}）
  }
  operationLog?: {
    enabled: boolean  // 操作记录开关
    refIdLabel: string  // Ref_ID 显示标签（可自定义），默认 'Ref_ID'
  }
  errorHelpUrl?: string  // 任务出错时引导用户提问的URL
  b50PollInterval?: number  // B50任务轮询间隔（毫秒），默认2000毫秒
  b50PollTimeout?: number  // B50任务轮询超时时间（毫秒），默认600000毫秒（10分钟）
  b50PollRequestTimeout?: number  // B50轮询单次请求超时时间（毫秒），默认10000毫秒（10秒）
  autoRecallProcessingMessages?: boolean  // B50任务完成后自动撤回"正在处理"和"已提交"消息
  /** 卡密生成/删除/导出等管理指令需要的 Koishi authority，默认 4 */
  authLevelForCardAdmin?: number
  /** 普通用户指令冷却（优先用户可走更短冷却）；authority > adminBypassAuthority 时绕过冷却并自动同步永久个人优先 */
  priorityCooldown?: PriorityCooldownConfig
  /** 换绑冷却与解绑卡说明（shopUrl 留空则用 priorityCooldown.shopUrl） */
  rebindPolicy?: {
    minDaysBetweenBindChange: number
    shopUrl?: string
  }
  /** 用户协议（V2）：自定义链接与确认词 */
  termsPolicy?: {
    url: string
    acceptText: string
    /** 协议版本号，变更后需用户重新确认 */
    version: string
  }
  /** 交互式提示/处理中消息完成后自动撤回（仅保留结果） */
  autoRecallInteractiveMessages?: boolean
  /** Token 直连模式：无需 /mai绑定，仅按 userId 绑定水鱼/落雪，且只开放 B50 与发票 */
  tokenOnlyMode?: boolean
  /** 测试阶段提示：首次使用功能前警示，版本变更后需重新确认 */
  betaNotice?: {
    enabled?: boolean
    version?: string
  }
  /** 群聊内回复时引用原消息并 @ 发送者 */
  replyInGroup?: boolean
  chargePollInterval?: number
  chargePollTimeout?: number
}

export const Config: Schema<Config> = Schema.object({
  apiMode: Schema.union([
    Schema.const('public').description('AWMC 公共网关（按量计费，见API平台。）'),
    Schema.const('team').description('团队内部或自建 API 服务'),
  ])
    .default('team')
    .description(
      'API 来源：public=公共网关（须填 publicGatewayToken，apiBaseURL 一般为 https://api.awmc.team ）；team=内部服务（须填 machineInfo、turnstileToken）。',
    ),
  publicGatewayToken: Schema.string()
    .required(false)
    .description('公共网关令牌（Bearer / gw_…，勿泄露）。申请 https://api.awmc.team · 购买额度 https://store.awmc.team'),
  apiBaseURL: Schema.string()
    .default('http://localhost:5001')
    .description('API 根地址。team 模式一般为 sw-api 地址（如 http://localhost:5001）；public 模式一般为 https://api.awmc.team'),
  apiTimeout: Schema.number().default(30000).description('API请求超时时间（毫秒）'),
  apiRetryCount: Schema.number().default(3).description('API 失败后的重试次数（默认 3 次；对 5xx/408/429、超时与网络错误生效）'),
  apiRetryDelay: Schema.number().default(1000).description('API请求重试间隔（毫秒）'),
  machineInfo: Schema.object({
    clientId: Schema.string().required().description('客户端ID'),
    regionId: Schema.number().required().description('区域ID'),
    placeId: Schema.number().required().description('场所ID'),
    placeName: Schema.string().required().description('场所名称'),
    regionName: Schema.string().required().description('区域名称'),
  })
    .required(false)
    .description('机台信息（仅 apiMode 为 team 时必填；public 可留空）'),
  turnstileToken: Schema.string()
    .required(false)
    .description('Turnstile Token（仅 apiMode 为 team 时必填；public 可留空）'),
  maintenanceNotice: Schema.object({
    enabled: Schema.boolean().default(true).description('是否启用维护时间提示与拦截'),
    startHour: Schema.number().default(4).description('维护开始时间（小时，0-23）'),
    endHour: Schema.number().default(7).description('维护结束时间（小时，0-23）'),
    message: Schema.string().default('❌503 当前为服务器维护时间，本指令暂不可用，请稍后再试。').description('维护时间内的提示文本'),
  }).description('B50 等指令的维护时间配置（例如凌晨 4:00-7:00 不允许上传）').default({
    enabled: true,
    startHour: 4,
    endHour: 7,
    message: '当前为凌立服务器维护时间，本指令暂不可用，请稍后再试。',
  }),
  confirmTimeout: Schema.number().default(10000).description('确认提示超时时间（毫秒），默认10秒（10000毫秒）'),
  rebindTimeout: Schema.number().default(60000).description('重新绑定超时时间（毫秒），默认60秒（60000毫秒）'),
  sgidCacheMinutes: Schema.number().default(10).description('SGID缓存有效期（分钟），默认10分钟（0表示禁用缓存）'),
  protectionCheckInterval: Schema.number().default(60000).description('保护模式检查间隔（毫秒），默认60秒（60000毫秒）'),
  authLevelForProxy: Schema.number().default(3).description('代操作功能需要的auth等级，默认3'),
  protectionLockMessage: Schema.string().default('🛡️ 保护模式：{playerid}{at} 你的账号已自动锁定成功').description('保护模式锁定成功消息（支持占位符：{playerid} 玩家名，{at} @用户）'),
  maintenanceMode: Schema.boolean().default(false).description('维护模式开关，开启时所有指令都会提示维护信息'),
  maintenanceMessage: Schema.string().default('⚠️  Milk Server Studio 正在进行维护。具体清查阅 https://awmc.cc/').description('维护模式提示消息'),
  hideLockAndProtection: Schema.boolean().default(false).description('隐藏锁定模式和保护模式功能，开启后相关指令将不可用，状态信息也不会显示'),
  enableMaimile: Schema.boolean().default(false).description('舞里程发放功能开关（默认关闭，因API暂不可用）'),
  debug: Schema.object({
    enabled: Schema.boolean().default(false).description('调试模式开关：开启后调试群内跳过所有限制（冷却/队列/维护/白名单等），并打印详细日志'),
    groupIds: Schema.array(Schema.string()).role('table').default(['onebot:1094443807']).description('调试群列表，支持 "platform:guildId"（如 onebot:1094443807）或仅 "guildId"'),
  }).description('调试配置').default({
    enabled: false,
    groupIds: ['onebot:1094443807'],
  }),
  whitelist: Schema.object({
    enabled: Schema.boolean().default(false).description('白名单开关，开启后只有白名单内的群可以使用Bot功能'),
    guildIds: Schema.array(Schema.string()).default(['1072033605']).description('允许使用Bot功能的群ID列表（兼容旧配置）'),
    targets: Schema.array(Schema.string()).role('table').default(['qq:1072033605']).description('允许使用Bot功能的群列表，支持 "platform:guildId"（如 qq:1072033605, discord:123456）或仅 "guildId"'),
    message: Schema.string().default('本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。').description('非白名单群的提示消息'),
  }).description('群白名单配置').default({
    enabled: false,
    guildIds: ['1072033605'],
    targets: ['qq:1072033605'],
    message: '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。',
  }),
  autoRecall: Schema.boolean().default(true).description('仅在交互输入或命令参数时自动撤回敏感消息（尝试撤回，如不支持则忽略）'),
  queue: Schema.object({
    enabled: Schema.boolean().default(false).description('发票 Bot 侧并发队列开关（仅 /mai发票）；开启后 Bot 串行化发票请求，与 sw-api 服务端充值队列配合使用'),
    interval: Schema.number().default(10000).description('发票 Bot 队列处理间隔（毫秒），默认 10 秒'),
    message: Schema.string().default('⏳ 发票排队中，前面还有 {queuePosition} 人，预计等待 {queueEST} 秒。').description('发票 Bot 队列提示模板（占位符 {queuePosition} {queueEST}）'),
  }).description('发票请求队列（Bot 侧限流）').default({
    enabled: false,
    interval: 10000,
    message: '⏳ 发票排队中，前面还有 {queuePosition} 人，预计等待 {queueEST} 秒。',
  }),
  operationLog: Schema.object({
    enabled: Schema.boolean().default(true).description('操作记录开关，开启后记录所有操作'),
    refIdLabel: Schema.string().default('Ref_ID').description('Ref_ID 显示标签（可自定义），默认 "Ref_ID"'),
  }).description('操作记录配置').default({
    enabled: true,
    refIdLabel: 'Ref_ID',
  }),
  errorHelpUrl: Schema.string().default('https://awmc.cc/forums/8/').description('任务出错时引导用户提问的URL（留空则不显示引导信息）'),
  b50PollInterval: Schema.number().default(2000).description('B50任务轮询间隔（毫秒），默认2000毫秒'),
  b50PollTimeout: Schema.number().default(600000).description('B50任务轮询超时时间（毫秒），默认600000毫秒（10分钟）'),
  b50PollRequestTimeout: Schema.number().default(10000).description('B50轮询单次请求超时时间（毫秒），默认10000毫秒（10秒），超时后会重试'),
  autoRecallProcessingMessages: Schema.boolean().default(true).description('B50任务完成后自动撤回"正在处理"和"已提交"消息'),
  authLevelForCardAdmin: Schema.number().default(4).description('卡密管理指令（生成/删除/导出）需要的 Koishi authority，默认 4'),
  priorityCooldown: Schema.object({
    enabled: Schema.boolean().default(false).description(
      '开启后，对参与冷却槽的 mai 指令在指令执行前统一检查间隔（见插件内 commandToCooldownSlot：含发票/B50/状态等分槽，其余多数为 default 槽；帮助、绑定类、管理员指令等不参与）',
    ),
    adminBypassAuthority: Schema.number()
      .default(4)
      .description(
        '仅当用户 Koishi authority 大于该数值时视为管理员：绕过冷却，并自动写入永久个人优先（带标记，权限回落时自动删除）；卡密兑换的优先记录不会被删除。',
      ),
    shopUrl: Schema.string().default('https://ifdian.net/a/AWMC_TEAM?tab=shop').description('冷却提示中的购买链接'),
    messageTemplate: Schema.string().role('textarea', { rows: 3 }).default('普通用户使用此功能有限制。您的冷却时间剩余：{remainingSec}秒。前往{shopUrl}购买优先授权！').description('冷却中提示（占位符 {remainingSec} {shopUrl}）'),
    normalTicketMs: Schema.number().default(1200000).description('普通用户「发票」类冷却（毫秒），默认 20 分钟'),
    priorityTicketMs: Schema.number().default(0).description('优先用户「发票」类冷却（毫秒），默认 0'),
    normalB50Ms: Schema.number().default(30000).description('普通用户 B50 相关（mai上传B50 / maiua / 落雪b50）冷却（毫秒）'),
    priorityB50Ms: Schema.number().default(0).description('优先用户 B50 相关冷却（毫秒）'),
    normalStatusMs: Schema.number().default(30000).description('普通用户 /mai状态 冷却（毫秒）'),
    priorityStatusMs: Schema.number().default(0).description('优先用户 /mai状态 冷却（毫秒）'),
    normalDefaultMs: Schema.number().default(30000).description('普通用户其它功能指令默认冷却（毫秒）'),
    priorityDefaultMs: Schema.number().default(0).description('优先用户其它功能指令默认冷却（毫秒）'),
  }).description('用户指令冷却与优先授权提示').default({
    enabled: false,
    adminBypassAuthority: 4,
    shopUrl: 'https://ifdian.net/a/AWMC_TEAM?tab=shop',
    messageTemplate: '普通用户使用此功能有限制。您的冷却时间剩余：{remainingSec}秒。前往{shopUrl}购买优先授权！',
    normalTicketMs: 1200000,
    priorityTicketMs: 0,
    normalB50Ms: 30000,
    priorityB50Ms: 0,
    normalStatusMs: 30000,
    priorityStatusMs: 0,
    normalDefaultMs: 30000,
    priorityDefaultMs: 0,
  }),
  rebindPolicy: Schema.object({
    minDaysBetweenBindChange: Schema.number().default(30).description('同一账号两次绑定/换绑之间的最小间隔天数'),
    shopUrl: Schema.string().default('').description('解绑卡购买链接（留空则用 priorityCooldown.shopUrl）'),
  }).description('换绑冷却与解绑卡').default({
    minDaysBetweenBindChange: 30,
    shopUrl: '',
  }),
  termsPolicy: Schema.object({
    url: Schema.string().default('https://wiki.awmc.cc/guide/bot/terms').description('服务协议网页链接'),
    acceptText: Schema.string().role('textarea', { rows: 4 }).default(
      '我已认真阅读网页中的服务说明，并已了解AWMC服务可能带来的风险。我了解因使用本服务，造成舞萌DX官方账号遭到封禁，责任和AWMC无关。我确认发送二维码可能会对我的账号产生安全影响，并愿意接受这样的风险。在阅读说明后，我同意上述协议。',
    ).description('用户需完整输入的确认词（与网页展示一致）'),
    version: Schema.string().default('2.0.0').description('协议版本号，变更后所有用户需重新确认'),
  }).description('用户协议配置（V2）').default({
    url: 'https://wiki.awmc.cc/guide/bot/terms',
    acceptText:
      '我已认真阅读网页中的服务说明，并已了解AWMC服务可能带来的风险。我了解因使用本服务，造成舞萌DX官方账号遭到封禁，责任和AWMC无关。我确认发送二维码可能会对我的账号产生安全影响，并愿意接受这样的风险。在阅读说明后，我同意上述协议。',
    version: '2.0.0',
  }),
  autoRecallInteractiveMessages: Schema.boolean().default(true).description('交互式提示与处理中消息完成后自动撤回，仅保留最终结果'),
  tokenOnlyMode: Schema.boolean().default(false).description(
    'Token 直连模式：关闭舞萌绑定，用户仅按 userId 绑定水鱼/落雪 Token，且只能使用 B50 上传与发票；关闭本模式后，未完成舞萌绑定的用户须 /mai绑定',
  ),
  betaNotice: Schema.object({
    enabled: Schema.boolean().default(true).description('是否在首次使用功能前向用户展示测试阶段警示'),
    version: Schema.string().default('2.0.0').description('测试提示版本号，变更后所有用户需重新确认'),
  }).description('测试阶段警示').default({
    enabled: true,
    version: '2.0.0',
  }),
  replyInGroup: Schema.boolean().default(true).description('群聊内 Bot 回复时引用用户消息并 @ 发送者'),
  chargePollInterval: Schema.number().default(3000).description('发票充值队列轮询间隔（毫秒），默认 3 秒'),
  chargePollTimeout: Schema.number().default(180000).description('发票充值队列轮询超时（毫秒），默认 3 分钟'),
}).description(
  '【公共 API】申请 https://api.awmc.team',
)

// 我认识了很多朋友 以下是我认识的好朋友们！
// MisakaNo
// Tome Chen
// BGCat
// and a lot...


/**
 * 票券ID到中文名称的映射
 */
const TICKET_NAME_MAP: Record<number, string> = {
  6: '6倍票',
  5: '5倍票',
  4: '4倍票',
  3: '3倍票',
  2: '2倍票',
  10005: '活动5倍票_1',
  10105: '活动5倍票_2',
  10205: '活动5倍票_3',
  30001: '联动票',
  0: '不使用',
  11001: '免费1.5倍票',
  30002: '每周区域前进2倍票',
  30003: '旅行伙伴等级提升5倍票',
}

/**
 * 获取票券中文名称
 */
function getTicketName(chargeId: number): string {
  return TICKET_NAME_MAP[chargeId] || `未知票券(${chargeId})`
}

/**
 * 清理错误消息中的敏感信息（IP地址、URL等）
 */
function sanitizeErrorMessage(message: string): string {
  if (!message) return '未提供错误详情'
  return message
    .replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?/g, '[服务器]')
    .replace(/https?:\/\/[^\s]+/g, '[链接]')
    .replace(/localhost(:\d+)?/g, '[服务器]')
}

/**
 * 清理错误信息，隐藏敏感的 API 地址等信息
 * 用于日志输出，防止泄漏服务器地址
 */
function sanitizeError(error: any): string {
  if (!error) return '未提供错误详情'
  
  // 获取错误消息
  const message = error?.message || String(error)
  
  // 获取错误代码（如 ETIMEDOUT, ECONNRESET 等）
  const code = error?.code ? `[${error.code}]` : ''
  
  // 隐藏敏感信息
  const sanitizedMessage = sanitizeErrorMessage(message)
  
  return `${code} ${sanitizedMessage}`.trim()
}

/** Session 上暂存当前正在执行的指令用法（由 command/before-execute 写入） */
const MAI_SESSION_CMD_USAGE_KEY = '__maiCmdUsageHint'
const MAI_GUILD_REPLY_KEY = '__maiGuildReplyEnabled'
const MAI_TRIGGER_USER_ID = '__maiTriggerUserId'
const MAI_TRIGGER_MESSAGE_ID = '__maiTriggerMessageId'
const MAI_ORIGINAL_SEND = '__maiOriginalSessionSend'

type StrippedSession = Session & { stripped?: { content?: string; prefix?: string } }

/** 去掉 Koishi 指令前缀后的正文（支持空 / 空格 / . / 等前缀） */
function getMaiMessageBody(session: Session): string {
  const s = session as StrippedSession
  let raw = s.stripped?.content ?? session.content ?? ''
  const prefix = s.stripped?.prefix
  if (typeof prefix === 'string' && prefix.length > 0 && raw.startsWith(prefix)) {
    raw = raw.slice(prefix.length)
  }
  return raw.trimStart()
}

/** 是否为 mai 插件相关用户消息（含别名 maiu / maiul 等） */
function isMaiUserMessage(session: Session): boolean {
  const body = getMaiMessageBody(session)
  if (/^\/?mai/i.test(body)) return true
  const argv = (session as { argv?: { command?: { name?: string } } }).argv
  const name = argv?.command?.name
  return !!name && isMaiPluginCommandName(name)
}

/** 去掉前缀与参数后的 mai 指令名（如 maiu、mai上传B50） */
function getMaiCommandName(session: Session): string {
  return getMaiMessageBody(session).replace(/^\//, '').split(/\s+/)[0] || ''
}

/** 解析可用于 @ 的平台用户 ID（OneBot 优先 QQ 号） */
function resolveAtUserId(session: Session): string | null {
  const bag = session as unknown as Record<string, unknown>
  const event = (session as {
    event?: {
      user_id?: unknown
      user?: { id?: unknown }
      member?: { user_id?: unknown; user?: { id?: unknown } }
    }
  }).event
  const candidates = [
    bag[MAI_TRIGGER_USER_ID],
    session.author?.userId,
    (session.author as { id?: unknown } | undefined)?.id,
    session.userId,
    (session as { uid?: string }).uid,
    event?.user_id,
    event?.user?.id,
    event?.member?.user_id,
    event?.member?.user?.id,
  ]
  for (const raw of candidates) {
    if (raw === undefined || raw === null || raw === '') continue
    const s = String(raw)
    if (/^\d+$/.test(s)) return s
    const prefixed = s.match(/:(\d+)$/)
    if (prefixed?.[1]) return prefixed[1]
  }
  return null
}

function resolveTriggerMessageId(session: Session): string | undefined {
  const bag = session as unknown as Record<string, unknown>
  const stored = bag[MAI_TRIGGER_MESSAGE_ID]
  if (stored !== undefined && stored !== null && stored !== '') {
    return String(stored)
  }
  const msg = (session as { event?: { message?: Record<string, unknown>; messageId?: unknown } }).event?.message
  const event = (session as { event?: { messageId?: unknown } }).event
  for (const raw of [
    session.messageId,
    msg?.id,
    msg?.messageId,
    msg?.message_id,
    event?.messageId,
  ]) {
    if (raw !== undefined && raw !== null && raw !== '') {
      return String(raw)
    }
  }
  return undefined
}

function stashTriggerSessionMeta(session: Session): void {
  const bag = session as unknown as Record<string, unknown>
  const atId = resolveAtUserId(session)
  if (atId) bag[MAI_TRIGGER_USER_ID] = atId
  const mid = resolveTriggerMessageId(session)
  if (mid) bag[MAI_TRIGGER_MESSAGE_ID] = mid
}

function fragmentAlreadyQuoted(content: unknown): boolean {
  const visit = (node: unknown): boolean => {
    if (!node || typeof node !== 'object') return false
    if ((node as { type?: string }).type === 'quote') return true
    if (Array.isArray(node)) return node.some(visit)
    const children = (node as { children?: unknown[] }).children
    if (Array.isArray(children)) return children.some(visit)
    return false
  }
  return visit(content)
}

/** 群聊回复：暂存触发消息元数据并包装 session.send */
function prepareGroupReplySession(session: Session, replyInGroup: boolean): void {
  if (!shouldUseGroupReply(session, replyInGroup)) return
  stashTriggerSessionMeta(session)
  patchSessionSendForGroupReply(session)
}

function shouldUseGroupReply(session: Session, replyInGroup: boolean): boolean {
  return replyInGroup && !!session.guildId
}

/** 去掉正文里遗留的 XML @ 标签，避免与 h.at 重复或原样显示 */
function stripLegacyAtTags(text: string): string {
  return text.replace(/<at\s+id=["'][^"']+["']\s*\/?>\s*/gi, '')
}

function wrapForGroupReply(session: Session, content: unknown): Fragment {
  if (content == null) return ''
  if (fragmentAlreadyQuoted(content)) return content as Fragment

  const atId = resolveAtUserId(session)
  const messageId = resolveTriggerMessageId(session)
  const parts: unknown[] = []

  if (messageId) parts.push(h.quote(String(messageId)))
  if (atId) parts.push(h.at(atId), h.text('\n'))

  if (typeof content === 'string') {
    const body = stripLegacyAtTags(content)
    if (body) parts.push(body)
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (Array.isArray(item)) {
        for (const sub of item) parts.push(sub)
      } else {
        parts.push(item)
      }
    }
  } else {
    parts.push(content)
  }

  if (parts.length === 0) return ''
  return h.normalize(parts as Fragment)
}

function patchSessionSendForGroupReply(session: Session): void {
  const bag = session as unknown as Record<string, unknown>
  if (bag[MAI_ORIGINAL_SEND]) return
  const originalSend = session.send.bind(session)
  bag[MAI_ORIGINAL_SEND] = originalSend
  session.send = async (content: unknown) => {
    if (!bag[MAI_GUILD_REPLY_KEY]) {
      return originalSend(content as Fragment)
    }
    stashTriggerSessionMeta(session)
    return originalSend(wrapForGroupReply(session, content) as Fragment)
  }
}

function enableGuildReplyOnSession(session: Session, replyInGroup: boolean): void {
  if (!shouldUseGroupReply(session, replyInGroup)) return
  ;(session as unknown as Record<string, unknown>)[MAI_GUILD_REPLY_KEY] = true
}

function disableGuildReplyOnSession(session: Session): void {
  delete (session as unknown as Record<string, unknown>)[MAI_GUILD_REPLY_KEY]
}

function getSessionCommandUsageHint(session?: Session): string {
  if (!session) return ''
  const raw = (session as unknown as Record<string, unknown>)[MAI_SESSION_CMD_USAGE_KEY]
  return typeof raw === 'string' ? raw.trim() : ''
}

function isMaiPluginCommandName(name: string): boolean {
  return name.trim().startsWith('mai')
}

function normalizeMaiCommandName(name: string): string {
  return name.trim().toLowerCase()
}

/** Token 直连模式白名单（canonical 指令名，别名由 Koishi 解析后再比对） */
function isTokenOnlyAllowedCommand(name: string): boolean {
  const cmd = normalizeMaiCommandName(name)
  if (cmd === 'mai') return true
  if (cmd.startsWith('mai管理员') || cmd === 'maibypass') return true
  return new Set([
    'mai绑定水鱼',
    'mai解绑水鱼',
    'mai绑定落雪',
    'mai解绑落雪',
    'mai上传b50',
    'maiua',
    'mai上传落雪b50',
    'mai发票',
  ]).has(cmd)
}

/**
 * <spec:text> 会把「clear -g 群号」整段吃成一个参数；从首尾拆出 -g 群标识，并与 .option('-g') 合并（优先已解析的 -g）。
 */
function splitGroupPrioritySpecAndGuild(
  specRaw: string | undefined,
  optionGuild: string | undefined,
): { spec: string; guild: string } {
  let specStr = (specRaw ?? '').trim()
  let guild = String(optionGuild ?? '').trim()

  const lead = specStr.match(/^\s*-g\s+(\S+)\s+([\s\S]+)$/i)
  if (lead) {
    if (!guild) guild = lead[1]
    specStr = lead[2].trim()
  }

  const tail = specStr.match(/^([\s\S]+?)\s+-g\s+(\S+)\s*$/i)
  if (tail) {
    specStr = tail[1].trim()
    if (!guild) guild = tail[2]
  }

  return { spec: specStr, guild }
}

/** 群优先表里的 guildKey 多为 platform:guildId；仅填数字时按当前会话平台补前缀 */
function normalizeGuildKeyForPriority(gk: string, session: Session): string {
  const t = gk.trim()
  if (!t) return t
  if (!/^\d+$/.test(t)) return t
  const p = String(session.platform || '').trim().toLowerCase()
  return p ? `${p}:${t}` : t
}

async function computeMaiCommandUsageHint(command: any, session: Session): Promise<string> {
  if (!command || !isMaiPluginCommandName(String(command.name || ''))) return ''
  const chunks: string[] = []
  try {
    const descPath = `commands.${command.name}.description`
    const d = session.text(descPath)
    if (d && String(d).trim() && d !== descPath && !String(d).startsWith('commands.')) {
      chunks.push(String(d).trim())
    }
  } catch {
    /* ignore */
  }
  const display = String(command.displayName ?? command.name ?? '').trim()
  const decl = String(command.declaration ?? '').trim()
  const syntax = [display, decl].filter(Boolean).join(' ')
  if (syntax) chunks.push(`用法：/${syntax}`)
  const usageField = command._usage
  if (typeof usageField === 'string' && usageField.trim()) {
    chunks.push(usageField.trim())
  } else if (typeof usageField === 'function') {
    try {
      const u = await usageField(session)
      if (u && String(u).trim()) chunks.push(String(u).trim())
    } catch {
      /* ignore */
    }
  }
  return chunks.join('\n')
}

function shouldAppendUsageFooter(text: string, session?: Session): boolean {
  if (!getSessionCommandUsageHint(session)) return false
  const t = (text || '').trim()
  if (!t) return true
  if (t.includes('查看各指令用法') || t.includes('/mai帮助')) return false
  if (t === '执行失败（未返回详细原因）') return true
  if (t === '未知错误' || t === '未提供错误详情') return true
  if (/^(发生未知错误|未知错误|An unknown error)/i.test(t)) return true
  return false
}

function formatCommandUsageAppend(session?: Session): string {
  let hint = getSessionCommandUsageHint(session)
  if (!hint) return ''
  const max = 800
  if (hint.length > max) hint = `${hint.slice(0, max)}…`
  return `\n\n📌 ${hint}`
}

/**
 * 获取用户友好的错误消息（隐藏敏感信息）
 * @param session 若传入且在指令执行上下文中，对模糊错误会附加当前指令的用法说明
 */
function getSafeErrorMessage(error: any, session?: Session): string {
  if (!error) {
    const base = '执行失败（未返回详细原因）'
    return shouldAppendUsageFooter(base, session) ? `${base}${formatCommandUsageAppend(session)}` : base
  }
  const message = error?.message || String(error)
  const sanitized = sanitizeErrorMessage(message)
  const base =
    !String(message).trim() || sanitized === '未知错误'
      ? '执行失败（未返回详细原因）'
      : sanitized
  return shouldAppendUsageFooter(base, session) ? `${base}${formatCommandUsageAppend(session)}` : base
}

type InteractiveCardKindChoice = 'personal' | 'group' | 'unbind' | 'cancel'

function parseInteractiveCardKindInput(text: string): InteractiveCardKindChoice | null {
  const t = text.trim().toLowerCase()
  if (!t) return null
  if (t === '0' || t === '取消' || t === 'cancel' || t === 'q') return 'cancel'
  if (t === '1' || t === '个人' || t === 'personal' || t === 'p') return 'personal'
  if (t === '2' || t === '群组' || t === 'group' || t === 'g') return 'group'
  if (t === '3' || t === '解绑' || t === 'unbind' || t === 'u') return 'unbind'
  return null
}

/** 批量作废卡密：一行一条；可粘贴导出 TSV（取每行首列）；从行内匹配 MAI-… */
function parseBatchVoidCardCodes(raw: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of raw.split(/\r?\n/)) {
    let s = line.trim()
    if (!s) continue
    if (s.includes('\t')) {
      s = s.split('\t')[0].trim()
    }
    const upper = s.toUpperCase()
    const m = upper.match(/MAI-[A-Z0-9-]+/)
    const code = m ? m[0] : upper
    if (!code.startsWith('MAI-')) continue
    if (seen.has(code)) continue
    seen.add(code)
    out.push(code)
  }
  return out
}

type ExportScopeChoice = 'all' | 'unused' | 'redeemed' | 'cancel'

function parseExportScopeInput(text: string): ExportScopeChoice | null {
  const t = text.trim().toLowerCase()
  if (!t) return null
  if (t === '0' || t === '取消' || t === 'cancel' || t === 'q') return 'cancel'
  if (t === '1' || t === 'all' || t === '全部') return 'all'
  if (t === '2' || t === 'unused' || t === '未使用') return 'unused'
  if (t === '3' || t === 'redeemed' || t === '已兑换') return 'redeemed'
  return null
}

type ExportKindFilterChoice = 'all' | 'personal' | 'group' | 'unbind' | 'cancel'

function parseExportKindFilterInput(text: string): ExportKindFilterChoice | null {
  const t = text.trim().toLowerCase()
  if (!t) return null
  if (t === '0' || t === '取消' || t === 'cancel' || t === 'q') return 'cancel'
  if (t === '1' || t === 'all' || t === '全部') return 'all'
  if (t === '2' || t === 'personal' || t === '个人') return 'personal'
  if (t === '3' || t === 'group' || t === '群组') return 'group'
  if (t === '4' || t === 'unbind' || t === '解绑') return 'unbind'
  return null
}

function rowCardKindOf(row: { cardKind?: string }): 'personal' | 'group' | 'unbind' {
  const k = row.cardKind
  if (k === 'group') return 'group'
  if (k === 'unbind') return 'unbind'
  return 'personal'
}

function buildMention(session: Session): Fragment {
  const atId = resolveAtUserId(session)
  if (atId) return h.at(atId)
  return `@${session.author?.nickname || session.username || '玩家'}`
}

/** 渲染带 {playerid}、{at} 占位符的通知模板为 Fragment（{at} 使用 h.at，非 XML 字符串） */
function renderNotifyTemplate(
  template: string,
  vars: { playerName?: string; atUserId?: string | null },
): Fragment {
  const parts: unknown[] = []
  const re = /\{playerid\}|\{at\}/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(template))) {
    if (match.index > last) parts.push(template.slice(last, match.index))
    if (match[0] === '{playerid}') parts.push(vars.playerName ?? '')
    else if (match[0] === '{at}' && vars.atUserId) parts.push(h.at(vars.atUserId))
    last = re.lastIndex
  }
  if (last < template.length) parts.push(template.slice(last))
  return parts as Fragment
}

// promptYes 函数将在 apply 函数内部重新定义以使用配置
async function promptYes(session: Session, message: string, timeout?: number): Promise<boolean> {
  const actualTimeout = timeout ?? 10000
  await session.send(`${message}\n在${actualTimeout / 1000}秒内输入 Y 确认，其它输入取消`)
  try {
    const answer = await session.prompt(actualTimeout)
    return answer?.trim().toUpperCase() === 'Y'
  } catch {
    return false
  }
}

const INTERACTIVE_CANCEL_HINT = '输入 00 取消'

function isInteractiveCancel(input: string | undefined | null): boolean {
  const t = (input ?? '').trim().toLowerCase()
  return t === '00' || t === '取消' || t === 'cancel' || t === 'q'
}

const COLLECTION_TYPE_OPTIONS = [
  { label: '姓名框', value: 1 },
  { label: '称号', value: 2 },
  { label: '头像', value: 3 },
  { label: '礼物', value: 4 },
  { label: '乐曲', value: 5 },
  { label: '解锁Master', value: 6 },
  { label: '解锁Re:Master', value: 7 },
  { label: '解锁黑铺 (未实装)', value: 8 },
  { label: '旅行伙伴', value: 9 },
  { label: '搭档', value: 10 },
  { label: '背景板', value: 11 },
  { label: '功能票', value: 12 },
  { label: '舞里程', value: 13 },
  { label: '亲密度礼物', value: 14 },
  { label: 'KALEIDXSCOPE 钥匙', value: 15 },
]

async function promptCollectionType(session: Session, timeout = 60000, excludeValues: number[] = []): Promise<number | null> {
  const availableOptions = COLLECTION_TYPE_OPTIONS.filter(opt => !excludeValues.includes(opt.value))
  const optionsText = availableOptions.map(
    (opt, idx) => `${idx + 1}. ${opt.label}`
  ).join('\n')
  
  await session.send(
    `请问你需要什么类型收藏品？\n\n${optionsText}\n\n请输入对应的数字（1-${availableOptions.length}），或输入 00 取消`
  )
  
  try {
    const answer = await session.prompt(timeout)
    if (isInteractiveCancel(answer)) {
      return null
    }
    const choice = parseInt(answer?.trim() || '0', 10)
    
    if (choice === 0) {
      return null
    }
    
    if (choice >= 1 && choice <= availableOptions.length) {
      return availableOptions[choice - 1].value
    }
    
    return null
  } catch {
    return null
  }
}

const LEVEL_OPTIONS = [
  { label: 'Basic', value: 1 },
  { label: 'Advanced', value: 2 },
  { label: 'Expert', value: 3 },
  { label: 'Master', value: 4 },
  { label: 'Re:Master', value: 5 },
]

const FC_STATUS_OPTIONS = [
  { label: '无', value: 0 },
  { label: 'Full Combo', value: 1 },
  { label: 'Full Combo+', value: 2 },
  { label: 'All Perfect', value: 3 },
  { label: 'All Perfect+', value: 4 },
]

const SYNC_STATUS_OPTIONS = [
  { label: '无', value: 0 },
  { label: 'Full Sync', value: 1 },
  { label: 'Full Sync+', value: 2 },
  { label: 'FullDX', value: 3 },
  { label: 'FullDX+', value: 4 },
  { label: 'SYNC', value: 5 },
]

const RANK_OPTIONS = [
  { label: 'C', value: 7 },
  { label: 'C+', value: 8 },
  { label: 'B', value: 9 },
  { label: 'B+', value: 10 },
  { label: 'A', value: 11 },
  { label: 'A+', value: 12 },
  { label: 'AA', value: 13 },
  { label: 'AA+', value: 14 },
  { label: 'S', value: 15 },
  { label: 'S+', value: 16 },
  { label: 'SS', value: 17 },
  { label: 'SS+', value: 18 },
  { label: 'SSS', value: 19 },
  { label: 'SSS+', value: 20 },
]

interface ScoreData {
  musicId: number
  levelId: number
  achievement: number
  combo: number
  sync: number
  dxScore: number
  rank: number
}

async function promptScoreData(session: Session, timeout = 60000): Promise<ScoreData | null> {
  try {
    // 1. 乐曲ID
    await session.send(
      '请输入乐曲ID（数字）\n' +
      '如果不知道乐曲ID，请前往 https://maimai.lxns.net/songs 查询\n\n' +
      INTERACTIVE_CANCEL_HINT
    )
    const musicIdInput = await session.prompt(timeout)
    if (!musicIdInput || isInteractiveCancel(musicIdInput)) {
      return null
    }
    const musicId = parseInt(musicIdInput.trim(), 10)
    if (isNaN(musicId) || musicId <= 0) {
      await session.send('❌ 乐曲ID必须是大于0的数字，操作已取消')
      return null
    }

    // 2. 难度 (levelId: 0=Basic, 1=Advanced, 2=Expert, 3=Master, 4=Re:Master)
    const LEVEL_ID_OPTIONS = [
      { label: 'Basic', value: 0 },
      { label: 'Advanced', value: 1 },
      { label: 'Expert', value: 2 },
      { label: 'Master', value: 3 },
      { label: 'Re:Master', value: 4 },
    ]
    const levelOptionsText = LEVEL_ID_OPTIONS.map(
      (opt, idx) => `${idx + 1}. ${opt.label}`
    ).join('\n')
    await session.send(
      `请选择难度：\n\n${levelOptionsText}\n\n请输入对应的数字（1-${LEVEL_ID_OPTIONS.length}），${INTERACTIVE_CANCEL_HINT}`
    )
    const levelInput = await session.prompt(timeout)
    if (isInteractiveCancel(levelInput)) {
      return null
    }
    const levelChoice = parseInt(levelInput?.trim() || '', 10)
    if (levelChoice < 1 || levelChoice > LEVEL_ID_OPTIONS.length) {
      await session.send('❌ 无效的选择，操作已取消')
      return null
    }
    const levelId = LEVEL_ID_OPTIONS[levelChoice - 1].value

    // 3. 成就值 (achievement: 0-1010000)
    await session.send(
      '请输入成就值（整数，0-1010000，例如：1005000 表示 100.5000%）\n' +
      '参考：\n' +
      '  1010000 = SSS+ (101%)\n' +
      '  1005000 = SSS (100.5%)\n' +
      '  1000000 = SSS (100%)\n' +
      '  995000  = S+\n' +
      '  990000  = S\n\n' +
      INTERACTIVE_CANCEL_HINT
    )
    const achievementInput = await session.prompt(timeout)
    if (!achievementInput || isInteractiveCancel(achievementInput)) {
      return null
    }
    const achievement = parseInt(achievementInput.trim(), 10)
    if (isNaN(achievement) || achievement < 0 || achievement > 1010000) {
      await session.send('❌ 成就值必须在 0-1010000 之间，操作已取消')
      return null
    }

    // 4. 连击状态 (combo: 0=无, 1=FC, 2=FC+, 3=AP, 4=AP+)
    const fcOptionsText = FC_STATUS_OPTIONS.map(
      (opt, idx) => `${idx + 1}. ${opt.label}`
    ).join('\n')
    await session.send(
      `请选择连击状态：\n\n${fcOptionsText}\n\n请输入对应的数字（1-${FC_STATUS_OPTIONS.length}），${INTERACTIVE_CANCEL_HINT}`
    )
    const fcInput = await session.prompt(timeout)
    if (isInteractiveCancel(fcInput)) {
      return null
    }
    const fcChoice = parseInt(fcInput?.trim() || '', 10)
    if (fcChoice < 1 || fcChoice > FC_STATUS_OPTIONS.length) {
      await session.send('❌ 无效的选择，操作已取消')
      return null
    }
    const combo = FC_STATUS_OPTIONS[fcChoice - 1].value

    // 5. 同步状态 (sync: 0=无, 1=FS, 2=FS+, 3=FDX, 4=FDX+, 5=SYNC)
    const syncOptionsText = SYNC_STATUS_OPTIONS.map(
      (opt, idx) => `${idx + 1}. ${opt.label}`
    ).join('\n')
    await session.send(
      `请选择同步状态：\n\n${syncOptionsText}\n\n请输入对应的数字（1-${SYNC_STATUS_OPTIONS.length}），${INTERACTIVE_CANCEL_HINT}`
    )
    const syncInput = await session.prompt(timeout)
    if (isInteractiveCancel(syncInput)) {
      return null
    }
    const syncChoice = parseInt(syncInput?.trim() || '', 10)
    if (syncChoice < 1 || syncChoice > SYNC_STATUS_OPTIONS.length) {
      await session.send('❌ 无效的选择，操作已取消')
      return null
    }
    const sync = SYNC_STATUS_OPTIONS[syncChoice - 1].value

    // 6. DX星级 (dxScore: 0-5)
    await session.send(
      '请输入DX星级（整数，0-5）\n\n' +
      INTERACTIVE_CANCEL_HINT
    )
    const dxInput = await session.prompt(timeout)
    if (!dxInput || isInteractiveCancel(dxInput)) {
      return null
    }
    const dxScore = parseInt(dxInput.trim(), 10)
    if (isNaN(dxScore) || dxScore < 0 || dxScore > 5) {
      await session.send('❌ DX星级必须在 0-5 之间，操作已取消')
      return null
    }

    // 7. 评价等级 (rank)
    const rankOptionsText = RANK_OPTIONS.map(
      (opt, idx) => `${idx + 1}. ${opt.label}`
    ).join('\n')
    await session.send(
      `请选择评价等级：\n\n${rankOptionsText}\n\n请输入对应的数字（1-${RANK_OPTIONS.length}），${INTERACTIVE_CANCEL_HINT}`
    )
    const rankInput = await session.prompt(timeout)
    if (isInteractiveCancel(rankInput)) {
      return null
    }
    const rankChoice = parseInt(rankInput?.trim() || '', 10)
    if (rankChoice < 1 || rankChoice > RANK_OPTIONS.length) {
      await session.send('❌ 无效的选择，操作已取消')
      return null
    }
    const rank = RANK_OPTIONS[rankChoice - 1].value

    return {
      musicId,
      levelId,
      achievement,
      combo,
      sync,
      dxScore,
      rank,
    }
  } catch {
    return null
  }
}

function isInMaintenanceWindow(maintenance?: {
  enabled: boolean
  startHour: number
  endHour: number
}): boolean {
  if (!maintenance || !maintenance.enabled) return false
  const now = new Date()
  const hour = now.getHours()
  const start = maintenance.startHour
  const end = maintenance.endHour

  if (start === end) {
    // 相等视为全天维护
    return true
  }

  if (start < end) {
    // 普通区间，例如 4-7 点
    return hour >= start && hour < end
  }

  // 跨零点区间，例如 23-5 点
  return hour >= start || hour < end
}

function getMaintenanceMessage(maintenance?: {
  enabled: boolean
  startHour: number
  endHour: number
  message: string
}): string | null {
  if (!isInMaintenanceWindow(maintenance)) return null
  return maintenance?.message || null
}

/**
 * 将 IsLogin 字符串转换为布尔值
 * 支持多种格式：'true', 'True', 'TRUE', true, 1, '1' 等
 */
function parseLoginStatus(isLogin: string | boolean | number | undefined): boolean {
  if (isLogin === undefined || isLogin === null) {
    return false
  }
  
  if (typeof isLogin === 'boolean') {
    return isLogin
  }
  
  if (typeof isLogin === 'number') {
    return isLogin !== 0
  }
  
  if (typeof isLogin === 'string') {
    const lower = isLogin.toLowerCase().trim()
    return lower === 'true' || lower === '1' || lower === 'yes'
  }
  
  return false
}

/**
 * 检查API返回的状态是否全部为false
 * 当所有状态都为false时，表示二维码已失效，需要重新绑定
 */
function checkAllStatusFalse(result: {
  LoginStatus?: boolean
  LogoutStatus?: boolean
  UserAllStatus?: boolean
  UserLogStatus?: boolean
  [key: string]: any
}): boolean {
  return (
    result.LoginStatus === false &&
    result.LogoutStatus === false &&
    result.UserAllStatus === false &&
    result.UserLogStatus === false
  )
}

/**
 * 从session中提取二维码文本（文本 / 链接 / 图片二维码）
 */
async function extractQRCodeFromSession(
  session: Session,
  ctx: Context
): Promise<string | null> {
  const result = await extractSgidFromSession(session)
  if (result.ok && result.qrText) {
    ctx.logger('maibot').info(`从会话提取 SGID 成功，来源: ${result.source}`)
    return result.qrText
  }
  if (result.error) {
    ctx.logger('maibot').debug(`从会话提取 SGID 失败: ${result.error}`)
  }
  return null
}

/**
 * 队列管理器
 */
class RequestQueue {
  private queue: Array<{
    resolve: () => void
    reject: (error: Error) => void
    timestamp: number
    userId: string
    channelId: string
  }> = []
  private processing = false
  private interval: number
  private lastProcessTime = 0
  private closed = false

  constructor(interval: number) {
    this.interval = interval
  }

  /**
   * 加入队列并等待处理
   * @param userId 用户ID
   * @param channelId 频道ID
   * @returns Promise<number>，当轮到处理时resolve，返回加入队列时的位置（0表示直接执行，没有排队）
   */
  async enqueue(userId: string, channelId: string): Promise<number> {
    if (this.closed) {
      return Promise.reject(new Error('队列已关闭'))
    }

    // 如果队列为空且距离上次处理已过间隔时间，直接执行
    if (this.queue.length === 0 && !this.processing) {
      const now = Date.now()
      const timeSinceLastProcess = now - this.lastProcessTime
      if (timeSinceLastProcess >= this.interval) {
        this.lastProcessTime = now
        return Promise.resolve(0)  // 0表示直接执行，没有排队
      }
    }

    // 需要加入队列
    return new Promise<number>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('队列已关闭'))
        return
      }

      // 记录加入队列时的位置（这是用户前面的人数）
      const queuePosition = this.queue.length
      
      this.queue.push({
        resolve: () => resolve(queuePosition),
        reject,
        timestamp: Date.now(),
        userId,
        channelId,
      })

      // 启动处理循环（如果还没启动）
      if (!this.processing) {
        // 使用setTimeout避免阻塞
        setTimeout(() => {
          this.processQueue()
        }, 0)
      }
    })
  }

  /**
   * 处理队列
   */
  private async processQueue(): Promise<void> {
    while (this.queue.length > 0 && !this.closed) {
      this.processing = true

      // 等待间隔时间
      const now = Date.now()
      const timeSinceLastProcess = now - this.lastProcessTime
      if (timeSinceLastProcess < this.interval) {
        await new Promise(resolve => setTimeout(resolve, this.interval - timeSinceLastProcess))
      }

      // 处理队列中的第一个任务
      if (this.queue.length > 0) {
        const task = this.queue.shift()!
        this.lastProcessTime = Date.now()
        task.resolve()
      }
    }

    this.processing = false
  }

  /**
   * 获取队列位置
   */
  getQueuePosition(): number {
    return this.queue.length
  }

  /**
   * 检查是否正在处理
   */
  isProcessing(): boolean {
    return this.processing
  }

  /**
   * 获取下一次可处理的剩余时间（毫秒）
   */
  private getNextDelayMs(): number {
    const now = Date.now()
    const timeSinceLastProcess = now - this.lastProcessTime
    if (timeSinceLastProcess < 0) {
      return this.interval
    }
    return Math.max(0, this.interval - timeSinceLastProcess)
  }

  /**
   * 获取处理间隔（毫秒）
   */
  getInterval(): number {
    return this.interval
  }

  /**
   * 获取上次处理时间戳
   */
  getLastProcessTime(): number {
    return this.lastProcessTime
  }

  /**
   * 关闭队列并清空等待任务
   */
  close(reason: string = '队列已关闭'): void {
    if (this.closed) return
    this.closed = true
    this.processing = false
    const error = new Error(reason)
    while (this.queue.length > 0) {
      const task = this.queue.shift()
      if (task) {
        task.reject(error)
      }
    }
  }

  /**
   * 获取预计等待时间（秒）
   */
  getEstimatedWaitTime(): number {
    const position = this.getQueuePosition()
    return this.getEstimatedWaitTimeForPosition(position)
  }

  /**
   * 根据位置计算预计等待时间（秒）
   * position=1 表示下一个被处理
   */
  getEstimatedWaitTimeForPosition(position: number): number {
    if (position <= 0) {
      return 0
    }
    const nextDelayMs = this.getNextDelayMs()
    const waitMs = nextDelayMs + (position - 1) * this.interval
    return Math.ceil(waitMs / 1000)
  }

  /**
   * 获取用户在队列中的位置
   * @param userId 用户ID
   * @param channelId 频道ID（可选，用于更精确的匹配）
   * @returns 用户在队列中的位置（0表示正在处理或不在队列中，>0表示前面还有多少人）
   */
  getUserQueuePosition(userId: string, channelId?: string): number {
    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i]
      if (task.userId === userId && (channelId === undefined || task.channelId === channelId)) {
        // 返回位置（前面的人数），索引0表示第一个等待的人
        return i + 1
      }
    }
    // 如果用户不在队列中，检查是否正在处理
    if (this.processing && this.queue.length > 0) {
      const firstTask = this.queue[0]
      if (firstTask.userId === userId && (channelId === undefined || firstTask.channelId === channelId)) {
        return 0  // 正在处理
      }
    }
    return -1  // 不在队列中
  }

  /**
   * 获取用户预计等待时间（秒）
   * @param userId 用户ID
   * @param channelId 频道ID（可选）
   * @returns 预计等待时间（秒），-1表示不在队列中
   */
  getUserEstimatedWaitTime(userId: string, channelId?: string): number {
    const position = this.getUserQueuePosition(userId, channelId)
    if (position < 0) {
      return -1
    }
    if (position === 0) {
      return 0  // 正在处理
    }
    return this.getEstimatedWaitTimeForPosition(position)
  }
}

/**
 * 检查群是否在白名单中（如果白名单功能启用）
 */
function checkWhitelist(session: Session | null, config: Config, debugBypass?: boolean): { allowed: boolean; message?: string } {
  if (!session) {
    return { allowed: true }  // 私聊允许
  }

  if (debugBypass) {
    return { allowed: true }  // 调试群放行
  }

  const whitelistConfig = config.whitelist || { enabled: false, guildIds: [], targets: [], message: '' }
  
  // 如果白名单未启用，允许所有群
  if (!whitelistConfig.enabled) {
    return { allowed: true }
  }

  // 如果是私聊，允许
  if (!session.guildId) {
    return { allowed: true }
  }

  // 检查群ID/频道ID是否在白名单中（兼容不同平台字段）
  const platform = String(session.platform || '').trim().toLowerCase()
  const guildId = String(session.guildId || '').trim()
  const channelId = String(session.channelId || '').trim()
  const whitelistTargets = [
    ...(whitelistConfig.guildIds || []),
    ...(whitelistConfig.targets || []),
  ]
    .map(item => String(item || '').trim())
    .filter(Boolean)

  const whitelistSet = new Set(whitelistTargets)
  const candidates = new Set<string>()
  if (guildId) {
    candidates.add(guildId)
    if (platform) candidates.add(`${platform}:${guildId}`)
  }
  if (channelId) {
    candidates.add(channelId)
    if (platform) candidates.add(`${platform}:${channelId}`)
  }

  for (const candidate of candidates) {
    if (whitelistSet.has(candidate)) {
      return { allowed: true }
    }
  }

  // 历史兼容：支持无前缀但与 guild/channel 任一匹配
  if (guildId && whitelistSet.has(guildId)) {
    return { allowed: true }
  }
  if (channelId && whitelistSet.has(channelId)) {
    return { allowed: true }
  }

  // 不在白名单中
  return { 
    allowed: false, 
    message: whitelistConfig.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。' 
  }
}

async function getBindRelatedLegacyUserIds(ctx: Context, session: Session): Promise<string[]> {
  const relatedUserIds: string[] = []
  const platform = session.platform ? String(session.platform) : ''
  const rawUserId = session.userId ? String(session.userId) : ''
  if (!platform || !rawUserId) return relatedUserIds

  const db = ctx.database as any
  if (!db || typeof db.get !== 'function') return relatedUserIds

  try {
    // 尝试从 bind 插件的 binding 表中反查同一账号下的其他平台ID
    const pidCandidates = [`${platform}:${rawUserId}`, rawUserId]
    let currentBindings: any[] = []
    for (const pid of pidCandidates) {
      const rows = await db.get('binding', { pid })
      if (rows?.length) {
        currentBindings = rows
        break
      }
    }
    if (!currentBindings.length) return relatedUserIds

    const aid = currentBindings[0]?.aid
    if (aid === undefined || aid === null) return relatedUserIds

    const allBindings = await db.get('binding', { aid })
    for (const item of allBindings || []) {
      const pid = item?.pid
      if (typeof pid === 'string' && pid.length > 0) {
        // 常见格式: "platform:userId"
        const idx = pid.indexOf(':')
        const extracted = idx >= 0 ? pid.slice(idx + 1) : pid
        if (extracted && !relatedUserIds.includes(extracted)) {
          relatedUserIds.push(extracted)
        }
      }
    }
  } catch {
    // binding 表不存在或结构不一致时忽略，保持插件可用
  }

  return relatedUserIds
}

async function getBindRelatedLegacyUserIdsForTarget(
  ctx: Context,
  platform: string,
  rawUserId: string,
): Promise<string[]> {
  const relatedUserIds: string[] = []
  if (!platform || !rawUserId) return relatedUserIds

  const db = ctx.database as any
  if (!db || typeof db.get !== 'function') return relatedUserIds

  try {
    const pidCandidates = [`${platform}:${rawUserId}`, rawUserId]
    let currentBindings: any[] = []
    for (const pid of pidCandidates) {
      const rows = await db.get('binding', { pid })
      if (rows?.length) {
        currentBindings = rows
        break
      }
    }
    if (!currentBindings.length) return relatedUserIds

    const aid = currentBindings[0]?.aid
    if (aid === undefined || aid === null) return relatedUserIds

    const allBindings = await db.get('binding', { aid })
    for (const item of allBindings || []) {
      const pid = item?.pid
      if (typeof pid === 'string' && pid.length > 0) {
        const idx = pid.indexOf(':')
        const extracted = idx >= 0 ? pid.slice(idx + 1) : pid
        if (extracted && !relatedUserIds.includes(extracted)) {
          relatedUserIds.push(extracted)
        }
      }
    }
  } catch {
    // binding 表不存在或结构不一致时忽略
  }

  return relatedUserIds
}

async function getSessionBindingKeys(ctx: Context, session: Session): Promise<string[]> {
  const keys: string[] = []
  const canonical = await getCanonicalV2UserId(session)
  if (canonical) {
    keys.push(canonical)
  }

  const rawUserId = session.userId ? String(session.userId) : ''
  if (rawUserId && !keys.includes(rawUserId)) {
    keys.push(rawUserId)
  }

  // bind 插件启用后，session.observeUser(['id']) 会返回统一用户ID（跨平台）
  try {
    const user = await session.observeUser(['id'])
    const unifiedId = user?.id
    if (unifiedId !== undefined && unifiedId !== null) {
      const unifiedKey = `koishi:${String(unifiedId)}`
      if (!keys.includes(unifiedKey)) {
        keys.push(unifiedKey)
      }
      const numericUnified = String(unifiedId)
      if (/^\d+$/.test(numericUnified) && !keys.includes(numericUnified)) {
        keys.unshift(numericUnified)
      }
    }
  } catch {
    // 忽略异常，保持向后兼容（仅用平台原始 userId）
  }

  // 兼容历史数据：若是 QQ 老绑定（仅存 raw userId），在新平台通过 bind 关系反查
  const legacyIds = await getBindRelatedLegacyUserIds(ctx, session)
  for (const id of legacyIds) {
    if (!keys.includes(id)) {
      keys.push(id)
    }
  }

  return keys
}

async function getBindingBySession(ctx: Context, session: Session): Promise<UserBinding | null> {
  const keys = await getSessionBindingKeys(ctx, session)
  for (const key of keys) {
    const bindings = await ctx.database.get('maibot_bindings', { userId: key })
    if (bindings.length > 0) return bindings[0]
  }
  return null
}

async function getOrCreateBindingByUserKey(ctx: Context, userId: string): Promise<UserBinding> {
  const rows = await ctx.database.get('maibot_bindings', { userId })
  if (rows.length) return rows[0]
  await ctx.database.create('maibot_bindings', {
    userId,
    qrCode: '',
    maiUid: '',
    bindTime: new Date(),
  })
  const created = await ctx.database.get('maibot_bindings', { userId })
  return created[0]
}

function shouldVerifyBindingIdentity(binding: UserBinding | null, tokenOnlyMode: boolean): boolean {
  if (!binding) return false
  if (tokenOnlyMode) return false
  return true
}

async function updateBindingBySession(ctx: Context, session: Session, data: Partial<UserBinding>): Promise<boolean> {
  const keys = await getSessionBindingKeys(ctx, session)
  for (const key of keys) {
    const bindings = await ctx.database.get('maibot_bindings', { userId: key })
    if (bindings.length > 0) {
      await ctx.database.set('maibot_bindings', { userId: key }, data)
      return true
    }
  }
  return false
}

async function removeBindingBySession(ctx: Context, session: Session): Promise<boolean> {
  const keys = await getSessionBindingKeys(ctx, session)
  for (const key of keys) {
    const bindings = await ctx.database.get('maibot_bindings', { userId: key })
    if (bindings.length > 0) {
      await ctx.database.remove('maibot_bindings', { userId: key })
      return true
    }
  }
  return false
}

/**
 * 尝试撤回用户消息（如果支持）
 */
async function tryRecallMessage(
  session: Session,
  ctx: Context,
  config: Config,
  messageId?: string
): Promise<void> {
  const logger = ctx.logger('maibot')
  
  // 如果配置中关闭了自动撤回，则跳过
  if (config.autoRecall === false) {
    return
  }

  try {
    // 如果没有提供messageId，尝试从session中获取
    const targetMessageId = messageId || session.messageId
    
    if (!targetMessageId || !session.channelId) {
      logger.debug('无法撤回消息：缺少消息ID或频道ID')
      return
    }

    // KOOK 对“刚发送就撤回”更敏感，增加短暂延迟和重试
    const platform = String(session.platform || '').toLowerCase()
    const retryCount = platform === 'kook' ? 3 : 1
    const delayMs = platform === 'kook' ? 500 : 0

    if (!(session.bot && typeof session.bot.deleteMessage === 'function')) {
      logger.debug('当前适配器不支持撤回消息功能')
      return
    }

    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }

    let lastError: any
    for (let i = 0; i < retryCount; i++) {
      try {
        await session.bot.deleteMessage(session.channelId, targetMessageId)
        logger.info(`已撤回用户 ${session.userId} 的消息: ${targetMessageId}`)
        return
      } catch (error) {
        lastError = error
        // KOOK 可能出现瞬时删除失败，短暂等待后重试
        if (i < retryCount - 1) {
          await new Promise(resolve => setTimeout(resolve, 350))
        }
      }
    }
    throw lastError
  } catch (error: any) {
    // 撤回失败时不抛出错误，只记录日志
    logger.debug(`尝试撤回消息失败（可能不支持该功能）: ${error?.message || '未知错误'}`)
  }
}

/** 撤回 Bot 发送的消息（用于交互流程只保留结果） */
async function recallBotMessages(
  session: Session,
  ctx: Context,
  messageIds: string[],
): Promise<void> {
  if (!messageIds.length || !session.channelId) return
  if (!(session.bot && typeof session.bot.deleteMessage === 'function')) return

  const platform = String(session.platform || '').toLowerCase()
  const delayMs = platform === 'kook' ? 500 : 200
  if (delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }

  for (const id of messageIds) {
    if (!id) continue
    try {
      await session.bot.deleteMessage(session.channelId, id)
    } catch {
      ctx.logger('maibot').debug(`撤回 Bot 消息失败: ${id}`)
    }
  }
}

/** 发送临时消息并在 recall() 时撤回 */
function createBotMessageTracker(session: Session, ctx: Context, enabled: boolean) {
  const ids: string[] = []
  return {
    async send(content: string): Promise<void> {
      if (!enabled) {
        await session.send(content)
        return
      }
      const result = await session.send(content)
      if (typeof result === 'string' && result) {
        ids.push(result)
      } else if (Array.isArray(result)) {
        for (const id of result) {
          if (id && typeof id === 'string') ids.push(id)
        }
      }
    },
    async recall(): Promise<void> {
      if (!enabled || ids.length === 0) return
      await recallBotMessages(session, ctx, [...ids])
      ids.length = 0
    },
    messageIds(): string[] {
      return [...ids]
    },
  }
}

/**
 * 等待用户下一条输入消息（返回完整 Session 便于撤回）
 */
async function waitForUserReply(
  session: Session,
  ctx: Context,
  timeout: number,
  expectedQuoteMessageIds?: string[]
): Promise<Session | null> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined
    const quoteIdSet = new Set((expectedQuoteMessageIds || []).filter(Boolean))
    const platform = String(session.platform || '').toLowerCase()

    const getQuotedMessageId = (replySession: any): string | null => {
      const quote = replySession?.quote
      if (!quote) return null
      if (typeof quote === 'string') return quote
      return quote.id || quote.messageId || null
    }

    const stop = ctx.on('message', (replySession) => {
      if (!replySession.userId || !replySession.channelId) {
        return
      }
      if (replySession.userId !== session.userId) {
        return
      }
      if (session.guildId) {
        if (replySession.guildId !== session.guildId) {
          return
        }
        // KOOK 等多频道平台：同一 guild 下也必须同一 channel，避免串台
        if (replySession.channelId !== session.channelId) {
          return
        }
      } else if (replySession.channelId !== session.channelId) {
        return
      }

      // KOOK 优先支持“引用机器人提示消息”作为输入，减少误触发
      if (platform === 'kook' && quoteIdSet.size > 0) {
        const quotedId = getQuotedMessageId(replySession)
        if (quotedId && !quoteIdSet.has(quotedId)) {
          return
        }
      }

      if (timer) {
        clearTimeout(timer)
      }
      stop()
      resolve(replySession)
    })
    timer = setTimeout(() => {
      stop()
      resolve(null)
    }, timeout)
  })
}

/** 处理 preview 校验结果：拦截错误、老格式 maiUid 自动迁移为纯数字并同步内存中的 binding */
async function applyVerifyPreviewBinding(
  ctx: Context,
  binding: UserBinding,
  result: VerifyPreviewBindingResult,
  logger: ReturnType<Context['logger']>,
): Promise<
  { blocked: true; message: string } | { blocked: false; migrationNotice?: string }
> {
  if (!result.ok) return { blocked: true, message: result.message }
  if ('migratedToUid' in result) {
    await ctx.database.set('maibot_bindings', { userId: binding.userId }, { maiUid: result.migratedToUid })
    ;(binding as UserBinding).maiUid = result.migratedToUid
    logger.info(`maiUid 已自动迁移为数字格式 bindingUserId=${binding.userId}`)
    return { blocked: false, migrationNotice: result.notice }
  }
  return { blocked: false }
}

/**
 * 标记最近一次 B50 类上传使用的 SGID 是否成功（影响 SGID 缓存）
 */
async function setQrUploadSuccessFlag(ctx: Context, bindingUserId: string, success: boolean | undefined): Promise<void> {
  await ctx.database.set('maibot_bindings', { userId: bindingUserId }, { lastQrUploadSuccess: success })
}

/**
 * 获取二维码文本（qr_text）
 * 有有效缓存则直接用；缓存过期则直接问用户发送 SGID/链接
 */
async function getQrText(
  session: Session,
  ctx: Context,
  api: MaiBotAPI,
  binding: UserBinding | null,
  config: Config,
  timeout: number = 60000,
  promptMessage?: string,
  useCache: boolean = true  // 是否使用缓存（默认启用）
): Promise<{ qrText: string; error?: string; fromCache?: boolean }> {
  const logger = ctx.logger('maibot')
  
  const tokenOnlyMode = config.tokenOnlyMode === true

  // 如果启用缓存且binding存在，检查是否有缓存（非 Token 模式会用 preview 校验身份）
  const cacheMinutes = config.sgidCacheMinutes ?? 10
  const cacheBlockedByFailedUpload = binding?.lastQrUploadSuccess === false
  if (cacheBlockedByFailedUpload) {
    logger.info('上次 B50 上传未成功，跳过 SGID 缓存，需用户重新提供')
  }
  if (!cacheBlockedByFailedUpload && useCache && cacheMinutes > 0 && binding && binding.lastQrCode && binding.lastQrCodeTime) {
    const cacheAge = Date.now() - new Date(binding.lastQrCodeTime).getTime()
    const cacheValidDuration = cacheMinutes * 60 * 1000
    
    if (cacheAge < cacheValidDuration && binding.lastQrCode.startsWith('SGWCMAID')) {
      if (tokenOnlyMode) {
        logger.info(`Token 模式：使用缓存的SGID（${Math.floor(cacheAge / 1000)}秒前输入）`)
        return { qrText: binding.lastQrCode, fromCache: true }
      }
      try {
        const previewCached = await api.getPreview(config.machineInfo?.clientId ?? '', binding.lastQrCode)
        if (shouldVerifyBindingIdentity(binding, tokenOnlyMode)) {
          const vr = verifyPreviewMatchesBinding(binding, previewCached)
          const hv = await applyVerifyPreviewBinding(ctx, binding, vr, logger)
          if (!hv.blocked) {
            if (hv.migrationNotice) await session.send(hv.migrationNotice)
            if (previewCached.UserName != null && !binding.boundPlayerName?.trim()) {
              await ctx.database.set('maibot_bindings', { userId: binding.userId }, {
                boundPlayerName: String(previewCached.UserName).trim(),
              })
            }
            logger.info(`使用缓存的SGID（${Math.floor(cacheAge / 1000)}秒前输入）`)
            return { qrText: binding.lastQrCode, fromCache: true }
          }
          logger.info('缓存 SGID 与绑定身份校验失败，需重新输入')
        } else {
          logger.info(`使用缓存的SGID（${Math.floor(cacheAge / 1000)}秒前输入）`)
          return { qrText: binding.lastQrCode, fromCache: true }
        }
      } catch (e) {
        logger.warn('缓存 SGID 预检失败:', e)
      }
    } else {
      logger.debug(`缓存已过期（${Math.floor(cacheAge / 1000)}秒前输入，超过${cacheMinutes}分钟）`)
    }
  }
  
  // 缓存过期或没有缓存，直接问
  const actualTimeout = timeout
  const message = promptMessage || `请在${actualTimeout / 1000}秒内发送SGID（长按玩家二维码识别后发送）或公众号提供的网页地址`
  const recallInteractive = config.autoRecallInteractiveMessages !== false
  const tracker = createBotMessageTracker(session, ctx, recallInteractive)
  
  try {
    await tracker.send(message)
    logger.info(`等待用户 ${session.userId} 输入 SGID/链接，超时: ${actualTimeout}ms`)
    
    const promptSession = await waitForUserReply(session, ctx, actualTimeout, tracker.messageIds())
    const promptText = promptSession?.content?.trim() || ''
    if (!promptText) {
      await tracker.recall()
      return { qrText: '', error: '超时未收到响应' }
    }

    const trimmed = promptText.trim()
    await tracker.recall()
    // 交互式输入的敏感信息，撤回用户输入消息
    if (promptSession) {
      await tryRecallMessage(promptSession, ctx, config, promptSession.messageId)
    }
    logger.debug(`收到用户输入: ${trimmed.substring(0, 50)}`)
    
    let qrText = trimmed
    
    // 检查是否为公众号网页地址格式（https://wq.wahlap.net/qrcode/req/）
    const isReqLink = trimmed.includes('https://wq.wahlap.net/qrcode/req/')
    // 检查是否为二维码图片链接格式（https://wq.wahlap.net/qrcode/img/）
    const isImgLink = trimmed.includes('https://wq.wahlap.net/qrcode/img/')
    const isLink = isReqLink || isImgLink
    const isSGID = trimmed.startsWith('SGWCMAID')
    
    // 如果是网页地址，提取MAID并转换为SGWCMAID格式
    if (isReqLink) {
      try {
        // 从URL中提取MAID部分：https://wq.wahlap.net/qrcode/req/MAID2601...55.html?...
        // 匹配 /qrcode/req/ 后面的 MAID 开头的内容（到 .html 或 ? 之前）
        const match = trimmed.match(/qrcode\/req\/(MAID[^?\.]+)/i)
        if (match && match[1]) {
          const maid = match[1]
          // 在前面加上 SGWC 变成 SGWCMAID...
          qrText = 'SGWC' + maid
          logger.info(`从网页地址提取MAID并转换: ${maid.substring(0, 20)}... -> ${qrText.substring(0, 24)}...`)
        } else {
          await session.send('⚠️ 无法从链接提取MAID，请发送 SGID 或有效链接')
          return { qrText: '', error: '无法从网页地址中提取MAID' }
        }
      } catch (error) {
        logger.warn('解析网页地址失败:', error)
        await session.send('⚠️ 链接格式错误，请发送 SGID 或有效链接')
        return { qrText: '', error: '网页地址格式错误' }
      }
    } else if (isImgLink) {
      try {
        // 从图片URL中提取MAID部分：https://wq.wahlap.net/qrcode/img/MAID260128205107...png?v
        // 匹配 /qrcode/img/ 后面的 MAID 开头的内容（到 .png 或 ? 之前）
        const match = trimmed.match(/qrcode\/img\/(MAID[^?\.]+)/i)
        if (match && match[1]) {
          const maid = match[1]
          // 在前面加上 SGWC 变成 SGWCMAID...
          qrText = 'SGWC' + maid
          logger.info(`从图片地址提取MAID并转换: ${maid.substring(0, 20)}... -> ${qrText.substring(0, 24)}...`)
        } else {
          await session.send('⚠️ 无法从图片链接提取MAID，请发送 SGID 或有效链接')
          return { qrText: '', error: '无法从图片地址中提取MAID' }
        }
      } catch (error) {
        logger.warn('解析图片地址失败:', error)
        await session.send('⚠️ 链接格式错误，请发送 SGID 或有效链接')
        return { qrText: '', error: '图片地址格式错误' }
      }
    } else if (!isSGID) {
      await session.send('⚠️ 请发送 SGID（SGWCMAID 开头）或有效链接')
      return { qrText: '', error: '无效格式，需 SGID 或链接' }
    }
    
    if (!qrText.startsWith('SGWCMAID')) {
      await session.send('❌ 格式错误，需以 SGWCMAID 开头')
      return { qrText: '', error: 'SGID格式错误' }
    }
    
    if (qrText.length < 48 || qrText.length > 128) {
      await session.send('❌ SGID 长度需在 48–128 字符')
      return { qrText: '', error: '二维码长度错误，应在48-128字符之间' }
    }
    
    logger.info(`✅ 接收到${isLink ? '链接地址（已转换）' : 'SGID'}: ${qrText.substring(0, 50)}...`)
    
    // 尝试撤回用户发送的消息（如果启用了自动撤回）
    await tryRecallMessage(session, ctx, config)

    if (tokenOnlyMode) {
      if (binding) {
        const patch: Record<string, unknown> = {
          lastQrCode: qrText,
          lastQrCodeTime: new Date(),
        }
        await ctx.database.set('maibot_bindings', { userId: binding.userId }, patch)
        logger.info(`Token 模式：已更新用户 ${binding.userId} 的 SGID 缓存`)
      }
      return { qrText }
    }

    const processingTracker = createBotMessageTracker(session, ctx, recallInteractive)
    await processingTracker.send('⏳ 正在处理，请稍候...')
    
    // 验证qrCode是否有效
    try {
      const preview = await api.getPreview(config.machineInfo?.clientId ?? '', qrText)
      if (preview.UserID === -1 || (typeof preview.UserID === 'string' && preview.UserID === '-1')) {
        await processingTracker.recall()
        return { qrText: '', error: '无效或过期的二维码' }
      }
      if (binding) {
        if (shouldVerifyBindingIdentity(binding, tokenOnlyMode)) {
          const vr = verifyPreviewMatchesBinding(binding, preview)
          const hv = await applyVerifyPreviewBinding(ctx, binding, vr, logger)
          if (hv.blocked) {
            await processingTracker.recall()
            return { qrText: '', error: hv.message }
          }
          if (hv.migrationNotice && !recallInteractive) await session.send(hv.migrationNotice)
        }
        const patch: Record<string, unknown> = {
          lastQrCode: qrText,
          lastQrCodeTime: new Date(),
          qrCode: qrText,
        }
        if (preview.UserName != null && !binding.boundPlayerName?.trim()) {
          patch.boundPlayerName = String(preview.UserName).trim()
        }
        await ctx.database.set('maibot_bindings', { userId: binding.userId }, patch)
        logger.info(`已更新用户 ${binding.userId} 的qrCode和缓存`)
      }
      
      await processingTracker.recall()
      return { qrText: qrText }
    } catch (error: any) {
      logger.error(`验证qrCode失败: ${sanitizeError(error)}`)
      await processingTracker.recall()
      return { qrText: '', error: `验证二维码失败：${getSafeErrorMessage(error, session)}` }
    }
  } catch (error: any) {
    logger.error(`等待用户输入二维码失败: ${error?.message}`, error)
    await tracker.recall()
    if (error.message?.includes('超时') || error.message?.includes('timeout') || error.message?.includes('未收到响应')) {
      return { qrText: '', error: '超时未收到响应' }
    }
    return { qrText: '', error: getSafeErrorMessage(error, session) }
  }
}

function qrOrLoginFailureHint(): string {
  return '请使用已绑定账号本人微信中的最新玩家二维码（SGID）重试；若需更换绑定账号，请在冷却结束后使用 /mai解绑，或在冷却期内使用 /mai解绑卡。'
}

export function apply(ctx: Context, config: Config) {
  const apiModeResolved = config.apiMode ?? 'team'
  const isPublicApi = apiModeResolved === 'public'
  const PUBLIC_API_UNAVAILABLE_MSG =
    '⚠️ 新版本仍然在开发中，暂时不提供相关接口。\n具体请加入 AWMC QQ 群获取更多信息：1072033605'
  if (isPublicApi) {
    if (!config.publicGatewayToken?.trim()) {
      ctx.logger('maibot').warn('[maibot] 公共 API 模式：新版本开发中，接口暂未启用')
    }
  } else {
    if (!config.machineInfo?.clientId?.trim()) {
      throw new Error('[maibot] 团队内部 API（apiMode: team）须完整配置 machineInfo')
    }
    if (!config.turnstileToken?.trim()) {
      throw new Error('[maibot] 团队内部 API 须配置 turnstileToken')
    }
  }

  // 扩展数据库
  extendDatabase(ctx)

  ctx.on('command/before-execute', async (argv) => {
    const sess = argv.session
    const cmd = argv.command
    if (sess && cmd) {
      const bag = sess as unknown as Record<string, unknown>
      try {
        bag[MAI_SESSION_CMD_USAGE_KEY] = await computeMaiCommandUsageHint(cmd, sess)
      } catch {
        bag[MAI_SESSION_CMD_USAGE_KEY] = ''
      }
    }
    if (
      sess &&
      cmd &&
      priorityCooldownCfg?.enabled &&
      isMaiPluginCommandName(String(cmd.name || ''))
    ) {
      try {
        await syncAuthorityAutoPriority(ctx, priorityCooldownCfg, sess, async (s) => getSessionBindingKeys(ctx, s))
      } catch (e) {
        logger.warn('管理员优先授权同步失败', e)
      }
    }
  })

  // Koishi 等框架在指令未捕获异常时可能只回复「发生未知错误」，此处附上当前指令用法
  ctx.on('before-send', (session: Session) => {
    const c = session.content
    if (typeof c === 'string') {
      const t = c.trim()
      if (t.length <= 200 && /^(发生未知错误\.?|未知错误\.?|An unknown error\.?)$/i.test(t)) {
        const extra = formatCommandUsageAppend(session)
        if (extra) session.content = `${c}${extra}`
      }
    }
  })

  // 初始化API客户端
  const api = new MaiBotAPI({
    baseURL: config.apiBaseURL,
    timeout: config.apiTimeout,
    retryCount: config.apiRetryCount,
    retryDelay: config.apiRetryDelay,
    apiStyle: isPublicApi ? 'public' : 'team',
    bearerToken: isPublicApi ? config.publicGatewayToken?.trim() : undefined,
  })
  const logger = ctx.logger('maibot')
  logger.info(
    `API 模式: ${isPublicApi ? 'public（AWMC 网关）' : 'team（自建服务）'}，根地址: ${config.apiBaseURL}`,
  )

  ctx.on('ready', async () => {
    try {
      const cleared = await purgeInvalidLxnsBindings(ctx)
      if (cleared > 0) {
        logger.info(
          `已自动清除 ${cleared} 条旧版落雪好友码绑定，请用户使用 Token 重新 /mai绑定落雪（${LXNS_TOKEN_HINT_URL}）`,
        )
      }
    } catch (e) {
      logger.warn('启动时清除旧版落雪绑定失败', e)
    }
  })

  function rebindShopUrl(): string {
    const fromPolicy = config.rebindPolicy?.shopUrl?.trim()
    if (fromPolicy) return fromPolicy
    return (
      config.priorityCooldown?.shopUrl ||
      'https://ifdian.net/a/AWMC_TEAM?tab=shop'
    )
  }

  async function touchRebindClock(userId: string): Promise<void> {
    const prev = await ctx.database.get('maibot_user_rebind_state', { userId })
    if (prev.length) {
      await ctx.database.set('maibot_user_rebind_state', { userId }, { lastBindChangeAt: new Date() })
    } else {
      await ctx.database.create('maibot_user_rebind_state', { userId, lastBindChangeAt: new Date() })
    }
  }

  async function getRebindWaitMsForBinding(binding: UserBinding): Promise<number> {
    const minDays = config.rebindPolicy?.minDaysBetweenBindChange ?? 30
    const stateRows = await ctx.database.get('maibot_user_rebind_state', { userId: binding.userId })
    const stateMs = stateRows[0]?.lastBindChangeAt ? new Date(stateRows[0].lastBindChangeAt).getTime() : 0
    const bindMs = new Date(binding.bindTime).getTime()
    return msUntilBindChangeAllowed(stateMs, bindMs, minDays)
  }

  async function formatAlreadyBoundMessage(existing: UserBinding): Promise<string> {
    const waitMs = await getRebindWaitMsForBinding(existing)
    const bindStr = new Date(existing.bindTime).toLocaleString('zh-CN')
    const shop = rebindShopUrl()
    const credits = existing.unbindCredits ?? 0
    if (waitMs > 0) {
      return (
        `❌ 您已经绑定了账号\n` +
        `绑定时间: ${bindStr}\n` +
        (credits > 0 ? `解绑卡额度: ${credits} 次\n` : '') +
        `\n如需重新绑定，请等待约 ${formatBindChangeWaitHuman(waitMs)}。或前往 ${shop} 购买解绑卡。\n` +
        `冷却期内请使用 /maiunbindkey 或 /mai解绑卡（按提示发送 SGID 并二次确认）。`
      )
    }
    return (
      `❌ 您已经绑定了账号\n` +
      `绑定时间: ${bindStr}\n` +
      (credits > 0 ? `解绑卡额度: ${credits} 次\n` : '') +
      `\n您已超过换绑冷却期，可直接使用 /mai解绑 后重新绑定。`
    )
  }

  // 初始化发票 Bot 侧队列（仅 /mai发票 使用）
  const queueConfig = config.queue || { enabled: false, interval: 10000, message: '⏳ 发票排队中，前面还有 {queuePosition} 人，预计等待 {queueEST} 秒。' }
  const chargeRequestQueue = queueConfig.enabled ? new RequestQueue(queueConfig.interval) : null

  // 操作记录配置
  const operationLogConfig = config.operationLog || { enabled: true, refIdLabel: 'Ref_ID' }
  const replyInGroupEnabled = config.replyInGroup !== false
  const chargePollIntervalMs = config.chargePollInterval ?? 3000
  const chargePollTimeoutMs = config.chargePollTimeout ?? 180000

  // 错误帮助URL配置
  const errorHelpUrl = config.errorHelpUrl || ''

  const priorityCooldownCfg = config.priorityCooldown
  const authLevelForCardAdmin = config.authLevelForCardAdmin ?? 4

  async function getCooldownPrimaryUserId(session: Session): Promise<string> {
    const keys = await getSessionBindingKeys(ctx, session)
    return keys[0] || String(session.userId || '')
  }

  ctx.on('command/before-execute', async (argv) => {
    const sess = argv.session
    const cmd = argv.command
    if (!sess || !cmd || !replyInGroupEnabled || !sess.guildId) return
    if (!isMaiPluginCommandName(String(cmd.name || ''))) return
    try {
      const user = await sess.observeUser(['id'])
      if (user?.id != null) {
        ;(sess as unknown as Record<string, unknown>)[MAI_TRIGGER_USER_ID] = String(user.id)
      }
    } catch {
      // bind 插件不可用时回退 session.userId / author
    }
    prepareGroupReplySession(sess, true)
    enableGuildReplyOnSession(sess, true)
  })

  ctx.on('command/before-execute', async (argv) => {
    const sess = argv.session
    const cmd = argv.command
    if (!sess || !cmd) return
    const cmdName = String(cmd.name || '')
    if (!priorityCooldownCfg?.enabled) return
    if (!isMaiPluginCommandName(cmdName)) return
    if (commandToCooldownSlot(cmdName) === null) return
    const wl = checkWhitelist(sess, config, isDebugSession(sess))
    if (!wl.allowed) return

    // 调试群完全跳过冷却 / 拦截
    if (isDebugSession(sess)) {
      debugLog(sess, `跳过冷却检查（调试群）：${cmdName}`)
      return
    }

    // 获取当前用户绑定的 maiUid（用于共享冷却）
    let sessionMaiUid: string | undefined
    try {
      const binding = await getBindingBySession(ctx, sess)
      if (binding?.maiUid) sessionMaiUid = binding.maiUid
    } catch { /* 忽略 */ }

    // 超过2个绑定时拦截有冷却的命令
    if (sessionMaiUid) {
      const sameUidBindings = await ctx.database.get('maibot_bindings', { maiUid: sessionMaiUid })
      if (sameUidBindings.length > 2) {
        return `❌ 您的游戏账号已被 ${sameUidBindings.length} 个用户绑定，请先解绑多余账号后再使用此功能。\n（使用 /mai解绑 解绑当前账号）`
      }
    }

    const hit = await checkCommandCooldown(
      ctx,
      sess,
      priorityCooldownCfg,
      cmdName,
      getCooldownPrimaryUserId,
      async (s) => getSessionBindingKeys(ctx, s),
      sessionMaiUid,
    )
    if (hit) return hit
    const uid = await getCooldownPrimaryUserId(sess)
    if (!uid) return
    await recordCommandCooldown(ctx, uid, cmdName, priorityCooldownCfg, sessionMaiUid)
  })

  const B50_COMMAND_MAPPING: Record<string, string> = {
    'mai上传B50-任务完成': 'mai上传B50',
    'mai上传B50-任务超时': 'mai上传B50',
    'mai上传B50-轮询异常': 'mai上传B50',
    'maiua-水鱼B50': 'mai上传B50',
    'maiua-落雪B50': 'mai上传落雪b50',
    'mai上传落雪b50-任务完成': 'mai上传落雪b50',
    'mai上传落雪b50-任务超时': 'mai上传落雪b50',
    'mai上传落雪b50-轮询异常': 'mai上传落雪b50',
  }

  function formatB50DurationSec(sec: number): string {
    if (sec < 60) return `约 ${Math.max(1, Math.round(sec))} 秒`
    const min = Math.floor(sec / 60)
    const remainder = Math.round(sec % 60)
    if (remainder === 0) return `约 ${min} 分钟`
    return `约 ${min} 分 ${remainder} 秒`
  }

  interface B50UploadStatsData {
    avgDurationSec: number
    durationSamples: number
    successCount: number
    totalCount: number
  }

  /** 采集今日 B50 上传统计（同步 + 异步任务） */
  async function collectB50UploadStats(commandPrefixes: string[]): Promise<B50UploadStatsData> {
    const prefixSet = new Set(commandPrefixes)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const todayStart = today.getTime()
    const pollTimeoutSec = (config.b50PollTimeout ?? 600000) / 1000

    const allLogs = await ctx.database.get('maibot_operation_logs', {})
    const todayLogs = allLogs.filter(log => {
      const logTime = new Date(log.createdAt).getTime()
      if (logTime < todayStart) return false
      const mapped = B50_COMMAND_MAPPING[log.command] || log.command
      return prefixSet.has(mapped)
    })

    const allSubmitLogs = todayLogs.filter(log => {
      const mapped = B50_COMMAND_MAPPING[log.command] || log.command
      return prefixSet.has(mapped) && !log.command.includes('-任务')
    })
    const allCompleteLogs = todayLogs.filter(log =>
      log.command.includes('-任务完成')
      || log.command.includes('-任务超时')
      || log.command.includes('-轮询异常'),
    )
    const successCompleteLogs = todayLogs.filter(log =>
      log.command.includes('-任务完成') && log.status === 'success',
    )

    let durationSum = 0
    let durationSamples = 0

    for (const submitLog of allSubmitLogs.filter(log => log.status === 'success')) {
      if (!submitLog.apiResponse) continue
      try {
        const response = JSON.parse(submitLog.apiResponse)
        if (typeof response.elapsedMs === 'number' && response.elapsedMs > 0) {
          const sec = response.elapsedMs / 1000
          if (sec < pollTimeoutSec) {
            durationSum += sec
            durationSamples++
          }
          continue
        }
        const taskId = response.task_id
        if (!taskId) continue
        const completeLog = successCompleteLogs.find(log => {
          if (!log.apiResponse) return false
          try {
            const completeResponse = JSON.parse(log.apiResponse)
            return completeResponse.alive_task_id === taskId
              || String(completeResponse.alive_task_id) === String(taskId)
          } catch {
            return false
          }
        })
        if (completeLog) {
          const duration = (new Date(completeLog.createdAt).getTime() - new Date(submitLog.createdAt).getTime()) / 1000
          if (duration > 0 && duration < pollTimeoutSec) {
            durationSum += duration
            durationSamples++
          }
        }
      } catch {
        continue
      }
    }

    const syncSubmitLogs = allSubmitLogs.filter(log => {
      if (!log.apiResponse) return true
      try {
        const response = JSON.parse(log.apiResponse)
        return response.sync === true || !response.task_id
      } catch {
        return true
      }
    })

    let successCount = syncSubmitLogs.filter(log => log.status === 'success').length
    let totalCount = syncSubmitLogs.length

    for (const log of allSubmitLogs) {
      if (syncSubmitLogs.includes(log)) continue
      if (log.status !== 'success') {
        totalCount++
      }
    }

    totalCount += allCompleteLogs.length
    successCount += successCompleteLogs.length

    return {
      avgDurationSec: durationSamples > 0 ? durationSum / durationSamples : 0,
      durationSamples,
      successCount,
      totalCount,
    }
  }

  async function getB50UploadStatsHint(commandPrefixes: string | string[]): Promise<{
    estimatedFinishText?: string
    successRateText?: string
  }> {
    try {
      const prefixes = Array.isArray(commandPrefixes) ? commandPrefixes : [commandPrefixes]
      const stats = await collectB50UploadStats(prefixes)
      const hint: { estimatedFinishText?: string; successRateText?: string } = {}
      if (stats.durationSamples > 0 && stats.avgDurationSec > 0) {
        hint.estimatedFinishText = formatB50DurationSec(stats.avgDurationSec)
      }
      if (stats.totalCount > 0) {
        hint.successRateText = `${((stats.successCount / stats.totalCount) * 100).toFixed(1)}%`
      }
      return hint
    } catch (error) {
      logger.warn(`获取 B50 统计提示失败: ${sanitizeError(error)}`)
      return {}
    }
  }

  /**
   * 获取上传任务的统计信息（管理员统计用）
   */
  async function getUploadStats(commandPrefix: string, showDetails: boolean = false): Promise<string> {
    try {
      const stats = await collectB50UploadStats([commandPrefix])
      const parts: string[] = []
      if (stats.durationSamples > 0 && stats.avgDurationSec > 0) {
        parts.push(`平均处理用时 ${stats.avgDurationSec.toFixed(1)} s`)
      }
      if (stats.totalCount > 0) {
        const rate = ((stats.successCount / stats.totalCount) * 100).toFixed(1)
        parts.push(showDetails
          ? `成功率 ${rate}% (${stats.successCount}/${stats.totalCount})`
          : `成功率 ${rate}%`)
      }
      return parts.join('，')
    } catch (error) {
      logger.warn(`获取上传统计信息失败: ${sanitizeError(error)}`)
      return ''
    }
  }

  /**
   * 发送消息并返回消息ID（用于后续撤回）
   * @param session 会话
   * @param content 消息内容
   * @returns 消息ID数组
   */
  async function sendAndGetMessageIds(session: Session, content: string): Promise<string[]> {
    try {
      const result = await session.send(content)
      // session.send 返回消息ID数组
      if (Array.isArray(result)) {
        return result.filter(id => id && typeof id === 'string')
      }
      return []
    } catch (err) {
      logger.debug(`发送消息失败: ${err}`)
      return []
    }
  }

  /**
   * 获取错误帮助信息（如果配置了帮助URL）
   */
  function getErrorHelpInfo(): string {
    if (!errorHelpUrl) {
      return ''
    }
    return `\n\n如有问题，请前往 ${errorHelpUrl} 提问`
  }

  /**
   * 生成唯一的 ref_id
   */
  function generateRefId(): string {
    const timestamp = Date.now().toString(36)
    const random = Math.random().toString(36).substring(2, 9)
    return `${timestamp}-${random}`.toUpperCase()
  }

  /**
   * 记录操作日志
   */
  async function logOperation(params: {
    command: string
    session: Session
    targetUserId?: string
    status: 'success' | 'failure' | 'error'
    result?: string
    errorMessage?: string
    apiResponse?: any
  }): Promise<string> {
    if (!operationLogConfig.enabled) {
      return ''
    }

    const refId = generateRefId()
    try {
      await ctx.database.create('maibot_operation_logs', {
        refId,
        command: params.command,
        userId: params.session.userId || '',
        targetUserId: params.targetUserId,
        guildId: params.session.guildId || undefined,
        channelId: params.session.channelId || undefined,
        status: params.status,
        result: params.result,
        errorMessage: params.errorMessage,
        apiResponse: params.apiResponse ? JSON.stringify(params.apiResponse) : undefined,
        createdAt: new Date(),
      })
    } catch (error: any) {
      logger.warn(`记录操作日志失败: ${error?.message || '未知错误'}`)
    }
    return refId
  }

  /**
   * 在结果消息中添加 Ref_ID
   */
  function appendRefId(message: string, refId: string): string {
    if (!refId || !operationLogConfig.enabled) {
      return message
    }
    const label = operationLogConfig.refIdLabel || 'Ref_ID'
    return `${message}\n${label}: ${refId}`
  }

  /**
   * 发送处理中提示（可撤回）
   */
  async function sendProcessingNotice(session: Session, message: string): Promise<string[]> {
    try {
      return await sendAndGetMessageIds(session, message)
    } catch (err) {
      logger.warn('发送处理中提示失败:', err)
      return []
    }
  }

  async function buildB50ProcessingMessage(commandPrefixes: string | string[]): Promise<string> {
    const lines = ['⏳ 正在上传 B50，预计 0-2 分钟，请勿重复提交。']
    const hint = await getB50UploadStatsHint(commandPrefixes)
    if (hint.estimatedFinishText) {
      lines.push(`预计完成时间：${hint.estimatedFinishText}`)
    }
    if (hint.successRateText) {
      lines.push(`成功率：${hint.successRateText}`)
    }
    return lines.join('\n')
  }

  /** B50 上传前发送一次处理提示（含可选统计行） */
  async function sendB50ProcessingNotice(session: Session, commandPrefixes: string | string[]): Promise<string[]> {
    return sendProcessingNotice(session, await buildB50ProcessingMessage(commandPrefixes))
  }

  /**
   * /mai发票 调用前：Bot 侧发票队列限流
   */
  async function waitForChargeQueue(session: Session): Promise<string[]> {
    const sentMessageIds: string[] = []

    if (!chargeRequestQueue) {
      return sentMessageIds
    }

    if (isDebugSession(session)) {
      debugLog(session, '跳过发票队列（调试群）')
      return sentMessageIds
    }

    if (!session.userId || !session.channelId) {
      logger.warn('无法加入发票队列：缺少 userId 或 channelId')
      return sentMessageIds
    }

    const currentQueueLength = chargeRequestQueue.getQueuePosition()
    const isProcessing = chargeRequestQueue.isProcessing()
    const timeSinceLastProcess = Date.now() - chargeRequestQueue.getLastProcessTime()
    const needsQueue = currentQueueLength > 0 ||
      isProcessing ||
      timeSinceLastProcess < chargeRequestQueue.getInterval()

    if (needsQueue) {
      const queuePosition = currentQueueLength + 1
      const estimatedWait = chargeRequestQueue.getEstimatedWaitTimeForPosition(queuePosition)
      const queueMessage = queueConfig.message
        .replace(/{queuePosition}/g, String(queuePosition))
        .replace(/{queueEST}/g, String(estimatedWait))
      try {
        const msgIds = await sendAndGetMessageIds(session, queueMessage)
        sentMessageIds.push(...msgIds)
      } catch (err) {
        logger.warn('发送发票队列提示失败:', err)
      }
    } else {
      try {
        const msgIds = await sendAndGetMessageIds(session, '⏳ 正在提交发票充值任务…')
        sentMessageIds.push(...msgIds)
      } catch (err) {
        logger.warn('发送发票处理提示失败:', err)
      }
    }

    try {
      await chargeRequestQueue.enqueue(session.userId, session.channelId)
    } catch (error: any) {
      logger.warn(`加入发票队列失败: ${error?.message || '未知错误'}`)
    }

    return sentMessageIds
  }

  // 自动撤回仅在交互式输入或命令参数触发

  // 插件运行状态标志，用于在插件停止后阻止新的请求
  let isPluginActive = true
  ctx.on('dispose', () => {
    isPluginActive = false
    logger.info('插件已停止，将不再执行新的定时任务')
    if (chargeRequestQueue) {
      chargeRequestQueue.close('插件已停止，发票队列已关闭')
    }
  })

  // 登录播报功能已移除

  // 使用配置中的值（public 模式下 machineInfo 为占位，仅供类型兼容；网关请求不携带这些字段）
  const machineInfo: MachineInfo =
    config.machineInfo ?? {
      clientId: '',
      regionId: 0,
      placeId: 0,
      placeName: '',
      regionName: '',
    }
  const turnstileToken = config.turnstileToken ?? ''
  const maintenanceNotice = config.maintenanceNotice
  const confirmTimeout = config.confirmTimeout ?? 10000
  const rebindTimeout = config.rebindTimeout ?? 60000  // 默认60秒
  const termsPolicy = config.termsPolicy ?? {
    url: 'https://wiki.awmc.cc/guide/bot/terms',
    acceptText:
      '我已认真阅读网页中的服务说明，并已了解AWMC服务可能带来的风险。我了解因使用本服务，造成舞萌DX官方账号遭到封禁，责任和AWMC无关。我确认发送二维码可能会对我的账号产生安全影响，并愿意接受这样的风险。在阅读说明后，我同意上述协议。',
    version: '2.0.0',
  }
  const autoRecallInteractive = config.autoRecallInteractiveMessages !== false
  const tokenOnlyModeEnabled = config.tokenOnlyMode === true
  const TOKEN_ONLY_MODE_BLOCKED_MSG =
    '⚠️ 当前为 Token 直连模式，仅支持：\n' +
    '· /mai绑定水鱼 /mai解绑水鱼\n' +
    '· /mai绑定落雪 /mai解绑落雪\n' +
    '· /mai上传B50 /mai上传落雪b50 /maiua\n' +
    '· /mai发票'
  const DX_BIND_REQUIRED_MSG =
    '❌ 请先完成舞萌DX账号绑定（/mai绑定）。您的水鱼/落雪 Token 已保留。'
  const BETA_VERSION_NOTICE =
    '⚠️ 本机器人目前处于测试阶段，部分功能不代表最终效果，可能存在变动或异常。'
  const betaNoticeConfig = config.betaNotice ?? { enabled: true, version: '2.0.0' }
  const betaNoticeEnabled = betaNoticeConfig.enabled !== false
  const BETA_NOTICE_VERSION = betaNoticeConfig.version || '2.0.0'
  const TOKEN_ONLY_BIND_HINT =
    '❌ 请先绑定水鱼或落雪 Token\n使用 /mai绑定水鱼 或 /mai绑定落雪'
  const authLevelForProxy = config.authLevelForProxy ?? 3
  const protectionLockMessage = config.protectionLockMessage ?? '🛡️ 保护模式：{playerid}{at} 你的账号已自动锁定成功'
  const maintenanceMode = config.maintenanceMode ?? false
  const maintenanceMessage = config.maintenanceMessage ?? '⚠️  Milk Server Studio 正在进行维护。具体清查阅 https://awmc.cc/'
  const hideLockAndProtection = config.hideLockAndProtection ?? false
  const enableMaimile = config.enableMaimile ?? false
  const debugConfig = config.debug || { enabled: false, groupIds: ['onebot:1094443807'] }
  const debugEnabled = debugConfig.enabled === true
  const debugGroupSet = new Set((debugConfig.groupIds || []).map(s => String(s || '').trim()).filter(Boolean))

  /** 当前会话是否在调试群内（且调试模式已开启） */
  function isDebugSession(session: Session | null | undefined): boolean {
    if (!debugEnabled || !session) return false
    if (!session.guildId) return false
    const platform = String(session.platform || '').trim().toLowerCase()
    const guildId = String(session.guildId || '').trim()
    const channelId = String(session.channelId || '').trim()
    const candidates = [
      guildId,
      platform ? `${platform}:${guildId}` : '',
      channelId,
      platform && channelId ? `${platform}:${channelId}` : '',
    ].filter(Boolean)
    return candidates.some(c => debugGroupSet.has(c))
  }

  /** 调试日志（仅在调试模式生效） */
  function debugLog(session: Session | null | undefined, label: string, data?: any): void {
    if (!isDebugSession(session)) return
    const prefix = `[DEBUG ${session?.platform || ''}:${session?.guildId || ''}/${session?.userId || ''}]`
    if (data === undefined) {
      logger.info(`${prefix} ${label}`)
    } else {
      try {
        const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
        logger.info(`${prefix} ${label}\n${text}`)
      } catch {
        logger.info(`${prefix} ${label} ${String(data)}`)
      }
    }
  }

  /** 调试群里给失败消息附加详细诊断信息（API 返回原文）；非调试群返回空串 */
  function debugDetailSuffix(session: Session | null | undefined, payload: any): string {
    if (!isDebugSession(session)) return ''
    try {
      const json = JSON.stringify(payload, null, 2)
      // 防止过长消息被截断
      const trimmed = json.length > 1500 ? json.slice(0, 1500) + '\n...(truncated)' : json
      return `\n\n[DEBUG] 服务器返回原文：\n${trimmed}`
    } catch {
      return `\n\n[DEBUG] 服务器返回原文：${String(payload)}`
    }
  }
  // 暴露给后续逻辑使用（避免未使用警告）
  void debugLog
  void debugDetailSuffix

  // 调试模式开启时，给 API 客户端注入请求/响应日志钩子
  if (debugEnabled) {
    api.debugLogger = (tag, payload, _fromDebugSession) => {
      let text: string
      try {
        text = JSON.stringify(payload, null, 2)
      } catch {
        text = String(payload)
      }
      logger.info(`[DEBUG API] ${tag}\n${text}`)

      // 调试模式开启时，所有 API 日志都发到调试群
      if (debugGroupSet.size === 0) return

      const truncated = text.length > 1500 ? text.slice(0, 1500) + '\n...(truncated)' : text
      const msg = `[DEBUG API] ${tag}\n${truncated}`
      for (const groupKey of debugGroupSet) {
        let platform = ''
        let guildId = groupKey
        const colonIdx = groupKey.indexOf(':')
        if (colonIdx > 0) {
          platform = groupKey.slice(0, colonIdx)
          guildId = groupKey.slice(colonIdx + 1)
        }
        const candidates = platform
          ? ctx.bots.filter(b => String(b.platform || '').toLowerCase() === platform.toLowerCase())
          : [...ctx.bots]
        for (const bot of candidates) {
          try {
            void bot.sendMessage(guildId, msg).catch(() => { /* 忽略 */ })
          } catch { /* 忽略 */ }
        }
      }
    }
    logger.info('🔧 调试模式已开启，调试群：' + [...debugGroupSet].join(', '))
  }

  // 创建使用配置的 promptYes 函数
  const promptYesWithConfig = async (session: Session, message: string, timeout?: number): Promise<boolean> => {
    const actualTimeout = timeout ?? confirmTimeout
    const tracker = createBotMessageTracker(session, ctx, autoRecallInteractive)
    await tracker.send(`${message}\n在${actualTimeout / 1000}秒内输入 Y 确认，其它输入取消`)
    try {
      const answer = await session.prompt(actualTimeout)
      await tracker.recall()
      return answer?.trim().toUpperCase() === 'Y'
    } catch {
      await tracker.recall()
      return false
    }
  }

  // 在 apply 函数内部使用 promptYesWithConfig 替代 promptYes
  // 为了简化，我们将直接修改所有调用，使用 promptYesWithConfig
  const promptYesLocal = promptYesWithConfig

  /**
   * 检查维护模式并返回相应的消息
   * 如果维护模式开启，返回维护消息；否则返回原始消息
   */
  function getMaintenanceModeMessage(originalMessage?: string): string {
    if (maintenanceMode) {
      return maintenanceMessage
    }
    return originalMessage || ''
  }

  // 维护模式中间件：拦截所有 maibot 插件的命令
  // 注意：使用 before('command') 来确保不会拦截所有消息
  ctx.middleware(async (session, next) => {
    if (!maintenanceMode) {
      return next()
    }

    // 调试群跳过维护拦截
    if (isDebugSession(session)) {
      return next()
    }
    
    // 检查是否是 maibot 插件的命令（所有 mai 开头的命令）
    if (isMaiUserMessage(session)) {
      return maintenanceMessage
    }
    
    return next()
  }, true) // 设置为 true 使其在早期执行，但不影响普通消息

  const TERMS_ACCEPT_TEXT = termsPolicy.acceptText
  const TERMS_VERSION = termsPolicy.version || '2.0.0'

  async function hasAcceptedTerms(userId: string): Promise<boolean> {
    if (!userId) return false
    const rows = await ctx.database.get('maibot_user_terms', { userId })
    if (rows.length === 0) return false
    const row = rows[0]
    const acceptedVersion = row.termsVersion || '1.0.0'
    return acceptedVersion === TERMS_VERSION
  }

  async function saveTermsAccepted(userId: string): Promise<void> {
    const existing = await ctx.database.get('maibot_user_terms', { userId })
    if (existing.length === 0) {
      await ctx.database.create('maibot_user_terms', {
        userId,
        acceptedAt: new Date(),
        termsVersion: TERMS_VERSION,
      })
    } else {
      await ctx.database.set('maibot_user_terms', { userId }, {
        acceptedAt: new Date(),
        termsVersion: TERMS_VERSION,
      })
    }
  }

  async function clearTermsAccepted(userId: string): Promise<void> {
    if (!userId) return
    await ctx.database.remove('maibot_user_terms', { userId })
  }

  async function hasAcknowledgedBeta(userId: string): Promise<boolean> {
    if (!betaNoticeEnabled) return true
    if (!userId) return false
    const rows = await ctx.database.get('maibot_user_terms', { userId })
    if (rows.length === 0) return false
    return rows[0].betaNoticeVersion === BETA_NOTICE_VERSION
  }

  async function saveBetaAcknowledged(userId: string): Promise<void> {
    const existing = await ctx.database.get('maibot_user_terms', { userId })
    if (existing.length === 0) {
      await ctx.database.create('maibot_user_terms', {
        userId,
        acceptedAt: new Date(),
        betaNoticeVersion: BETA_NOTICE_VERSION,
      })
    } else {
      await ctx.database.set('maibot_user_terms', { userId }, {
        betaNoticeVersion: BETA_NOTICE_VERSION,
      })
    }
  }

  function prependBetaNotice(text: string): string {
    if (!betaNoticeEnabled) return text
    return `${BETA_VERSION_NOTICE}\n\n${text}`
  }

  /** V2 数据迁移中间件：老用户需确认迁移，拒绝则无法继续使用 */
  ctx.middleware(async (session, next) => {
    if (!isMaiUserMessage(session)) {
      return next()
    }

    if (isDebugSession(session)) {
      return next()
    }

    const baseCmd = getMaiCommandName(session)
    if (baseCmd === 'mai' || baseCmd === 'mai帮助' || baseCmd === 'maiping' || baseCmd === 'maiSGID获取' || baseCmd === 'SGID获取') {
      return next()
    }

    const keys = await getSessionBindingKeys(ctx, session)
    const canonicalUserId = await getCanonicalV2UserId(session)
    if (!canonicalUserId) {
      return next()
    }

    const migrationTargetId = isV2UserIdFormat(canonicalUserId)
      ? canonicalUserId
      : keys.find(k => isV2UserIdFormat(k)) || canonicalUserId

    if (await hasCompletedV2Migration(ctx, migrationTargetId)) {
      return next()
    }

    const legacyData = await hasAnyMaibotUserData(ctx, keys)
    if (!legacyData) {
      await markV2MigrationComplete(ctx, migrationTargetId)
      return next()
    }

    const tracker = createBotMessageTracker(session, ctx, autoRecallInteractive)
    await tracker.send(V2_MIGRATION_PROMPT)

    const replySession = await waitForUserReply(session, ctx, 60000, tracker.messageIds())
    await tracker.recall()
    const reply = replySession?.content?.trim() || ''
    if (!reply) {
      return '❌ 迁移确认超时，操作已取消'
    }
    const decision = parseMigrationConfirm(reply)
    if (decision === 'no') {
      return '❌ 您已取消数据迁移，无法继续使用 maiBot V2。如需使用请重新发起指令并选择【是】。'
    }
    if (decision !== 'yes') {
      return '❌ 请输入【是】或【否】以确认是否迁移数据'
    }

    await tracker.send(V2_MIGRATION_CONFIRM_PROMPT)
    const confirmSession = await waitForUserReply(session, ctx, 60000, tracker.messageIds())
    await tracker.recall()
    const confirmReply = confirmSession?.content?.trim() || ''
    if (!confirmReply) {
      return '❌ 迁移确认超时，操作已取消'
    }
    const confirmDecision = parseMigrationConfirm(confirmReply)
    if (confirmDecision === 'no') {
      return '❌ 您已取消数据迁移，无法继续使用 maiBot V2。如需使用请重新发起指令并选择【是】。'
    }
    if (confirmDecision !== 'yes') {
      return '❌ 请输入【是】或【否】以确认是否同意变更并完成迁移'
    }

    try {
      if (isV2UserIdFormat(migrationTargetId)) {
        await performV2UserMigration(ctx, migrationTargetId, keys)
      } else {
        await ctx.database.remove('maibot_user_terms', { userId: migrationTargetId })
        await clearLegacyLxnsBinding(ctx, migrationTargetId)
        await markV2MigrationComplete(ctx, migrationTargetId)
      }
    } catch (error) {
      logger.warn('V2 数据迁移执行失败:', error)
      return '❌ 数据迁移失败，请稍后重试或联系管理员'
    }
    return '✅ 数据已迁移至 maiBot V2。落雪好友码绑定已清除，请使用落雪 Token 重新绑定。请重新确认用户协议后再使用其他功能。'
  }, true)

  /** public 模式：接口暂未开放，仅允许帮助/卡密/管理员等本地指令 */
  ctx.middleware(async (session, next) => {
    if (!isPublicApi) return next()
    if (!isMaiUserMessage(session)) return next()
    if (isDebugSession(session)) return next()

    const baseCmd = getMaiCommandName(session)
    const publicApiExempt = new Set([
      'mai', 'mai帮助', 'mai兑换卡密', 'maiSGID获取', 'SGID获取',
    ])
    if (
      publicApiExempt.has(baseCmd)
      || baseCmd.startsWith('mai管理员')
      || baseCmd === 'maibypass'
    ) {
      return next()
    }
    return PUBLIC_API_UNAVAILABLE_MSG
  }, true)

  /** Token 直连模式：按 canonical 指令名拦截（兼容 Koishi 别名） */
  ctx.on('command/before-execute', async (argv) => {
    if (!tokenOnlyModeEnabled) return
    const sess = argv.session
    const cmd = argv.command
    if (!sess || !cmd) return
    if (isDebugSession(sess)) return
    const cmdName = String(cmd.name || '')
    if (!isMaiPluginCommandName(cmdName)) return
    if (isTokenOnlyAllowedCommand(cmdName)) return
    return TOKEN_ONLY_MODE_BLOCKED_MSG
  })

  // 测试阶段警示：协议确认后、首次使用功能前须确认
  ctx.middleware(async (session, next) => {
    if (!betaNoticeEnabled) {
      return next()
    }

    if (!isMaiUserMessage(session)) {
      return next()
    }

    if (isDebugSession(session)) {
      return next()
    }

    const baseCmd = getMaiCommandName(session)
    const betaExempt = new Set(['mai', 'mai帮助', 'maiping', 'maiqueue', 'mai兑换卡密', 'maiSGID获取', 'SGID获取'])
    if (betaExempt.has(baseCmd) || baseCmd.startsWith('mai管理员') || baseCmd === 'maibypass') {
      return next()
    }

    const canonicalUserId = await getCanonicalV2UserId(session)
    const keys = await getSessionBindingKeys(ctx, session)
    const primaryUserId = canonicalUserId || keys[0] || String(session.userId || '')
    if (!primaryUserId) {
      return next()
    }

    if (!(await hasCompletedV2Migration(ctx, primaryUserId))) {
      return next()
    }

    if (await hasAcknowledgedBeta(primaryUserId)) {
      return next()
    }

    const accepted = await promptYesLocal(
      session,
      `${BETA_VERSION_NOTICE}\n\n请确认您已知晓上述说明。`,
      60000,
    )
    if (!accepted) {
      return '❌ 未确认测试阶段提示，操作已取消'
    }

    await saveBetaAcknowledged(primaryUserId)
    return next()
  }, true)

  // 用户协议中间件：拦截 mai 指令，要求用户浏览协议页并输入确认词
  ctx.middleware(async (session, next) => {
    if (!isMaiUserMessage(session)) {
      return next()
    }

    if (isDebugSession(session)) {
      return next()
    }

    const baseCmd = getMaiCommandName(session)
    const termsExempt = new Set(['mai', 'mai帮助', 'maiping', 'maiqueue', 'mai兑换卡密', 'maiSGID获取', 'SGID获取'])
    if (termsExempt.has(baseCmd) || baseCmd.startsWith('mai管理员') || baseCmd === 'maibypass') {
      return next()
    }

    const canonicalUserId = await getCanonicalV2UserId(session)
    const keys = await getSessionBindingKeys(ctx, session)
    const primaryUserId = canonicalUserId || keys[0] || String(session.userId || '')
    if (!primaryUserId) {
      return next()
    }

    if (!(await hasCompletedV2Migration(ctx, primaryUserId))) {
      return next()
    }

    if (await hasAcceptedTerms(primaryUserId)) {
      return next()
    }

    const tracker = createBotMessageTracker(session, ctx, autoRecallInteractive)
    await tracker.send(
      '📋 使用前请先阅读AWMC项目maiBot的服务协议：\n' +
      'https://wiki.awmc.cc/guide/bot/terms\n' +
      'https://wiki.awmc.team/guide/bot/terms\n\n\n' +
      '请打开上述链接，阅读网页中的服务说明后，在 60 秒内完整输入网页中的提示词来确认。\n' +
      '请仔细阅读。',
    )

    const replySession = await waitForUserReply(session, ctx, 60000, tracker.messageIds())
    await tracker.recall()
    const replyText = (replySession?.content || '').trim()
    if (!replyText) {
      return '❌ 确认超时，操作已取消'
    }
    if (replyText === TERMS_ACCEPT_TEXT) {
      await saveTermsAccepted(primaryUserId)
      return next()
    }
    return '❌ 未输入正确的提示词，操作已取消'
  }, true)

  /**
   * 群聊：mai 指令回复引用原消息并 @ 发送者（包装 session.send，含交互提示与命令返回值）。
   */
  ctx.middleware(async (session, next) => {
    if (!isMaiUserMessage(session)) return next()
    prepareGroupReplySession(session, replyInGroupEnabled)
    enableGuildReplyOnSession(session, replyInGroupEnabled)
    try {
      return await next()
    } finally {
      disableGuildReplyOnSession(session)
    }
  }, true)

  /**
   * 从文本中提取用户ID（支持@userid格式、<at id="数字"/>格式或直接userid）
   */
  function extractUserId(text: string | undefined): string | null {
    if (!text) return null
    const trimmed = text.trim()
    
    // 尝试匹配 <at id="数字"/> 格式
    const atMatch = trimmed.match(/<at\s+id=["'](\d+)["']\s*\/?>/i)
    if (atMatch && atMatch[1]) {
      logger.debug(`从 @mention 标签中提取到用户ID: ${atMatch[1]}`)
      return atMatch[1]
    }
    
    // 移除@符号和空格，然后提取所有数字
    const cleaned = trimmed.replace(/^@/, '').trim()
    
    // 如果只包含数字，直接返回
    if (/^\d+$/.test(cleaned)) {
      logger.debug(`提取到纯数字用户ID: ${cleaned}`)
      return cleaned
    }
    
    // 如果包含其他字符，尝试提取其中的数字
    const numberMatch = cleaned.match(/\d+/)
    if (numberMatch) {
      logger.debug(`从文本 "${cleaned}" 中提取到数字ID: ${numberMatch[0]}`)
      return numberMatch[0]
    }
    
    logger.debug(`无法从文本 "${trimmed}" 中提取用户ID`)
    return null
  }

  async function resolveCooldownKeyCandidatesForBypass(session: Session, targetText: string): Promise<string[]> {
    const extracted = extractUserId(targetText) || targetText?.trim()
    if (!extracted) return []
    const keys = new Set<string>([extracted])
    const platform = session.platform ? String(session.platform) : ''
    const legacy = await getBindRelatedLegacyUserIdsForTarget(ctx, platform, extracted)
    for (const id of legacy) keys.add(id)

    // 通过 bind 插件反查 aid，补上 koishi:<aid>（实际记录冷却用的统一键）
    const db = ctx.database as any
    if (db && typeof db.get === 'function') {
      try {
        const pidCandidates = platform
          ? [`${platform}:${extracted}`, extracted]
          : [extracted]
        let aid: number | string | undefined
        for (const pid of pidCandidates) {
          const rows = await db.get('binding', { pid })
          if (rows?.length) {
            aid = rows[0]?.aid
            break
          }
        }
        if (aid !== undefined && aid !== null) {
          keys.add(`koishi:${String(aid)}`)
        }
      } catch {
        // binding 表不存在或结构不一致时忽略
      }
    }

    for (const id of [...keys]) {
      const rows = await ctx.database.get('maibot_bindings', { userId: id })
      for (const b of rows) keys.add(b.userId)
    }
    return [...keys]
  }

  /**
   * 检查权限并获取目标用户绑定
   * 如果提供了targetUserId，检查权限并使用目标用户
   * 否则使用当前用户
   */
  async function getTargetBinding(
    session: Session,
    targetUserIdText: string | undefined,
  ): Promise<{ binding: UserBinding | null, isProxy: boolean, error: string | null }> {
    const currentUserId = session.userId
    logger.debug(`getTargetBinding: 原始输入 = "${targetUserIdText}", 当前用户ID = ${currentUserId}`)
    
    const targetUserIdRaw = extractUserId(targetUserIdText)
    logger.debug(`getTargetBinding: 提取后的用户ID = "${targetUserIdRaw}"`)
    
    // 如果没有提供目标用户，使用当前用户
    if (!targetUserIdRaw) {
      logger.debug(`getTargetBinding: 未提供目标用户，使用当前用户 ${currentUserId}`)
      let binding = await getBindingBySession(ctx, session)
      if (!binding && tokenOnlyModeEnabled) {
        const keys = await getSessionBindingKeys(ctx, session)
        const key = await getCanonicalV2UserId(session) || keys[0] || String(session.userId || '')
        if (key) binding = await getOrCreateBindingByUserKey(ctx, key)
      }
      logger.debug(`getTargetBinding: 当前用户绑定状态 = ${binding ? 'found' : 'not found'}`)
      if (!binding) {
        return {
          binding: null,
          isProxy: false,
          error: tokenOnlyModeEnabled ? TOKEN_ONLY_BIND_HINT : '❌ 请先绑定舞萌DX账号\n使用 /mai绑定 <SGWCMAID...> 进行绑定',
        }
      }
      if (!tokenOnlyModeEnabled && !isDxBound(binding)) {
        return { binding: null, isProxy: false, error: DX_BIND_REQUIRED_MSG }
      }
      return { binding, isProxy: false, error: null }
    }
    
    // 如果提供了目标用户，需要检查权限
    const userAuthority = (session.user as any)?.authority ?? 0
    logger.debug(`getTargetBinding: 当前用户权限 = ${userAuthority}, 需要权限 = ${authLevelForProxy}`)
    if (userAuthority < authLevelForProxy) {
      return { binding: null, isProxy: true, error: `❌ 权限不足，需要auth等级${authLevelForProxy}以上才能代操作` }
    }
    
    // 获取目标用户的绑定
    logger.debug(`getTargetBinding: 查询目标用户 ${targetUserIdRaw} 的绑定`)
    // 收集候选键：原始ID + bind插件反查的同账号其他平台ID + koishi:<aid> 统一键
    const candidates = new Set<string>([targetUserIdRaw])
    const platform = session.platform ? String(session.platform) : ''
    try {
      const legacy = await getBindRelatedLegacyUserIdsForTarget(ctx, platform, targetUserIdRaw)
      for (const id of legacy) candidates.add(id)
    } catch { /* 忽略 */ }
    // 反查 aid 得到 koishi:<aid>
    const db = ctx.database as any
    if (db && typeof db.get === 'function') {
      try {
        const pidCandidates = platform
          ? [`${platform}:${targetUserIdRaw}`, targetUserIdRaw]
          : [targetUserIdRaw]
        let aid: number | string | undefined
        for (const pid of pidCandidates) {
          const rows = await db.get('binding', { pid })
          if (rows?.length) {
            aid = rows[0]?.aid
            break
          }
        }
        if (aid !== undefined && aid !== null) {
          candidates.add(`koishi:${String(aid)}`)
        }
      } catch { /* 忽略 */ }
    }

    let bindings: UserBinding[] = []
    for (const key of candidates) {
      const rows = await ctx.database.get('maibot_bindings', { userId: key })
      if (rows.length > 0) {
        bindings = rows
        break
      }
    }
    logger.debug(`getTargetBinding: 候选键 = ${[...candidates].join(', ')}, 命中数量 = ${bindings.length}`)
    if (bindings.length === 0) {
      if (tokenOnlyModeEnabled) {
        const key = [...candidates][0]
        const binding = await getOrCreateBindingByUserKey(ctx, key)
        return { binding, isProxy: true, error: null }
      }
      logger.warn(`getTargetBinding: 用户 ${targetUserIdRaw} 尚未绑定账号（原始输入: "${targetUserIdText}"）`)
      return { binding: null, isProxy: true, error: `❌ 用户 ${targetUserIdRaw} 尚未绑定账号\n\n[Debug] 原始输入: "${targetUserIdText}"\n提取的ID: "${targetUserIdRaw}"\n候选键: ${[...candidates].join(', ')}\n请确认用户ID是否正确` }
    }

    const binding = bindings[0]
    if (!tokenOnlyModeEnabled && !isDxBound(binding)) {
      return { binding: null, isProxy: true, error: DX_BIND_REQUIRED_MSG }
    }

    logger.debug(`getTargetBinding: 成功获取目标用户 ${targetUserIdRaw} 的绑定`)
    return { binding, isProxy: true, error: null }
  }

  async function verifyQrPreviewIfNeeded(
    binding: UserBinding,
    preview: { UserID: string | number; UserName?: string },
    session: Session,
  ): Promise<{ blocked: true; message: string } | { blocked: false; migrationNotice?: string }> {
    if (!shouldVerifyBindingIdentity(binding, tokenOnlyModeEnabled)) {
      return { blocked: false }
    }
    const vr = verifyPreviewMatchesBinding(binding, preview)
    const hv = await applyVerifyPreviewBinding(ctx, binding, vr, logger)
    if (hv.blocked) return { blocked: true, message: hv.message }
    return { blocked: false, migrationNotice: hv.migrationNotice }
  }

  function patchQrCacheFromPreview(
    binding: UserBinding,
    qrCode: string,
    preview: { UserName?: string },
  ): Record<string, unknown> {
    const patch: Record<string, unknown> = {
      lastQrCode: qrCode,
      lastQrCodeTime: new Date(),
    }
    if (!tokenOnlyModeEnabled) {
      patch.qrCode = qrCode
    }
    if (preview.UserName != null && !binding.boundPlayerName?.trim()) {
      patch.boundPlayerName = String(preview.UserName).trim()
    }
    return patch
  }

  /** 命令行直接携带 SGID 时：Token 模式跳过 preview，否则走 preview 与绑定校验 */
  async function resolveInlineQrText(
    qrCode: string,
    binding: UserBinding,
    session: Session,
  ): Promise<{ qrText: string; error?: string; fromCache?: boolean }> {
    if (tokenOnlyModeEnabled) {
      if (!qrCode.startsWith('SGWCMAID')) {
        return { qrText: '', error: '❌ SGID 格式错误，需以 SGWCMAID 开头' }
      }
      await ctx.database.set(
        'maibot_bindings',
        { userId: binding.userId },
        patchQrCacheFromPreview(binding, qrCode, {}),
      )
      return { qrText: qrCode }
    }
    try {
      const preview = await api.getPreview(machineInfo?.clientId ?? '', qrCode)
      if (preview.UserID === -1 || (typeof preview.UserID === 'string' && preview.UserID === '-1')) {
        return { qrText: '', error: '❌ 无效或过期的二维码，请重新发送' }
      }
      const vc = await verifyQrPreviewIfNeeded(binding, preview, session)
      if (vc.blocked) {
        return { qrText: '', error: vc.message }
      }
      if (vc.migrationNotice) await session.send(vc.migrationNotice)
      await ctx.database.set(
        'maibot_bindings',
        { userId: binding.userId },
        patchQrCacheFromPreview(binding, qrCode, preview),
      )
      return { qrText: qrCode }
    } catch (error: any) {
      return { qrText: '', error: `❌ 验证二维码失败：${getSafeErrorMessage(error, session)}` }
    }
  }

  async function recallBotMessages(session: Session, messageIds: string[] | undefined): Promise<void> {
    if (!messageIds?.length || !session.bot || !session.channelId) return
    for (const msgId of messageIds) {
      try {
        await session.bot.deleteMessage(session.channelId, msgId)
      } catch {
        // 忽略撤回失败
      }
    }
  }

  function formatB50UploadSuccessMessage(
    result: { sync?: boolean; task_id?: string; count?: number },
    opts: { prefix?: string } = {},
  ): string {
    const prefix = opts.prefix ?? ''
    if (isSyncB50Upload(result)) {
      const countPart = result.count != null ? `，共 ${result.count} 首乐曲` : ''
      return `${prefix}✅ B50 上传完成${countPart}`
    }
    return `${prefix}✅ B50 已提交，完成后将通知您`
  }

  const scheduleB50Notification = (session: Session, taskId: string, initialRefId?: string, messagesToRecall?: string[]) => {
    if (!taskId) return
    stashTriggerSessionMeta(session)
    const bot = session.bot
    const channelId = session.channelId
    if (!bot || !channelId) {
      logger.warn('无法追踪B50任务完成状态：bot或channel信息缺失')
      return
    }

    const guildId = session.guildId
    const pollInterval = config.b50PollInterval ?? 2000
    const pollTimeout = config.b50PollTimeout ?? 600000  // 默认10分钟超时
    const maxAttempts = Math.ceil(pollTimeout / pollInterval)
    const interval = pollInterval
    const initialDelay = pollInterval  // 首次延迟与轮询间隔相同
    let attempts = 0
    const autoRecallProcessing = config.autoRecallProcessingMessages ?? true
    
    logger.debug(`水鱼B50轮询配置: interval=${pollInterval}ms, timeout=${pollTimeout}ms, maxAttempts=${maxAttempts}`)

    // 撤回处理中消息的辅助函数
    const recallProcessingMessages = async () => {
      if (!autoRecallProcessing || !messagesToRecall || messagesToRecall.length === 0) return
      for (const msgId of messagesToRecall) {
        try {
          await bot.deleteMessage(channelId, msgId)
          logger.debug(`已撤回处理中消息: ${msgId}`)
        } catch (err) {
          logger.debug(`撤回消息失败 ${msgId}: ${err}`)
        }
      }
    }

    const poll = async () => {
      attempts += 1
      logger.debug(`水鱼B50轮询 ${taskId}: 第${attempts}/${maxAttempts}次`)
      try {
        const detail = await api.getB50TaskById(taskId)
        
        // 检测 done === true 或者 error is not none 就停止
        const hasError = detail.error !== null && detail.error !== undefined && detail.error !== ''
        const isDone = detail.done === true
        
        if (isDone || hasError) {
          // 任务完成或出错，撤回处理中消息
          await recallProcessingMessages()
          
          // 发送通知并停止
          const statusText = hasError
            ? `❌ 任务失败：${detail.error}${getErrorHelpInfo()}`
            : '✅ 任务已完成'
          const finishTime = detail.alive_task_end_time
            ? `\n完成时间: ${new Date((typeof detail.alive_task_end_time === 'number' ? detail.alive_task_end_time : parseInt(String(detail.alive_task_end_time))) * 1000).toLocaleString('zh-CN')}`
            : ''
          
          // 记录任务完成/失败的操作日志（添加 alive_task_id 用于统计匹配）
          const taskRefId = await logOperation({
            command: 'mai上传B50-任务完成',
            session,
            status: hasError ? 'failure' : 'success',
            result: `${statusText}${finishTime}`,
            errorMessage: hasError ? detail.error || '未知错误' : undefined,
            apiResponse: { ...detail, alive_task_id: taskId },
          })
          
          const finalMessage = `水鱼B50任务 ${taskId} 状态更新\n${statusText}${finishTime}`
          await sendBotNotification(session, appendRefId(finalMessage, taskRefId))
          return
        }
        
        // 如果还没完成且没出错，继续轮询（在超时范围内）
        if (attempts < maxAttempts) {
          ctx.setTimeout(poll, interval)
          return
        }

        // 超时情况，撤回处理中消息
        await recallProcessingMessages()
        
        const timeoutRefId = await logOperation({
          command: 'mai上传B50-任务超时',
          session,
          status: 'failure',
          errorMessage: `任务轮询超时（${Math.round(pollTimeout / 60000)}分钟）`,
        })
        
        let msg = `水鱼B50任务 ${taskId} 上传失败，请稍后再试一次。${getErrorHelpInfo()}`
        const maintenanceMsg = getMaintenanceMessage(maintenanceNotice)
        if (maintenanceMsg) {
          msg += `\n${maintenanceMsg}`
        }
        await sendBotNotification(session, appendRefId(msg, timeoutRefId))
      } catch (error) {
        logger.warn(`轮询B50任务状态失败: ${sanitizeError(error)}`)
        if (attempts < maxAttempts) {
          ctx.setTimeout(poll, interval)
          return
        }
        
        // 轮询异常情况，撤回处理中消息
        await recallProcessingMessages()
        
        const errorRefId = await logOperation({
          command: 'mai上传B50-轮询异常',
          session,
          status: 'error',
          errorMessage: error instanceof Error ? sanitizeErrorMessage(error.message) : '未知错误',
        })
        
        let msg = `水鱼B50任务 ${taskId} 上传失败，请稍后再试一次。${getErrorHelpInfo()}`
        const maintenanceMsg = getMaintenanceMessage(maintenanceNotice)
        if (maintenanceMsg) {
          msg += `\n${maintenanceMsg}`
        }
        await sendBotNotification(session, appendRefId(msg, errorRefId))
      }
    }

    // 首次延迟后开始检查
    ctx.setTimeout(poll, initialDelay)
  }

  const scheduleLxB50Notification = (session: Session, taskId: string, initialRefId?: string, messagesToRecall?: string[]) => {
    if (!taskId) return
    stashTriggerSessionMeta(session)
    const bot = session.bot
    const channelId = session.channelId
    if (!bot || !channelId) {
      logger.warn('无法追踪落雪B50任务完成状态：bot或channel信息缺失')
      return
    }

    const guildId = session.guildId
    const pollInterval = config.b50PollInterval ?? 2000
    const pollTimeout = config.b50PollTimeout ?? 600000  // 默认10分钟超时
    const maxAttempts = Math.ceil(pollTimeout / pollInterval)
    const interval = pollInterval
    const initialDelay = pollInterval  // 首次延迟与轮询间隔相同
    let attempts = 0
    const autoRecallProcessing = config.autoRecallProcessingMessages ?? true
    
    logger.debug(`落雪B50轮询配置: interval=${pollInterval}ms, timeout=${pollTimeout}ms, maxAttempts=${maxAttempts}`)

    // 撤回处理中消息的辅助函数
    const recallProcessingMessages = async () => {
      if (!autoRecallProcessing || !messagesToRecall || messagesToRecall.length === 0) return
      for (const msgId of messagesToRecall) {
        try {
          await bot.deleteMessage(channelId, msgId)
          logger.debug(`已撤回处理中消息: ${msgId}`)
        } catch (err) {
          logger.debug(`撤回消息失败 ${msgId}: ${err}`)
        }
      }
    }

    const poll = async () => {
      attempts += 1
      logger.debug(`落雪B50轮询 ${taskId}: 第${attempts}/${maxAttempts}次`)
      try {
        const detail = await api.getLxB50TaskById(taskId)
        
        // 检测 done === true 或者 error is not none 就停止
        const hasError = detail.error !== null && detail.error !== undefined && detail.error !== ''
        const isDone = detail.done === true
        
        if (isDone || hasError) {
          // 任务完成或出错，撤回处理中消息
          await recallProcessingMessages()
          
          // 发送通知并停止
          const statusText = hasError
            ? `❌ 任务失败：${detail.error}${getErrorHelpInfo()}`
            : '✅ 任务已完成'
          const finishTime = detail.alive_task_end_time
            ? `\n完成时间: ${new Date((typeof detail.alive_task_end_time === 'number' ? detail.alive_task_end_time : parseInt(String(detail.alive_task_end_time))) * 1000).toLocaleString('zh-CN')}`
            : ''
          
          // 记录任务完成/失败的操作日志（添加 alive_task_id 用于统计匹配）
          const taskRefId = await logOperation({
            command: 'mai上传落雪b50-任务完成',
            session,
            status: hasError ? 'failure' : 'success',
            result: `${statusText}${finishTime}`,
            errorMessage: hasError ? detail.error || '未知错误' : undefined,
            apiResponse: { ...detail, alive_task_id: taskId },
          })
          
          const finalMessage = `落雪B50任务 ${taskId} 状态更新\n${statusText}${finishTime}`
          await sendBotNotification(session, appendRefId(finalMessage, taskRefId))
          return
        }
        
        // 如果还没完成且没出错，继续轮询（在超时范围内）
        if (attempts < maxAttempts) {
          ctx.setTimeout(poll, interval)
          return
        }

        // 超时情况，撤回处理中消息
        await recallProcessingMessages()
        
        const timeoutRefId = await logOperation({
          command: 'mai上传落雪b50-任务超时',
          session,
          status: 'failure',
          errorMessage: `任务轮询超时（${Math.round(pollTimeout / 60000)}分钟）`,
        })
        
        let msg = `落雪B50任务 ${taskId} 上传失败，请稍后再试一次。${getErrorHelpInfo()}`
        const maintenanceMsg = getMaintenanceMessage(maintenanceNotice)
        if (maintenanceMsg) {
          msg += `\n${maintenanceMsg}`
        }
        await sendBotNotification(session, appendRefId(msg, timeoutRefId))
      } catch (error) {
        logger.warn(`轮询落雪B50任务状态失败: ${sanitizeError(error)}`)
        if (attempts < maxAttempts) {
          ctx.setTimeout(poll, interval)
          return
        }
        
        // 轮询异常情况，撤回处理中消息
        await recallProcessingMessages()
        
        const errorRefId = await logOperation({
          command: 'mai上传落雪b50-轮询异常',
          session,
          status: 'error',
          errorMessage: error instanceof Error ? sanitizeErrorMessage(error.message) : '未知错误',
        })
        
        let msg = `落雪B50任务 ${taskId} 上传失败，请稍后再试一次。${getErrorHelpInfo()}`
        const maintenanceMsg = getMaintenanceMessage(maintenanceNotice)
        if (maintenanceMsg) {
          msg += `\n${maintenanceMsg}`
        }
        await sendBotNotification(session, appendRefId(msg, errorRefId))
      }
    }

    // 首次延迟后开始检查
    ctx.setTimeout(poll, initialDelay)
  }

  async function sendBotNotification(session: Session, content: string, refId?: string): Promise<void> {
    const bot = session.bot
    const channelId = session.channelId
    if (!bot || !channelId) return
    const full = refId ? appendRefId(content, refId) : content
    const payload = shouldUseGroupReply(session, replyInGroupEnabled)
      ? wrapForGroupReply(session, full)
      : full
    await bot.sendMessage(channelId, payload, session.guildId)
  }

  const scheduleChargeNotification = (
    session: Session,
    params: { chargeId: number; qrText: string; submitRefId?: string },
  ) => {
    if (isPublicApi) return
    stashTriggerSessionMeta(session)
    const bot = session.bot
    const channelId = session.channelId
    if (!bot || !channelId) return

    const pollInterval = chargePollIntervalMs
    const pollTimeout = chargePollTimeoutMs
    const maxAttempts = Math.ceil(pollTimeout / pollInterval)
    const clientId = machineInfo?.clientId ?? ''
    let attempts = 0

    const poll = async () => {
      attempts += 1
      try {
        const q = await api.getChargeQueue()
        if (q.code !== 0) {
          if (attempts < maxAttempts) {
            ctx.setTimeout(poll, pollInterval)
          }
          return
        }

        const task = findMatchingChargeTask(q.tasks, params.chargeId, params.qrText, clientId)
        if (task?.status === 'done') {
          const taskRefId = await logOperation({
            command: 'mai发票-任务完成',
            session,
            status: 'success',
            result: formatChargeTaskStatus(task),
            apiResponse: { ...task, submitRefId: params.submitRefId },
          })
          await sendBotNotification(
            session,
            `✅ ${params.chargeId} 倍发票充值已完成\n${formatChargeTaskStatus(task)}\n请在游戏内确认到账`,
            taskRefId,
          )
          return
        }
        if (task?.status === 'failed') {
          const taskRefId = await logOperation({
            command: 'mai发票-任务失败',
            session,
            status: 'failure',
            result: formatChargeTaskStatus(task),
            errorMessage: task.msg || '充值失败',
            apiResponse: { ...task, submitRefId: params.submitRefId },
          })
          await sendBotNotification(
            session,
            `❌ ${params.chargeId} 倍发票充值失败\n${formatChargeTaskStatus(task)}${getErrorHelpInfo()}`,
            taskRefId,
          )
          return
        }

        if (attempts < maxAttempts) {
          ctx.setTimeout(poll, pollInterval)
          return
        }

        const timeoutRefId = await logOperation({
          command: 'mai发票-任务超时',
          session,
          status: 'failure',
          errorMessage: `轮询超时（${Math.round(pollTimeout / 60000)} 分钟）`,
          apiResponse: { chargeId: params.chargeId, submitRefId: params.submitRefId },
        })
        const hint = params.submitRefId
          ? `\n可使用 /maiqueue ${params.submitRefId} 查询最新状态`
          : ''
        await sendBotNotification(
          session,
          `⏳ ${params.chargeId} 倍发票充值仍在处理或已移出队列（轮询 ${Math.round(pollTimeout / 60000)} 分钟）${hint}`,
          timeoutRefId,
        )
      } catch (error) {
        logger.warn(`轮询发票队列失败: ${sanitizeError(error)}`)
        if (attempts < maxAttempts) {
          ctx.setTimeout(poll, pollInterval)
        }
      }
    }

    ctx.setTimeout(poll, pollInterval)
  }

  /**
   * 帮助指令
   * 用法: /mai 或 /mai帮助 [--advanced] 显示高级功能（发票、收藏品、舞里程等）
   */
  ctx.command('mai [help:text]', '查看所有可用指令')
    .alias('mai帮助')
    .userFields(['authority'])
    .option('advanced', '--advanced  显示高级功能（发票、收藏品、舞里程等）')
    .action(async ({ session, options }) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      // 检查白名单
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }

      // 获取用户权限
      const userAuthority = (session.user as any)?.authority ?? 0
      const canProxy = userAuthority >= authLevelForProxy

      if (tokenOnlyModeEnabled) {
        let tokenHelp = `📖 舞萌DX机器人指令帮助（Token 直连模式）

ℹ️ 当前无需 /mai绑定，请按 userId 直接绑定 Token，且仅可使用以下指令：

🐟 水鱼：
  /mai绑定水鱼 <token> - 绑定水鱼Token
  /mai解绑水鱼 - 解绑水鱼Token
  /mai上传B50 - 上传B50到水鱼

❄️ 落雪：
  /mai绑定落雪 <token> - 绑定落雪Token
  /mai解绑落雪 - 解绑落雪Token
  /mai上传落雪b50 - 上传B50到落雪

  /maiua - 同时上传B50到水鱼和落雪

🎫 票券：
  /mai发票 [倍数] - 发放功能票（2 或 3 倍）

关闭 Token 直连模式后，未完成舞萌绑定的用户须使用 /mai绑定。`
        if (canProxy) {
          tokenHelp += `\n\n代操作（auth>=${authLevelForProxy}）可在指令后加 [@用户]`
        }
        return prependBetaNotice(tokenHelp)
      }

      let helpText = prependBetaNotice(`📖 舞萌DX机器人指令帮助${isPublicApi ? '（公共 API 模式）' : ''}

🔐 账号管理：
  /mai绑定 - 绑定舞萌DX账号（支持SGID文本或公众号提供的网页地址）
  /mai解绑 - 解绑舞萌DX账号
  /mai状态 - 查询绑定状态
  /mymai - 与 /mai状态 相同（别名）
  /maiping - 测试机台连接
  /maiqueue [Ref_ID] - 查询发票充值队列状态（可带 Ref_ID 查单笔）`)

      // 有权限的代操作命令
      if (canProxy) {
        helpText += `
  /mai状态 [@用户] - 查询他人绑定状态（需要auth等级${authLevelForProxy}以上）`
      }

      helpText += `

🐟 水鱼B50：
  /mai绑定水鱼 <token> - 绑定水鱼Token
  /mai解绑水鱼 - 解绑水鱼Token
  /mai上传B50 - 上传B50到水鱼
  /maiua - 同时上传B50到水鱼和落雪`

      if (canProxy) {
        helpText += `
  /mai绑定水鱼 <token> [@用户] - 为他人绑定水鱼Token（需要auth等级${authLevelForProxy}以上）
  /mai解绑水鱼 [@用户] - 解绑他人的水鱼Token（需要auth等级${authLevelForProxy}以上）
  /mai上传B50 [@用户] - 为他人上传B50（需要auth等级${authLevelForProxy}以上）
  /maiua [@用户] - 为他人同时上传B50（需要auth等级${authLevelForProxy}以上）`
      }

      helpText += `

❄️ 落雪B50：
  /mai绑定落雪 <token> - 绑定落雪Token
  /mai解绑落雪 - 解绑落雪Token
  /mai上传落雪b50 - 上传B50到落雪`

      if (canProxy) {
        helpText += `
  /mai绑定落雪 <token> [@用户] - 为他人绑定落雪 Token（需要auth等级${authLevelForProxy}以上）
  /mai解绑落雪 [@用户] - 解绑他人的落雪 Token（需要auth等级${authLevelForProxy}以上）
  /mai上传落雪b50 [token] [@用户] - 为他人上传落雪B50（需要auth等级${authLevelForProxy}以上）`
      }

      // 只有在使用 --advanced 参数时才显示高级功能（发票、收藏品、舞里程等）
      const showAdvanced = options?.advanced
      
      if (showAdvanced && !isPublicApi) {
          helpText += `

🎫 票券管理（异步入队，走充值队列，约 2–3 分钟）：
  /mai发票 [倍数] - 为账号发放功能票（2 或 3 倍，默认 2 倍）
  /mai清票 - 清空账号的所有功能票`

          if (canProxy) {
            helpText += `
  /mai发票 [倍数] [@用户] - 为他人发放功能票（需要auth等级${authLevelForProxy}以上）
  /mai清票 [@用户] - 清空他人的功能票（需要auth等级${authLevelForProxy}以上）`
          }

          if (enableMaimile) {
            helpText += `

🎮 游戏功能：
  /mai舞里程 <里程数> - 为账号发放舞里程（必须是1000的倍数）`

            if (canProxy) {
              helpText += `
  /mai舞里程 <里程数> [@用户] - 为他人发放舞里程（需要auth等级${authLevelForProxy}以上）`
            }
          }

          helpText += `

🎁 收藏品管理：
  /mai获取收藏品 [SGID或@用户] - 获取/解锁收藏品（可选首参传 SGID/链接 或代操 @用户；支持缓存，/mai发收藏品 为别名）
  /mai上传乐曲成绩 [@用户] - 手动上传乐曲成绩（交互式输入，包含60秒安全等待）
  /mai删除成绩 [@用户] - 删除指定乐曲的成绩（交互式输入）
  /mai修改版本号 [SGID或@用户] - 修改版本号（可选首参传 SGID/链接 或代操 @用户；支持缓存）`

          if (canProxy) {
            helpText += `
  /mai获取收藏品 [@用户] - 为他人获取/解锁收藏品（需要auth等级${authLevelForProxy}以上）
  /mai上传乐曲成绩 [@用户] - 为他人上传乐曲成绩（需要auth等级${authLevelForProxy}以上）
  /mai删除成绩 [@用户] - 为他人删除成绩（需要auth等级${authLevelForProxy}以上）
  /mai修改版本号 [@用户] - 为他人修改版本号（需要auth等级${authLevelForProxy}以上）`
          }
      }

      helpText += `

💎 优先授权（缓解指令冷却，需在配置中开启 priorityCooldown）：
  /mai兑换卡密 [卡密] — 无需 SGID 验证；可直接带卡密或发送指令后粘贴。个人卡全局有效；群组卡须在对应群内兑换；解绑卡须已 /mai绑定
  /mymai 或 /mai状态 — 可查看个人授权与「群组优先」状态及到期时间
  /mai取消群组优先 — 在群内，群组卡兑换人可取消本群群组优先
  /mai群组优先换绑 — 在原群发起，再在目标群发 /mai群组优先换入（兑换人迁移授权）`

      // 隐藏锁定和保护模式功能（如果hideLockAndProtection为true）；公共 API 下亦不展示（相关机台接口不可用）
      if (!hideLockAndProtection && !isPublicApi) {
        helpText += `

🔒 账号锁定：
  /mai锁定 - 锁定账号，防止他人登录
  /mai解锁 - 解锁账号（仅限通过mai锁定指令锁定的账号）
  /mai逃离 - 解锁账号的别名`

        if (canProxy) {
          helpText += `
  /mai锁定 [@用户] - 锁定他人账号（需要auth等级${authLevelForProxy}以上）
  /mai解锁 [@用户] - 解锁他人账号（需要auth等级${authLevelForProxy}以上）`
        }

        helpText += `

🛡️ 保护模式：
  /mai保护模式 [on|off] - 开关账号保护模式（自动锁定已下线的账号）`

        if (canProxy) {
          helpText += `
  /mai保护模式 [on|off] [@用户] - 设置他人的保护模式（需要auth等级${authLevelForProxy}以上）`
        }
      }

      if (canProxy) {
        helpText += `

👑 管理员指令：
  /mai管理员关闭所有锁定和保护 - 一键关闭所有人的锁定模式和保护模式（需要auth等级${authLevelForProxy}以上）`
      }

      if (userAuthority >= authLevelForCardAdmin) {
        helpText += `

🎟️ 卡密与冷却管理（需要 auth 等级 ${authLevelForCardAdmin} 以上）：
  /mai管理员生成卡密 — 无参数时交互选择类型、时长、数量；也可 /mai管理员生成卡密 <时长> [数量] [-g|-u]
  /mai管理员删除卡密 — 支持多行批量（每行一条，或粘贴导出 TSV 整段）；无参走交互粘贴
  /mai管理员导出卡密 — 无参数时交互选择范围与类型；也可 /mai管理员导出卡密 [all|unused|redeemed]
  /mai管理员取消群组优先 [群标识] — 取消群组优先；省略时在群内则针对当前群
  /mai管理员取消个人优先 <@或ID> — 清除个人优先记录
  /mai管理员设置个人优先 <@或ID> <spec> — spec：永久、7d、clear 等
  /mai管理员设置群组优先 <spec> [-g 群标识] — spec 与 -g 可同一段输入（如 clear -g qq:群号）；纯数字 -g 会按当前平台补前缀；-g 省略且在群内则当前群
  /maibypass <@用户|用户ID> — 清除该用户当前全部指令冷却（别名 /mai管理员清除冷却）
  /mai管理员重置用户协议 [all|@或ID] — 清除协议确认；all 重置全部用户（需二次确认）
  /mai管理员清除落雪旧绑定 [legacy|all|@或ID] — 清除旧好友码；all 清除全部落雪绑定（需二次确认）
  /maiSGID获取 [文本|链接] — 调试 SGID 提取（auth≥3 或调试群；可交互发送文本/图片）`
      }

      helpText += `

💬 交流与反馈：
如有问题或建议，请前往QQ群: 1072033605

📝 说明：
  - 绑定账号支持SGID文本或公众号提供的网页地址`

      if (canProxy) {
        helpText += `
  - 支持 [@用户] 参数进行代操作（需要auth等级${authLevelForProxy}以上）`
      }
      
      helpText += `
  - 部分指令支持 -bypass 参数绕过确认
  - 使用 /mai状态 --expired 可查看过期票券`

      if (isPublicApi) {
        helpText += `

ℹ️ ${PUBLIC_API_UNAVAILABLE_MSG}`
      }

      return helpText
    })

  /**
   * Ping功能
   * 用法: /maiping
   */
  ctx.command('maiping', '测试机台连接')
    .action(async ({ session }) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      // 检查白名单
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }

      try {
        const tracker = createBotMessageTracker(session, ctx, autoRecallInteractive)
        await tracker.send('⏳ 正在测试机台连接...')
        const result = await api.maiPing()
        await tracker.recall()
        
        // 检查返回结果是否为 {"result":"Pong"} 或 sw-api health
        if (result.status === 'ok') {
          return `✅ 机台连接正常\n\n📊 查看所有服务状态: https://status.awmc.team`
        } else if (result.result === 'Pong') {
          return `✅ 机台连接正常\n\n📊 查看所有服务状态: https://status.awmc.team`
        } else if (result.returnCode === 1 && result.serverTime) {
          const serverTime = new Date(result.serverTime * 1000).toLocaleString('zh-CN')
          return `✅ 机台连接正常\n服务器时间: ${serverTime}\n\n📊 查看所有服务状态: https://status.awmc.team`
        } else if (result.result === 'down') {
          return `❌ 机台连接失败，机台可能已下线\n\n📊 查看所有服务状态: https://status.awmc.team`
        } else {
          return `⚠️ 机台状态未知\n返回结果: ${JSON.stringify(result)}\n\n📊 查看所有服务状态: https://status.awmc.team`
        }
      } catch (error: any) {
        ctx.logger('maibot').error('Ping机台失败:', error)
        if (maintenanceMode) {
          return `${maintenanceMessage}\n\n📊 查看所有服务状态: https://status.awmc.team`
        }
        return `❌ Ping失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}\n\n📊 查看所有服务状态: https://status.awmc.team`
      }
    })

// 这个 Fracture_Hikaritsu 不给我吃KFC，故挂在此处。 我很生气。
  /**
   * 查询发票充值队列状态
   * 用法: /maiqueue [Ref_ID]
   */
  ctx.command('maiqueue [refId:text]', '查询发票充值队列状态')
    .action(async ({ session }, refIdInput) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }

      if (!isPublicApi) {
        try {
          const q = await api.getChargeQueue()
          if (q.code !== 0) {
            return '❌ 查询服务端发票队列失败'
          }

          const refId = refIdInput?.trim()
          if (refId) {
            const logs = await ctx.database.get('maibot_operation_logs', { refId })
            if (!logs.length) {
              return `❌ 未找到 Ref_ID: ${refId}`
            }
            const log = logs[0]
            let meta: { chargeId?: number; qrTextPrefix?: string; clientId?: string } = {}
            if (log.apiResponse) {
              try {
                meta = JSON.parse(log.apiResponse)
              } catch {
                /* ignore */
              }
            }
            if (!meta.chargeId) {
              return `ℹ️ 该 Ref_ID 无发票队列信息\n指令: ${log.command}\n状态: ${log.status}`
            }
            const qrHint = meta.qrTextPrefix || ''
            const task = findMatchingChargeTask(
              q.tasks,
              meta.chargeId,
              qrHint,
              meta.clientId || machineInfo?.clientId,
            )
            if (!task) {
              const doneLogs = await ctx.database.get('maibot_operation_logs', {})
              const followUp = doneLogs.find(
                (row) => row.apiResponse?.includes(refId)
                  && (row.command === 'mai发票-任务完成' || row.command === 'mai发票-任务失败'),
              )
              if (followUp) {
                return `📋 发票任务（Ref_ID: ${refId}）\n${followUp.result || followUp.errorMessage || followUp.status}`
              }
              return `ℹ️ 服务端队列中未找到该笔任务（可能已完成并移出队列）\nRef_ID: ${refId}\n提交指令: ${log.command}`
            }
            return `📋 发票任务（Ref_ID: ${refId}）\n${formatChargeTaskStatus(task)}\n更新时间: ${task.ts}`
          }

          const pending = q.tasks.filter(t => t.status === 'pending').length
          const processing = q.tasks.filter(t => t.status === 'processing').length
          const failed = q.tasks.filter(t => t.status === 'failed').length
          let msg = `📋 发票充值队列（服务端）\nWorker 数: ${q.workers}\n排队中: ${pending} · 处理中: ${processing}`
          if (failed > 0) msg += ` · 最近失败: ${failed}`

          const binding = await getBindingBySession(ctx, session)
          const qrText = binding?.lastQrCode?.trim()
          if (qrText?.startsWith('SGWCMAID')) {
            const mine = q.tasks.filter(
              (t) => findMatchingChargeTask([t], t.chargeId, qrText, machineInfo?.clientId),
            )
            if (mine.length) {
              msg += '\n\n📌 与您最近 SGID 相关的任务：'
              for (const t of mine.slice(0, 3)) {
                msg += `\n· ${formatChargeTaskStatus(t)}（${t.ts}）`
              }
            }
          }

          if (pending + processing === 0) {
            msg += '\n当前无等待中的充值任务'
          }
          msg += '\n\n说明：B50 上传不走此队列；可用 /maiqueue <Ref_ID> 查询单笔发票状态。'
          return msg
        } catch (error: any) {
          return `❌ 查询发票队列失败: ${getSafeErrorMessage(error, session)}`
        }
      }

      if (!chargeRequestQueue) {
        return 'ℹ️ 公共 API 模式下发票为同步处理，无服务端充值队列。\n如需 Bot 侧限流，可在配置中开启 queue.enabled。'
      }

      if (!session.userId || !session.channelId) {
        return '❌ 无法查询队列：缺少用户信息'
      }

      const position = chargeRequestQueue.getUserQueuePosition(session.userId, session.channelId)
      const estimatedWait = chargeRequestQueue.getUserEstimatedWaitTime(session.userId, session.channelId)
      const totalQueue = chargeRequestQueue.getQueuePosition()

      if (position < 0) {
        return `ℹ️ 您当前不在 Bot 发票队列中\n队列总长度: ${totalQueue}\n\n说明：B50 上传不走队列。`
      }
      if (position === 0) {
        return `✅ 您的发票请求正在 Bot 侧处理中\n队列总长度: ${totalQueue}`
      }
      return `⏳ 您在 Bot 发票队列中排第 ${position} 位\n预计等待: ${estimatedWait} 秒\n队列总长度: ${totalQueue}`
    })

  /**
   * 绑定用户
   * 用法: /mai绑定 [SGWCMAID...]
   */
  ctx.command('mai绑定 [qrCode:text]', '绑定舞萌DX账号')
    .action(async ({ session }, qrCode) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      // 检查白名单
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }

      if (tokenOnlyModeEnabled) {
        return '⚠️ 当前为 Token 直连模式，舞萌账号绑定已关闭。\n请使用 /mai绑定水鱼 或 /mai绑定落雪 绑定 Token。'
      }

      // 使用队列系统
      const userBindingKeys = await getSessionBindingKeys(ctx, session)
      const userId = await getCanonicalV2UserId(session) || userBindingKeys[0] || String(session.userId)

      try {
        // 检查是否已绑定
        const existing = await getBindingBySession(ctx, session)
        if (existing && isDxBound(existing)) {
          return await formatAlreadyBoundMessage(existing)
        }

        // 如果没有提供SGID，提示用户输入
        if (!qrCode) {
          const actualTimeout = rebindTimeout
          let promptMessageId: string | undefined
          try {
            const sentMessage = await session.send(
              `请在${actualTimeout / 1000}秒内发送SGID（长按玩家二维码识别后发送）或公众号提供的网页地址`
            )
            if (typeof sentMessage === 'string') {
              promptMessageId = sentMessage
            } else if (sentMessage && (sentMessage as any).messageId) {
              promptMessageId = (sentMessage as any).messageId
            }
          } catch (error) {
            ctx.logger('maibot').warn('发送提示消息失败:', error)
          }

          try {
            logger.info(`开始等待用户 ${session.userId} 输入SGID，超时时间: ${actualTimeout}ms`)
            
            // 等待用户输入SGID文本（获取完整 Session 便于撤回）
            const promptSession = await waitForUserReply(
              session,
              ctx,
              actualTimeout,
              promptMessageId ? [promptMessageId] : undefined,
            )
            const promptText = promptSession?.content?.trim() || ''
            if (!promptText) {
              throw new Error('超时未收到响应')
            }

            const trimmed = promptText.trim()
            // 交互式输入的敏感信息，撤回用户输入消息
            if (promptSession) {
              await tryRecallMessage(promptSession, ctx, config, promptSession.messageId)
            }
            logger.debug(`收到用户输入: ${trimmed.substring(0, 50)}`)
            
            qrCode = trimmed
            
            // 检查是否为公众号网页地址格式（https://wq.wahlap.net/qrcode/req/）
            const isReqLink = trimmed.includes('https://wq.wahlap.net/qrcode/req/')
            // 检查是否为二维码图片链接格式（https://wq.wahlap.net/qrcode/img/）
            const isImgLink = trimmed.includes('https://wq.wahlap.net/qrcode/img/')
            const isLink = isReqLink || isImgLink
            const isSGID = trimmed.startsWith('SGWCMAID')
            
            // 如果是网页地址，提取MAID并转换为SGWCMAID格式
            if (isReqLink) {
              try {
                // 从URL中提取MAID部分：https://wq.wahlap.net/qrcode/req/MAID2601...55.html?...
                // 匹配 /qrcode/req/ 后面的 MAID 开头的内容（到 .html 或 ? 之前）
                const match = trimmed.match(/qrcode\/req\/(MAID[^?\.]+)/i)
                if (match && match[1]) {
                  const maid = match[1]
                  // 在前面加上 SGWC 变成 SGWCMAID...
                  qrCode = 'SGWC' + maid
                  logger.info(`从网页地址提取MAID并转换: ${maid.substring(0, 20)}... -> ${qrCode.substring(0, 24)}...`)
                } else {
                  await session.send('⚠️ 无法从网页地址中提取MAID，请发送SGID文本（SGWCMAID开头）或公众号提供的网页/图片地址')
                  throw new Error('无法从网页地址中提取MAID')
                }
              } catch (error) {
                logger.warn('解析网页地址失败:', error)
                await session.send('⚠️ 网页地址格式错误，请发送SGID文本（SGWCMAID开头）或公众号提供的网页/图片地址')
                throw new Error('网页地址格式错误')
              }
            } else if (isImgLink) {
              try {
                // 从图片URL中提取MAID部分：https://wq.wahlap.net/qrcode/img/MAID260128205107...png?v
                // 匹配 /qrcode/img/ 后面的 MAID 开头的内容（到 .png 或 ? 之前）
                const match = trimmed.match(/qrcode\/img\/(MAID[^?\.]+)/i)
                if (match && match[1]) {
                  const maid = match[1]
                  // 在前面加上 SGWC 变成 SGWCMAID...
                  qrCode = 'SGWC' + maid
                  logger.info(`从图片地址提取MAID并转换: ${maid.substring(0, 20)}... -> ${qrCode.substring(0, 24)}...`)
                } else {
                  await session.send('⚠️ 无法从图片地址中提取MAID，请发送SGID文本（SGWCMAID开头）或公众号提供的网页/图片地址')
                  throw new Error('无法从图片地址中提取MAID')
                }
              } catch (error) {
                logger.warn('解析图片地址失败:', error)
                await session.send('⚠️ 图片地址格式错误，请发送SGID文本（SGWCMAID开头）或公众号提供的网页/图片地址')
                throw new Error('图片地址格式错误')
              }
            } else if (!isSGID) {
              await session.send('⚠️ 未识别到有效的SGID格式或网页地址，请发送SGID文本（SGWCMAID开头）或公众号提供的网页/图片地址')
              throw new Error('无效的二维码格式，必须是SGID文本或网页/图片地址')
            }
            
            // 验证SGID格式和长度
            if (!qrCode.startsWith('SGWCMAID')) {
              await session.send('⚠️ 未识别到有效的SGID格式，请发送SGID文本（SGWCMAID开头）或公众号提供的网页/图片地址')
              throw new Error('无效的二维码格式，必须以 SGWCMAID 开头')
            }
            
            if (qrCode.length < 48 || qrCode.length > 128) {
              await session.send('❌ SGID长度错误，应在48-128字符之间')
              throw new Error('二维码长度错误，应在48-128字符之间')
            }
            
            logger.info(`✅ 接收到${isLink ? '链接地址（已转换）' : 'SGID'}: ${qrCode.substring(0, 50)}...`)
            
            // 发送识别中反馈
            await session.send('⏳ 正在处理，请稍候...')
          } catch (error: any) {
            logger.error(`等待用户输入二维码失败: ${error?.message}`, error)
            if (error.message?.includes('超时') || error.message?.includes('timeout') || error.message?.includes('未收到响应')) {
              await session.send(`❌ 绑定超时（${actualTimeout / 1000}秒），请稍后使用 /mai绑定 重新绑定`)
              return '❌ 超时未收到响应，绑定已取消'
            }
            if (error.message?.includes('无效的二维码')) {
              return `❌ 绑定失败：${getSafeErrorMessage(error, session)}`
            }
            await session.send(`❌ 绑定过程中发生错误：${getSafeErrorMessage(error, session)}`)
            return `❌ 绑定失败：${getSafeErrorMessage(error, session)}`
          }
        }

        // 如果直接提供了qrCode参数，尝试撤回并处理
        // 注意：如果qrCode是通过交互式输入获取的，已经在getQrText中处理过了
        // 这里只处理直接通过参数提供的qrCode
        if (qrCode && !qrCode.startsWith('SGWCMAID')) {
          // 如果qrCode不是SGWCMAID格式，可能是原始输入，需要处理
          await tryRecallMessage(session, ctx, config)
          
          // 处理并转换SGID（从URL或直接SGID）
          const processed = processSGID(qrCode)
          if (!processed) {
            return '❌ 二维码格式错误，必须是SGID文本（SGWCMAID开头）或公众号提供的网页地址（https://wq.wahlap.net/qrcode/req/...）'
          }
          qrCode = processed.qrText
          logger.info(`从参数中提取并转换SGID: ${qrCode.substring(0, 50)}...`)
        } else if (qrCode && qrCode.startsWith('SGWCMAID')) {
          // 如果已经是SGWCMAID格式，说明可能是直接参数传入的，尝试撤回
          await tryRecallMessage(session, ctx, config)
        }

        // 使用新API获取用户信息（team 模式需 client_id；public 网关仅 qr_text）
        let previewResult
        try {
          previewResult = await api.getPreview(machineInfo?.clientId ?? '', qrCode)
        } catch (error: any) {
          ctx.logger('maibot').error('获取用户预览信息失败:', error)
          const errorMessage = `❌ 绑定失败：无法从二维码获取用户信息\n错误信息: ${getSafeErrorMessage(error, session)}`
          const refId = await logOperation({
            command: 'mai绑定',
            session,
            status: 'error',
            errorMessage: getSafeErrorMessage(error, session),
            apiResponse: error?.response?.data,
          })
          return appendRefId(errorMessage, refId)
        }

        // 检查是否获取成功
        if (previewResult.UserID === -1 || (typeof previewResult.UserID === 'string' && previewResult.UserID === '-1')) {
          const errorMessage = `❌ 绑定失败：无效或过期的二维码`
          const refId = await logOperation({
            command: 'mai绑定',
            session,
            status: 'failure',
            errorMessage: '无效或过期的二维码',
            apiResponse: previewResult,
          })
          return appendRefId(errorMessage, refId)
        }

        const maiUid = String(previewResult.UserID)
        const userName = previewResult.UserName
        const rating = previewResult.Rating ? String(previewResult.Rating) : undefined

        // 检查同一游戏账号是否已被其他 Bot 用户绑定
        const sameUidBindings = await ctx.database.get('maibot_bindings', { maiUid })
        const otherBindings = sameUidBindings.filter(b => b.userId !== userId)
        if (otherBindings.length > 0) {
          const earliest = otherBindings.sort(
            (a, b) => new Date(a.bindTime).getTime() - new Date(b.bindTime).getTime()
          )[0]
          await session.send(
            `⚠️ 此游戏账号已被其他用户绑定（最早绑定时间: ${new Date(earliest.bindTime).toLocaleString('zh-CN')}）。\n` +
            `持有 SGID 即证明账号所有权，继续绑定后进入冷却期。`
          )
        }

        const bindPayload = {
          maiUid,
          qrCode,
          bindTime: new Date(),
          userName,
          boundPlayerName: userName != null ? String(userName).trim() : undefined,
          rating,
          lastQrCode: qrCode,
          lastQrCodeTime: new Date(),
        }

        if (existing && !isDxBound(existing)) {
          await ctx.database.set('maibot_bindings', { userId: existing.userId }, bindPayload)
        } else {
          await ctx.database.create('maibot_bindings', {
            userId,
            ...bindPayload,
          })
        }
        await touchRebindClock(userId)

        const successMessage = `✅ 绑定成功！\n` +
               (userName ? `用户名: ${userName}\n` : '') +
               (rating ? `Rating: ${rating}\n` : '') +
               `绑定时间: ${new Date().toLocaleString('zh-CN')}\n\n` +
               `⚠️ 为了确保账户安全，请手动撤回群内包含SGID的消息`
        
        const refId = await logOperation({
          command: 'mai绑定',
          session,
          status: 'success',
          result: successMessage,
        })
        
        return appendRefId(successMessage, refId)
      } catch (error: any) {
        ctx.logger('maibot').error('绑定失败:', error)
        const errorMessage = maintenanceMode 
          ? maintenanceMessage
          : (error?.response 
            ? `❌ API请求失败: ${error.response.status} ${error.response.statusText}\n\n${maintenanceMessage}`
            : `❌ 绑定失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`)
        
        const refId = await logOperation({
          command: 'mai绑定',
          session,
          status: 'error',
          errorMessage: getSafeErrorMessage(error, session),
          apiResponse: error?.response?.data,
        })
        
        return appendRefId(errorMessage, refId)
      }
    })

  /**
   * 解绑用户
   * 用法: /mai解绑
   */
  ctx.command('mai解绑', '解绑舞萌DX账号')
    .action(async ({ session }) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      // 检查白名单
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }

      if (tokenOnlyModeEnabled) {
        return '⚠️ 当前为 Token 直连模式，舞萌账号解绑已关闭。'
      }

      try {
        const binding = await getBindingBySession(ctx, session)
        if (!binding) {
          return '❌ 您还没有绑定账号\n使用 /mai绑定 <SGWCMAID...> 进行绑定'
        }

        if (!isDxBound(binding)) {
          return '❌ 您尚未完成舞萌DX账号绑定\n使用 /mai绑定 进行绑定'
        }

        const waitMs = await getRebindWaitMsForBinding(binding)
        if (waitMs > 0) {
          return (
            `❌ 当前处于换绑冷却期内，还需等待约 ${formatBindChangeWaitHuman(waitMs)}。\n` +
            `请使用 /mai解绑卡 或 /maiunbindkey（需解绑卡额度并验证 SGID），或前往 ${rebindShopUrl()} 购买解绑卡。\n` +
            `已绑定状态下可使用 /mai兑换卡密 兑换解绑卡。`
          )
        }

        await touchRebindClock(binding.userId)
        await removeBindingBySession(ctx, session)

        return `✅ 解绑成功！`
      } catch (error: any) {
        ctx.logger('maibot').error('解绑失败:', error)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        return `❌ 解绑失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })

  ctx.command('mai解绑卡', '冷却期内凭解绑卡额度解绑（需 SGID 验证与二次确认）')
    .alias('maiunbindkey')
    .action(async ({ session }) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }
      if (tokenOnlyModeEnabled) {
        return '⚠️ 当前为 Token 直连模式，舞萌账号解绑已关闭。'
      }
      try {
        const binding = await getBindingBySession(ctx, session)
        if (!binding) {
          return '❌ 您还没有绑定账号\n使用 /mai绑定 <SGWCMAID...> 进行绑定'
        }
        if (!isDxBound(binding)) {
          return '❌ 您尚未完成舞萌DX账号绑定\n使用 /mai绑定 进行绑定'
        }
        const waitMs = await getRebindWaitMsForBinding(binding)
        const credits = binding.unbindCredits ?? 0
        if (waitMs > 0 && credits <= 0) {
          return (
            `❌ 换绑冷却期内且没有解绑卡额度。\n` +
            `还需等待约 ${formatBindChangeWaitHuman(waitMs)}，或前往 ${rebindShopUrl()} 购买解绑卡后用 /mai兑换卡密 兑换。`
          )
        }
        const qrTextResult = await getQrText(session, ctx, api, binding, config, rebindTimeout, undefined, false)
        if (qrTextResult.error) {
          return `❌ ${qrTextResult.error}`
        }
        if (!await promptYesLocal(session, '⚠️ 即将解绑当前舞萌账号，相关功能将无法使用直到再次绑定\n确认继续？')) {
          return '操作已取消'
        }
        if (!await promptYesLocal(session, '二次确认：确定要解绑吗？')) {
          return '操作已取消'
        }
        const fresh = await getBindingBySession(ctx, session)
        if (!fresh) {
          return '❌ 绑定记录已变更，请重新执行'
        }
        const w2 = await getRebindWaitMsForBinding(fresh)
        const c2 = fresh.unbindCredits ?? 0
        if (w2 > 0 && c2 <= 0) {
          return '❌ 解绑卡额度不足或状态已变更，请重新检查。'
        }
        if (w2 > 0) {
          await ctx.database.set('maibot_bindings', { userId: fresh.userId }, { unbindCredits: c2 - 1 })
        }
        await touchRebindClock(fresh.userId)
        await removeBindingBySession(ctx, session)
        const left = w2 > 0 ? c2 - 1 : c2
        return (
          `✅ 已解绑舞萌账号` +
          (w2 > 0 ? `\n（已消耗 1 次解绑卡额度，剩余 ${left} 次）` : '')
        )
      } catch (error: any) {
        ctx.logger('maibot').error('解绑卡流程失败:', error)
        return `❌ 解绑失败: ${getSafeErrorMessage(error, session)}`
      }
    })

  /**
   * 查询绑定状态
   * 用法: /mai状态 [--expired] [@用户id]
   */
  ctx.command('mai状态 [targetUserId:text]', '查询绑定状态')
    .alias('mymai')
    .userFields(['authority'])
    .option('expired', '--expired  显示过期票券')
    .action(async ({ session, options }, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      // 检查白名单
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }

      try {
        // 获取目标用户绑定
        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId
        const primaryAccountId = await getCooldownPrimaryUserId(session)
        const sessionKeysForPri = await getSessionBindingKeys(ctx, session)
        const priView = await getPriorityUserDisplayForAnyKey(
          ctx,
          sessionKeysForPri.length ? sessionKeysForPri : [primaryAccountId],
        )
        const grpView = await getGroupPriorityDisplay(ctx, session)
        let statusInfo = `✅ 已绑定账号\n\n` +
                        `绑定时间: ${new Date(binding.bindTime).toLocaleString('zh-CN')}\n` +
                        `账户ID（通用）: ${primaryAccountId}\n` +
                        `授权状态: ${priView.isPriority ? '优先用户' : '普通用户'}\n` +
                        (priView.isPriority
                          ? (priView.permanent ? `到期时间: 永久\n` : `到期时间: ${priView.expiresAt!.toLocaleString('zh-CN')}\n`)
                          : '') +
                        (grpView.active
                          ? (`状态：群组优先\n` +
                            (grpView.permanent ? `本群授权到期：永久\n` : `本群授权到期：${grpView.expiresAt!.toLocaleString('zh-CN')}\n`))
                          : '')

        // 通过 user/data（扫码）获取最新账号状态
        let qrTextResultForCharge: { qrText: string; error?: string; chargeResult?: ChargeResult } | null = null

        const persistPreviewBinding = async (preview: UserPreview, qrCode?: string) => {
          const patch: Record<string, unknown> = {
            userName: preview.UserName,
            rating: preview.Rating ? String(preview.Rating) : undefined,
          }
          const numericUid = String(preview.UserID)
          if (isNumericMaiUid(numericUid)) {
            patch.maiUid = numericUid
            ;(binding as UserBinding).maiUid = numericUid
          }
          if (preview.UserName != null) {
            patch.boundPlayerName = String(preview.UserName).trim()
          }
          if (qrCode) {
            patch.lastQrCode = qrCode
            patch.lastQrCodeTime = new Date()
          }
          await ctx.database.set('maibot_bindings', { userId }, patch)
        }

        const applyPreviewToStatus = async (
          preview: UserPreview,
          chargeResult: ChargeResult,
          qrCode?: string,
        ) => {
          await persistPreviewBinding(preview, qrCode)
          statusInfo += formatAccountStatusBlock(preview)
          return chargeResult
        }

        try {
          const qrTextResult = await getQrText(session, ctx, api, binding, config, rebindTimeout)
          qrTextResultForCharge = qrTextResult
          if (qrTextResult.error) {
            statusInfo += `\n⚠️ 无法获取最新状态：${qrTextResult.error}`
          } else {
            try {
              const preview = await api.getPreview(machineInfo?.clientId ?? '', qrTextResult.qrText)
              const chargeUserId = isNumericMaiUid(String(preview.UserID))
                ? String(preview.UserID)
                : (isNumericMaiUid(binding.maiUid) ? binding.maiUid : undefined)
              const chargeResult = await api.getCharge(
                machineInfo.regionId,
                machineInfo.clientId,
                machineInfo.placeId,
                qrTextResult.qrText,
                chargeUserId ? { userId: chargeUserId } : undefined,
              )
              const cr = await applyPreviewToStatus(preview, chargeResult, qrTextResult.qrText)
              qrTextResultForCharge = { ...qrTextResult, chargeResult: cr }
            } catch (error) {
              logger.warn(`获取用户预览信息失败: ${sanitizeError(error)}`)
              statusInfo += `\n⚠️ 无法获取最新状态，请检查API服务`
            }
          }
        } catch (error) {
          // 如果获取失败，使用缓存的信息
          if (binding.userName) {
            statusInfo += `\n📊 账号信息（缓存）：\n` +
                         `用户名: ${binding.userName}\n` +
                         (binding.rating ? `Rating: ${binding.rating}\n` : '')
          }
          statusInfo += `\n⚠️ 无法获取最新状态，请检查API服务`
        }

        // 显示水鱼Token绑定状态
        if (binding.fishToken) {
          statusInfo += `\n\n🐟 水鱼Token: 已绑定`
        } else {
          statusInfo += `\n\n🐟 水鱼Token: 未绑定\n使用 /mai绑定水鱼 <token> 进行绑定`
        }

        // 显示落雪 Token 绑定状态
        if (binding.lxnsCode) {
          statusInfo += `\n\n❄️ 落雪 Token: 已绑定`
        } else {
          statusInfo += `\n\n❄️ 落雪 Token: 未绑定\n使用 /mai绑定落雪 <token> 进行绑定`
        }

        // 显示保护模式状态（如果未隐藏）
        if (!hideLockAndProtection) {
          if (binding.protectionMode) {
            statusInfo += `\n\n🛡️ 保护模式: 已开启\n使用 /mai保护模式 off 关闭`
          } else {
            statusInfo += `\n\n🛡️ 保护模式: 未开启\n使用 /mai保护模式 on 开启（自动锁定已下线的账号）`
          }

          // 显示锁定状态（不显示LoginId）
          if (binding.isLocked) {
            const lockTime = binding.lockTime 
              ? new Date(binding.lockTime).toLocaleString('zh-CN')
              : '未知'
            statusInfo += `\n\n🔒 锁定状态: 已锁定`
            statusInfo += `\n锁定时间: ${lockTime}`
            statusInfo += `\n使用 /mai解锁 可以解锁账号`
          } else {
            statusInfo += `\n\n🔒 锁定状态: 未锁定\n使用 /mai锁定 可以锁定账号（防止他人登录）`
          }
        }

        // 显示票券信息（使用新的getCharge API）
        try {
          if (qrTextResultForCharge && !qrTextResultForCharge.error) {
            // 如果已经在上面获取了 chargeResult，直接使用；否则重新获取
            let chargeResult: ChargeResult | undefined
            if (qrTextResultForCharge.chargeResult) {
              chargeResult = qrTextResultForCharge.chargeResult
            } else if (qrTextResultForCharge.qrText) {
              const chargeUserId = isNumericMaiUid(binding.maiUid) ? binding.maiUid : undefined
              chargeResult = await api.getCharge(
                machineInfo.regionId,
                machineInfo.clientId,
                machineInfo.placeId,
                qrTextResultForCharge.qrText,
                chargeUserId ? { userId: chargeUserId } : undefined,
              )
            }

            if (chargeResult?.ChargeStatus) {
              const ticketList = chargeResult.userChargeList ?? []
              const now = new Date()
              const validTickets: Array<{ chargeId: number; stock: number; validDate: string; purchaseDate: string }> = []
              const expiredTickets: Array<{ chargeId: number; stock: number; validDate: string; purchaseDate: string }> = []
              
              for (const ticket of ticketList) {
                const validDate = new Date(ticket.validDate)
                if (validDate > now) {
                  validTickets.push(ticket)
                } else {
                  expiredTickets.push(ticket)
                }
              }
              
              // 显示有效票券
              if (validTickets.length > 0 || (options?.expired && expiredTickets.length > 0)) {
                statusInfo += `\n\n🎫 票券情况：`
                
                if (validTickets.length > 0) {
                  statusInfo += `\n有效票券：`
                  for (const ticket of validTickets) {
                    const ticketName = getTicketName(ticket.chargeId)
                    const validDateStr = new Date(ticket.validDate).toLocaleString('zh-CN')
                    statusInfo += `\n  ${ticketName}: ${ticket.stock} 张（有效期至 ${validDateStr}）`
                  }
                }
                
                // 如果使用 --expired 选项，显示过期票券
                if (options?.expired && expiredTickets.length > 0) {
                  statusInfo += `\n过期票券：`
                  for (const ticket of expiredTickets) {
                    const ticketName = getTicketName(ticket.chargeId)
                    const validDateStr = new Date(ticket.validDate).toLocaleString('zh-CN')
                    statusInfo += `\n  ${ticketName}: ${ticket.stock} 张（已过期，过期时间 ${validDateStr}）`
                  }
                } else if (expiredTickets.length > 0) {
                  statusInfo += `\n（还有 ${expiredTickets.length} 种过期票券，使用 --expired 查看）`
                }
                
                // 显示免费票券
                if (chargeResult.userFreeChargeList && chargeResult.userFreeChargeList.length > 0) {
                  statusInfo += `\n免费票券：`
                  for (const freeTicket of chargeResult.userFreeChargeList) {
                    const ticketName = getTicketName(freeTicket.chargeId)
                    statusInfo += `\n  ${ticketName}: ${freeTicket.stock} 张`
                  }
                }
              } else {
                statusInfo += `\n\n🎫 票券情况: 暂无有效票券`
              }
            } else {
              statusInfo += `\n\n🎫 票券情况: 获取失败（${chargeResult?.ChargeStatus === false ? 'API返回失败' : '数据格式错误'}）`
            }
          }
        } catch (error: any) {
          logger.warn(`获取票券信息失败: ${sanitizeError(error)}`)
          statusInfo += `\n\n🎫 票券情况: 获取失败（${getSafeErrorMessage(error, session)}）`
        }

        const refId = await logOperation({
          command: 'mai状态',
          session,
          targetUserId,
          status: 'success',
          result: statusInfo,
        })

        return appendRefId(statusInfo, refId)
      } catch (error: any) {
        ctx.logger('maibot').error('查询状态失败:', error)
        const errorMessage = `❌ 查询状态失败: ${getSafeErrorMessage(error, session)}`
        const refId = await logOperation({
          command: 'mai状态',
          session,
          targetUserId,
          status: 'error',
          errorMessage: getSafeErrorMessage(error, session),
        })
        return appendRefId(errorMessage, refId)
      }
    })

  /**
   * 锁定账号（登录保持）
   * 用法: /mai锁定
   * @deprecated 锁定功能已在新API中移除，已注释
   */
  /*
  ctx.command('mai锁定 [targetUserId:text]', '锁定账号，防止他人登录')
    .userFields(['authority'])
    .option('bypass', '-bypass  绕过确认')
    .action(async ({ session, options }, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      // 检查隐藏模式
      if (hideLockAndProtection) {
        return '❌ 该功能已禁用'
      }

      const userId = session.userId
      try {
        const bindings = await ctx.database.get('maibot_bindings', { userId })
        if (bindings.length === 0) {
          return '❌ 请先绑定舞萌DX账号\n使用 /mai绑定 <SGWCMAID...> 进行绑定'
        }

        const binding = bindings[0]
        
        // 检查是否已经锁定
        if (binding.isLocked) {
          const lockTime = binding.lockTime 
            ? new Date(binding.lockTime).toLocaleString('zh-CN')
            : '未知'
          return `⚠️ 账号已经锁定\n锁定时间: ${lockTime}\n使用 /mai解锁 可以解锁账号`
        }

        // 确认操作
        if (!options?.bypass) {
          const confirm = await promptYesLocal(session, `⚠️ 即将锁定账号\n锁定后账号将保持登录状态，防止他人登录\n确认继续？`)
          if (!confirm) {
            return '操作已取消'
          }
        }

        await session.send('⏳ 正在锁定账号，请稍候...')

        // 调用登录API锁定账号
        const result = await api.login(
          binding.maiUid,
          machineInfo.regionId,
          machineInfo.placeId,
          machineInfo.clientId,
          turnstileToken,
        )

        if (!result.LoginStatus) {
          if (result.UserID === -2) {
            return '❌ 锁定失败：Turnstile校验失败，请检查token配置'
          }
          return '❌ 锁定失败，服务端未返回成功状态，请稍后重试。请点击获取二维码刷新账号后再试。'
        }

        // 保存锁定信息到数据库，同时关闭 maialert 推送（如果之前是开启的）
        const updateData: any = {
          isLocked: true,
          lockTime: new Date(),
          lockLoginId: result.LoginId,
        }
        
        // 如果之前开启了推送，锁定时自动关闭
        if (binding.alertEnabled === true) {
          updateData.alertEnabled = false
          logger.info(`用户 ${userId} 锁定账号，已自动关闭 maialert 推送`)
        }

        await ctx.database.set('maibot_bindings', { userId }, updateData)

        let message = `✅ 账号已锁定\n` +
               `锁定时间: ${new Date().toLocaleString('zh-CN')}\n\n`
        
        if (binding.alertEnabled === true) {
          message += `⚠️ 已自动关闭 maialert 推送（锁定期间不会收到上线/下线提醒）\n`
        }
        
        message += `使用 /mai解锁 可以解锁账号`

        return message
      } catch (error: any) {
        logger.error(`锁定账号失败: ${sanitizeError(error)}`)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        if (error?.response) {
          if (error.response.status === 401) {
            return `❌ 锁定失败：Turnstile校验失败，请检查token配置\n\n${maintenanceMessage}`
          }
          return `❌ API请求失败: ${error.response.status} ${error.response.statusText}\n\n${maintenanceMessage}`
        }
        return `❌ 锁定失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })
  */

  /**
   * 解锁账号（登出）
   * 用法: /mai解锁
   * @deprecated 解锁功能已在新API中移除，已注释
   */
  /*
  ctx.command('mai解锁 [targetUserId:text]', '解锁账号（仅限通过mai锁定指令锁定的账号）')
    .userFields(['authority'])
    .option('bypass', '-bypass  绕过确认')
    .alias('mai逃离小黑屋')
    .alias('mai逃离')
    .action(async ({ session, options }, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      // 检查隐藏模式
      if (hideLockAndProtection) {
        return '❌ 该功能已禁用'
      }

      try {
        // 获取目标用户绑定
        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId

        // 检查是否通过mai锁定指令锁定
        if (!binding.isLocked) {
          return '⚠️ 账号未锁定\n\n目前只能解锁由 /mai锁定 指令发起的账户。\n其他登录暂时无法解锁。'
        }

        // 确认操作
        if (!options?.bypass) {
          const proxyTip = isProxy ? `（代操作用户 ${userId}）` : ''
          const confirm = await promptYesLocal(session, `⚠️ 即将解锁账号${proxyTip}\n确认继续？`)
          if (!confirm) {
            return '操作已取消'
          }
        }

        await session.send('⏳ 正在解锁账号，请稍候...')

        const result = await api.logout(
          binding.maiUid,
          machineInfo.regionId.toString(),
          machineInfo.clientId,
          machineInfo.placeId.toString(),
          turnstileToken,
        )

        if (!result.LogoutStatus) {
          return '❌ 解锁失败，服务端未返回成功状态，请稍后重试'
        }

        // 清除锁定信息（如果开启了保护模式，不关闭保护模式，让它继续监控）
        await ctx.database.set('maibot_bindings', { userId }, {
          isLocked: false,
          lockTime: null,
          lockLoginId: null,
        })

        let message = `✅ 账号已解锁\n` +
               `建议稍等片刻再登录`
        
        // 如果开启了保护模式，提示用户保护模式会继续监控
        if (binding.protectionMode) {
          message += `\n\n🛡️ 保护模式仍开启，系统会在检测到账号下线时自动尝试锁定`
        }

        return message
      } catch (error: any) {
        logger.error(`解锁账号失败: ${sanitizeError(error)}`)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        if (error?.response) {
          return `❌ API请求失败: ${error.response.status} ${error.response.statusText}\n\n${maintenanceMessage}`
        }
        return `❌ 解锁失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })
  */

  /**
   * 绑定水鱼Token
   * 用法: /mai绑定水鱼 [fishToken]
   */
  ctx.command('mai绑定水鱼 [fishToken:text] [targetUserId:text]', '绑定水鱼Token用于B50上传')
    .userFields(['authority'])
    .action(async ({ session }, fishToken, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      // 检查白名单
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }

      try {
        // 获取目标用户绑定
        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId

        // 如果没有提供Token，提示用户交互式输入
        if (!fishToken) {
          const actualTimeout = rebindTimeout
          try {
            await session.send(`请在${actualTimeout / 1000}秒内发送水鱼Token（长度应在127-132字符之间）`)
            
            const promptSession = await waitForUserReply(session, ctx, actualTimeout)
            const promptText = promptSession?.content?.trim() || ''
            if (!promptText) {
              return `❌ 输入超时（${actualTimeout / 1000}秒），绑定已取消`
            }

            fishToken = promptText.trim()
            // 交互式输入的敏感信息，撤回用户输入消息
            if (promptSession) {
              await tryRecallMessage(promptSession, ctx, config, promptSession.messageId)
            }
          } catch (error: any) {
            logger.error(`等待用户输入水鱼Token失败: ${error?.message}`, error)
            if (error.message?.includes('超时') || error.message?.includes('timeout') || error.message?.includes('未收到响应')) {
              return `❌ 输入超时（${actualTimeout / 1000}秒），绑定已取消`
            }
            return `❌ 绑定失败：${getSafeErrorMessage(error, session)}`
          }
        }

        // 命令参数的敏感信息，尝试撤回
        await tryRecallMessage(session, ctx, config)

        // 验证Token长度
        if (fishToken.length < 127 || fishToken.length > 132) {
          return '❌ Token长度错误，应在127-132字符之间'
        }

        // 更新水鱼Token
        await ctx.database.set('maibot_bindings', { userId }, {
          fishToken,
        })

        return `✅ 水鱼Token绑定成功！\nToken: ${fishToken.substring(0, 8)}***${fishToken.substring(fishToken.length - 4)}`
      } catch (error: any) {
        ctx.logger('maibot').error('绑定水鱼Token失败:', error)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        return `❌ 绑定失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })

  /**
   * 解绑水鱼Token
   * 用法: /mai解绑水鱼
   */
  ctx.command('mai解绑水鱼 [targetUserId:text]', '解绑水鱼Token（保留舞萌DX账号绑定）')
    .userFields(['authority'])
    .action(async ({ session }, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      try {
        // 获取目标用户绑定
        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId

        // 检查是否已绑定水鱼Token
        if (!binding.fishToken) {
          return '❌ 您还没有绑定水鱼Token\n使用 /mai绑定水鱼 <token> 进行绑定'
        }

        // 清除水鱼Token（设置为空字符串）
        await ctx.database.set('maibot_bindings', { userId }, {
          fishToken: '',
        })

        return `✅ 水鱼Token解绑成功！\n已解绑的Token: ${binding.fishToken.substring(0, 8)}***${binding.fishToken.substring(binding.fishToken.length - 4)}\n\n舞萌DX账号绑定仍保留`
      } catch (error: any) {
        ctx.logger('maibot').error('解绑水鱼Token失败:', error)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        return `❌ 解绑失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })

  /**
   * 绑定落雪 Token
   * 用法: /mai绑定落雪 [token]
   */
  ctx.command('mai绑定落雪 [lxnsToken:text] [targetUserId:text]', '绑定落雪 Token 用于 B50 上传')
    .userFields(['authority'])
    .action(async ({ session }, lxnsToken, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      // 检查白名单
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }

      try {
        // 获取目标用户绑定
        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId

        // 如果没有提供落雪 Token，提示用户交互式输入
        if (!lxnsToken) {
          const actualTimeout = rebindTimeout
          try {
            await session.send(
              `请在${actualTimeout / 1000}秒内发送落雪 Token\n` +
              `获取地址：${LXNS_TOKEN_HINT_URL}`,
            )
            
            const promptSession = await waitForUserReply(session, ctx, actualTimeout)
            const promptText = promptSession?.content?.trim() || ''
            if (!promptText) {
              return `❌ 输入超时（${actualTimeout / 1000}秒），绑定已取消`
            }

            lxnsToken = promptText.trim()
            // 交互式输入的敏感信息，撤回用户输入消息
            if (promptSession) {
              await tryRecallMessage(promptSession, ctx, config, promptSession.messageId)
            }
          } catch (error: any) {
            logger.error(`等待用户输入落雪 Token 失败: ${error?.message}`, error)
            if (error.message?.includes('超时') || error.message?.includes('timeout') || error.message?.includes('未收到响应')) {
              return `❌ 输入超时（${actualTimeout / 1000}秒），绑定已取消`
            }
            return `❌ 绑定失败：${getSafeErrorMessage(error, session)}`
          }
        }

        // 命令参数的敏感信息，尝试撤回
        await tryRecallMessage(session, ctx, config)

        if (!isValidLxnsToken(lxnsToken)) {
          return lxnsTokenFormatError()
        }

        // 更新落雪 Token（数据库字段 lxnsCode 保留兼容）
        await ctx.database.set('maibot_bindings', { userId }, {
          lxnsCode: lxnsToken.trim(),
        })

        return `✅ 落雪 Token 绑定成功！\nToken: ${maskLxnsToken(lxnsToken)}`
      } catch (error: any) {
        ctx.logger('maibot').error('绑定落雪 Token 失败:', error)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        return `❌ 绑定失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })

  /**
   * 解绑落雪 Token
   * 用法: /mai解绑落雪
   */
  ctx.command('mai解绑落雪 [targetUserId:text]', '解绑落雪 Token（保留舞萌DX账号绑定）')
    .userFields(['authority'])
    .action(async ({ session }, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      try {
        // 获取目标用户绑定
        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId

        // 检查是否已绑定落雪 Token
        if (!binding.lxnsCode) {
          return '❌ 您还没有绑定落雪 Token\n使用 /mai绑定落雪 <token> 进行绑定'
        }

        // 清除落雪 Token
        await ctx.database.set('maibot_bindings', { userId }, {
          lxnsCode: '',
        })

        return `✅ 落雪 Token 解绑成功！\n已解绑: ${maskLxnsToken(binding.lxnsCode)}\n\n舞萌DX账号绑定仍保留`
      } catch (error: any) {
        ctx.logger('maibot').error('解绑落雪 Token 失败:', error)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        return `❌ 解绑失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })

  // public/team 均可用：公共网关已支持 /v1/*_manual 兼容（上传成绩 / 解锁收藏品等）
  {
  /**
   * 发票（2 或 3 倍票）
   * 用法: /mai发票 [倍数] [@用户id]，默认 2
   */
  ctx.command('mai发票 [multiple:number] [targetUserId:text]', '为账号发放功能票（2 或 3 倍）')
    .userFields(['authority'])
    .option('bypass', '-bypass  绕过确认')
    .action(async ({ session, options }, multipleInput, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      // 检查白名单
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }

      const multiple = multipleInput ? Number(multipleInput) : 2
      if (!Number.isInteger(multiple) || (multiple !== 2 && multiple !== 3)) {
        return '❌ 倍数只能是 2 或 3\n例如：/mai发票 3\n例如：/mai发票 2 @userid'
      }

      try {
        // 获取目标用户绑定
        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId
        const proxyTip = isProxy ? `（代操作用户 ${userId}）` : ''
        
        // 确认操作（如果未使用 -bypass）
        if (!options?.bypass) {
          const baseTip = `⚠️ 即将发放 ${multiple} 倍票${proxyTip}`
          const confirmFirst = await promptYesLocal(session, `${baseTip}\n操作具有风险，请谨慎\n确认继续？`)
          if (!confirmFirst) {
            return '操作已取消（确认未通过）'
          }
        }

        // 获取qr_text（交互式或从绑定中获取）
        const qrTextResult = await getQrText(session, ctx, api, binding, config, rebindTimeout)
        if (qrTextResult.error) {
          return `❌ 获取二维码失败：${qrTextResult.error}`
        }

        debugLog(session, 'mai发票 / qr_text 已获取', {
          fromCache: qrTextResult.fromCache,
          qrTextPrefix: qrTextResult.qrText?.substring(0, 12) + '...',
          multiple,
          targetUserId: binding.userId,
          playerLabel: formatBindingPlayerLabel(binding),
        })

        // Bot 侧发票队列限流（可选）
        await waitForChargeQueue(session)

        if (isPublicApi) {
          await session.send('⏳ 正在发放发票，请等待服务器响应（通常 2–3 分钟）…')
        } else if (!chargeRequestQueue) {
          await session.send('⏳ 正在提交发票充值任务…')
        }

        debugLog(session, 'mai发票 / 准备调用 getTicket', {
          regionId: isPublicApi ? undefined : machineInfo.regionId,
          clientId: isPublicApi ? undefined : machineInfo.clientId,
          placeId: isPublicApi ? undefined : machineInfo.placeId,
          ticketId: multiple,
          apiStyle: isPublicApi ? 'public' : 'team',
          baseURL: config.apiBaseURL,
        })

        // 使用新API获取功能票（需要qr_text）
        let ticketResult
        let usedCache = qrTextResult.fromCache === true
        try {
          ticketResult = await api.getTicket(
            isPublicApi ? undefined : machineInfo.regionId,
            isPublicApi ? undefined : machineInfo.clientId,
            isPublicApi ? undefined : machineInfo.placeId,
            multiple,
            qrTextResult.qrText
          )
          debugLog(session, 'mai发票 / getTicket 返回（首次）', ticketResult)
        } catch (error: any) {
          debugLog(session, 'mai发票 / getTicket 异常（首次）', {
            code: error?.code,
            status: error?.response?.status,
            message: error?.message,
            data: error?.response?.data,
          })
          // 如果使用了缓存且失败，尝试重新获取SGID
          if (usedCache) {
            logger.info('使用缓存的SGID失败，尝试重新获取SGID')
            const retryQrText = await getQrText(session, ctx, api, binding, config, rebindTimeout, undefined, false)  // 禁用缓存，强制重新输入
            if (retryQrText.error) {
              return `❌ 获取二维码失败：${retryQrText.error}`
            }
            await waitForChargeQueue(session)
            ticketResult = await api.getTicket(
              isPublicApi ? undefined : machineInfo.regionId,
              isPublicApi ? undefined : machineInfo.clientId,
              isPublicApi ? undefined : machineInfo.placeId,
              multiple,
              retryQrText.qrText
            )
            debugLog(session, 'mai发票 / getTicket 返回（异常重试）', ticketResult)
          } else {
            throw error
          }
        }

        if (!ticketResult.TicketStatus || !ticketResult.LoginStatus || !ticketResult.LogoutStatus) {
          debugLog(session, 'mai发票 / 状态不全 true', {
            TicketStatus: ticketResult.TicketStatus,
            LoginStatus: ticketResult.LoginStatus,
            LogoutStatus: ticketResult.LogoutStatus,
            QrStatus: ticketResult.QrStatus,
            usedCache,
          })
          // 如果使用了缓存且失败，尝试重新获取SGID
          if (usedCache && (!ticketResult.QrStatus || ticketResult.LoginStatus === false)) {
            logger.info('使用缓存的SGID失败，尝试重新获取SGID')
            const retryQrText = await getQrText(session, ctx, api, binding, config, rebindTimeout, undefined, false)  // 禁用缓存，强制重新输入
            if (retryQrText.error) {
              return `❌ 获取二维码失败：${retryQrText.error}`
            }
            await waitForChargeQueue(session)
            ticketResult = await api.getTicket(
              machineInfo.regionId,
              machineInfo.clientId,
              machineInfo.placeId,
              multiple,
              retryQrText.qrText
            )
            debugLog(session, 'mai发票 / getTicket 返回（缓存失败后重试）', ticketResult)
            if (!ticketResult.TicketStatus || !ticketResult.LoginStatus || !ticketResult.LogoutStatus) {
              if (!ticketResult.QrStatus || ticketResult.LoginStatus === false) {
                return `❌ 发放功能票失败：无法验证登录或二维码状态。\n${qrOrLoginFailureHint()}${debugDetailSuffix(session, ticketResult)}`
              }
              return `❌ 发票失败：服务器返回未成功，请确认是否已在短时间内多次执行发票指令或稍后再试或点击获取二维码刷新账号后再试。${debugDetailSuffix(session, ticketResult)}`
            }
          } else {
            if (!ticketResult.QrStatus || ticketResult.LoginStatus === false) {
              return `❌ 发放功能票失败：无法验证登录或二维码状态。\n${qrOrLoginFailureHint()}${debugDetailSuffix(session, ticketResult)}`
            }
            return `❌ 发票失败：服务器返回未成功，请确认是否已在短时间内多次执行发票指令或稍后再试或点击获取二维码刷新账号后再试。${debugDetailSuffix(session, ticketResult)}`
          }
        }

        const successMessage = isPublicApi
          ? `✅ 已发放 ${multiple} 倍票\n请稍等几分钟在游戏内确认`
          : `✅ ${multiple} 倍发票已加入充值队列${ticketResult.queueMsg ? `\n${ticketResult.queueMsg}` : ''}\n后台处理约需 2–3 分钟，完成后将 @ 您通知`
        const refId = await logOperation({
          command: 'mai发票',
          session,
          targetUserId,
          status: 'success',
          result: successMessage,
          apiResponse: {
            chargeId: multiple,
            qrTextPrefix: qrTextResult.qrText.substring(0, 48),
            clientId: machineInfo?.clientId,
            queueMsg: ticketResult.queueMsg,
          },
        })
        if (!isPublicApi) {
          scheduleChargeNotification(session, {
            chargeId: multiple,
            qrText: qrTextResult.qrText,
            submitRefId: refId,
          })
        }
        return appendRefId(successMessage, refId)
      } catch (error: any) {
        logger.error(`发票失败: ${sanitizeError(error)}`)
        const errorMessage = maintenanceMode 
          ? maintenanceMessage
          : (error?.response 
            ? `❌ API请求失败: ${error.response.status} ${error.response.statusText}\n\n${maintenanceMessage}`
            : `❌ 发票失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`)
        const refId = await logOperation({
          command: 'mai发票',
          session,
          targetUserId,
          status: 'error',
          errorMessage: getSafeErrorMessage(error, session),
          apiResponse: error?.response?.data,
        })
        return appendRefId(errorMessage, refId)
      }
    })

  }

  /**
   * 舞里程发放 / 签到
   * 用法: /mai舞里程 <里程数>
   * @deprecated 发舞里程功能已在新API中移除，已注释
   */
  /*
  ctx.command('mai舞里程 <mile:number> [targetUserId:text]', '为账号发放舞里程（maimile）')
    .userFields(['authority'])
    .option('bypass', '-bypass  绕过确认')
    .action(async ({ session, options }, mileInput, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      const mile = Number(mileInput)
      if (!Number.isInteger(mile) || mile <= 0) {
        return '❌ 舞里程必须是大于 0 的整数'
      }

      // 安全逻辑：必须是 1000 的倍数，且小于 99999
      if (mile % 1000 !== 0) {
        return '❌ 舞里程必须是 1000 的倍数，例如：1000 / 2000 / 5000'
      }
      if (mile >= 99999) {
        return '❌ 舞里程过大，请控制在 99999 以下'
      }

      try {
        // 获取目标用户绑定
        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId
        const proxyTip = isProxy ? `（代操作用户 ${userId}）` : ''
        
        // 确认操作（如果未使用 -bypass）
        if (!options?.bypass) {
          const baseTip = `⚠️ 即将为 ${formatBindingPlayerLabel(binding)} 发放 ${mile} 点舞里程${proxyTip}`
          const confirmFirst = await promptYesLocal(session, `${baseTip}\n操作具有风险，请谨慎`)
          if (!confirmFirst) {
            return '操作已取消（第一次确认未通过）'
          }

          const confirmSecond = await promptYesLocal(session, '二次确认：若理解风险，请再次输入 Y 执行')
          if (!confirmSecond) {
            return '操作已取消（第二次确认未通过）'
          }
        }

        await session.send('请求成功提交，请等待服务器响应。（通常需要2-3分钟）')

        const result = await api.maimile(
          binding.maiUid,
          mile,
          machineInfo.clientId,
          machineInfo.regionId,
          machineInfo.placeId,
          machineInfo.placeName,
          machineInfo.regionName,
        )

        if (
          result.MileStatus === false ||
          result.LoginStatus === false ||
          result.LogoutStatus === false
        ) {
          return '❌ 发放舞里程失败：服务器返回未成功，请稍后再试'
        }

        const current = typeof result.CurrentMile === 'number'
          ? `\n当前舞里程：${result.CurrentMile}`
          : ''

        return `✅ 已为 ${formatBindingPlayerLabel(binding)} 发放 ${mile} 点舞里程${current}`
      } catch (error: any) {
        logger.error(`发舞里程失败: ${sanitizeError(error)}`)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        if (error?.response) {
          return `❌ API请求失败: ${error.response.status} ${error.response.statusText}\n\n${maintenanceMessage}`
        }
        return `❌ 发放舞里程失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })
  */

  /**
   * 上传B50到水鱼
   * 用法: /mai上传B50 [@用户id]
   */
  ctx.command('mai上传B50 [qrCodeOrTarget:text]', '上传B50数据到水鱼')
    .alias('maiu')
    .userFields(['authority'])
    .action(async ({ session }, qrCodeOrTarget) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      // 检查白名单
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }

      let bindingUserId: string | undefined
      try {
        // 解析参数：可能是SGID或targetUserId
        let qrCode: string | undefined
        let targetUserId: string | undefined
        
        // 检查第一个参数是否是SGID或URL
        if (qrCodeOrTarget) {
          const processed = processSGID(qrCodeOrTarget)
          if (processed) {
            // 是SGID或URL，尝试撤回
            await tryRecallMessage(session, ctx, config)
            qrCode = processed.qrText
          } else {
            // 不是SGID，可能是targetUserId
            targetUserId = qrCodeOrTarget
          }
        }

        // 获取目标用户绑定
        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId
        bindingUserId = userId

        // 检查是否已绑定水鱼Token
        if (!binding.fishToken) {
          return '❌ 请先绑定水鱼Token\n使用 /mai绑定水鱼 <token> 进行绑定'
        }

        // 维护时间内直接提示，不发起上传请求
        const maintenanceMsg = getMaintenanceMessage(maintenanceNotice)
        if (maintenanceMsg) {
          return maintenanceMsg
        }

        // 获取qr_text（如果提供了SGID参数则直接使用，否则交互式获取）
        let qrTextResult
        if (qrCode) {
          const resolved = await resolveInlineQrText(qrCode, binding, session)
          if (resolved.error) {
            return resolved.error
          }
          qrTextResult = resolved
        } else {
          qrTextResult = await getQrText(session, ctx, api, binding, config, rebindTimeout)
        }
        if (qrTextResult.error) {
          return `❌ 获取二维码失败：${qrTextResult.error}`
        }

        const processingMsgIds = await sendB50ProcessingNotice(session, 'mai上传B50')
        const uploadStartedAt = Date.now()

        // 上传B50（使用新API，需要qr_text）
        let result
        let usedCache = qrTextResult.fromCache === true
        try {
          result = await api.uploadB50(
            machineInfo.regionId,
            machineInfo.clientId,
            machineInfo.placeId,
            qrTextResult.qrText,
            binding.fishToken
          )
        } catch (error: any) {
          // 如果使用了缓存且失败，尝试重新获取SGID
          if (usedCache) {
            logger.info('使用缓存的SGID失败，尝试重新获取SGID')
            const retryQrText = await getQrText(session, ctx, api, binding, config, rebindTimeout, undefined, false)  // 禁用缓存，强制重新输入
            if (retryQrText.error) {
              await recallBotMessages(session, processingMsgIds)
              return `❌ 获取二维码失败：${retryQrText.error}`
            }
            result = await api.uploadB50(
              machineInfo.regionId,
              machineInfo.clientId,
              machineInfo.placeId,
              retryQrText.qrText,
              binding.fishToken
            )
          } else {
            throw error
          }
        }

        if (!result.UploadStatus) {
          // 如果使用了缓存且失败，尝试重新获取SGID
          if (usedCache && (result.msg?.includes('二维码') || result.msg?.includes('qr_text') || result.msg?.includes('无效'))) {
            logger.info('使用缓存的SGID失败，尝试重新获取SGID')
            const retryQrText = await getQrText(session, ctx, api, binding, config, rebindTimeout, undefined, false)  // 禁用缓存，强制重新输入
            if (retryQrText.error) {
              const taskIdInfo = result.task_id ? `\n任务ID: ${result.task_id}` : ''
              await recallBotMessages(session, processingMsgIds)
              await setQrUploadSuccessFlag(ctx, userId, false)
              return `❌ 上传失败：${result.msg || '未知错误'}\n获取新二维码失败：${retryQrText.error}${taskIdInfo}`
            }
            result = await api.uploadB50(
              machineInfo.regionId,
              machineInfo.clientId,
              machineInfo.placeId,
              retryQrText.qrText,
              binding.fishToken
            )
            if (!result.UploadStatus) {
              if (result.msg === '该账号下存在未完成的任务') {
                return '⚠️ 当前账号已有未完成的水鱼B50任务，请耐心等待任务完成，预计1-10分钟，无需重复上传。'
              }
              const taskIdInfo = result.task_id ? `\n任务ID: ${result.task_id}` : ''
              await setQrUploadSuccessFlag(ctx, userId, false)
              return `❌ 上传失败：${result.msg || '未知错误'}${taskIdInfo}`
            }
          } else {
            if (result.msg === '该账号下存在未完成的任务') {
              return '⚠️ 当前账号已有未完成的水鱼B50任务，请耐心等待任务完成，预计1-10分钟，无需重复上传。'
            }
            if (result.msg?.includes('二维码') || result.msg?.includes('qr_text') || result.msg?.includes('无效')) {
              const taskIdInfo = result.task_id ? `\n任务ID: ${result.task_id}` : ''
              await setQrUploadSuccessFlag(ctx, userId, false)
              return `❌ 上传失败：${result.msg || '未知错误'}${taskIdInfo}\n${qrOrLoginFailureHint()}${getErrorHelpInfo()}`
            }
            const taskIdInfo = result.task_id ? `\n任务ID: ${result.task_id}` : ''
            await setQrUploadSuccessFlag(ctx, userId, false)
            return `❌ 上传失败：${result.msg || '未知错误'}${taskIdInfo}${getErrorHelpInfo()}`
          }
        }

        await setQrUploadSuccessFlag(ctx, userId, true)

        const successMessage = formatB50UploadSuccessMessage(result)
        const refId = await logOperation({
          command: 'mai上传B50',
          session,
          targetUserId,
          status: 'success',
          result: successMessage,
          apiResponse: { ...result, elapsedMs: Date.now() - uploadStartedAt },
        })

        if (isSyncB50Upload(result)) {
          await recallBotMessages(session, processingMsgIds)
          return appendRefId(successMessage, refId)
        }

        // 发送成功消息并获取消息ID（用于后续撤回）
        const successMsgIds = await sendAndGetMessageIds(session, appendRefId(successMessage, refId))
        // 合并处理中消息ID和成功消息ID
        const allMessageIds = [...processingMsgIds, ...successMsgIds]
        scheduleB50Notification(session, result.task_id, refId, allMessageIds)

        return ''  // 消息已发送，返回空字符串避免重复发送
      } catch (error: any) {
        if (bindingUserId) {
          await setQrUploadSuccessFlag(ctx, bindingUserId, false)
        }
        ctx.logger('maibot').error('上传B50失败:', error)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        // 处理请求超时类错误，统一提示
        if (error?.code === 'ECONNABORTED' || String(error?.message || '').includes('timeout')) {
          let msg = '水鱼B50任务 上传失败，请稍后再试一次。'
          const maintenanceMsg = getMaintenanceMessage(maintenanceNotice)
          if (maintenanceMsg) {
            msg += `\n${maintenanceMsg}`
          }
          msg += `\n\n${maintenanceMessage}${getErrorHelpInfo()}`
          return msg
        }
        if (error?.response) {
          return `❌ API请求失败: ${error.response.status} ${error.response.statusText}\n\n${maintenanceMessage}`
        }
        return `❌ 上传失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })

  /**
   * 同时上传B50到水鱼和落雪（SGID输入一次）
   * 用法: /maiua [SGID/网页地址] [@用户id]
   */
  ctx.command('maiua [qrCodeOrLxnsCode:text] [targetUserId:text]', '同时上传B50到水鱼和落雪（SGID只需一次）')
    .userFields(['authority'])
    .action(async ({ session }, qrCodeOrLxnsCode, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      // 检查白名单
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }

      try {
        // 解析参数：可能是 SGID/URL、落雪 Token 或目标用户
        let qrCode: string | undefined
        let lxnsToken: string | undefined
        let actualTargetUserId: string | undefined = targetUserId

        if (qrCodeOrLxnsCode) {
          const processed = processSGID(qrCodeOrLxnsCode)
          if (processed) {
            await tryRecallMessage(session, ctx, config)
            qrCode = processed.qrText
          } else if (isValidLxnsToken(qrCodeOrLxnsCode)) {
            lxnsToken = qrCodeOrLxnsCode.trim()
          } else {
            actualTargetUserId = qrCodeOrLxnsCode
          }
        }

        const { binding, isProxy, error } = await getTargetBinding(session, actualTargetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId
        const proxyTip = isProxy ? `（代操作用户 ${userId}）` : ''

        if (!binding.fishToken && !binding.lxnsCode && !lxnsToken) {
          return '❌ 请先绑定水鱼 Token 和落雪 Token\n使用 /mai绑定水鱼 <token> 和 /mai绑定落雪 <token> 进行绑定'
        }
        if (!binding.fishToken) {
          return '❌ 请先绑定水鱼 Token\n使用 /mai绑定水鱼 <token> 进行绑定'
        }
        const fishToken = binding.fishToken as string

        const finalLxnsToken = lxnsToken || binding.lxnsCode
        if (!finalLxnsToken) {
          return '❌ 请先绑定落雪 Token 或在指令中提供\n使用 /mai绑定落雪 <token> 或 /maiua <token>'
        }
        if (lxnsToken && !isValidLxnsToken(finalLxnsToken)) {
          return lxnsTokenFormatError()
        }

        const maintenanceMsg = getMaintenanceMessage(maintenanceNotice)
        if (maintenanceMsg) {
          return maintenanceMsg
        }

        // 获取qr_text（SGID输入一次）
        let qrTextResult
        if (qrCode) {
          const resolved = await resolveInlineQrText(qrCode, binding, session)
          if (resolved.error) {
            return resolved.error
          }
          qrTextResult = resolved
        } else {
          qrTextResult = await getQrText(session, ctx, api, binding, config, rebindTimeout)
        }

        if (qrTextResult.error) {
          return `❌ 获取二维码失败：${qrTextResult.error}`
        }

        const results: string[] = []
        await sendB50ProcessingNotice(session, ['mai上传B50', 'mai上传落雪b50'])
        const uaUploadStartedAt = Date.now()

        // 先上传水鱼B50，等待完成后再上传落雪（串行执行，避免同时登录）
        try {
          let fishResult = await api.uploadB50(
            machineInfo.regionId,
            machineInfo.clientId,
            machineInfo.placeId,
            qrTextResult.qrText,
            fishToken
          )

          // 如果使用了缓存且失败，尝试重新获取SGID
          if (qrTextResult.fromCache && !fishResult.UploadStatus && (fishResult.msg?.includes('二维码') || fishResult.msg?.includes('qr_text') || fishResult.msg?.includes('无效'))) {
            logger.info('使用缓存的SGID失败，尝试重新获取SGID')
            const retryQrText = await getQrText(session, ctx, api, binding, config, rebindTimeout, undefined, false)  // 禁用缓存，强制重新输入
            if (retryQrText.error) {
              const taskIdInfo = fishResult.task_id ? `\n任务ID: ${fishResult.task_id}` : ''
              return `🐟 水鱼: ❌ 上传失败：${fishResult.msg || '未知错误'}\n获取新二维码失败：${retryQrText.error}${taskIdInfo}`
            }
            fishResult = await api.uploadB50(
              machineInfo.regionId,
              machineInfo.clientId,
              machineInfo.placeId,
              retryQrText.qrText,
              fishToken
            )
          }

          if (!fishResult.UploadStatus) {
            if (fishResult.msg === '该账号下存在未完成的任务') {
              results.push('🐟 水鱼: ⚠️ 当前账号已有未完成的B50任务，请稍后再试，无需重复上传。')
            } else if (fishResult.msg?.includes('二维码') || fishResult.msg?.includes('qr_text') || fishResult.msg?.includes('无效')) {
              const taskIdInfo = fishResult.task_id ? `\n任务ID: ${fishResult.task_id}` : ''
              return `❌ 水鱼上传失败：${fishResult.msg || '未知错误'}${taskIdInfo}\n${qrOrLoginFailureHint()}`
            } else {
              const taskIdInfo = fishResult.task_id ? `\n任务ID: ${fishResult.task_id}` : ''
              results.push(`🐟 水鱼: ❌ 上传失败：${fishResult.msg || '未知错误'}${taskIdInfo}`)
            }
          } else {
            const successMessage = formatB50UploadSuccessMessage(fishResult, { prefix: '🐟 水鱼: ' })
            const refId = await logOperation({
              command: 'maiua-水鱼B50',
              session,
              targetUserId: actualTargetUserId,
              status: 'success',
              result: successMessage,
              apiResponse: { ...fishResult, elapsedMs: Date.now() - uaUploadStartedAt },
            })
            if (!isSyncB50Upload(fishResult)) {
              scheduleB50Notification(session, fishResult.task_id, refId)
            }
            results.push(appendRefId(successMessage, refId))
          }
        } catch (error: any) {
          // 如果使用了缓存且失败，尝试重新获取SGID
          if (qrTextResult.fromCache) {
            logger.info('使用缓存的SGID失败，尝试重新获取SGID')
            const retryQrText = await getQrText(session, ctx, api, binding, config, rebindTimeout, undefined, false)  // 禁用缓存，强制重新输入
            if (retryQrText.error) {
              return `🐟 水鱼: ❌ 获取二维码失败：${retryQrText.error}`
            }
            try {
              const fishResult = await api.uploadB50(
                machineInfo.regionId,
                machineInfo.clientId,
                machineInfo.placeId,
                retryQrText.qrText,
                fishToken
              )
              if (!fishResult.UploadStatus) {
                if (fishResult.msg === '该账号下存在未完成的任务') {
                  results.push('🐟 水鱼: ⚠️ 当前账号已有未完成的B50任务，请稍后再试，无需重复上传。')
                } else {
                  const taskIdInfo = fishResult.task_id ? `\n任务ID: ${fishResult.task_id}` : ''
                  return `🐟 水鱼: ❌ 上传失败：${fishResult.msg || '未知错误'}${taskIdInfo}`
                }
              } else {
                if (!isSyncB50Upload(fishResult)) {
                  scheduleB50Notification(session, fishResult.task_id)
                }
                results.push(formatB50UploadSuccessMessage(fishResult, { prefix: '🐟 水鱼: ' }))
              }
            } catch (retryError: any) {
              if (retryError?.code === 'ECONNABORTED' || String(retryError?.message || '').includes('timeout')) {
                return '🐟 水鱼: ❌ 上传超时，请稍后再试一次。'
              }
              if (retryError?.response) {
                return `🐟 水鱼: ❌ API请求失败: ${retryError.response.status} ${retryError.response.statusText}`
              }
              return `🐟 水鱼: ❌ 上传失败: ${retryError?.message || '未知错误'}`
            }
          } else {
            if (error?.code === 'ECONNABORTED' || String(error?.message || '').includes('timeout')) {
              return '🐟 水鱼: ❌ 上传超时，请稍后再试一次。'
            }
            if (error?.response) {
              return `🐟 水鱼: ❌ API请求失败: ${error.response.status} ${error.response.statusText}`
            }
            return `🐟 水鱼: ❌ 上传失败: ${getSafeErrorMessage(error, session)}`
          }
        }

        // 等待水鱼上传完成后再上传落雪（避免同时登录导致失败）
        // 上传落雪B50
        const lxUploadStartedAt = Date.now()
        try {
          let lxResult = await api.uploadLxB50(
            machineInfo.regionId,
            machineInfo.clientId,
            machineInfo.placeId,
            qrTextResult.qrText,
            finalLxnsToken
          )

          // 如果使用了缓存且失败，尝试重新获取SGID
          if (qrTextResult.fromCache && !lxResult.UploadStatus && (lxResult.msg?.includes('二维码') || lxResult.msg?.includes('qr_text') || lxResult.msg?.includes('无效'))) {
            logger.info('使用缓存的SGID失败，尝试重新获取SGID')
            const retryQrText = await getQrText(session, ctx, api, binding, config, rebindTimeout, undefined, false)  // 禁用缓存，强制重新输入
            if (retryQrText.error) {
              const taskIdInfo = lxResult.task_id ? `\n任务ID: ${lxResult.task_id}` : ''
              results.push(`❄️ 落雪: ❌ 上传失败：${lxResult.msg || '未知错误'}\n获取新二维码失败：${retryQrText.error}${taskIdInfo}`)
            } else {
              lxResult = await api.uploadLxB50(
                machineInfo.regionId,
                machineInfo.clientId,
                machineInfo.placeId,
                retryQrText.qrText,
                finalLxnsToken
              )
            }
          }

          if (!lxResult.UploadStatus) {
            if (lxResult.msg === '该账号下存在未完成的任务') {
              results.push('❄️ 落雪: ⚠️ 当前账号已有未完成的B50任务，请稍后再试，无需重复上传。')
            } else if (lxResult.msg?.includes('二维码') || lxResult.msg?.includes('qr_text') || lxResult.msg?.includes('无效')) {
              const taskIdInfo = lxResult.task_id ? `\n任务ID: ${lxResult.task_id}` : ''
              return `❌ 落雪上传失败：${lxResult.msg || '未知错误'}${taskIdInfo}\n${qrOrLoginFailureHint()}`
            } else {
              const taskIdInfo = lxResult.task_id ? `\n任务ID: ${lxResult.task_id}` : ''
              results.push(`❄️ 落雪: ❌ 上传失败：${lxResult.msg || '未知错误'}${taskIdInfo}`)
            }
          } else {
            const successMessage = formatB50UploadSuccessMessage(lxResult, { prefix: '❄️ 落雪: ' })
            const refId = await logOperation({
              command: 'maiua-落雪B50',
              session,
              targetUserId: actualTargetUserId,
              status: 'success',
              result: successMessage,
              apiResponse: { ...lxResult, elapsedMs: Date.now() - lxUploadStartedAt },
            })
            if (!isSyncB50Upload(lxResult)) {
              scheduleLxB50Notification(session, lxResult.task_id, refId)
            }
            results.push(appendRefId(successMessage, refId))
          }
        } catch (error: any) {
          // 如果使用了缓存且失败，尝试重新获取SGID
          if (qrTextResult.fromCache) {
            logger.info('使用缓存的SGID失败，尝试重新获取SGID')
            const retryQrText = await getQrText(session, ctx, api, binding, config, rebindTimeout, undefined, false)  // 禁用缓存，强制重新输入
            if (retryQrText.error) {
              results.push(`❄️ 落雪: ❌ 获取二维码失败：${retryQrText.error}`)
            } else {
              try {
                const lxResult = await api.uploadLxB50(
                  machineInfo.regionId,
                  machineInfo.clientId,
                  machineInfo.placeId,
                  retryQrText.qrText,
                  finalLxnsToken
                )
                if (!lxResult.UploadStatus) {
                  if (lxResult.msg === '该账号下存在未完成的任务') {
                    results.push('❄️ 落雪: ⚠️ 当前账号已有未完成的B50任务，请稍后再试，无需重复上传。')
                  } else {
                    const taskIdInfo = lxResult.task_id ? `\n任务ID: ${lxResult.task_id}` : ''
                    results.push(`❄️ 落雪: ❌ 上传失败：${lxResult.msg || '未知错误'}${taskIdInfo}`)
                  }
                } else {
                  const successMessage = formatB50UploadSuccessMessage(lxResult, { prefix: '❄️ 落雪: ' })
                  const refId = await logOperation({
                    command: 'maiua-落雪B50',
                    session,
                    targetUserId: actualTargetUserId,
                    status: 'success',
                    result: successMessage,
                    apiResponse: { ...lxResult, elapsedMs: Date.now() - lxUploadStartedAt },
                  })
                  if (!isSyncB50Upload(lxResult)) {
                    scheduleLxB50Notification(session, lxResult.task_id, refId)
                  }
                  results.push(appendRefId(successMessage, refId))
                }
              } catch (retryError: any) {
                if (retryError?.code === 'ECONNABORTED' || String(retryError?.message || '').includes('timeout')) {
                  results.push('❄️ 落雪: ❌ 上传超时，请稍后再试一次。')
                } else if (retryError?.response) {
                  results.push(`❄️ 落雪: ❌ API请求失败: ${retryError.response.status} ${retryError.response.statusText}`)
                } else {
                  results.push(`❄️ 落雪: ❌ 上传失败: ${retryError?.message || '未知错误'}`)
                }
              }
            }
          } else {
            if (error?.code === 'ECONNABORTED' || String(error?.message || '').includes('timeout')) {
              results.push('❄️ 落雪: ❌ 上传超时，请稍后再试一次。')
            } else if (error?.response) {
              results.push(`❄️ 落雪: ❌ API请求失败: ${error.response.status} ${error.response.statusText}`)
            } else {
              results.push(`❄️ 落雪: ❌ 上传失败: ${getSafeErrorMessage(error, session)}`)
            }
          }
        }

        if (results.length === 0) {
          return `⚠️ 未能发起上传请求${proxyTip}`
        }

        return `${results.join('\n\n')}${proxyTip ? `\n${proxyTip}` : ''}`
      } catch (error: any) {
        logger.error(`双上传B50失败: ${sanitizeError(error)}`)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        if (error?.response) {
          return `❌ API请求失败: ${error.response.status} ${error.response.statusText}\n\n${maintenanceMessage}`
        }
        return `❌ 双上传失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })

  /**
   * 清空功能票
   * 用法: /mai清票
   * @deprecated 清票功能已在新API中移除，已注释
   */
  /*
  ctx.command('mai清票 [targetUserId:text]', '清空账号的所有功能票')
    .userFields(['authority'])
    .option('bypass', '-bypass  绕过确认')
    .action(async ({ session, options }, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      try {
        // 获取目标用户绑定
        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId
        const proxyTip = isProxy ? `（代操作用户 ${userId}）` : ''
        
        // 确认操作（如果未使用 -bypass）
        if (!options?.bypass) {
          const confirm = await promptYesLocal(session, `⚠️ 即将清空 ${formatBindingPlayerLabel(binding)} 的所有功能票${proxyTip}，确认继续？`)
          if (!confirm) {
            return '操作已取消'
          }
        }

        await session.send('请求成功提交，请等待服务器响应。（通常需要2-3分钟）')

        const result = await api.clearTicket(
          binding.maiUid,
          machineInfo.clientId,
          machineInfo.regionId,
          machineInfo.placeId,
          machineInfo.placeName,
          machineInfo.regionName,
        )

        // 检查4个状态字段是否都是 true
        const loginStatus = result.LoginStatus === true
        const logoutStatus = result.LogoutStatus === true
        const userAllStatus = result.UserAllStatus === true
        const userLogStatus = result.UserLogStatus === true

        // 如果4个状态都是 true，则清票成功
        if (loginStatus && logoutStatus && userAllStatus && userLogStatus) {
          return `✅ 已清空 ${formatBindingPlayerLabel(binding)} 的所有功能票`
        }

        // 如果4个状态都是 false，需要重新绑定二维码
        if (checkAllStatusFalse(result)) {
          await session.send('🔄 二维码已失效，需要重新绑定后才能继续操作')
          const rebindResult = await promptForRebind(session, ctx, api, binding, config, rebindTimeout)
          if (rebindResult.success && rebindResult.newBinding) {
            // 重新绑定成功后，尝试再次清票
            try {
              await session.send('⏳ 重新绑定成功，正在重新执行清票操作...')
              const retryResult = await api.clearTicket(
                rebindResult.newBinding.maiUid,
                machineInfo.clientId,
                machineInfo.regionId,
                machineInfo.placeId,
                machineInfo.placeName,
                machineInfo.regionName,
              )
              
              if (checkAllStatusFalse(retryResult)) {
                await session.send('❌ 重新绑定后清票仍然失败，请检查二维码是否正确')
                return `❌ 重新绑定后清票仍然失败\n错误信息： ${JSON.stringify(retryResult)}`
              }
              
              const retryLoginStatus = retryResult.LoginStatus === true
              const retryLogoutStatus = retryResult.LogoutStatus === true
              const retryUserAllStatus = retryResult.UserAllStatus === true
              const retryUserLogStatus = retryResult.UserLogStatus === true

              if (retryLoginStatus && retryLogoutStatus && retryUserAllStatus && retryUserLogStatus) {
                return `✅ 重新绑定成功！已清空 ${formatBindingPlayerLabel(rebindResult.newBinding)} 的所有功能票`
              }
              
              return `⚠️ 重新绑定成功，但清票部分失败\n错误信息： ${JSON.stringify(retryResult)}`
            } catch (retryError) {
              logger.error('重新绑定后清票失败:', retryError)
              return `✅ 重新绑定成功，但清票操作失败，请稍后重试`
            }
          } else {
            return `❌ 重新绑定失败：${rebindResult.error || '未知错误'}\n请使用 /mai绑定 重新绑定二维码`
          }
        }

        // 其他失败情况，显示详细错误信息
        return `❌ 清票失败\n错误信息： ${JSON.stringify(result)}`
      } catch (error: any) {
        logger.error(`清票失败: ${sanitizeError(error)}`)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        if (error?.response) {
          const errorInfo = error.response.data ? JSON.stringify(error.response.data) : `${error.response.status} ${error.response.statusText}`
          return `❌ API请求失败\n错误信息： ${errorInfo}\n\n${maintenanceMessage}`
        }
        return `❌ 清票失败\n错误信息： ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })
  */

  // 查询B50任务状态功能已暂时取消

  if (!isPublicApi) {
  /**
   * 获取收藏品
   * 用法: /mai获取收藏品 或 /mai获取收藏品 <SGID或链接> 或 /mai发收藏品
   * 流程：选择类别 → 输入收藏品 ID → 输入数量（默认 1）→ 发送 SGID（或使用缓存/命令参数）→ 提交
   */
  ctx.command('mai获取收藏品 [qrCodeOrTarget:text]', '为账号获取收藏品（交互式选择类别、ID 与数量；可选首参传 SGID 或链接）')
    .alias('mai发收藏品')
    .userFields(['authority'])
    .option('bypass', '-bypass  绕过确认')
    .action(async ({ session, options }, qrCodeOrTarget) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }

      try {
        // 解析首参：可为 SGID/链接 或 目标用户（代操作）
        let qrCode: string | undefined
        let targetUserId: string | undefined
        if (qrCodeOrTarget) {
          const processed = processSGID(qrCodeOrTarget)
          if (processed) {
            await tryRecallMessage(session, ctx, config)
            qrCode = processed.qrText
          } else {
            targetUserId = qrCodeOrTarget
          }
        }

        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId
        const proxyTip = isProxy ? `（代操作用户 ${userId}）` : ''

        // 交互式选择收藏品类别
        const itemKind = await promptCollectionType(session, 60000, (enableMaimile || isDebugSession(session)) ? [] : [13, 15])
        if (itemKind === null) {
          return '操作已取消'
        }

        const selectedType = COLLECTION_TYPE_OPTIONS.find(opt => opt.value === itemKind)

        let itemId = '0'
        if (itemKind !== 13) {
          await session.send(
            `已选择：${selectedType?.label}\n\n` +
            `请输入收藏品 ID（数字）\n` +
            `若不知道 ID，可前往 https://sdgb.lemonno.xyz/ 查询；乐曲解禁请输入乐曲 ID。\n\n` +
            INTERACTIVE_CANCEL_HINT
          )

          const promptSession = await waitForUserReply(session, ctx, 60000)
          const itemIdInput = promptSession?.content?.trim() || ''
          if (!itemIdInput || isInteractiveCancel(itemIdInput)) {
            return '操作已取消'
          }

          itemId = itemIdInput.trim()
          if (!/^\d+$/.test(itemId)) {
            return '❌ 收藏品 ID 必须为数字，请重新输入'
          }
        }

        const UNLOCK_LOCK_KINDS = new Set([1, 2, 3, 5, 6, 7])
        const isUnlockLockKind = UNLOCK_LOCK_KINDS.has(itemKind)
        const isFixedOneKind = itemKind === 9 // 旅行伙伴固定数量1

        let stockFinal: number
        if (isFixedOneKind) {
          stockFinal = 1
        } else if (isUnlockLockKind) {
          await session.send(
            `请输入操作模式（数字）：\n` +
            `  0 = 锁定\n` +
            `  1 = 解锁（默认）\n\n` +
            INTERACTIVE_CANCEL_HINT
          )
          const promptStock = await waitForUserReply(session, ctx, 60000)
          const stockInput = promptStock?.content?.trim() ?? '1'
          if (isInteractiveCancel(stockInput)) {
            return '操作已取消'
          }
          const itemStock = parseInt(stockInput, 10)
          if (itemStock !== 0 && itemStock !== 1) {
            return '❌ 只能输入 0（锁定）或 1（解锁）'
          }
          stockFinal = itemStock
        } else {
          const stockLimit = itemKind === 13 ? 99999 : 999
          await session.send(`请输入获取数量（正整数，最大 ${stockLimit}）。${INTERACTIVE_CANCEL_HINT}`)
          const promptStock = await waitForUserReply(session, ctx, 60000)
          const stockInput = promptStock?.content?.trim() ?? '1'
          if (isInteractiveCancel(stockInput)) {
            return '操作已取消'
          }
          const itemStock = parseInt(stockInput, 10)
          if (!Number.isInteger(itemStock) || itemStock < 1) {
            return '❌ 数量必须为正整数，请重新执行指令并输入有效数量'
          }
          stockFinal = Math.min(itemStock, stockLimit)
        }

        // 确认操作（如果未使用 -bypass）
        if (!options?.bypass) {
          const stockLabel = isUnlockLockKind ? (stockFinal === 0 ? '锁定' : '解锁') : `数量: ${stockFinal}`
          const confirm = await promptYesLocal(
            session,
              `⚠️ 即将为 ${formatBindingPlayerLabel(binding)} 获取收藏品${proxyTip}\n类型: ${selectedType?.label}` +
              (itemKind === 13 ? '' : `\nID: ${itemId}`) +
              `\n${stockLabel}\n确认继续？`
          )
          if (!confirm) {
            return '操作已取消'
          }
        }

        // 获取 qr_text：命令带 SGID/链接则校验并使用（并更新缓存）；否则交互式获取或使用缓存（与上传 B50 一致）
        let qrTextResult: { qrText: string; error?: string; fromCache?: boolean }
        if (qrCode) {
          const resolved = await resolveInlineQrText(qrCode, binding, session)
          if (resolved.error) {
            return resolved.error
          }
          qrTextResult = resolved
        } else {
          qrTextResult = await getQrText(session, ctx, api, binding, config, rebindTimeout)
          if (qrTextResult.error) {
            return `❌ 获取二维码失败：${qrTextResult.error}`
          }
        }

        await session.send('请求已提交，请等待服务器响应。（通常约 2–3 分钟）')

        // 根据收藏品类型选择对应的 API
        let result
        let usedCache = qrTextResult.fromCache === true
        try {
          if (itemKind === 5) {
            // 乐曲解禁：使用 unlock_music_manual
            result = await api.unlockMusicManual(
              qrTextResult.qrText,
              parseInt(itemId, 10),
              stockFinal,
              0 // remaster 默认 0（不解锁白谱）
            )
          } else if (itemKind === 6) {
            // 解锁 Master：使用 unlock_music_manual
            result = await api.unlockMusicManual(
              qrTextResult.qrText,
              parseInt(itemId, 10),
              stockFinal,
              0
            )
          } else if (itemKind === 7) {
            // 解锁 Re:Master：使用 unlock_music_manual
            result = await api.unlockMusicManual(
              qrTextResult.qrText,
              parseInt(itemId, 10),
              stockFinal,
              1 // remaster=1 解锁 Re:MASTER
            )
          } else if (itemKind === 8) {
            // 解锁黑铺：使用 unlock_music_manual（仅白谱）
            result = await api.unlockMusicManual(
              qrTextResult.qrText,
              parseInt(itemId, 10),
              stockFinal,
              2 // remaster=2 仅白谱
            )
          } else {
            // 其他收藏品：使用 unlock_single_item_manual
            // 映射旧 itemKind 到新 API 的 item_kind
            let apiItemKind = itemKind
            if (itemKind === 1) apiItemKind = 1 // 姓名框
            else if (itemKind === 2) apiItemKind = 2 // 称号
            else if (itemKind === 3) apiItemKind = 3 // 头像
            else if (itemKind === 9) apiItemKind = 10 // 旅行伙伴 -> 搭档 (10)
            else if (itemKind === 10) apiItemKind = 10 // 搭档
            else if (itemKind === 11) apiItemKind = 11 // 背景板
            else if (itemKind === 12) apiItemKind = 12 // 功能票
            else if (itemKind === 13) apiItemKind = 13 // 舞里程
            else if (itemKind === 14) apiItemKind = 14 // 米奇妙妙屋
            else if (itemKind === 15) apiItemKind = 15 // KALEIDXSCOPE
            else apiItemKind = itemKind

            result = await api.unlockSingleItemManual(
              qrTextResult.qrText,
              parseInt(itemId, 10),
              apiItemKind,
              stockFinal
            )
          }
        } catch (error: any) {
          if (usedCache) {
            logger.info('使用缓存的SGID失败，尝试重新获取SGID')
            const retryQrText = await getQrText(session, ctx, api, binding, config, rebindTimeout, undefined, false)
            if (retryQrText.error) {
              return `❌ 获取二维码失败：${retryQrText.error}`
            }
            // 重试同样的 API 调用
            if (itemKind === 5 || itemKind === 6 || itemKind === 7 || itemKind === 8) {
              let remaster = 0
              if (itemKind === 7) remaster = 1
              if (itemKind === 8) remaster = 2
              result = await api.unlockMusicManual(
                retryQrText.qrText,
                parseInt(itemId, 10),
                stockFinal,
                remaster
              )
            } else {
              let apiItemKind = itemKind
              if (itemKind === 1) apiItemKind = 1
              else if (itemKind === 2) apiItemKind = 2
              else if (itemKind === 3) apiItemKind = 3
              else if (itemKind === 9) apiItemKind = 10
              else if (itemKind === 10) apiItemKind = 10
              else if (itemKind === 11) apiItemKind = 11
              else if (itemKind === 12) apiItemKind = 12
              else if (itemKind === 13) apiItemKind = 13
              else if (itemKind === 14) apiItemKind = 14
              else if (itemKind === 15) apiItemKind = 15
              result = await api.unlockSingleItemManual(
                retryQrText.qrText,
                parseInt(itemId, 10),
                apiItemKind,
                stockFinal
              )
            }
          } else {
            throw error
          }
        }

        // 新 API 返回格式：{ success: boolean, result?: { returnCode, apiName }, msg?: string }
        if (!result.success || (result.result && result.result.returnCode !== 1)) {
          const errorMsg = result.msg || '服务器返回未成功'
          if (usedCache && (errorMsg.includes('二维码') || errorMsg.includes('qr_text') || errorMsg.includes('无效') || errorMsg.includes('登录'))) {
            logger.info('使用缓存的SGID失败，尝试重新获取SGID')
            const retryQrText = await getQrText(session, ctx, api, binding, config, rebindTimeout, undefined, false)
            if (retryQrText.error) {
              return `❌ 获取二维码失败：${retryQrText.error}`
            }
            // 重试
            if (itemKind === 5 || itemKind === 6 || itemKind === 7 || itemKind === 8) {
              let remaster = 0
              if (itemKind === 7) remaster = 1
              if (itemKind === 8) remaster = 2
              result = await api.unlockMusicManual(
                retryQrText.qrText,
                parseInt(itemId, 10),
                stockFinal,
                remaster
              )
            } else {
              let apiItemKind = itemKind
              if (itemKind === 1) apiItemKind = 1
              else if (itemKind === 2) apiItemKind = 2
              else if (itemKind === 3) apiItemKind = 3
              else if (itemKind === 9) apiItemKind = 10
              else if (itemKind === 10) apiItemKind = 10
              else if (itemKind === 11) apiItemKind = 11
              else if (itemKind === 12) apiItemKind = 12
              else if (itemKind === 13) apiItemKind = 13
              else if (itemKind === 14) apiItemKind = 14
              else if (itemKind === 15) apiItemKind = 15
              result = await api.unlockSingleItemManual(
                retryQrText.qrText,
                parseInt(itemId, 10),
                apiItemKind,
                stockFinal
              )
            }
            if (!result.success || (result.result && result.result.returnCode !== 1)) {
              return `❌ 获取收藏品失败：${result.msg || '服务器返回未成功'}\n${qrOrLoginFailureHint()}`
            }
          } else {
            return `❌ 获取收藏品失败：${errorMsg}\n${qrOrLoginFailureHint()}`
          }
        }

        const resultLabel = isUnlockLockKind ? (stockFinal === 0 ? '锁定' : '解锁') : `数量: ${stockFinal}`
        return `✅ 已为 ${formatBindingPlayerLabel(binding)} 获取收藏品${proxyTip}\n类型: ${selectedType?.label}` +
               (itemKind === 13 ? '' : `\nID: ${itemId}`) +
               `\n${resultLabel}`
      } catch (error: any) {
        logger.error(`获取收藏品失败: ${sanitizeError(error)}`)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        if (error?.response) {
          return `❌ API请求失败: ${error.response.status} ${error.response.statusText}\n\n${maintenanceMessage}`
        }
        return `❌ 获取收藏品失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })

  /**
   * 修改版本号
   * 用法: /mai修改版本号 或 /mai修改版本号 <SGID或链接>
   */
  ctx.command('mai修改版本号 [qrCodeOrTarget:text]', '修改账号游戏版本号（可选首参传 SGID 或链接；支持缓存）')
    .userFields(['authority'])
    .option('bypass', '-bypass  绕过确认')
    .action(async ({ session, options }, qrCodeOrTarget) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }

      try {
        let qrCode: string | undefined
        let targetUserId: string | undefined
        if (qrCodeOrTarget) {
          const processed = processSGID(qrCodeOrTarget)
          if (processed) {
            await tryRecallMessage(session, ctx, config)
            qrCode = processed.qrText
          } else {
            targetUserId = qrCodeOrTarget
          }
        }

        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const proxyTip = isProxy ? `（代操作用户 ${binding.userId}）` : ''

        let qrTextResult: { qrText: string; error?: string; fromCache?: boolean }
        if (qrCode) {
          const resolved = await resolveInlineQrText(qrCode, binding, session)
          if (resolved.error) {
            return resolved.error
          }
          qrTextResult = resolved
        } else {
          qrTextResult = await getQrText(session, ctx, api, binding, config, rebindTimeout)
          if (qrTextResult.error) {
            return `❌ 获取二维码失败：${qrTextResult.error}`
          }
        }

        let currentRom = ''
        let currentData = ''
        if (!tokenOnlyModeEnabled) {
          try {
            const preview = await api.getPreview(machineInfo?.clientId ?? '', qrTextResult.qrText)
            if (preview.RomVersion) currentRom = preview.RomVersion
            if (preview.DataVersion) currentData = preview.DataVersion
          } catch {
            // 忽略预览失败，继续让用户输入
          }
        }

        const versionHint = currentRom || currentData
          ? `\n当前账号：机台版本 ${currentRom || '未知'}，数据版本 ${currentData || '未知'}。`
          : ''

        await session.send(
          `请输入新机台版本号 (rom_ver)，例如 1.53.10${versionHint}\n输入 0 取消`
        )
        const promptSessionRom = await waitForUserReply(session, ctx, 60000)
        const romVer = promptSessionRom?.content?.trim() || ''
        if (!romVer || romVer === '0') {
          return '操作已取消'
        }

        await session.send('请输入新数据版本号 (data_ver)，例如 1.53.00\n输入 0 取消')
        const promptSessionData = await waitForUserReply(session, ctx, 60000)
        const dataVer = promptSessionData?.content?.trim() || ''
        if (!dataVer || dataVer === '0') {
          return '操作已取消'
        }

        if (!options?.bypass) {
          const confirm = await promptYesLocal(
            session,
            `⚠️ 即将为 ${formatBindingPlayerLabel(binding)} 修改版本号${proxyTip}\n机台版本: ${romVer}\n数据版本: ${dataVer}\n确认继续？`
          )
          if (!confirm) {
            return '操作已取消'
          }
        }

        await session.send('请求已提交，请等待服务器响应。（通常需要约 2–3 分钟）')

        let result
        try {
          result = await api.editVer(
            machineInfo.regionId,
            machineInfo.regionName,
            machineInfo.clientId,
            machineInfo.placeId,
            machineInfo.placeName,
            romVer,
            dataVer,
            qrTextResult.qrText
          )
        } catch (error: any) {
          throw error
        }

        if (!result.UserAllStatus || !result.LoginStatus || !result.LogoutStatus) {
          if (!result.QrStatus || result.LoginStatus === false) {
            return `❌ 修改版本号失败：无法验证登录或二维码状态。\n${qrOrLoginFailureHint()}`
          }
          return '❌ 修改版本号失败：服务器返回未成功，请稍后再试或刷新二维码后再试。'
        }

        return `✅ 已为 ${formatBindingPlayerLabel(binding)} 修改版本号${proxyTip}\n机台版本: ${romVer}\n数据版本: ${dataVer}`
      } catch (error: any) {
        logger.error(`修改版本号失败: ${sanitizeError(error)}`)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        if (error?.response) {
          return `❌ API请求失败: ${error.response.status} ${error.response.statusText}\n\n${maintenanceMessage}`
        }
        return `❌ 修改版本号失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })

  }

  /**
   * 清收藏品
   * 用法: /mai清收藏品
   * @deprecated 清收藏品功能已在新API中移除，已注释
   */
  /*
  ctx.command('mai清收藏品 [targetUserId:text]', '清空收藏品')
    .userFields(['authority'])
    .option('bypass', '-bypass  绕过确认')
    .action(async ({ session, options }, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      try {
        // 获取目标用户绑定
        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId

        // 交互式选择收藏品类别
        const itemKind = await promptCollectionType(session)
        if (itemKind === null) {
          return '操作已取消'
        }

        const selectedType = COLLECTION_TYPE_OPTIONS.find(opt => opt.value === itemKind)
        await session.send(
          `已选择：${selectedType?.label}\n\n` +
          `请输入收藏品ID（数字）\n` +
          `如果不知道收藏品ID，请前往 https://sdgb.lemonno.xyz/ 查询\n` +
          `乐曲解禁请输入乐曲ID\n\n` +
          INTERACTIVE_CANCEL_HINT
        )

        const itemIdInput = await session.prompt(60000)
        if (!itemIdInput || isInteractiveCancel(itemIdInput)) {
          return '操作已取消'
        }

        const itemId = itemIdInput.trim()
        // 验证ID是否为数字
        if (!/^\d+$/.test(itemId)) {
          return '❌ ID必须是数字，请重新输入'
        }

        // 确认操作（如果未使用 -bypass）
        if (!options?.bypass) {
          const confirm = await promptYesLocal(
            session,
            `⚠️ 即将清空 ${formatBindingPlayerLabel(binding)} 的收藏品\n类型: ${selectedType?.label}\nID: ${itemId}\n确认继续？`
          )
          if (!confirm) {
            return '操作已取消'
          }
        }

        await session.send('请求成功提交，请等待服务器响应。（通常需要2-3分钟）')

        const result = await api.clearItem(
          binding.maiUid,
          itemId,
          itemKind.toString(),
          machineInfo.clientId,
          machineInfo.regionId,
          machineInfo.placeId,
          machineInfo.placeName,
          machineInfo.regionName,
        )

        if (result.ClearStatus === false || result.LoginStatus === false || result.LogoutStatus === false) {
          return '❌ 清空失败：服务器未返回成功状态，请稍后再试或点击获取二维码刷新账号后再试。'
        }

        return `✅ 已清空 ${formatBindingPlayerLabel(binding)} 的收藏品\n类型: ${selectedType?.label}\nID: ${itemId}`
      } catch (error: any) {
        logger.error(`清收藏品失败: ${sanitizeError(error)}`)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        if (error?.response) {
          return `❌ API请求失败: ${error.response.status} ${error.response.statusText}\n\n${maintenanceMessage}`
        }
        return `❌ 清空失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })
  */

  /**
   * 上传乐曲成绩
   * 用法: /mai上传乐曲成绩 [targetUserId:text]
   * 使用新API: POST /api/private/upload_score_manual
   */
  ctx.command('mai上传乐曲成绩 [targetUserId:text]', '上传游戏乐曲成绩（手动）')
    .userFields(['authority'])
    .option('bypass', '-bypass  绕过确认')
    .action(async ({ session, options }, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      try {
        // 获取目标用户绑定
        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId

        // 交互式输入乐曲成绩数据
        const scoreData = await promptScoreData(session)
        if (!scoreData) {
          return '操作已取消'
        }

        const levelLabel = ['Basic', 'Advanced', 'Expert', 'Master', 'Re:Master'][scoreData.levelId] || scoreData.levelId.toString()
        const fcLabel = FC_STATUS_OPTIONS.find(opt => opt.value === scoreData.combo)?.label || scoreData.combo.toString()
        const syncLabel = SYNC_STATUS_OPTIONS.find(opt => opt.value === scoreData.sync)?.label || scoreData.sync.toString()

        // 确认操作（如果未使用 -bypass）
        if (!options?.bypass) {
          const confirm = await promptYesLocal(
            session,
            `⚠️ 即将为 ${formatBindingPlayerLabel(binding)} 上传乐曲成绩\n` +
            `乐曲ID: ${scoreData.musicId}\n` +
            `难度: ${levelLabel}\n` +
            `成就值: ${scoreData.achievement}\n` +
            `连击: ${fcLabel}\n` +
            `同步: ${syncLabel}\n` +
            `DX星级: ${scoreData.dxScore}\n` +
            `评价: ${scoreData.rank}\n` +
            `确认继续？`
          )
          if (!confirm) {
            return '操作已取消'
          }
        }

        // 获取 qr_text
        const qrTextResult = await getQrText(session, ctx, api, binding, config, rebindTimeout)
        if (qrTextResult.error) {
          return `❌ 获取二维码失败：${qrTextResult.error}`
        }

        await session.send('请求已提交，请等待服务器响应。（包含约60秒安全等待）')

        // 使用新API上传成绩
        let result
        let usedCache = qrTextResult.fromCache === true
        try {
          result = await api.uploadScoreManual(
            qrTextResult.qrText,
            scoreData.musicId,
            scoreData.levelId,
            scoreData.achievement,
            scoreData.combo,
            scoreData.sync,
            scoreData.dxScore,
            scoreData.rank
          )
        } catch (error: any) {
          if (usedCache) {
            logger.info('使用缓存的SGID失败，尝试重新获取SGID')
            const retryQrText = await getQrText(session, ctx, api, binding, config, rebindTimeout, undefined, false)
            if (retryQrText.error) {
              return `❌ 获取二维码失败：${retryQrText.error}`
            }
            result = await api.uploadScoreManual(
              retryQrText.qrText,
              scoreData.musicId,
              scoreData.levelId,
              scoreData.achievement,
              scoreData.combo,
              scoreData.sync,
              scoreData.dxScore,
              scoreData.rank
            )
          } else {
            throw error
          }
        }

        // 新API返回格式：{ success: boolean, result?: { returnCode, apiName }, msg?: string }
        if (!result.success || (result.result && result.result.returnCode !== 1)) {
          const errorMsg = result.msg || '服务器返回未成功'
          if (usedCache && (errorMsg.includes('二维码') || errorMsg.includes('qr_text') || errorMsg.includes('无效') || errorMsg.includes('登录'))) {
            logger.info('使用缓存的SGID失败，尝试重新获取SGID')
            const retryQrText = await getQrText(session, ctx, api, binding, config, rebindTimeout, undefined, false)
            if (retryQrText.error) {
              return `❌ 获取二维码失败：${retryQrText.error}`
            }
            result = await api.uploadScoreManual(
              retryQrText.qrText,
              scoreData.musicId,
              scoreData.levelId,
              scoreData.achievement,
              scoreData.combo,
              scoreData.sync,
              scoreData.dxScore,
              scoreData.rank
            )
            if (!result.success || (result.result && result.result.returnCode !== 1)) {
              return `❌ 上传乐曲成绩失败：${result.msg || '服务器返回未成功'}\n${qrOrLoginFailureHint()}`
            }
          } else {
            return `❌ 上传乐曲成绩失败：${errorMsg}\n${qrOrLoginFailureHint()}`
          }
        }

        return `✅ 已为 ${formatBindingPlayerLabel(binding)} 上传乐曲成绩\n` +
               `乐曲ID: ${scoreData.musicId}\n` +
               `难度: ${levelLabel}\n` +
               `成就值: ${scoreData.achievement}\n` +
               `连击: ${fcLabel}\n` +
               `同步: ${syncLabel}\n` +
               `DX星级: ${scoreData.dxScore}\n` +
               `评价: ${scoreData.rank}`
      } catch (error: any) {
        logger.error(`上传乐曲成绩失败: ${sanitizeError(error)}`)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        if (error?.response) {
          const errorInfo = error.response.data ? JSON.stringify(error.response.data) : `${error.response.status} ${error.response.statusText}`
          return `❌ API请求失败\n错误信息： ${errorInfo}\n\n${maintenanceMessage}`
        }
        return `❌ 上传失败\n错误信息： ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })

  /**
   * 删除乐曲成绩
   * 用法: /mai删除成绩 [targetUserId:text]
   * 使用API: POST /api/private/delete_score_manual
   */
  ctx.command('mai删除成绩 [targetUserId:text]', '删除指定乐曲的成绩')
    .userFields(['authority'])
    .option('bypass', '-bypass  绕过确认')
    .action(async ({ session, options }, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      try {
        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const proxyTip = isProxy ? `（代操作用户 ${binding.userId}）` : ''

        // 1. 输入乐曲ID
        await session.send(
          '请输入要删除成绩的乐曲ID（数字）\n' +
          '如果不知道乐曲ID，请前往 https://maimai.lxns.net/songs 查询\n\n' +
          INTERACTIVE_CANCEL_HINT
        )
        const musicIdReply = await session.prompt(60000)
        if (!musicIdReply || isInteractiveCancel(musicIdReply)) {
          return '操作已取消'
        }
        const musicId = parseInt(musicIdReply.trim(), 10)
        if (isNaN(musicId) || musicId <= 0) {
          return '❌ 乐曲ID必须是大于0的数字，操作已取消'
        }

        // 2. 选择难度
        const LEVEL_ID_OPTIONS = [
          { label: 'Basic', value: 0 },
          { label: 'Advanced', value: 1 },
          { label: 'Expert', value: 2 },
          { label: 'Master', value: 3 },
          { label: 'Re:Master', value: 4 },
        ]
        const levelText = LEVEL_ID_OPTIONS.map(
          (opt, idx) => `${idx + 1}. ${opt.label}`
        ).join('\n')
        await session.send(
          `请选择难度：\n\n${levelText}\n\n请输入对应的数字（1-${LEVEL_ID_OPTIONS.length}），${INTERACTIVE_CANCEL_HINT}`
        )
        const levelReply = await session.prompt(60000)
        if (!levelReply || isInteractiveCancel(levelReply)) {
          return '操作已取消'
        }
        const levelChoice = parseInt(levelReply.trim(), 10)
        if (levelChoice < 1 || levelChoice > LEVEL_ID_OPTIONS.length) {
          return '❌ 无效的选择，操作已取消'
        }
        const levelId = LEVEL_ID_OPTIONS[levelChoice - 1].value
        const levelLabel = LEVEL_ID_OPTIONS[levelChoice - 1].label

        // 3. 确认
        if (!options?.bypass) {
          const confirm = await promptYesLocal(
            session,
            `⚠️ 即将删除 ${formatBindingPlayerLabel(binding)} 的乐曲成绩${proxyTip}\n乐曲ID: ${musicId}\n难度: ${levelLabel}\n确认继续？`
          )
          if (!confirm) {
            return '操作已取消'
          }
        }

        // 4. 获取 qr_text
        const qrTextResult = await getQrText(session, ctx, api, binding, config, rebindTimeout)
        if (qrTextResult.error) {
          return `❌ 获取二维码失败：${qrTextResult.error}`
        }

        await session.send('请求已提交，请等待服务器响应。（包含约60秒安全等待）')

        // 5. 调用API
        const result = await api.deleteScoreManual(qrTextResult.qrText, musicId, levelId)

        if (result.success === false) {
          return `❌ 删除成绩失败：${result.msg || '服务器返回未成功'}`
        }

        return `✅ 已删除 ${formatBindingPlayerLabel(binding)} 的乐曲成绩${proxyTip}\n乐曲ID: ${musicId}\n难度: ${levelLabel}`
      } catch (error: any) {
        logger.error(`删除乐曲成绩失败: ${sanitizeError(error)}`)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        if (error?.response) {
          const errorInfo = error.response.data ? JSON.stringify(error.response.data) : `${error.response.status} ${error.response.statusText}`
          return `❌ API请求失败\n错误信息： ${errorInfo}\n\n${maintenanceMessage}`
        }
        return `❌ 删除失败\n错误信息： ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })

  /**
   * 上传落雪B50
   * 用法: /mai上传落雪b50 [token] [@用户id]
   */
  ctx.command('mai上传落雪b50 [qrCodeOrLxnsCode:text] [targetUserId:text]', '上传B50数据到落雪')
    .alias('maiul')
    .userFields(['authority'])
    .action(async ({ session }, qrCodeOrLxnsCode, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      // 检查白名单
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }

      // 解析参数：第一个参数可能是 SGID/URL 或落雪 Token
      let qrCode: string | undefined
      let lxnsToken: string | undefined
      let actualTargetUserId: string | undefined = targetUserId

      try {
        
        // 检查第一个参数是否是 SGID、URL 或落雪 Token
        if (qrCodeOrLxnsCode) {
          const processed = processSGID(qrCodeOrLxnsCode)
          if (processed) {
            // 是 SGID 或 URL，尝试撤回
            await tryRecallMessage(session, ctx, config)
            qrCode = processed.qrText
          } else if (isValidLxnsToken(qrCodeOrLxnsCode)) {
            lxnsToken = qrCodeOrLxnsCode.trim()
          } else {
            // 可能是 targetUserId
            actualTargetUserId = qrCodeOrLxnsCode
          }
        }

        // 获取目标用户绑定
        const { binding, isProxy, error } = await getTargetBinding(session, actualTargetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId

        // 确定使用的落雪 Token
        let finalLxnsToken: string
        if (lxnsToken) {
          finalLxnsToken = lxnsToken
        } else {
          if (!binding.lxnsCode) {
            return '❌ 请先绑定落雪 Token 或在指令中提供\n使用 /mai绑定落雪 <token> 或 /mai上传落雪b50 <token>'
          }
          finalLxnsToken = binding.lxnsCode
        }
        if (!isValidLxnsToken(finalLxnsToken)) {
          return lxnsTokenFormatError()
        }

        // 维护时间内直接提示，不发起上传请求
        const maintenanceMsg = getMaintenanceMessage(maintenanceNotice)
        if (maintenanceMsg) {
          return maintenanceMsg
        }

        // 获取qr_text（如果提供了SGID参数则直接使用，否则交互式获取）
        let qrTextResult
        if (qrCode) {
          const resolved = await resolveInlineQrText(qrCode, binding, session)
          if (resolved.error) {
            return resolved.error
          }
          qrTextResult = resolved
        } else {
          qrTextResult = await getQrText(session, ctx, api, binding, config, rebindTimeout)
        }
        if (qrTextResult.error) {
          return `❌ 获取二维码失败：${qrTextResult.error}${getErrorHelpInfo()}`
        }

        const processingMsgIds = await sendB50ProcessingNotice(session, 'mai上传落雪b50')
        const uploadStartedAt = Date.now()

        // 上传落雪B50（使用新API，需要qr_text）
        let result
        let usedCache = qrTextResult.fromCache === true
        try {
          result = await api.uploadLxB50(
            machineInfo.regionId,
            machineInfo.clientId,
            machineInfo.placeId,
            qrTextResult.qrText,
            finalLxnsToken
          )
        } catch (error: any) {
          if (usedCache) {
            logger.info('使用缓存的SGID失败，尝试重新获取SGID')
            const retryQrText = await getQrText(session, ctx, api, binding, config, rebindTimeout, undefined, false)  // 禁用缓存，强制重新输入
            if (retryQrText.error) {
              await recallBotMessages(session, processingMsgIds)
              return `❌ 获取二维码失败：${retryQrText.error}`
            }
            result = await api.uploadLxB50(
              machineInfo.regionId,
              machineInfo.clientId,
              machineInfo.placeId,
              retryQrText.qrText,
              finalLxnsToken
            )
          } else {
            throw error
          }
        }

        if (!result.UploadStatus) {
          if (usedCache && (result.msg?.includes('二维码') || result.msg?.includes('qr_text') || result.msg?.includes('无效'))) {
            logger.info('使用缓存的SGID失败，尝试重新获取SGID')
            const retryQrText = await getQrText(session, ctx, api, binding, config, rebindTimeout, undefined, false)  // 禁用缓存，强制重新输入
            if (retryQrText.error) {
              const taskIdInfo = result.task_id ? `\n任务ID: ${result.task_id}` : ''
              await recallBotMessages(session, processingMsgIds)
              return `❌ 上传失败：${result.msg || '未知错误'}\n获取新二维码失败：${retryQrText.error}${taskIdInfo}`
            }
            result = await api.uploadLxB50(
              machineInfo.regionId,
              machineInfo.clientId,
              machineInfo.placeId,
              retryQrText.qrText,
              finalLxnsToken
            )
            if (!result.UploadStatus) {
              if (result.msg === '该账号下存在未完成的任务') {
                return '⚠️ 当前账号已有未完成的落雪B50任务，请耐心等待任务完成，预计1-10分钟，无需重复上传。'
              }
              const taskIdInfo = result.task_id ? `\n任务ID: ${result.task_id}` : ''
              return `❌ 上传失败：${result.msg || '未知错误'}${taskIdInfo}`
            }
          } else {
            if (result.msg === '该账号下存在未完成的任务') {
              return '⚠️ 当前账号已有未完成的落雪B50任务，请耐心等待任务完成，预计1-10分钟，无需重复上传。'
            }
            if (result.msg?.includes('二维码') || result.msg?.includes('qr_text') || result.msg?.includes('无效')) {
              const taskIdInfo = result.task_id ? `\n任务ID: ${result.task_id}` : ''
              return `❌ 上传失败：${result.msg || '未知错误'}${taskIdInfo}\n${qrOrLoginFailureHint()}${getErrorHelpInfo()}`
            }
            const taskIdInfo = result.task_id ? `\n任务ID: ${result.task_id}` : ''
            return `❌ 上传失败：${result.msg || '未知错误'}${taskIdInfo}${getErrorHelpInfo()}`
          }
        }

        const successMessage = formatB50UploadSuccessMessage(result)
        const refId = await logOperation({
          command: 'mai上传落雪b50',
          session,
          targetUserId: actualTargetUserId || undefined,
          status: 'success',
          result: successMessage,
          apiResponse: { ...result, elapsedMs: Date.now() - uploadStartedAt },
        })

        if (isSyncB50Upload(result)) {
          await recallBotMessages(session, processingMsgIds)
          return appendRefId(successMessage, refId)
        }

        // 发送成功消息并获取消息ID（用于后续撤回）
        const successMsgIds = await sendAndGetMessageIds(session, appendRefId(successMessage, refId))
        // 合并处理中消息ID和成功消息ID
        const allMessageIds = [...processingMsgIds, ...successMsgIds]
        scheduleLxB50Notification(session, result.task_id, refId, allMessageIds)

        return ''  // 消息已发送，返回空字符串避免重复发送
      } catch (error: any) {
        ctx.logger('maibot').error('上传落雪B50失败:', error)
        const errorMessage = maintenanceMode 
          ? maintenanceMessage
          : (error?.code === 'ECONNABORTED' || String(error?.message || '').includes('timeout')
            ? (() => {
                let msg = '落雪B50任务 上传失败，请稍后再试一次。'
                const maintenanceMsg = getMaintenanceMessage(maintenanceNotice)
                if (maintenanceMsg) {
                  msg += `\n${maintenanceMsg}`
                }
                msg += `\n\n${maintenanceMessage}${getErrorHelpInfo()}`
                return msg
              })()
            : (error?.response 
              ? `❌ API请求失败: ${error.response.status} ${error.response.statusText}\n\n${maintenanceMessage}${getErrorHelpInfo()}`
              : `❌ 上传失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}${getErrorHelpInfo()}`))
        
        const refId = await logOperation({
          command: 'mai上传落雪b50',
          session,
          targetUserId: (typeof actualTargetUserId !== 'undefined' ? actualTargetUserId : targetUserId) || undefined,
          status: 'error',
          errorMessage: getSafeErrorMessage(error, session),
          apiResponse: error?.response?.data,
        })
        
        return appendRefId(errorMessage, refId)
      }
    })

  // 查询落雪B50任务状态功能已暂时取消

  if (!isPublicApi) {
  /**
   * 查询选项文件（OPT）
   * 用法: /mai查询opt <title_ver>
   */
  ctx.command('mai查询opt <titleVer:text>', '查询Mai2选项文件下载地址')
    .action(async ({ session }, titleVer) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      if (!titleVer) {
        return '❌ 请提供游戏版本号\n用法：/mai查询opt <title_ver>\n例如：/mai查询opt 1.00'
      }

      try {
        const result = await api.getOpt(titleVer, machineInfo.clientId)

        if (result.error) {
          return `❌ 查询失败：${result.error}`
        }

        let message = `✅ 选项文件查询成功\n\n`
        message += `游戏版本: ${titleVer}\n`
        message += `客户端ID: ${machineInfo.clientId}\n\n`

        if (result.app_url && result.app_url.length > 0) {
          message += `📦 APP文件 (${result.app_url.length}个):\n`
          result.app_url.forEach((url, index) => {
            message += `${index + 1}. ${url}\n`
          })
          message += `\n`
        } else {
          message += `📦 APP文件: 无\n\n`
        }

        if (result.opt_url && result.opt_url.length > 0) {
          message += `📦 OPT文件 (${result.opt_url.length}个):\n`
          result.opt_url.forEach((url, index) => {
            message += `${index + 1}. ${url}\n`
          })
          message += `\n`
        } else {
          message += `📦 OPT文件: 无\n\n`
        }

        if (result.latest_app_time) {
          message += `最新APP发布时间: ${result.latest_app_time}\n`
        }
        if (result.latest_opt_time) {
          message += `最新OPT发布时间: ${result.latest_opt_time}\n`
        }

        return message
      } catch (error: any) {
        logger.error(`查询OPT失败: ${sanitizeError(error)}`)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        if (error?.response) {
          return `❌ API请求失败: ${error.response.status} ${error.response.statusText}\n\n${maintenanceMessage}`
        }
        return `❌ 查询失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })

  }

  /**
   * 开关账号保护模式
   * 用法: /mai保护模式 [on|off]
   * @deprecated 保护模式功能已在新API中移除，已注释
   */
  /*
  ctx.command('mai保护模式 [state:text] [targetUserId:text]', '开关账号保护模式（自动锁定已下线的账号）')
    .userFields(['authority'])
    .action(async ({ session }, state, targetUserId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      // 检查隐藏模式
      if (hideLockAndProtection) {
        return '❌ 该功能已禁用'
      }

      try {
        // 获取目标用户绑定
        const { binding, isProxy, error } = await getTargetBinding(session, targetUserId)
        if (error || !binding) {
          return error || '❌ 获取用户绑定失败'
        }

        const userId = binding.userId
        const currentState = binding.protectionMode ?? false

        // 如果没有提供参数，显示当前状态
        if (!state) {
          return `当前保护模式状态: ${currentState ? '✅ 已开启' : '❌ 已关闭'}\n\n使用 /mai保护模式 on 开启\n使用 /mai保护模式 off 关闭\n\n开启后会自动锁定账号，如果锁定失败会在账号下线时自动尝试锁定`
        }

        const newState = state.toLowerCase() === 'on' || state.toLowerCase() === 'true' || state === '1'

        // 如果状态没有变化
        if (currentState === newState) {
          return `保护模式已经是 ${newState ? '开启' : '关闭'} 状态`
        }

        logger.info(`用户 ${userId} ${newState ? '开启' : '关闭'}保护模式`)

        if (newState) {
          // 开启保护模式：尝试立即锁定账号
          if (binding.isLocked) {
            // 如果已经锁定，直接开启保护模式
            await ctx.database.set('maibot_bindings', { userId }, {
              protectionMode: true,
            })
            return `✅ 保护模式已开启\n账号当前已锁定，保护模式将在账号解锁后生效`
          }

          // 尝试锁定账号
          await session.send('⏳ 正在尝试锁定账号，请稍候...')

          const result = await api.login(
            binding.maiUid,
            machineInfo.regionId,
            machineInfo.placeId,
            machineInfo.clientId,
            turnstileToken,
          )

          const updateData: any = {
            protectionMode: true,
          }

          if (result.LoginStatus) {
            // 锁定成功
            updateData.isLocked = true
            updateData.lockTime = new Date()
            updateData.lockLoginId = result.LoginId
            
            // 如果之前开启了推送，锁定时自动关闭
            if (binding.alertEnabled === true) {
              updateData.alertEnabled = false
              logger.info(`用户 ${userId} 保护模式锁定账号，已自动关闭 maialert 推送`)
            }

            await ctx.database.set('maibot_bindings', { userId }, updateData)

            return `✅ 保护模式已开启\n账号已成功锁定，将保持登录状态防止他人登录`
          } else {
            // 锁定失败，但仍开启保护模式，系统会在账号下线时自动尝试锁定
            await ctx.database.set('maibot_bindings', { userId }, updateData)

            let message = `✅ 保护模式已开启\n⚠️ 当前无法锁定账号（可能账号正在被使用或者挂哥上号）\n系统将定期检查账号状态，当检测到账号下线时会自动尝试锁定，防止一直小黑屋！\n`
            
            if (result.UserID === -2) {
              message += `\n错误信息：Turnstile校验失败`
            } else {
              message += `\n错误信息：服务端未返回成功状态`
            }

            return message
          }
        } else {
          // 关闭保护模式
          await ctx.database.set('maibot_bindings', { userId }, {
            protectionMode: false,
          })
          return `✅ 保护模式已关闭\n已停止自动锁定功能`
        }
      } catch (error: any) {
        logger.error('开关保护模式失败:', error)
        if (maintenanceMode) {
          return maintenanceMessage
        }
        return `❌ 操作失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      }
    })
  */

  /**
   * 管理员一键关闭所有人的锁定模式和保护模式
   * 用法: /mai管理员关闭所有锁定和保护
   * @deprecated 锁定和保护模式功能已在新API中移除，已注释
   */
  /*
  ctx.command('mai管理员关闭所有锁定和保护', '管理员一键关闭所有人的锁定模式和保护模式（需要auth等级3以上）')
    .userFields(['authority'])
    .option('bypass', '-bypass  绕过确认')
    .action(async ({ session, options }) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }

      // 检查权限
      if ((session.user?.authority ?? 0) < 3) {
        return '❌ 权限不足，需要auth等级3以上才能执行此操作'
      }

      try {
        // 确认操作（如果未使用 -bypass）
        if (!options?.bypass) {
          const confirm = await promptYesLocal(
            session,
            '⚠️ 即将关闭所有用户的锁定模式和保护模式\n此操作将影响所有已绑定账号的用户\n确认继续？'
          )
          if (!confirm) {
            return '操作已取消'
          }
        }

        await session.send('⏳ 正在处理，请稍候...')

        // 获取所有绑定记录
        const allBindings = await ctx.database.get('maibot_bindings', {})
        
        // 统计需要更新的用户数量
        let lockedCount = 0
        let protectionCount = 0
        let totalUpdated = 0

        // 遍历所有绑定记录，更新锁定模式和保护模式
        for (const binding of allBindings) {
          const updateData: any = {}
          let needsUpdate = false

          // 如果用户开启了锁定模式，关闭它
          if (binding.isLocked === true) {
            updateData.isLocked = false
            updateData.lockTime = null
            updateData.lockLoginId = null
            lockedCount++
            needsUpdate = true
          }

          // 如果用户开启了保护模式，关闭它
          if (binding.protectionMode === true) {
            updateData.protectionMode = false
            protectionCount++
            needsUpdate = true
          }

          // 如果有需要更新的字段，执行更新
          if (needsUpdate) {
            await ctx.database.set('maibot_bindings', { userId: binding.userId }, updateData)
            totalUpdated++
          }
        }

        logger.info(`管理员 ${session.userId} 执行了一键关闭操作，更新了 ${totalUpdated} 个用户（锁定: ${lockedCount}，保护模式: ${protectionCount}）`)

        let resultMessage = `✅ 操作完成\n\n`
        resultMessage += `已更新用户数: ${totalUpdated}\n`
        resultMessage += `关闭锁定模式: ${lockedCount} 个用户\n`
        resultMessage += `关闭保护模式: ${protectionCount} 个用户`

        if (totalUpdated === 0) {
          resultMessage = `ℹ️ 没有需要更新的用户\n所有用户都未开启锁定模式和保护模式`
        }

      const refId = await logOperation({
        command: 'mai管理员一键关闭',
        session,
        status: 'success',
        result: resultMessage,
      })
      
      return appendRefId(resultMessage, refId)
    } catch (error: any) {
      logger.error(`管理员一键关闭操作失败: ${sanitizeError(error)}`)
      const errorMessage = maintenanceMode 
        ? maintenanceMessage
        : `❌ 操作失败: ${getSafeErrorMessage(error, session)}\n\n${maintenanceMessage}`
      
      const refId = await logOperation({
        command: 'mai管理员一键关闭',
        session,
        status: 'error',
        errorMessage: getSafeErrorMessage(error, session),
      })
      
      return appendRefId(errorMessage, refId)
    }
  })

  /**
   * 管理员查询操作记录（通过 ref_id）
   * 用法: /mai管理员查询操作 <ref_id>
   */
  ctx.command('mai管理员查询操作 <refId:text>', '通过 Ref_ID 查询操作详细信息（需要auth等级3以上）')
    .userFields(['authority'])
    .action(async ({ session }, refId) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }
      if ((session.user?.authority ?? 0) < 3) {
        return '❌ 权限不足，需要auth等级3以上才能执行此操作'
      }

      try {
        const logs = await ctx.database.get('maibot_operation_logs', { refId: refId.trim() })
        if (logs.length === 0) {
          return `❌ 未找到 Ref_ID 为 "${refId}" 的操作记录`
        }

        const log = logs[0]
        const statusText = {
          success: '✅ 成功',
          failure: '❌ 失败',
          error: '⚠️ 错误',
        }[log.status] || log.status

        let result = `📋 操作记录详情\n\n`
        result += `Ref_ID: ${log.refId}\n`
        result += `命令: ${log.command}\n`
        result += `操作人: ${log.userId}\n`
        if (log.targetUserId) {
          result += `目标用户: ${log.targetUserId}\n`
        }
        result += `状态: ${statusText}\n`
        result += `操作时间: ${new Date(log.createdAt).toLocaleString('zh-CN')}\n`
        if (log.guildId) {
          result += `群组ID: ${log.guildId}\n`
        }
        if (log.channelId) {
          result += `频道ID: ${log.channelId}\n`
        }
        if (log.result) {
          result += `\n操作结果:\n${log.result}\n`
        }
        if (log.errorMessage) {
          result += `\n错误信息:\n${log.errorMessage}\n`
        }
        if (log.apiResponse) {
          try {
            const apiResp = JSON.parse(log.apiResponse)
            result += `\nAPI响应:\n${JSON.stringify(apiResp, null, 2)}\n`
          } catch {
            result += `\nAPI响应:\n${log.apiResponse}\n`
          }
        }

        return result
      } catch (error: any) {
        logger.error('查询操作记录失败:', error)
        return `❌ 查询失败: ${getSafeErrorMessage(error, session)}`
      }
    })

  /**
   * 管理员查看今日命令统计
   * 用法: /mai管理员统计
   */
  ctx.command('mai管理员统计', '查看今日各指令执行次数统计（需要auth等级3以上）')
    .userFields(['authority'])
    .action(async ({ session }) => {
      if (!session) {
        return '❌ 无法获取会话信息'
      }
      if ((session.user?.authority ?? 0) < 3) {
        return '❌ 权限不足，需要auth等级3以上才能执行此操作'
      }

      try {
        const today = new Date()
        today.setHours(0, 0, 0, 0)
        const todayStart = today.getTime()

        // 获取今日所有操作记录
        const allLogs = await ctx.database.get('maibot_operation_logs', {})
        const todayLogs = allLogs.filter(log => new Date(log.createdAt).getTime() >= todayStart)

        // 统计各命令执行次数
        // 将任务完成/失败等子命令合并到主命令中
        const commandStats: Record<string, { total: number; success: number; failure: number; error: number }> = {}
        
        // 命令名称映射：将子命令合并到主命令
        const commandMapping: Record<string, string> = {
          'mai上传B50-任务完成': 'mai上传B50',
          'mai上传B50-任务超时': 'mai上传B50',
          'mai上传B50-轮询异常': 'mai上传B50',
          'mai上传落雪b50-任务完成': 'mai上传落雪b50',
          'mai上传落雪b50-任务超时': 'mai上传落雪b50',
          'mai上传落雪b50-轮询异常': 'mai上传落雪b50',
          'maiua-水鱼B50': 'maiua',
          'maiua-落雪B50': 'maiua',
        }
        
        for (const log of todayLogs) {
          // 使用映射后的命令名称，如果没有映射则使用原命令名称
          const commandName = commandMapping[log.command] || log.command
          
          if (!commandStats[commandName]) {
            commandStats[commandName] = { total: 0, success: 0, failure: 0, error: 0 }
          }
          commandStats[commandName].total++
          if (log.status === 'success') {
            commandStats[commandName].success++
          } else if (log.status === 'failure') {
            commandStats[commandName].failure++
          } else if (log.status === 'error') {
            commandStats[commandName].error++
          }
        }

        // 按执行次数排序
        const sortedCommands = Object.entries(commandStats).sort((a, b) => b[1].total - a[1].total)

        // 获取B50平均处理时长统计（管理员统计显示详细数量）
        const pollInterval = config.b50PollInterval ?? 2000
        const pollTimeout = config.b50PollTimeout ?? 600000
        const fishStats = await getUploadStats('mai上传B50', true)
        const lxStats = await getUploadStats('mai上传落雪b50', true)

        let result = `📊 今日命令执行统计\n\n`
        result += `统计时间: ${new Date().toLocaleString('zh-CN')}\n`
        result += `总操作数: ${todayLogs.length}\n`
        result += `轮询间隔: ${pollInterval} ms\n`
        result += `轮询超时: ${Math.round(pollTimeout / 60000)} 分钟\n\n`

        // B50处理时长统计和成功率
        result += `📈 B50上传统计:\n`
        if (fishStats) {
          result += `  🐟 水鱼B50: ${fishStats}\n`
        } else {
          result += `  🐟 水鱼B50: 暂无今日数据\n`
        }
        if (lxStats) {
          result += `  ❄️ 落雪B50: ${lxStats}\n`
        } else {
          result += `  ❄️ 落雪B50: 暂无今日数据\n`
        }

        if (sortedCommands.length === 0) {
          result += `\nℹ️ 今日暂无操作记录`
        } else {
          result += `\n各命令执行情况:\n`
          for (const [command, stats] of sortedCommands) {
            // 计算成功率（成功数 / 总数 * 100）
            const successRate = stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(1) : '0.0'
            result += `\n${command}:\n`
            result += `  总次数: ${stats.total} | 成功率: ${successRate}%\n`
            result += `  成功: ${stats.success} | 失败: ${stats.failure} | 错误: ${stats.error}\n`
          }
        }

        return result
      } catch (error: any) {
        logger.error('查询统计失败:', error)
        return `❌ 查询失败: ${getSafeErrorMessage(error, session)}`
      }
    })

  ctx.command('mai兑换卡密 [code:text]', '兑换卡密（个人/群组/解绑卡；解绑卡需已绑定舞萌）')
    .userFields(['authority'])
    .usage(' /mai兑换卡密 <MAI-开头的卡密>  或发送 /mai兑换卡密 后在限时内粘贴卡密。群组卡请在目标群内兑换；解绑卡须先 /mai绑定。')
    .action(async ({ session }, code) => {
      if (!session) return '❌ 无法获取会话信息'
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }
      const binding = await getBindingBySession(ctx, session)
      let codeFinal = code?.trim() || ''
      if (!codeFinal) {
        await session.send(`请在 ${Math.floor(rebindTimeout / 1000)} 秒内发送要兑换的卡密（可直接粘贴，如 MAI- 开头）`)
        const ps = await waitForUserReply(session, ctx, rebindTimeout)
        codeFinal = ps?.content?.trim() || ''
        if (ps) {
          await tryRecallMessage(ps, ctx, config, ps.messageId)
        }
      }
      if (!codeFinal) {
        return '❌ 未收到卡密或已超时\n📖 用法：/mai兑换卡密 <卡密> 或先发 /mai兑换卡密 再粘贴卡密。'
      }
      const linkKeys = await getSessionBindingKeys(ctx, session)
      const uid = linkKeys[0] || String(session.userId || '')
      if (!uid) return '❌ 无法识别用户身份，请稍后重试'
      const r = await redeemCardKey(ctx, codeFinal, uid, session, binding?.userId ?? null, linkKeys)
      if (r.ok) {
        const keys = await getSessionBindingKeys(ctx, session)
        await clearUserCooldownsForKeys(ctx, keys)
      }
      return r.message
    })

  ctx.command('mai管理员生成卡密 [durationSpec:text] [count:number]', '生成优先授权卡密（无参为交互式；需要 auth）')
    .userFields(['authority'])
    .usage(' 快速：/mai管理员生成卡密 7d 5  或  -g 30d 3  或  -u -1 10\n无参数：发指令后按提示选类型、时长、数量。')
    .option('group', '-g  群组卡密（须在群内兑换，本群全员群内免冷却）')
    .option('unbind', '-u  解绑卡（已绑定用户兑换后为当前绑定增加解绑额度；时长参数可填 -1/任意占位）')
    .action(async ({ session, options }, durationSpec, countInput) => {
      if (!session) return '❌ 无法获取会话信息'
      if ((session.user?.authority ?? 0) < authLevelForCardAdmin) {
        return `❌ 权限不足，需要 auth 等级 ${authLevelForCardAdmin} 以上才能生成卡密`
      }
      if (options?.group && options?.unbind) {
        return '❌ -g 与 -u 不能同时使用'
      }

      const promptMs = Math.max(90000, rebindTimeout)
      const durStr = durationSpec != null && String(durationSpec).trim() !== '' ? String(durationSpec).trim() : ''
      const cntNum = countInput !== undefined && countInput !== null ? Number(countInput) : NaN
      const hasCountArg = Number.isInteger(cntNum)

      let cardKind: 'personal' | 'group' | 'unbind' = options?.unbind ? 'unbind' : options?.group ? 'group' : 'personal'
      let parsed: ReturnType<typeof parseCardDurationSpec> | -1
      let cnt: number

      const needInteractive = !durStr && !hasCountArg

      if (needInteractive) {
        if (!options?.group && !options?.unbind) {
          await session.send(
            '【生成卡密】请选择类型（回复序号或英文）：\n' +
            '1 = 个人优先\n2 = 群组优先\n3 = 解绑卡\n0 = 取消',
          )
          const r1 = await waitForUserReply(session, ctx, promptMs)
          const ch = parseInteractiveCardKindInput(r1?.content || '')
          if (ch === null || ch === 'cancel') return '操作已取消或输入无效'
          cardKind = ch
        }

        if (cardKind !== 'unbind') {
          await session.send(
            '请输入时长，例如：7d、30d、12h、-1 或 永久\n（个人/群组卡密必填）',
          )
          const r2 = await waitForUserReply(session, ctx, promptMs)
          const spec = r2?.content?.trim() || ''
          const p = parseCardDurationSpec(spec)
          if (p === null) {
            return '❌ 时长格式无效。支持：-1/永久、7d、7天、12h、7d12h、1mo/月、1m（天）、1y/年、min/分钟 等'
          }
          parsed = p
        } else {
          parsed = -1
        }

        await session.send('请输入生成数量（1–50 的整数，直接发数字）')
        const r3 = await waitForUserReply(session, ctx, promptMs)
        const rawC = (r3?.content?.trim() || '').trim()
        const cn = parseInt(rawC, 10)
        if (!Number.isInteger(cn) || cn < 1 || cn > 50) {
          return '❌ 数量须为 1–50 之间的整数'
        }
        cnt = cn
      } else {
        if (options?.unbind) {
          parsed = -1
        } else {
          const p = parseCardDurationSpec(durStr)
          if (p === null) {
            return '❌ 时长格式无效。支持：-1/永久、7d、7天、12h、7d12h、1mo/月、1m（表示 1 天）、1y/年、min/分钟 等组合'
          }
          parsed = p
        }
        cnt = hasCountArg ? Math.min(50, Math.max(1, cntNum)) : 1
        if (hasCountArg && cnt !== cntNum) {
          return '❌ 数量须为 1–50 之间的整数'
        }
      }

      const keys = await createCardKeys(ctx, String(session.userId || 'unknown'), parsed, cnt, cardKind)
      const kindLabel = cardKind === 'group' ? '群组' : cardKind === 'unbind' ? '解绑' : '个人'
      const durLabel = (k: (typeof keys)[0]) =>
        cardKind === 'unbind' ? '解绑额度+1' : (k.permanent ? '永久' : `${k.durationMs}ms（约 ${(k.durationMs / 86400000).toFixed(2)} 天）`)
      const lines = keys.map(k => `${k.code}\t${kindLabel}\t${durLabel(k)}`)
      const explain =
        cardKind === 'group'
          ? '群组卡密仅能在群聊内兑换，兑换后该群全体成员在群内使用指令时免冷却。'
          : cardKind === 'unbind'
            ? '解绑卡须用户已绑定舞萌账号后兑换，兑换后为该绑定增加 1 次冷却期内解绑额度（配合 /mai解绑卡）。'
            : '个人卡密任意环境兑换，兑换后该账号全局享受优先冷却。'
      return (
        `✅ 已生成 ${keys.length} 条${kindLabel}卡密（请妥善保管，勿公开）：\n` +
        `说明：${explain}\n` +
        lines.join('\n')
      )
    })

  ctx.command('mai管理员删除卡密 [code:text]', '作废卡密（无参为交互式；需要 auth）')
    .userFields(['authority'])
    .usage(
      ' 快速：/mai管理员删除卡密 MAI-XXX（可多行粘贴，每行一条；或导出 TSV 整段粘贴）\n无参数：发指令后粘贴，支持批量。',
    )
    .action(async ({ session }, code) => {
      if (!session) return '❌ 无法获取会话信息'
      if ((session.user?.authority ?? 0) < authLevelForCardAdmin) {
        return `❌ 权限不足，需要 auth 等级 ${authLevelForCardAdmin} 以上`
      }
      let codeFinal = code?.trim() || ''
      const promptMs = Math.max(90000, rebindTimeout)
      if (!codeFinal) {
        await session.send(
          `【作废卡密】请在 ${Math.floor(promptMs / 1000)} 秒内发送卡密，一行一条（可多条）；支持粘贴导出 TSV（每行取首列）。\n单独发 0 = 取消`,
        )
        const r = await waitForUserReply(session, ctx, promptMs)
        codeFinal = r?.content?.trim() || ''
        if (r) {
          await tryRecallMessage(r, ctx, config, r.messageId)
        }
        if (/^0$/u.test(codeFinal)) return '操作已取消'
      }
      if (!codeFinal) return '❌ 未收到卡密或已超时'

      const codes = parseBatchVoidCardCodes(codeFinal)
      if (!codes.length) return '❌ 未解析到有效卡密（需 MAI- 开头，每行一条或 TSV 首列）'

      const voided: string[] = []
      const notFound: string[] = []
      const already: string[] = []
      for (const c of codes) {
        const rows = await ctx.database.get('maibot_card_keys', { code: c })
        if (!rows.length) {
          notFound.push(c)
          continue
        }
        const row = rows[0] as { active?: boolean }
        if (row.active === false) {
          already.push(c)
          continue
        }
        await ctx.database.set('maibot_card_keys', { code: c }, { active: false })
        voided.push(c)
      }

      const parts: string[] = []
      if (voided.length) parts.push(`✅ 已作废 ${voided.length} 条：\n${voided.join('\n')}`)
      if (already.length) parts.push(`ℹ️ 已是作废状态（跳过）${already.length} 条：\n${already.join('\n')}`)
      if (notFound.length) parts.push(`❌ 未找到 ${notFound.length} 条：\n${notFound.join('\n')}`)
      return parts.join('\n\n')
    })

  ctx.command('mai管理员导出卡密 [scope:text]', '导出卡密（无参为交互筛选；制表符文本）')
    .userFields(['authority'])
    .usage(' 快速：/mai管理员导出卡密 all|unused|redeemed\n无参数：按提示选「兑换状态」与「卡密类型」。')
    .action(async ({ session }, scope) => {
      if (!session) return '❌ 无法获取会话信息'
      if ((session.user?.authority ?? 0) < authLevelForCardAdmin) {
        return `❌ 权限不足，需要 auth 等级 ${authLevelForCardAdmin} 以上`
      }

      const promptMs = Math.max(90000, rebindTimeout)
      let sc: 'all' | 'unused' | 'redeemed' = 'all'
      let kindFilter: ExportKindFilterChoice = 'all'

      const scopeArg = scope?.trim() || ''
      if (scopeArg) {
        const low = scopeArg.toLowerCase()
        if (low === 'unused' || low === '未使用') sc = 'unused'
        else if (low === 'redeemed' || low === '已兑换') sc = 'redeemed'
        else if (low === 'all' || low === '全部') sc = 'all'
        else {
          return '❌ 范围参数无效。请使用 all / unused / redeemed，或不带参数进入交互。'
        }
      } else {
        await session.send(
          '【导出卡密】第一步：请选择兑换状态（回复序号）：\n' +
          '1 = 全部记录\n2 = 仅未使用（有效且未兑换）\n3 = 仅已兑换\n0 = 取消',
        )
        const r1 = await waitForUserReply(session, ctx, promptMs)
        const ch1 = parseExportScopeInput(r1?.content || '')
        if (ch1 === null || ch1 === 'cancel') return '操作已取消或输入无效'
        sc = ch1

        await session.send(
          '第二步：是否按卡密类型再筛选？（回复序号）\n' +
          '1 = 不筛选（全部类型）\n2 = 仅个人优先卡\n3 = 仅群组卡\n4 = 仅解绑卡\n0 = 取消',
        )
        const r2 = await waitForUserReply(session, ctx, promptMs)
        const ch2 = parseExportKindFilterInput(r2?.content || '')
        if (ch2 === null || ch2 === 'cancel') return '操作已取消或输入无效'
        kindFilter = ch2
      }

      const all = await ctx.database.get('maibot_card_keys', {})
      const filtered = all.filter((row) => {
        const redeemed = !!row.redeemedAt
        if (sc === 'unused' && (redeemed || !row.active)) return false
        if (sc === 'redeemed' && !redeemed) return false
        if (kindFilter !== 'all') {
          const rk = rowCardKindOf(row as { cardKind?: string })
          if (kindFilter !== rk) return false
        }
        return true
      })
      const header = [
        'code',
        'cardKind',
        'permanent',
        'durationMs',
        'active',
        'createdAt',
        'issuerUserId',
        'redeemedAt',
        'redeemerUserId',
      ].join('\t')
      const lines = filtered.map((row) =>
        [
          row.code,
          (row as { cardKind?: string }).cardKind === 'group'
            ? 'group'
            : (row as { cardKind?: string }).cardKind === 'unbind'
              ? 'unbind'
              : 'personal',
          row.permanent ? '1' : '0',
          String(row.durationMs),
          row.active ? '1' : '0',
          row.createdAt ? new Date(row.createdAt).toISOString() : '',
          row.issuerUserId || '',
          row.redeemedAt ? new Date(row.redeemedAt).toISOString() : '',
          row.redeemerUserId || '',
        ].join('\t'),
      )
      const body = [header, ...lines].join('\n')
      const maxLen = 3200
      const scLabel = sc === 'all' ? '全部' : sc === 'unused' ? '未使用' : '已兑换'
      const kLabel =
        kindFilter === 'all' ? '全部类型' : kindFilter === 'personal' ? '个人' : kindFilter === 'group' ? '群组' : '解绑'
      if (body.length <= maxLen) {
        return `共 ${filtered.length} 条（状态：${scLabel}，类型：${kLabel}）\n` + body
      }
      await session.send(`共 ${filtered.length} 条（状态：${scLabel}，类型：${kLabel}），将分多条发送`)
      for (let i = 0; i < body.length; i += maxLen) {
        await session.send(body.slice(i, i + maxLen))
      }
      return ''
    })

  ctx.command('mai取消群组优先', '取消本群群组优先（仅群组卡兑换人）')
    .action(async ({ session }) => {
      if (!session) return '❌ 无法获取会话信息'
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }
      const gkey = canonicalGuildPriorityKey(session)
      if (!gkey) return '❌ 请在群聊内使用本指令。'
      const keys = await getSessionBindingKeys(ctx, session)
      const r = await userCancelGroupPriority(ctx, gkey, keys)
      return r.message
    })

  ctx.command('mai群组优先换绑', '发起将本群群组优先迁移到其他群（仅兑换人）')
    .action(async ({ session }) => {
      if (!session) return '❌ 无法获取会话信息'
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }
      const r = await startGroupPriorityRebind(ctx, session, async (s) => getSessionBindingKeys(ctx, s))
      return r.message
    })

  ctx.command('mai群组优先换入', '在目标群完成群组优先换绑')
    .alias('mai群组优先换绑完成')
    .action(async ({ session }) => {
      if (!session) return '❌ 无法获取会话信息'
      const whitelistCheck = checkWhitelist(session, config, isDebugSession(session))
      if (!whitelistCheck.allowed) {
        return whitelistCheck.message || '本群暂时没有被授权使用本Bot的功能，请添加官方群聊1072033605。'
      }
      const r = await completeGroupPriorityRebind(ctx, session, async (s) => getSessionBindingKeys(ctx, s))
      return r.message
    })

  ctx.command('mai管理员取消群组优先 [guildKey:text]', '取消指定群或当前群的群组优先')
    .userFields(['authority'])
    .action(async ({ session }, guildKey) => {
      if (!session) return '❌ 无法获取会话信息'
      if ((session.user?.authority ?? 0) < authLevelForCardAdmin) {
        return `❌ 权限不足，需要 auth 等级 ${authLevelForCardAdmin} 以上`
      }
      const gk = (guildKey?.trim() || canonicalGuildPriorityKey(session) || '').trim()
      if (!gk) {
        return '❌ 请填写群标识（如 qq:123456），或在群聊内使用并不带参数。'
      }
      const did = await adminRemoveGroupPriorityRow(ctx, gk)
      return did ? `✅ 已取消群组优先：${gk}` : `ℹ️ 该群无群组优先记录：${gk}`
    })

  ctx.command('mai管理员取消个人优先 <targetUserId:text>', '清除目标用户的个人优先记录')
    .userFields(['authority'])
    .action(async ({ session }, targetUserId) => {
      if (!session) return '❌ 无法获取会话信息'
      if ((session.user?.authority ?? 0) < authLevelForCardAdmin) {
        return `❌ 权限不足，需要 auth 等级 ${authLevelForCardAdmin} 以上`
      }
      if (!targetUserId?.trim()) {
        return '❌ 请指定用户，例如：/mai管理员取消个人优先 @用户 或 数字ID'
      }
      const candidates = await resolveCooldownKeyCandidatesForBypass(session, targetUserId)
      if (!candidates.length) {
        return '❌ 无法解析目标用户，请使用 @用户 或数字 ID'
      }
      const n = await adminRemovePersonalPriorityRows(ctx, candidates)
      return `✅ 已清除 ${n} 条个人优先记录。\n匹配键：${candidates.join('、')}`
    })

  ctx.command('mai管理员设置个人优先 [targetUserId:text] [spec:text]', '设置个人优先：永久 / 时长 / clear（无参数走交互式）')
    .userFields(['authority'])
    .action(async ({ session }, targetUserId, spec) => {
      if (!session) return '❌ 无法获取会话信息'
      if ((session.user?.authority ?? 0) < authLevelForCardAdmin) {
        return `❌ 权限不足，需要 auth 等级 ${authLevelForCardAdmin} 以上`
      }

      const promptMs = Math.max(90000, rebindTimeout)

      // 交互式：未提供目标用户
      if (!targetUserId?.trim()) {
        await session.send(
          `【设置个人优先】请在 ${Math.floor(promptMs / 1000)} 秒内发送目标用户（@用户 或数字ID）\n${INTERACTIVE_CANCEL_HINT}`
        )
        const r1 = await waitForUserReply(session, ctx, promptMs)
        const replyText = r1?.content?.trim() || ''
        if (!replyText || isInteractiveCancel(replyText)) return '操作已取消'
        targetUserId = replyText
      }

      // 交互式：未提供时长
      if (!spec?.trim()) {
        await session.send(
          `请发送时长规格（永久 / 7d / 30d / clear 等）\n${INTERACTIVE_CANCEL_HINT}`
        )
        const r2 = await waitForUserReply(session, ctx, promptMs)
        const replyText = r2?.content?.trim() || ''
        if (!replyText || isInteractiveCancel(replyText)) return '操作已取消'
        spec = replyText
      }

      const sp = parsePriorityAdminSpec(spec)
      if (sp === null) {
        return '❌ 无效的 spec，示例：永久、7d、30d、clear'
      }
      const candidates = await resolveCooldownKeyCandidatesForBypass(session, targetUserId)
      if (!candidates.length) {
        return '❌ 无法解析目标用户'
      }
      const r = await adminSetPersonalPriorityForUserIds(ctx, candidates, sp)
      return r.message
    })

  ctx.command('mai管理员设置群组优先 [spec:text]', '直接设置群组优先（-g 指定群；无参数走交互式）')
    .userFields(['authority'])
    .usage(
      ' 示例：/mai管理员设置群组优先 clear -g qq:5911013814031454\n' +
        '或：/mai管理员设置群组优先 -g qq:5911013814031454 永久\n' +
        '无参数：发指令后按提示输入群标识与时长（仅数字群号请写 qq:群号；在群内执行可省略群标识）',
    )
    .option('guild', '-g <guildKey:string> 群标识，如 qq:群号')
    .action(async ({ session, options }, spec) => {
      if (!session) return '❌ 无法获取会话信息'
      if ((session.user?.authority ?? 0) < authLevelForCardAdmin) {
        return `❌ 权限不足，需要 auth 等级 ${authLevelForCardAdmin} 以上`
      }

      const promptMs = Math.max(90000, rebindTimeout)
      const { spec: specOnly, guild: guildOpt } = splitGroupPrioritySpecAndGuild(spec, options?.guild)
      let specFinal = specOnly
      let guildFinal = guildOpt

      // 无任何参数 → 全交互式
      if (!specFinal) {
        // 群标识
        if (!guildFinal) {
          const fromSessionGuild = canonicalGuildPriorityKey(session)
          await session.send(
            `【设置群组优先】请在 ${Math.floor(promptMs / 1000)} 秒内发送群标识（如 qq:123456）${fromSessionGuild ? `\n直接发送 0 则使用当前群 ${fromSessionGuild}` : ''}\n${INTERACTIVE_CANCEL_HINT}`
          )
          const r1 = await waitForUserReply(session, ctx, promptMs)
          const replyText = r1?.content?.trim() || ''
          if (isInteractiveCancel(replyText)) return '操作已取消'
          if (replyText === '0' && fromSessionGuild) {
            guildFinal = fromSessionGuild
          } else if (replyText) {
            guildFinal = replyText
          } else {
            return '操作已取消'
          }
        }

        // 时长
        await session.send(
          `请发送时长规格（永久 / 7d / 30d / clear 等）\n${INTERACTIVE_CANCEL_HINT}`
        )
        const r2 = await waitForUserReply(session, ctx, promptMs)
        const replyText = r2?.content?.trim() || ''
        if (!replyText || isInteractiveCancel(replyText)) return '操作已取消'
        specFinal = replyText
      }

      const sp = parsePriorityAdminSpec(specFinal)
      if (sp === null) {
        return '❌ 无效的 spec，示例：永久、7d、clear'
      }
      let gk = (guildFinal.trim() || canonicalGuildPriorityKey(session) || '').trim()
      gk = normalizeGuildKeyForPriority(gk, session)
      if (!gk) {
        return '❌ 请使用 -g 指定群标识（platform:guildId），或在群聊内执行。'
      }
      const r = await adminSetGroupPriorityForGuild(ctx, gk, sp)
      return r.message
    })

  ctx.command('maibypass <targetUserId:text>', '清除指定用户的全部指令冷却（需要 auth 等级，默认 4）')
    .alias('mai管理员清除冷却')
    .userFields(['authority'])
    .action(async ({ session }, targetUserId) => {
      if (!session) return '❌ 无法获取会话信息'
      if ((session.user?.authority ?? 0) < authLevelForCardAdmin) {
        return `❌ 权限不足，需要 auth 等级 ${authLevelForCardAdmin} 以上`
      }
      if (!targetUserId?.trim()) {
        return '❌ 请指定用户，例如：/maibypass @123456 或 /maibypass 123456'
      }
      const candidates = await resolveCooldownKeyCandidatesForBypass(session, targetUserId)
      if (!candidates.length) {
        return '❌ 无法解析目标用户，请使用 @用户 或数字 ID'
      }
      const removed = await clearUserCooldownsForKeys(ctx, candidates)
      return `✅ 已清除 ${removed} 条冷却记录。\n尝试匹配的用户键：${candidates.join('、')}`
    })

  ctx.command('mai管理员清除落雪旧绑定 [target:text]', '清除旧版落雪好友码；all 清除全部落雪绑定')
    .userFields(['authority'])
    .action(async ({ session }, target) => {
      if (!session) return '❌ 无法获取会话信息'
      if ((session.user?.authority ?? 0) < authLevelForProxy) {
        return `❌ 权限不足，需要 auth 等级 ${authLevelForProxy} 以上`
      }

      const arg = (target || '').trim()
      const lower = arg.toLowerCase()

      if (lower === 'all') {
        const confirmed = await promptYesLocal(
          session,
          '⚠️ 即将清除【所有用户】的落雪绑定（含有效 Token），所有人须重新 /mai绑定落雪',
        )
        if (!confirmed) return '已取消'
        const count = await purgeAllLxnsBindings(ctx)
        return count > 0
          ? `✅ 已清除 ${count} 条落雪绑定（含 Token）`
          : 'ℹ️ 当前没有任何落雪绑定记录'
      }

      if (!arg || lower === 'legacy' || lower === '旧') {
        const confirmed = await promptYesLocal(
          session,
          '⚠️ 即将清除所有用户的【旧版落雪好友码】绑定（有效 Token 保留）',
        )
        if (!confirmed) return '已取消'
        const count = await purgeInvalidLxnsBindings(ctx)
        return count > 0
          ? `✅ 已清除 ${count} 条旧版落雪好友码，请通知用户用 Token 重新 /mai绑定落雪`
          : 'ℹ️ 当前没有需要清除的旧版落雪好友码'
      }

      const candidates = await resolveCooldownKeyCandidatesForBypass(session, arg)
      if (!candidates.length) {
        return '❌ 无法解析目标用户，请使用 @用户 或数字 ID'
      }

      let cleared = 0
      let skipped = 0
      for (const key of candidates) {
        const result = await clearUserLxnsBinding(ctx, key, true)
        if (result === 'cleared') cleared++
        else if (result === 'skipped') skipped++
      }

      if (cleared > 0) {
        return `✅ 已清除 ${cleared} 条旧版落雪绑定${skipped > 0 ? `（${skipped} 条已是有效 Token，未动）` : ''}\n匹配键：${candidates.join('、')}`
      }
      if (skipped > 0) {
        return `ℹ️ 该用户已绑定有效落雪 Token，请使用 /mai解绑落雪 或由管理员执行 /mai管理员清除落雪旧绑定 all（慎用）`
      }
      return `ℹ️ 未找到落雪绑定记录。\n匹配键：${candidates.join('、')}`
    })

  ctx.command('mai管理员重置用户协议 [targetUserId:text]', '清除目标用户的协议确认记录，使其下次使用时重新确认')
    .userFields(['authority'])
    .action(async ({ session }, targetUserId) => {
      if (!session) return '❌ 无法获取会话信息'
      if ((session.user?.authority ?? 0) < authLevelForProxy) {
        return `❌ 权限不足，需要 auth 等级 ${authLevelForProxy} 以上`
      }

      const target = targetUserId?.trim() || ''

      if (target.toLowerCase() === 'all') {
        const confirmed = await promptYesLocal(
          session,
          '⚠️ 即将清除【所有用户】的协议确认记录，所有用户下次使用功能时均需重新确认协议',
        )
        if (!confirmed) return '已取消'
        const all = await ctx.database.get('maibot_user_terms', {})
        const count = all.length
        for (const row of all) {
          await clearTermsAccepted(row.userId)
        }
        return count > 0
          ? `✅ 已清除全部 ${count} 条用户协议确认记录`
          : 'ℹ️ 当前没有任何用户协议确认记录'
      }

      let candidates: string[] = []
      if (target) {
        candidates = await resolveCooldownKeyCandidatesForBypass(session, target)
        if (!candidates.length) {
          return '❌ 无法解析目标用户，请使用 @用户 或数字 ID'
        }
      } else {
        const canonical = await getCanonicalV2UserId(session)
        const keys = await getSessionBindingKeys(ctx, session)
        candidates = [...new Set([canonical, ...keys].filter(Boolean))]
      }

      let cleared = 0
      for (const key of candidates) {
        const rows = await ctx.database.get('maibot_user_terms', { userId: key })
        if (rows.length) {
          await clearTermsAccepted(key)
          cleared++
        }
      }
      return cleared > 0
        ? `✅ 已清除 ${cleared} 条用户协议确认记录，相关用户下次使用功能时需重新确认。\n匹配键：${candidates.join('、')}`
        : `ℹ️ 未找到已确认的协议记录。\n匹配键：${candidates.join('、')}`
    })

  ctx.command('maiSGID获取 [input:text]', '调试：测试从文本/链接/图片消息提取 SGID')
    .alias('SGID获取')
    .userFields(['authority'])
    .action(async ({ session }, input) => {
      if (!session) return '❌ 无法获取会话信息'

      const canUse =
        (session.user?.authority ?? 0) >= authLevelForProxy ||
        (debugEnabled && isDebugSession(session))
      if (!canUse) {
        return `❌ 权限不足：需要 auth 等级 ${authLevelForProxy} 以上，或在调试群内且开启 debug 模式`
      }

      if (input?.trim()) {
        const result = extractSgidFromText(input.trim())
        return formatSgidExtractReport(result)
      }

      const tracker = createBotMessageTracker(session, ctx, autoRecallInteractive)
      await tracker.send(
        `【SGID 提取测试】请在 ${Math.floor(rebindTimeout / 1000)} 秒内发送：\n` +
          `• SGID 纯文本\n• wahlap req/img 链接\n• 玩家二维码图片\n\n${INTERACTIVE_CANCEL_HINT}`,
      )

      const replySession = await waitForUserReply(session, ctx, rebindTimeout)
      await tracker.recall()

      if (!replySession) {
        return '❌ 等待输入超时'
      }

      const replyText = replySession.content?.trim() || ''
      if (isInteractiveCancel(replyText)) {
        return '已取消'
      }

      await tryRecallMessage(replySession, ctx, config, replySession.messageId)

      const result = await extractSgidFromSession(replySession)
      return formatSgidExtractReport(result)
    })
}
