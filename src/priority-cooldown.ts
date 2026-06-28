import type { Context, Session } from 'koishi'
import type {
  MaiBotCardKey,
  MaiBotCardKind,
  MaiBotGroupPriority,
  MaiBotGroupRebindPending,
  MaiBotPriorityUser,
} from './database'

/** 卡密时长：有限为毫秒数，永久为 -1 */
export type CardDurationResult = number | -1 | null

export interface PriorityCooldownConfig {
  enabled?: boolean
  /** 大于该 Koishi authority 的用户视为管理员：绕过冷却，并自动同步永久个人优先（权限低于等于阈值时撤销该项自动授权） */
  adminBypassAuthority?: number
  shopUrl?: string
  /** 占位符：{remainingSec} */
  messageTemplate?: string
  normalTicketMs?: number
  priorityTicketMs?: number
  normalB50Ms?: number
  priorityB50Ms?: number
  normalStatusMs?: number
  priorityStatusMs?: number
  normalDefaultMs?: number
  priorityDefaultMs?: number
}

const DEFAULT_SHOP = 'https://ifdian.net/a/AWMC_TEAM?tab=shop'

/** 去重非空 userId（bind 跨平台、卡密同步） */
function dedupeNonEmptyUserIds(ids: (string | undefined | null)[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const s = id != null && id !== '' ? String(id) : ''
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

const MGR_TAB = '\t'
const GROUP_REBIND_TTL_MS = 10 * 60 * 1000

export function parseManagerUserIdsTab(raw: string | undefined): string[] {
  if (!raw?.trim()) return []
  return dedupeNonEmptyUserIds(raw.split(MGR_TAB))
}

function mergeManagerUserIdsField(existing: string | undefined, add: string[]): string {
  return dedupeNonEmptyUserIds([...parseManagerUserIdsTab(existing), ...add]).join(MGR_TAB)
}

/** 当前会话账号键是否可管理该群的群组优先（兑换人及其关联键） */
export function sessionKeysManageGroup(managerField: string | undefined, sessionKeys: string[]): boolean {
  const mgr = parseManagerUserIdsTab(managerField)
  if (!mgr.length) return false
  const set = new Set(sessionKeys)
  return mgr.some((m) => set.has(m))
}

/** 从指令名映射到冷却槽；返回 null 表示不参与冷却 */
export function commandToCooldownSlot(commandName: string): string | null {
  // Koishi 注册命令时 Command.normalize 会强制把名字转小写（参见 @koishijs/core）；
  // 这里也做小写处理，避免 'mai上传B50' / 'mai上传b50' 因大小写不一致落入错误的槽。
  const base = (commandName.split(/\s+/)[0] || commandName).toLowerCase()
  const excluded = new Set([
    'mai',
    'maiping',
    'maiqueue',
    'mai绑定',
    'mai解绑',
    'mai绑定水鱼',
    'mai解绑水鱼',
    'mai绑定落雪',
    'mai解绑落雪',
    'mai查询opt',
    'mai取消群组优先',
    'mai群组优先换绑',
    'mai群组优先换入',
  ])
  if (excluded.has(base)) return null
  if (base.startsWith('mai管理员')) return null
  if (base === 'maibypass') return null

  if (base === 'mai发票') return 'ticket'
  if (base === 'mai上传乐曲成绩' || base === 'mai获取收藏品' || base === 'mai删除成绩') return 'ticket'
  if (base === 'mai上传b50' || base === 'maiua' || base === 'mai上传落雪b50') return 'b50'
  if (base === 'mai状态' || base === 'mymai' || base === 'mai地图') return 'status'
  return 'default'
}

function slotCooldownMs(
  slot: string,
  cfg: PriorityCooldownConfig,
  isPriority: boolean,
): number {
  const p = isPriority ? 'priority' : 'normal'
  const map: Record<string, [keyof PriorityCooldownConfig, keyof PriorityCooldownConfig]> = {
    ticket: ['normalTicketMs', 'priorityTicketMs'],
    b50: ['normalB50Ms', 'priorityB50Ms'],
    status: ['normalStatusMs', 'priorityStatusMs'],
    default: ['normalDefaultMs', 'priorityDefaultMs'],
  }
  const keys = map[slot] || map.default
  const def: Record<string, [number, number]> = {
    ticket: [20 * 60 * 1000, 0],
    b50: [30 * 1000, 0],
    status: [30 * 1000, 0],
    default: [30 * 1000, 0],
  }
  const d = def[slot] || def.default
  const nk = keys[0]
  const pk = keys[1]
  const raw = (isPriority ? cfg[pk] : cfg[nk]) as number | undefined
  if (typeof raw === 'number' && raw >= 0) return raw
  return isPriority ? d[1] : d[0]
}

function formatCooldownMessage(cfg: PriorityCooldownConfig, remainingSec: number): string {
  const tpl =
    cfg.messageTemplate ||
    '普通用户使用此功能有限制。您的冷却时间剩余：{remainingSec}秒。前往{shopUrl}购买优先授权！'
  const shop = cfg.shopUrl || DEFAULT_SHOP
  return tpl.replace(/\{remainingSec\}/g, String(remainingSec)).replace(/\{shopUrl\}/g, shop)
}

export async function isPriorityUserNow(ctx: Context, userId: string): Promise<boolean> {
  if (!userId) return false
  const rows = await ctx.database.get('maibot_priority_users', { userId })
  const row = rows[0]
  if (!row) return false
  if (row.expiresAt === undefined || row.expiresAt === null) return true
  return new Date(row.expiresAt).getTime() > Date.now()
}

/** 任一 userId 有效优先即 true（bind 跨平台） */
export async function isPriorityUserNowAny(ctx: Context, userIds: string[]): Promise<boolean> {
  for (const id of dedupeNonEmptyUserIds(userIds)) {
    if (await isPriorityUserNow(ctx, id)) return true
  }
  return false
}

/** 与冷却、群组授权中使用的群标识一致：有 platform 时为 platform:guildId，否则为 guildId */
export function canonicalGuildPriorityKey(session: Session): string | null {
  if (!session.guildId) return null
  const platform = String(session.platform || '').trim().toLowerCase()
  const guildId = String(session.guildId || '').trim()
  if (!guildId) return null
  return platform ? `${platform}:${guildId}` : guildId
}

export async function isGroupPriorityActive(ctx: Context, session: Session): Promise<boolean> {
  const gkey = canonicalGuildPriorityKey(session)
  if (!gkey) return false
  const rows = await ctx.database.get('maibot_group_priority', { guildKey: gkey })
  const row = rows[0] as MaiBotGroupPriority | undefined
  if (!row) return false
  if (row.expiresAt === undefined || row.expiresAt === null) return true
  return new Date(row.expiresAt).getTime() > Date.now()
}

export async function getGroupPriorityDisplay(
  ctx: Context,
  session: Session,
): Promise<{ active: boolean; expiresAt: Date | null; permanent: boolean }> {
  const gkey = canonicalGuildPriorityKey(session)
  if (!gkey) {
    return { active: false, expiresAt: null, permanent: false }
  }
  const rows = await ctx.database.get('maibot_group_priority', { guildKey: gkey })
  const row = rows[0] as MaiBotGroupPriority | undefined
  if (!row) {
    return { active: false, expiresAt: null, permanent: false }
  }
  if (row.expiresAt === undefined || row.expiresAt === null) {
    return { active: true, expiresAt: null, permanent: true }
  }
  const exp = new Date(row.expiresAt)
  if (exp.getTime() <= Date.now()) {
    return { active: false, expiresAt: exp, permanent: false }
  }
  return { active: true, expiresAt: exp, permanent: false }
}

export async function getPriorityUserDisplay(
  ctx: Context,
  userId: string,
): Promise<{ isPriority: boolean; expiresAt: Date | null; permanent: boolean }> {
  if (!userId) {
    return { isPriority: false, expiresAt: null, permanent: false }
  }
  const rows = await ctx.database.get('maibot_priority_users', { userId })
  const row = rows[0]
  if (!row) {
    return { isPriority: false, expiresAt: null, permanent: false }
  }
  if (row.expiresAt === undefined || row.expiresAt === null) {
    return { isPriority: true, expiresAt: null, permanent: true }
  }
  const exp = new Date(row.expiresAt)
  if (exp.getTime() <= Date.now()) {
    return { isPriority: false, expiresAt: exp, permanent: false }
  }
  return { isPriority: true, expiresAt: exp, permanent: false }
}

/** 在多个关联 userId 中取展示用优先状态（永久优先，否则取最晚到期） */
export async function getPriorityUserDisplayForAnyKey(
  ctx: Context,
  userIds: string[],
): Promise<{ isPriority: boolean; expiresAt: Date | null; permanent: boolean }> {
  const ids = dedupeNonEmptyUserIds(userIds)
  let best: { isPriority: boolean; expiresAt: Date | null; permanent: boolean } | null = null
  for (const id of ids) {
    const v = await getPriorityUserDisplay(ctx, id)
    if (!v.isPriority) continue
    if (v.permanent) return v
    if (!best) {
      best = v
      continue
    }
    const bt = best.expiresAt?.getTime() ?? 0
    const vt = v.expiresAt?.getTime() ?? 0
    if (vt > bt) best = v
  }
  return best ?? { isPriority: false, expiresAt: null, permanent: false }
}

/**
 * 按 Koishi authority 与 adminBypassAuthority 同步「管理员自动永久个人优先」：
 * authority > 阈值 时写入/刷新 authorityAuto；≤ 阈值 时仅删除 authorityAuto 行（不碰卡密兑换产生的记录）。
 */
export async function syncAuthorityAutoPriority(
  ctx: Context,
  cfg: PriorityCooldownConfig | undefined,
  session: Session,
  getLinkedUserIds: (s: Session) => Promise<string[]>,
): Promise<void> {
  const c = cfg || {}
  if (!c.enabled) return

  const threshold = c.adminBypassAuthority ?? 4
  const auth = (session.user as { authority?: number } | undefined)?.authority ?? 0
  const primary = String(session.userId || '').trim()
  const linked = dedupeNonEmptyUserIds([primary, ...(await getLinkedUserIds(session))])

  if (auth > threshold) {
    const now = new Date()
    for (const uid of linked) {
      if (!uid) continue
      const rows = await ctx.database.get('maibot_priority_users', { userId: uid })
      const row = rows[0] as MaiBotPriorityUser | undefined
      if (row && row.authorityAuto !== true) {
        continue
      }
      if (row) {
        await ctx.database.set('maibot_priority_users', { userId: uid }, {
          expiresAt: null,
          updatedAt: now,
          authorityAuto: true,
        })
      } else {
        await ctx.database.create('maibot_priority_users', {
          userId: uid,
          updatedAt: now,
          authorityAuto: true,
        })
      }
    }
    return
  }

  for (const uid of linked) {
    if (!uid) continue
    const rows = await ctx.database.get('maibot_priority_users', { userId: uid })
    const row = rows[0] as MaiBotPriorityUser | undefined
    if (row?.authorityAuto === true) {
      await ctx.database.remove('maibot_priority_users', { userId: uid })
    }
  }
}

export async function checkCommandCooldown(
  ctx: Context,
  session: Session,
  cfg: PriorityCooldownConfig | undefined,
  commandName: string,
  getPrimaryUserId: (s: Session) => Promise<string>,
  /** 与 getPrimaryUserId 同一自然人的其它键（如各平台 ID）；用于识别在任一平台上兑换的个人优先 */
  getLinkedUserIdsForPriority?: (s: Session) => Promise<string[]>,
  /** 当前用户绑定的 maiUid，用于跨账号共享冷却 */
  maiUid?: string,
): Promise<string | null> {
  const c = cfg || {}
  if (!c.enabled) return null

  const slot = commandToCooldownSlot(commandName)
  if (!slot) return null

  const auth = (session.user as { authority?: number } | undefined)?.authority ?? 0
  const bypass = c.adminBypassAuthority ?? 4
  if (auth > bypass) return null

  const userId = await getPrimaryUserId(session)
  if (!userId) return null

  let personalPriority: boolean
  if (getLinkedUserIdsForPriority) {
    const linked = await getLinkedUserIdsForPriority(session)
    personalPriority = await isPriorityUserNowAny(ctx, [userId, ...linked])
  } else {
    personalPriority = await isPriorityUserNow(ctx, userId)
  }
  const groupPriority = await isGroupPriorityActive(ctx, session)
  const priority = personalPriority || groupPriority
  const needMs = slotCooldownMs(slot, c, priority)
  if (needMs <= 0) return null

  // 先检查个人冷却键
  const rows = await ctx.database.get('maibot_user_cooldowns', { userId, slot })
  const row = rows[0]
  if (row) {
    const elapsed = Date.now() - new Date(row.lastAt).getTime()
    if (elapsed < needMs) {
      const remainingSec = Math.ceil((needMs - elapsed) / 1000)
      return formatCooldownMessage(c, remainingSec)
    }
  }

  // 再检查 maiuid 共享冷却键（防止小号绕过）
  if (maiUid) {
    const sharedKey = `maiuid:${maiUid}`
    const sharedRows = await ctx.database.get('maibot_user_cooldowns', { userId: sharedKey, slot })
    const sharedRow = sharedRows[0]
    if (sharedRow) {
      const elapsed = Date.now() - new Date(sharedRow.lastAt).getTime()
      if (elapsed < needMs) {
        const remainingSec = Math.ceil((needMs - elapsed) / 1000)
        return formatCooldownMessage(c, remainingSec)
      }
    }
  }

  return null
}

export async function recordCommandCooldown(
  ctx: Context,
  userId: string,
  commandName: string,
  cfg: PriorityCooldownConfig | undefined,
  /** 当前用户绑定的 maiUid，用于跨账号共享冷却 */
  maiUid?: string,
): Promise<void> {
  const c = cfg || {}
  if (!c.enabled) return

  const slot = commandToCooldownSlot(commandName)
  if (!slot) return

  const now = new Date()

  // 写入个人冷却键
  const existing = await ctx.database.get('maibot_user_cooldowns', { userId, slot })
  if (existing.length > 0) {
    await ctx.database.set('maibot_user_cooldowns', { userId, slot }, { lastAt: now })
  } else {
    await ctx.database.create('maibot_user_cooldowns', { userId, slot, lastAt: now })
  }

  // 同时写入 maiuid 共享冷却键
  if (maiUid) {
    const sharedKey = `maiuid:${maiUid}`
    const sharedExisting = await ctx.database.get('maibot_user_cooldowns', { userId: sharedKey, slot })
    if (sharedExisting.length > 0) {
      await ctx.database.set('maibot_user_cooldowns', { userId: sharedKey, slot }, { lastAt: now })
    } else {
      await ctx.database.create('maibot_user_cooldowns', { userId: sharedKey, slot, lastAt: now })
    }
  }
}

/**
 * 解析卡密时长。支持：-1 / 永久；7d / 7天；12h / 小时；7d12h；1mo / 1月 / 一个月；1y / 1年；
 * 按需求：单独的数字+m（且非 mo、非 min）表示「天」，如 1m = 1 天；min / 分钟 表示分钟。
 */
export function parseCardDurationSpec(spec: string): CardDurationResult {
  let s = spec.trim().replace(/\s+/g, '')
  if (!s) return null
  if (s === '-1' || s === '永久') return -1
  const low = s.toLowerCase()
  if (low === 'forever' || low === 'perm' || low === 'permanent') return -1

  s = s.replace(/一个月/g, '1mo').replace(/(\d+)个月/g, '$1mo')

  const unitRe = /(\d+(?:\.\d+)?)(mo|月|min|分钟|ms|年|y|天|d|小时|时|h|m)/gi
  let total = 0
  let matched = false
  let m: RegExpExecArray | null
  while ((m = unitRe.exec(s)) !== null) {
    const v = parseFloat(m[1])
    const u = m[2].toLowerCase()
    if (!Number.isFinite(v) || v < 0) return null
    matched = true
    if (u === 'mo' || u === '月') total += v * 30 * 24 * 60 * 60 * 1000
    else if (u === 'y' || u === '年') total += v * 365 * 24 * 60 * 60 * 1000
    else if (u === 'd' || u === '天') total += v * 24 * 60 * 60 * 1000
    else if (u === 'h' || u === '时') total += v * 60 * 60 * 1000
    else if (u === '小时') total += v * 60 * 60 * 1000
    else if (u === 'min' || u === '分钟') total += v * 60 * 1000
    else if (u === 'ms') total += v
    else if (u === 'm') total += v * 24 * 60 * 60 * 1000
  }

  if (!matched) return null
  if (total <= 0 || !Number.isFinite(total)) return null
  return Math.floor(total)
}

export function generateCardCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 18; i++) {
    out += chars[Math.floor(Math.random() * chars.length)]
  }
  return `MAI-${out}`
}

