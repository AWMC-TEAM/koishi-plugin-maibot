import type { Context, Session } from 'koishi'

/** V2 标准用户键：纯数字 */
export function isV2UserIdFormat(userId: string): boolean {
  return /^\d+$/.test(String(userId || ''))
}

/** 从会话解析 V2 标准用户键（纯数字） */
export async function getCanonicalV2UserId(session: Session): Promise<string> {
  const raw = session.userId ? String(session.userId) : ''
  if (isV2UserIdFormat(raw)) return raw

  try {
    const user = await session.observeUser(['id'])
    const unifiedId = user?.id
    if (unifiedId !== undefined && unifiedId !== null) {
      const numeric = String(unifiedId)
      if (isV2UserIdFormat(numeric)) return numeric
    }
  } catch {
    // bind 插件不可用时回退平台原始 ID
  }

  return raw
}

export const V2_MIGRATION_PROMPT =
  '喵！您正在使用 maiBot V2 版本，V1 数据需要迁移后才能继续使用。\n\n' +
  '⚠️ 重要变更：2.0.0 起落雪绑定由「好友码」改为「落雪 Token」。\n' +
  '迁移后旧版落雪好友码绑定将被清除，请先在落雪个人中心获取 Token：\n' +
  'https://maimai.lxns.net/user/profile?tab=thirdparty\n\n' +
  '是否继续迁移？\n【是/否】'

export const V2_MIGRATION_CONFIRM_PROMPT =
  '更新新版本\n\n' +
  '✅ 会保留：\n' +
  '· 舞萌DX账号绑定信息\n' +
  '· 水鱼Token绑定信息\n' +
  '· 用户优先队列数据\n' +
  '· 用户操作记录\n\n' +
  '❌ 会移除：\n' +
  '· 落雪好友码绑定信息\n\n' +
  '请再次确认是否同意以上变更并完成迁移。\n【是/否】'

export function parseMigrationConfirm(input: string | undefined | null): 'yes' | 'no' | null {
  const t = (input ?? '').trim().toLowerCase()
  if (['是', 'y', 'yes', '确认', '好', 'ok', '同意', '是的', '好的'].includes(t)) return 'yes'
  if (['否', 'n', 'no', '取消', '不'].includes(t)) return 'no'
  return null
}

async function tableHasUserRow(
  ctx: Context,
  table: 'maibot_bindings' | 'maibot_user_cooldowns' | 'maibot_priority_users' | 'maibot_user_rebind_state' | 'maibot_user_terms',
  userId: string,
): Promise<boolean> {
  const rows = await ctx.database.get(table, { userId })
  return rows.length > 0
}

/** 会话关联键中是否存在任意 maiBot 用户数据 */
export async function hasAnyMaibotUserData(ctx: Context, candidateKeys: string[]): Promise<boolean> {
  const unique = [...new Set(candidateKeys.filter(Boolean))]
  for (const key of unique) {
    const tables = [
      'maibot_bindings',
      'maibot_user_cooldowns',
      'maibot_priority_users',
      'maibot_user_rebind_state',
      'maibot_user_terms',
    ] as const
    for (const table of tables) {
      if (await tableHasUserRow(ctx, table, key)) return true
    }
  }
  return false
}

/** 会话关联键中是否存在需合并的 V1 遗留键（如 koishi: 前缀或非数字键） */
export async function hasLegacyV1UserData(ctx: Context, candidateKeys: string[]): Promise<boolean> {
  const unique = [...new Set(candidateKeys.filter(Boolean))]
  if (unique.length === 0) return false

  for (const key of unique) {
    const tables = [
      'maibot_bindings',
      'maibot_user_cooldowns',
      'maibot_priority_users',
      'maibot_user_rebind_state',
      'maibot_user_terms',
    ] as const
    for (const table of tables) {
      if (await tableHasUserRow(ctx, table, key)) {
        if (!isV2UserIdFormat(key)) return true
      }
    }
  }

  const v2Keys = unique.filter(isV2UserIdFormat)
  if (v2Keys.length <= 1) {
    const nonV2WithData = unique.filter(k => !isV2UserIdFormat(k))
    for (const key of nonV2WithData) {
      if (await tableHasUserRow(ctx, 'maibot_bindings', key)) return true
      if (await tableHasUserRow(ctx, 'maibot_user_cooldowns', key)) return true
      if (await tableHasUserRow(ctx, 'maibot_priority_users', key)) return true
    }
    return false
  }

  let dataKeyCount = 0
  for (const key of v2Keys) {
    if (await tableHasUserRow(ctx, 'maibot_bindings', key)) dataKeyCount++
    else if (await tableHasUserRow(ctx, 'maibot_priority_users', key)) dataKeyCount++
  }
  return dataKeyCount > 1
}

