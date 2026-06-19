import axios from 'axios'
import Jimp from 'jimp'
import jsQR from 'jsqr'
import type { Session } from 'koishi'

export type SgidInputSource =
  | 'text-direct'
  | 'text-url-req'
  | 'text-url-img'
  | 'text-embedded'
  | 'image-url-maid'
  | 'image-qrcode-decode'
  | 'none'

export interface SgidExtractResult {
  ok: boolean
  qrText?: string
  source: SgidInputSource
  /** 供调试展示的原始输入摘要（已截断） */
  rawPreview?: string
  imageUrl?: string
  error?: string
  length?: number
}

/** 处理并转换 SGID（文本 / 公众号 req·img 链接） */
export function processSGID(input: string): { qrText: string } | null {
  const result = extractSgidFromText(input)
  return result.ok && result.qrText ? { qrText: result.qrText } : null
}

export function maskSgidPreview(qrText: string): string {
  if (!qrText || qrText.length <= 16) return '***'
  return `${qrText.slice(0, 8)}***${qrText.slice(-8)}（共 ${qrText.length} 字符）`
}

export function extractSgidFromText(input: string): SgidExtractResult {
  const trimmed = (input || '').trim()
  if (!trimmed) {
    return { ok: false, source: 'none', error: '输入为空' }
  }

  const rawPreview = trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed
  const isReqLink = trimmed.includes('https://wq.wahlap.net/qrcode/req/')
  const isImgLink = trimmed.includes('https://wq.wahlap.net/qrcode/img/')
  const isDirect = trimmed.startsWith('SGWCMAID')

  let qrText = trimmed
  let source: SgidInputSource = 'text-direct'

  if (isReqLink) {
    const match = trimmed.match(/qrcode\/req\/(MAID[^?\.]+)/i)
    if (!match?.[1]) {
      return { ok: false, source: 'text-url-req', rawPreview, error: '无法从 req 链接提取 MAID' }
    }
    qrText = 'SGWC' + match[1]
    source = 'text-url-req'
  } else if (isImgLink) {
    const match = trimmed.match(/qrcode\/img\/(MAID[^?\.]+)/i)
    if (!match?.[1]) {
      return { ok: false, source: 'text-url-img', rawPreview, error: '无法从 img 链接提取 MAID' }
    }
    qrText = 'SGWC' + match[1]
    source = 'text-url-img'
  } else if (!isDirect) {
    const embedded = trimmed.match(/SGWCMAID[A-Za-z0-9+/=]{40,120}/)
    if (embedded?.[0]) {
      qrText = embedded[0]
      source = 'text-embedded'
    } else {
      return { ok: false, source: 'none', rawPreview, error: '未识别为 SGID 文本或 wahlap 链接' }
    }
  }

  if (!qrText.startsWith('SGWCMAID')) {
    return { ok: false, source, rawPreview, error: '转换结果不以 SGWCMAID 开头' }
  }
  if (qrText.length < 48 || qrText.length > 128) {
    return {
      ok: false,
      source,
      rawPreview,
      qrText,
      length: qrText.length,
      error: `SGID 长度 ${qrText.length} 不在 48–128 范围内`,
    }
  }

  return { ok: true, qrText, source, rawPreview, length: qrText.length }
}

function collectImageUrlsFromSession(session: Session): string[] {
  const urls: string[] = []
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) urls.push(v.trim())
  }

  if (session.elements) {
    for (const el of session.elements) {
      if (el.type === 'image' || el.type === 'img') {
        push(el.attrs?.url)
        push(el.attrs?.src)
        push(el.attrs?.file)
      }
    }
  }

  const quote = (session as { quote?: { elements?: typeof session.elements } }).quote
  if (quote?.elements) {
    for (const el of quote.elements) {
      if (el.type === 'image' || el.type === 'img') {
        push(el.attrs?.url)
        push(el.attrs?.src)
        push(el.attrs?.file)
      }
    }
  }

  return [...new Set(urls)]
}

async function loadImageBuffer(url: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(url)) {
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 20000 })
    return Buffer.from(resp.data)
  }
  const path = url.replace(/^file:\/\//, '')
  const fs = await import('fs/promises')
  return fs.readFile(path)
}