function normalizeCardKind(k: MaiBotCardKind | undefined): MaiBotCardKind {
  if (k === 'group') return 'group'
  if (k === 'unbind') return 'unbind'
  return 'personal'
}

export function cardKeyKind(key: MaiBotCardKey): MaiBotCardKind {
  return normalizeCardKind(key.cardKind as MaiBotCardKind | undefined)
}

export async function createCardKeys(
  ctx: Context,
  issuerUserId: string,
  duration: CardDurationResult,
  count: number,
  cardKind: MaiBotCardKind = 'personal',
): Promise<MaiBotCardKey[]> {
  const permanent = duration === -1
  const durationMs = permanent ? 0 : (duration as number)
  const ck = normalizeCardKind(cardKind)
  const forUnbind = ck === 'unbind'
  const created: MaiBotCardKey[] = []
  for (let i = 0; i < count; i++) {
    let code = generateCardCode()
    for (let attempt = 0; attempt < 5; attempt++) {
      const dup = await ctx.database.get('maibot_card_keys', { code })
      if (dup.length === 0) break
      code = generateCardCode()
    }
    await ctx.database.create('maibot_card_keys', {
      code,
      cardKind: ck,
      permanent: forUnbind ? true : permanent,
      durationMs: forUnbind ? 0 : durationMs,
      createdAt: new Date(),
      issuerUserId,
      active: true,
    })
    const saved = await ctx.database.get('maibot_card_keys', { code })
    if (saved[0]) created.push(saved[0] as MaiBotCardKey)
  }
  return created
}