export async function hasCompletedV2Migration(ctx: Context, canonicalUserId: string): Promise<boolean> {
  if (!canonicalUserId) return false
  const rows = await ctx.database.get('maibot_v2_migration', { userId: canonicalUserId })
  return rows.length > 0
}

async function moveBinding(ctx: Context, fromKey: string, toKey: string): Promise<void> {
  const rows = await ctx.database.get('maibot_bindings', { userId: fromKey })
  if (!rows.length) return
  const row = rows[0]
  const target = await ctx.database.get('maibot_bindings', { userId: toKey })
  if (target.length) {
    await ctx.database.remove('maibot_bindings', { userId: fromKey })
    return
  }
  await ctx.database.set('maibot_bindings', { userId: fromKey }, { userId: toKey })
}

async function moveSimpleUserRows(
  ctx: Context,
  table: 'maibot_priority_users' | 'maibot_user_rebind_state' | 'maibot_user_terms',
  fromKey: string,
  toKey: string,
): Promise<void> {
  const rows = await ctx.database.get(table, { userId: fromKey })
  if (!rows.length) return

  const existing = await ctx.database.get(table, { userId: toKey })
  if (existing.length) {
    await ctx.database.remove(table, { userId: fromKey })
    return
  }
  await ctx.database.set(table, { userId: fromKey }, { userId: toKey })
}

async function moveCooldownRows(ctx: Context, fromKey: string, toKey: string): Promise<void> {
  const rows = await ctx.database.get('maibot_user_cooldowns', { userId: fromKey })
  if (!rows.length) return

  for (const row of rows) {
    const slot = row.slot
    if (!slot) continue
    const existing = await ctx.database.get('maibot_user_cooldowns', { userId: toKey, slot })
    if (existing.length) {
      await ctx.database.remove('maibot_user_cooldowns', { userId: fromKey, slot })
      continue
    }
    await ctx.database.set('maibot_user_cooldowns', { userId: fromKey, slot }, { userId: toKey })
  }
}

/** 迁移时清除 V1 落雪好友码绑定（V2 改用落雪 Token） */
export async function clearLegacyLxnsBinding(ctx: Context, userId: string): Promise<void> {
  if (!userId) return
  const rows = await ctx.database.get('maibot_bindings', { userId })
  if (rows.length && rows[0].lxnsCode) {
    await ctx.database.set('maibot_bindings', { userId }, { lxnsCode: '' })
  }
}

/** 将 candidateKeys 下的 V1 数据合并到 canonicalUserId；DX/水鱼绑定保留，落雪好友码清除，用户协议清除以便重新确认 */
export async function performV2UserMigration(
  ctx: Context,
  canonicalUserId: string,
  candidateKeys: string[],
): Promise<void> {
  if (!canonicalUserId || !isV2UserIdFormat(canonicalUserId)) {
    throw new Error('无效的 V2 用户 ID')
  }

  const keys = [...new Set(candidateKeys.filter(k => k && k !== canonicalUserId))]
  for (const key of keys) {
    await moveBinding(ctx, key, canonicalUserId)
    await moveCooldownRows(ctx, key, canonicalUserId)
    await moveSimpleUserRows(ctx, 'maibot_priority_users', key, canonicalUserId)
    await moveSimpleUserRows(ctx, 'maibot_user_rebind_state', key, canonicalUserId)
    await moveSimpleUserRows(ctx, 'maibot_user_terms', key, canonicalUserId)
  }

  await ctx.database.remove('maibot_user_terms', { userId: canonicalUserId })
  await clearLegacyLxnsBinding(ctx, canonicalUserId)

  const existing = await ctx.database.get('maibot_v2_migration', { userId: canonicalUserId })
  if (existing.length) {
    await ctx.database.set('maibot_v2_migration', { userId: canonicalUserId }, { migratedAt: new Date() })
  } else {
    await ctx.database.create('maibot_v2_migration', { userId: canonicalUserId, migratedAt: new Date() })
  }
}

export async function markV2MigrationComplete(ctx: Context, canonicalUserId: string): Promise<void> {
  if (!canonicalUserId) return
  const existing = await ctx.database.get('maibot_v2_migration', { userId: canonicalUserId })
  if (existing.length) return
  await ctx.database.create('maibot_v2_migration', { userId: canonicalUserId, migratedAt: new Date() })
}