/** 从图片 URL / 本地路径解码二维码内容 */
export async function decodeQrFromImageUrl(imageUrl: string): Promise<string | null> {
  try {
    const buffer = await loadImageBuffer(imageUrl)
    const image = await Jimp.read(buffer)
    const { data, width, height } = image.bitmap
    const code = jsQR(new Uint8ClampedArray(data), width, height)
    return code?.data?.trim() || null
  } catch {
    return null
  }
}

/**
 * 从会话消息中提取 SGID：文本、链接、图片 URL（含 wahlap img 路径）或图片二维码解码
 */
export async function extractSgidFromSession(session: Session): Promise<SgidExtractResult> {
  const text = session.content?.trim() || ''
  if (text) {
    const fromText = extractSgidFromText(text)
    if (fromText.ok) return fromText
  }

  const imageUrls = collectImageUrlsFromSession(session)
  if (imageUrls.length === 0) {
    if (text) {
      const fromText = extractSgidFromText(text)
      return fromText
    }
    return { ok: false, source: 'none', error: '消息中无文本 SGID/链接，也未检测到图片' }
  }

  for (const imageUrl of imageUrls) {
    const fromUrlText = extractSgidFromText(imageUrl)
    if (fromUrlText.ok) {
      return { ...fromUrlText, imageUrl, source: 'image-url-maid' }
    }

    const decoded = await decodeQrFromImageUrl(imageUrl)
    if (decoded) {
      const fromDecoded = extractSgidFromText(decoded)
      if (fromDecoded.ok) {
        return {
          ...fromDecoded,
          imageUrl,
          source: 'image-qrcode-decode',
          rawPreview: `二维码内容: ${decoded.length > 60 ? decoded.slice(0, 60) + '…' : decoded}`,
        }
      }
      if (decoded.startsWith('SGWCMAID')) {
        return {
          ok: false,
          source: 'image-qrcode-decode',
          imageUrl,
          qrText: decoded,
          length: decoded.length,
          rawPreview: decoded.slice(0, 60),
          error: `已解码二维码，但 SGID 长度 ${decoded.length} 无效（需 48–128）`,
        }
      }
      return {
        ok: false,
        source: 'image-qrcode-decode',
        imageUrl,
        rawPreview: decoded.slice(0, 80),
        error: '已解码二维码，但内容不是 SGWCMAID 格式',
      }
    }
  }

  return {
    ok: false,
    source: 'none',
    imageUrl: imageUrls[0],
    error: `检测到 ${imageUrls.length} 张图片，但无法从 URL 提取 MAID，二维码解码也未得到 SGID（需平台提供可访问的图片地址）`,
  }
}

const SOURCE_LABEL: Record<SgidInputSource, string> = {
  'text-direct': 'SGID 纯文本',
  'text-url-req': '公众号 req 网页链接',
  'text-url-img': '公众号 img 图片链接',
  'text-embedded': '文本中嵌入的 SGID',
  'image-url-maid': '图片 URL 中的 MAID 路径',
  'image-qrcode-decode': '图片二维码解码',
  none: '无',
}

export function formatSgidExtractReport(result: SgidExtractResult): string {
  const lines = ['🔍 SGID 提取测试结果', '']
  lines.push(`来源: ${SOURCE_LABEL[result.source] || result.source}`)
  if (result.rawPreview) lines.push(`原始输入: ${result.rawPreview}`)
  if (result.imageUrl) {
    const u = result.imageUrl.length > 100 ? result.imageUrl.slice(0, 100) + '…' : result.imageUrl
    lines.push(`图片地址: ${u}`)
  }
  if (result.ok && result.qrText) {
    lines.push(`结果: ✅ 成功`)
    lines.push(`SGID: ${maskSgidPreview(result.qrText)}`)
  } else {
    lines.push(`结果: ❌ 失败`)
    if (result.qrText) lines.push(`部分提取: ${maskSgidPreview(result.qrText)}`)
    if (result.error) lines.push(`原因: ${result.error}`)
  }
  lines.push('')
  lines.push(
    '说明: 支持 SGID 文本、wahlap req/img 链接；图片消息会尝试 URL 提取与二维码解码。' +
      '若平台不提供可下载的图片 URL，则无法从纯图片消息读取。',
  )
  return lines.join('\n')
}