export async function redeemCardKey(
  ctx: Context,
  codeRaw: string,
  redeemerUserId: string,
  session: Session,
  /** 当前绑定行 maibot_bindings.userId；解绑卡兑换必填 */
  bindingDbUserId: string | null,
  /**
   * 与当前会话关联的全部账号键（含 koishi: 统一 ID、各平台原始 ID、bind 插件反查的 legacy ID）。
   * 个人卡密：优先授权写入每一键；解绑卡：同 maiUid 的多行绑定同步 unbindCredits。
   */
  linkedAccountUserIds?: string[],
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const code = codeRaw.trim().toUpperCase()
  const rows = await ctx.database.get('maibot_card_keys', { code })
  const key = rows[0] as MaiBotCardKey | undefined
  if (!key || !key.active) {
    return { ok: false, message: '❌ 卡密无效或已被删除' }
  }
  if (key.redeemedAt) {
    return { ok: false, message: '❌ 该卡密已被兑换' }
  }

  const kind = cardKeyKind(key)
  const now = Date.now()

  if (kind === 'group') {
    const gkey = canonicalGuildPriorityKey(session)
    if (!gkey) {
      return { ok: false, message: '❌ 此为群组卡密，请在群聊内兑换（私聊无法绑定到群组）。' }
    }

    const gRows = await ctx.database.get('maibot_group_priority', { guildKey: gkey })
    const existingG = gRows[0] as MaiBotGroupPriority | undefined
    const mgrAdd = dedupeNonEmptyUserIds([redeemerUserId, ...(linkedAccountUserIds ?? [])])
    const mergedMgr = mergeManagerUserIdsField(existingG?.managerUserIds, mgrAdd)

    let newGExpires: Date | undefined
    if (key.permanent) {
      newGExpires = undefined
    } else {
      const add = key.durationMs
      const baseStart = (() => {
        if (!existingG?.expiresAt) return now
        const t = new Date(existingG.expiresAt).getTime()
        return t > now ? t : now
      })()
      newGExpires = new Date(baseStart + add)
    }

    await ctx.database.set(
      'maibot_card_keys',
      { code },
      {
        redeemedAt: new Date(),
        redeemerUserId,
      },
    )

    if (key.permanent) {
      const prev = await ctx.database.get('maibot_group_priority', { guildKey: gkey })
      if (prev.length > 0) {
        await ctx.database.set('maibot_group_priority', { guildKey: gkey }, {
          expiresAt: null,
          updatedAt: new Date(),
          managerUserIds: mergedMgr,
        } as any)
      } else {
        await ctx.database.create('maibot_group_priority', {
          guildKey: gkey,
          updatedAt: new Date(),
          managerUserIds: mergedMgr,
        })
      }
    } else {
      const prev = await ctx.database.get('maibot_group_priority', { guildKey: gkey })
      if (prev.length > 0) {
        await ctx.database.set('maibot_group_priority', { guildKey: gkey }, {
          expiresAt: newGExpires,
          updatedAt: new Date(),
          managerUserIds: mergedMgr,
        })
      } else {
        await ctx.database.create('maibot_group_priority', {
          guildKey: gkey,
          expiresAt: newGExpires!,
          updatedAt: new Date(),
          managerUserIds: mergedMgr,
        })
      }
    }

    const untilText = key.permanent ? '永久' : newGExpires!.toLocaleString('zh-CN')
    return {
      ok: true,
      message:
        `✅ 兑换成功！本群已启用群组优先（群内全体成员使用 Bot 时免冷却，私聊不享受）。\n` +
        `本群授权到期：${untilText}`,
    }
  }

  if (kind === 'unbind') {
    if (!bindingDbUserId) {
      return { ok: false, message: '❌ 请先绑定舞萌账号后，再兑换解绑卡。' }
    }
    const bRows = await ctx.database.get('maibot_bindings', { userId: bindingDbUserId })
    const b = bRows[0]
    if (!b) {
      return { ok: false, message: '❌ 未找到绑定记录，无法兑换解绑卡。' }
    }
    await ctx.database.set(
      'maibot_card_keys',
      { code },
      {
        redeemedAt: new Date(),
        redeemerUserId,
      },
    )
    const next = (b.unbindCredits ?? 0) + 1
    const syncBindIds = dedupeNonEmptyUserIds([bindingDbUserId, ...(linkedAccountUserIds ?? [])])
    for (const bid of syncBindIds) {
      const row = await ctx.database.get('maibot_bindings', { userId: bid })
      const ob = row[0] as { maiUid?: string } | undefined
      if (ob && String(ob.maiUid) === String(b.maiUid)) {
        await ctx.database.set('maibot_bindings', { userId: bid }, { unbindCredits: next })
      }
    }
    return {
      ok: true,
      message:
        `✅ 解绑卡兑换成功！您当前拥有 ${next} 次解绑额度。\n` +
        `在换绑冷却期内请使用 /mai解绑卡 或 /maiunbindkey，按提示发送 SGID 并确认后即可解绑。`,
    }
  }

  // personal：所有关联平台 userId 写入相同优先状态（兼容 bind 跨 QQ / KOOK 等）
  const prioSyncIds = dedupeNonEmptyUserIds([redeemerUserId, ...(linkedAccountUserIds ?? [])])

  let newExpires: Date | undefined
  if (key.permanent) {
    newExpires = undefined
  } else {
    const add = key.durationMs
    let baseStart = now
    let hitPermanent = false
    for (const uid of prioSyncIds) {
      const rows = await ctx.database.get('maibot_priority_users', { userId: uid })
      const e = rows[0] as MaiBotPriorityUser | undefined
      if (!e) continue
      if (!e.expiresAt) {
        hitPermanent = true
        break
      }
      const t = new Date(e.expiresAt).getTime()
      const candidate = t > now ? t : now
      if (candidate > baseStart) baseStart = candidate
    }
    if (hitPermanent) {
      baseStart = now
    }
    newExpires = new Date(baseStart + add)
  }

  await ctx.database.set(
    'maibot_card_keys',
    { code },
    {
      redeemedAt: new Date(),
      redeemerUserId,
    },
  )

  if (key.permanent) {
    for (const uid of prioSyncIds) {
      const prevP = await ctx.database.get('maibot_priority_users', { userId: uid })
      if (prevP.length > 0) {
        await ctx.database.set('maibot_priority_users', { userId: uid }, {
          expiresAt: null,
          updatedAt: new Date(),
          authorityAuto: false,
        })
      } else {
        await ctx.database.create('maibot_priority_users', {
          userId: uid,
          updatedAt: new Date(),
          authorityAuto: false,
        })
      }
    }
  } else {
    for (const uid of prioSyncIds) {
      const prev = await ctx.database.get('maibot_priority_users', { userId: uid })
      if (prev.length > 0) {
        await ctx.database.set('maibot_priority_users', { userId: uid }, {
          expiresAt: newExpires,
          updatedAt: new Date(),
          authorityAuto: false,
        })
      } else {
        await ctx.database.create('maibot_priority_users', {
          userId: uid,
          expiresAt: newExpires!,
          updatedAt: new Date(),
          authorityAuto: false,
        })
      }
    }
  }

  const untilText = key.permanent
    ? '永久'
    : newExpires!.toLocaleString('zh-CN')
  return { ok: true, message: `✅ 兑换成功！个人优先授权已生效，到期时间：${untilText}` }
}

