import type { Context } from 'koishi'
import type { UserBinding } from './database'

export const LXNS_TOKEN_HINT_URL = 'https://maimai.lxns.net/user/profile?tab=thirdparty'

/** 落雪 Token（个人中心第三方导入，非旧版 15 位好友码） */
export function isValidLxnsToken(token: string): boolean {
  const t = token.trim()
  if (t.length < 32 || t.length > 128) return false
  if (!/^[A-Za-z0-9+/=_-]+$/.test(t)) return false
  if (t.startsWith('SGWCMAID') || t.startsWith('MAID')) return false
  return true
}

/** 仍为旧版落雪好友码等非 Token 格式 */
export function isLegacyLxnsFriendCode(code: string | undefined | null): boolean {
  const t = (code || '').trim()
  if (!t) return false
  return !isValidLxnsToken(t)
}

export function maskLxnsToken(token: string): string {
  const t = token.trim()
  if (t.length <= 10) return '***'
  return `${t.slice(0, 6)}***${t.slice(-4)}`
}

export function lxnsTokenFormatError(): string {
  return (
    '❌ 落雪 Token 格式无效\n' +
    '请在落雪个人中心获取 Token（类似 2sDHRYucFS03HGBbw0naqyHpRxQSFPbhMlbO4vmWQUo=）\n' +
    LXNS_TOKEN_HINT_URL
  )
}

/** 清除所有非 Token 格式的落雪绑定（旧好友码等） */
export async function purgeInvalidLxnsBindings(ctx: Context): Promise<number> {
  const rows = await ctx.database.get('maibot_bindings', {})
  let cleared = 0
  for (const row of rows) {
    if (!isLegacyLxnsFriendCode(row.lxnsCode)) continue
    await ctx.database.set('maibot_bindings', { userId: row.userId }, { lxnsCode: '' })
    cleared++
  }
  return cleared
}

/** 清除指定用户的落雪绑定；legacyOnly 为 true 时仅清除旧好友码 */
export async function clearUserLxnsBinding(
  ctx: Context,
  userId: string,
  legacyOnly: boolean,
): Promise<'none' | 'skipped' | 'cleared'> {
  const rows = await ctx.database.get('maibot_bindings', { userId })
  if (!rows.length || !rows[0].lxnsCode?.trim()) return 'none'
  const code = rows[0].lxnsCode.trim()
  if (legacyOnly && isValidLxnsToken(code)) return 'skipped'
  await ctx.database.set('maibot_bindings', { userId }, { lxnsCode: '' })
  return 'cleared'
}

/** 清除全部用户的落雪绑定 */
export async function purgeAllLxnsBindings(ctx: Context): Promise<number> {
  const rows = await ctx.database.get('maibot_bindings', {})
  let cleared = 0
  for (const row of rows) {
    if (!row.lxnsCode?.trim()) continue
    await ctx.database.set('maibot_bindings', { userId: row.userId }, { lxnsCode: '' })
    cleared++
  }
  return cleared
}

/** 是否已完成舞萌 DX 账号绑定（非仅 Token 占位记录） */
export function isDxBound(binding: UserBinding | null | undefined): boolean {
  if (!binding) return false
  const qr = (binding.qrCode || '').trim()
  const uid = (binding.maiUid || '').trim()
  return qr.startsWith('SGWCMAID') && uid.length > 0
}

export function normalizePreviewUserId(userId: string | number): string {
  return String(userId)
}

/** 新版本 maiUid 为纯数字 */
export function isNumericMaiUid(uid: string): boolean {
  return /^\d+$/.test(String(uid).trim())
}

/** 老版本存库的 maiUid 含英文字符（如 Base64 前缀 MDk…），需迁移到纯数字 UID */
export function isLegacyLetterMaiUid(boundUid: string): boolean {
  const s = String(boundUid).trim()
  if (!s) return false
  return /[A-Za-z]/.test(s)
}

/** @deprecated 使用 isLegacyLetterMaiUid */
export function isLegacyMdkMaiUid(boundUid: string): boolean {
  return isLegacyLetterMaiUid(boundUid)
}

export function formatBindingPlayerLabel(binding: {
  userName?: string
  boundPlayerName?: string
}): string {
  const name = binding.boundPlayerName?.trim() || binding.userName?.trim()
  return name || '您的账号'
}

export type VerifyPreviewBindingResult =
  | { ok: true }
  | { ok: false; message: string }
  | {
      ok: true
      migratedToUid: string
      notice: string
    }

/**
 * 校验二维码 preview 与绑定是否为同一街机账号。
 * 不向用户展示 UID；老格式（含英文字符）自动迁移为 preview 中的纯数字 UID。
 */
export function verifyPreviewMatchesBinding(
  binding: UserBinding,
  preview: { UserID: string | number; UserName?: string },
): VerifyPreviewBindingResult {
  const pid = normalizePreviewUserId(preview.UserID)
  if (pid === '-1' || preview.UserID === -1) {
    return { ok: false, message: '❌ 无效或过期的二维码，无法完成验证。请重新获取玩家二维码后重试。' }
  }
  if (!isNumericMaiUid(pid)) {
    return { ok: false, message: '❌ 无法识别账号信息，请重新获取玩家二维码后重试。' }
  }

  const boundUid = String(binding.maiUid || '').trim()
  if (!boundUid || isLegacyLetterMaiUid(boundUid)) {
    return {
      ok: true,
      migratedToUid: pid,
      notice: boundUid && isLegacyLetterMaiUid(boundUid)
        ? '💾 已为您自动更新账号信息。'
        : undefined,
    }
  }

  if (boundUid === pid) {
    return { ok: true }
  }

  const previewName = preview.UserName?.trim()
  const boundName = binding.boundPlayerName?.trim() || binding.userName?.trim()
  if (previewName && boundName && previewName === boundName) {
    return {
      ok: true,
      migratedToUid: pid,
      notice: '💾 已为您自动更新账号信息。',
    }
  }

  const boundLabel = formatBindingPlayerLabel(binding)
  const previewLabel = previewName || '当前二维码对应账号'
  return {
    ok: false,
    message:
      `❌ 当前二维码与绑定账号不一致：\n` +
      `• 绑定玩家：${boundLabel}\n` +
      `• 二维码玩家：${previewLabel}\n` +
      `若您已更换游戏账号，请使用 /mai解绑 后重新绑定（换绑冷却期内请使用 /mai解绑卡）。`,
  }
}

/** lastStateAt：maibot_user_rebind_state.lastBindChangeAt；bindTime：当前绑定记录的 bindTime（无绑定则 0） */
export function msUntilBindChangeAllowed(
  lastStateAtMs: number,
  bindTimeMs: number,
  minIntervalDays: number,
): number {
  const base = Math.max(lastStateAtMs || 0, bindTimeMs || 0)
  if (!base) return 0
  const minMs = Math.max(0, minIntervalDays) * 24 * 60 * 60 * 1000
  const elapsed = Date.now() - base
  return Math.max(0, minMs - elapsed)
}

export function formatBindChangeWaitHuman(ms: number): string {
  if (ms <= 0) return '0'
  const d = Math.floor(ms / (24 * 60 * 60 * 1000))
  const h = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
  if (d > 0) return `${d} 天${h > 0 ? ` ${h} 小时` : ''}`
  const m = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000))
  if (h > 0) return `${h} 小时${m > 0 ? ` ${m} 分钟` : ''}`
  const s = Math.ceil(ms / 1000)
  return `${Math.max(1, s)} 秒`
}
