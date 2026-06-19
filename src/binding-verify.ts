import type { UserBinding } from './database'

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

/** 老版本密钥存库的 maiUid 常见以 Base64 前缀 MDk（即 ASCII「097…」）开头 */
export function isLegacyMdkMaiUid(boundUid: string): boolean {
  return String(boundUid).startsWith('MDk')
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
 * 校验 preview 与绑定是否为同一街机账号：比较绑定记录的 maiUid 与二维码 preview 的 UserID。
 * 绑定为老格式（maiUid 以 MDk 开头）且与二维码 UID 不一致时，视为同账号升级格式，返回 ok + 迁移信息（由调用方写库并提示）。
 */
export function verifyPreviewMatchesBinding(
  binding: UserBinding,
  preview: { UserID: string | number; UserName?: string },
): VerifyPreviewBindingResult {
  const pid = normalizePreviewUserId(preview.UserID)
  if (pid === '-1' || preview.UserID === -1) {
    return { ok: false, message: '❌ 无效或过期的二维码，无法完成验证。请重新获取玩家二维码后重试。' }
  }
  const boundUid = String(binding.maiUid)
  if (boundUid === pid) {
    return { ok: true }
  }
  if (isLegacyMdkMaiUid(boundUid)) {
    return {
      ok: true,
      migratedToUid: pid,
      notice:
        `💾 街机账号 UID 不一致：\n` +
        `• 当前绑定记录的 UID：${boundUid}\n` +
        `• 当前二维码对应的 UID：${pid}\n` +
        `已为您自动迁移到新格式。`,
    }
  }
  return {
    ok: false,
    message:
      `❌ 街机账号 UID 不一致：\n` +
      `• 当前绑定记录的 UID：${boundUid}\n` +
      `• 当前二维码对应的 UID：${pid}\n` +
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