export async function sweepExpiredGroupRebindPending(ctx: Context): Promise<void> {
  const rows = await ctx.database.get('maibot_group_rebind_pending', {})
  const now = Date.now()
  for (const r of rows as MaiBotGroupRebindPending[]) {
    if (new Date(r.expiresAt).getTime() < now) {
      await ctx.database.remove('maibot_group_rebind_pending', { anchorUserId: r.anchorUserId })
    }
  }
}

export async function userCancelGroupPriority(
  ctx: Context,
  guildKey: string,
  sessionKeys: string[],
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const rows = await ctx.database.get('maibot_group_priority', { guildKey })
  const row = rows[0] as MaiBotGroupPriority | undefined
  if (!row) {
    return { ok: false, message: '❌ 本群当前没有群组优先授权记录。' }
  }
  if (!sessionKeysManageGroup(row.managerUserIds, sessionKeys)) {
    return {
      ok: false,
      message:
        '❌ 仅群组卡密兑换人（及跨平台关联账号）可取消。\n若数据较旧无兑换人记录，请使用 /mai管理员取消群组优先。',
    }
  }
  await ctx.database.remove('maibot_group_priority', { guildKey })
  return { ok: true, message: '✅ 已取消本群的群组优先授权。' }
}

export async function startGroupPriorityRebind(
  ctx: Context,
  session: Session,
  getLinkedUserIds: (s: Session) => Promise<string[]>,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const fromGuildKey = canonicalGuildPriorityKey(session)
  if (!fromGuildKey) {
    return { ok: false, message: '❌ 请在原群组内发送本指令以发起换绑。' }
  }
  const gRows = await ctx.database.get('maibot_group_priority', { guildKey: fromGuildKey })
  const grow = gRows[0] as MaiBotGroupPriority | undefined
  if (!grow) {
    return { ok: false, message: '❌ 本群当前没有群组优先授权。' }
  }
  const sessionKeys = dedupeNonEmptyUserIds([String(session.userId || ''), ...(await getLinkedUserIds(session))])
  if (!sessionKeysManageGroup(grow.managerUserIds, sessionKeys)) {
    return { ok: false, message: '❌ 仅兑换人可对群组授权发起换绑。' }
  }
  const anchorUserId = sessionKeys[0] || String(session.userId)
  const exp = new Date(Date.now() + GROUP_REBIND_TTL_MS)
  const prev = await ctx.database.get('maibot_group_rebind_pending', { anchorUserId })
  if (prev.length) {
    await ctx.database.remove('maibot_group_rebind_pending', { anchorUserId })
  }
  await ctx.database.create('maibot_group_rebind_pending', {
    anchorUserId,
    matchKeys: sessionKeys.join(MGR_TAB),
    fromGuildKey,
    expiresAt: exp,
  })
  const min = Math.ceil(GROUP_REBIND_TTL_MS / 60000)
  return {
    ok: true,
    message:
      `✅ 已发起换绑。请在 ${min} 分钟内在目标群内发送 /mai群组优先换入（需同一账号）。\n原群标识：${fromGuildKey}`,
  }
}

function mergeTransferredGroupState(
  from: MaiBotGroupPriority,
  intoExisting: MaiBotGroupPriority | undefined,
): { expiresAt: Date | undefined; permanent: boolean; managerUserIds: string } {
  const mergedMgr = mergeManagerUserIdsField(intoExisting?.managerUserIds, parseManagerUserIdsTab(from.managerUserIds))
  const fromPerm = !from.expiresAt
  const intoPerm = !!(intoExisting && !intoExisting.expiresAt)
  if (fromPerm || intoPerm) {
    return { permanent: true, expiresAt: undefined, managerUserIds: mergedMgr }
  }
  const now = Date.now()
  const tFrom = from.expiresAt ? new Date(from.expiresAt).getTime() : now
  const tInto = intoExisting?.expiresAt ? Math.max(new Date(intoExisting.expiresAt).getTime(), now) : now
  return { permanent: false, expiresAt: new Date(Math.max(tFrom, tInto)), managerUserIds: mergedMgr }
}

export async function completeGroupPriorityRebind(
  ctx: Context,
  session: Session,
  getLinkedUserIds: (s: Session) => Promise<string[]>,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const toGuildKey = canonicalGuildPriorityKey(session)
  if (!toGuildKey) {
    return { ok: false, message: '❌ 请在目标群聊内发送 /mai群组优先换入。' }
  }
  const sessionKeys = dedupeNonEmptyUserIds([String(session.userId || ''), ...(await getLinkedUserIds(session))])
  const keySet = new Set(sessionKeys)

  await sweepExpiredGroupRebindPending(ctx)

  const pendingAll = await ctx.database.get('maibot_group_rebind_pending', {})
  const now = Date.now()
  const hit = (pendingAll as MaiBotGroupRebindPending[]).find((p) => {
    if (new Date(p.expiresAt).getTime() < now) return false
    if (p.anchorUserId && keySet.has(p.anchorUserId)) return true
    const saved = parseManagerUserIdsTab(p.matchKeys)
    return saved.some((k) => keySet.has(k))
  })

  if (!hit) {
    return { ok: false, message: '❌ 没有待完成的换绑，请先在原群发送 /mai群组优先换绑。' }
  }
  if (hit.fromGuildKey === toGuildKey) {
    return { ok: false, message: '❌ 目标群不能与原群相同。' }
  }

  const fromRows = await ctx.database.get('maibot_group_priority', { guildKey: hit.fromGuildKey })
  const fromRow = fromRows[0] as MaiBotGroupPriority | undefined
  if (!fromRow) {
    await ctx.database.remove('maibot_group_rebind_pending', { anchorUserId: hit.anchorUserId })
    return { ok: false, message: '❌ 原群授权已不存在，换绑已失效。' }
  }

  const toRows = await ctx.database.get('maibot_group_priority', { guildKey: toGuildKey })
  const toExisting = toRows[0] as MaiBotGroupPriority | undefined
  const merged = mergeTransferredGroupState(fromRow, toExisting)

  await ctx.database.remove('maibot_group_priority', { guildKey: hit.fromGuildKey })
  await ctx.database.remove('maibot_group_rebind_pending', { anchorUserId: hit.anchorUserId })

  const nowDate = new Date()
  if (toExisting) {
    if (merged.permanent) {
      await ctx.database.set('maibot_group_priority', { guildKey: toGuildKey }, {
        expiresAt: null,
        updatedAt: nowDate,
        managerUserIds: merged.managerUserIds,
      } as any)
    } else {
      await ctx.database.set('maibot_group_priority', { guildKey: toGuildKey }, {
        expiresAt: merged.expiresAt!,
        updatedAt: nowDate,
        managerUserIds: merged.managerUserIds,
      })
    }
  } else if (merged.permanent) {
    await ctx.database.create('maibot_group_priority', {
      guildKey: toGuildKey,
      updatedAt: nowDate,
      managerUserIds: merged.managerUserIds,
    })
  } else {
    await ctx.database.create('maibot_group_priority', {
      guildKey: toGuildKey,
      expiresAt: merged.expiresAt!,
      updatedAt: nowDate,
      managerUserIds: merged.managerUserIds,
    })
  }

  const untilText = merged.permanent ? '永久' : merged.expiresAt!.toLocaleString('zh-CN')
  return {
    ok: true,
    message: `✅ 已将群组优先从原群迁移到本群。\n本群授权到期：${untilText}`,
  }
}

/** 解析管理员对个人/群组优先的「直接修改」参数：clear / 永久 / 时长 */
export function parsePriorityAdminSpec(specRaw: string): 'clear' | 'permanent' | number | null {
  const s = specRaw.trim()
  if (!s) return null
  const low = s.toLowerCase()
  if (low === 'clear' || s === '取消' || s === '删除' || low === 'none') return 'clear'
  if (s === '永久' || s === '-1' || low === 'forever' || low === 'permanent' || low === 'perm') return 'permanent'
  const parsed = parseCardDurationSpec(s)
  if (parsed === -1) return 'permanent'
  if (parsed === null) return null
  return parsed
}

export async function adminRemovePersonalPriorityRows(ctx: Context, userIds: string[]): Promise<number> {
  let n = 0
  for (const uid of dedupeNonEmptyUserIds(userIds)) {
    const rows = await ctx.database.get('maibot_priority_users', { userId: uid })
    if (rows.length) {
      await ctx.database.remove('maibot_priority_users', { userId: uid })
      n++
    }
  }
  return n
}

export async function adminSetPersonalPriorityForUserIds(
  ctx: Context,
  userIds: string[],
  spec: 'clear' | 'permanent' | number,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const ids = dedupeNonEmptyUserIds(userIds)
  if (!ids.length) return { ok: false, message: '❌ 无有效用户键' }
  if (spec === 'clear') {
    const n = await adminRemovePersonalPriorityRows(ctx, ids)
    return { ok: true, message: `✅ 已清除 ${n} 条个人优先记录。` }
  }
  const now = new Date()
  for (const uid of ids) {
    if (spec === 'permanent') {
      const ex = await ctx.database.get('maibot_priority_users', { userId: uid })
      if (ex.length) {
        await ctx.database.set('maibot_priority_users', { userId: uid }, {
          expiresAt: null,
          updatedAt: now,
          authorityAuto: false,
        } as any)
      } else {
        await ctx.database.create('maibot_priority_users', {
          userId: uid,
          updatedAt: now,
          authorityAuto: false,
        })
      }
    } else {
      const exp = new Date(Date.now() + spec)
      const ex = await ctx.database.get('maibot_priority_users', { userId: uid })
      if (ex.length) {
        await ctx.database.set('maibot_priority_users', { userId: uid }, {
          expiresAt: exp,
          updatedAt: now,
          authorityAuto: false,
        })
      } else {
        await ctx.database.create('maibot_priority_users', {
          userId: uid,
          expiresAt: exp,
          updatedAt: now,
          authorityAuto: false,
        })
      }
    }
  }
  const tail = spec === 'permanent' ? '永久' : new Date(Date.now() + spec).toLocaleString('zh-CN')
  return { ok: true, message: `✅ 已更新 ${ids.length} 个账号键的个人优先（到期：${tail}）。` }
}

export async function adminRemoveGroupPriorityRow(ctx: Context, guildKey: string): Promise<boolean> {
  const rows = await ctx.database.get('maibot_group_priority', { guildKey })
  if (!rows.length) return false
  await ctx.database.remove('maibot_group_priority', { guildKey })
  return true
}

export async function adminSetGroupPriorityForGuild(
  ctx: Context,
  guildKey: string,
  spec: 'clear' | 'permanent' | number,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const gk = guildKey.trim()
  if (!gk) return { ok: false, message: '❌ 无效的群标识' }
  if (spec === 'clear') {
    const did = await adminRemoveGroupPriorityRow(ctx, gk)
    return { ok: true, message: did ? `✅ 已取消群组优先：${gk}` : `ℹ️ 该群无群组优先记录：${gk}` }
  }
  const nowD = new Date()
  if (spec === 'permanent') {
    const ex = await ctx.database.get('maibot_group_priority', { guildKey: gk })
    if (ex.length) {
      await ctx.database.set('maibot_group_priority', { guildKey: gk }, {
        expiresAt: null,
        updatedAt: nowD,
      } as any)
    } else {
      await ctx.database.create('maibot_group_priority', {
        guildKey: gk,
        updatedAt: nowD,
      })
    }
    return { ok: true, message: `✅ 已设置 ${gk} 为永久群组优先（未写入兑换人）。` }
  }
  const exp = new Date(Date.now() + spec)
  const ex = await ctx.database.get('maibot_group_priority', { guildKey: gk })
  if (ex.length) {
    await ctx.database.set('maibot_group_priority', { guildKey: gk }, {
      expiresAt: exp,
      updatedAt: nowD,
    })
  } else {
    await ctx.database.create('maibot_group_priority', {
      guildKey: gk,
      expiresAt: exp,
      updatedAt: nowD,
    })
  }
  return { ok: true, message: `✅ 已设置 ${gk} 群组优先到期：${exp.toLocaleString('zh-CN')}（自此刻起算）。` }
}

/** 清除某一 userId 下的全部冷却槽 */
export async function clearUserCooldowns(ctx: Context, userId: string): Promise<number> {
  if (!userId) return 0
  const rows = await ctx.database.get('maibot_user_cooldowns', { userId })
  let n = 0
  for (const r of rows) {
    await ctx.database.remove('maibot_user_cooldowns', { userId: r.userId, slot: r.slot })
    n++
  }
  return n
}

/** 合并清除多个可能的主键（如平台 ID 与 koishi: 统一 ID），同一槽位只删一次 */
export async function clearUserCooldownsForKeys(ctx: Context, userIds: string[]): Promise<number> {
  const seen = new Set<string>()
  let total = 0
  const uniq = [...new Set(userIds.filter(Boolean))]
  for (const uid of uniq) {
    const rows = await ctx.database.get('maibot_user_cooldowns', { userId: uid })
    for (const r of rows) {
      const sig = `${r.userId}\t${r.slot}`
      if (seen.has(sig)) continue
      seen.add(sig)
      await ctx.database.remove('maibot_user_cooldowns', { userId: r.userId, slot: r.slot })
      total++
    }
  }
  return total
}
