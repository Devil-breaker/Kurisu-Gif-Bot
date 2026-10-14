const MAX_ZIP_BYTES = 45 * 1024 * 1024;
const LINE_STORE_HOST = 'store.line.me';
const LINE_CDN_HOST = 'stickershop.line-scdn.net';

export type LinePackKind = 'stickers' | 'emoji';
export type LinePackFormat = 'static' | 'animated';

export interface ParsedLinePack {
  kind: LinePackKind;
  productId: string;
}

/** Accept only official LINE Store pack URLs. */
export function parseLinePackUrl(raw: string): ParsedLinePack | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' || url.hostname !== LINE_STORE_HOST || url.port || url.username || url.password) {
    return null;
  }

  const sticker = url.pathname.match(/^\/stickershop\/product\/(\d+)(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/?$/);
  if (sticker) return { kind: 'stickers', productId: sticker[1] };

  const emoji = url.pathname.match(/^\/emojishop\/product\/([a-f\d]{24})(?:\/[a-z]{2}(?:-[A-Z]{2})?)?\/?$/i);
  if (emoji) return { kind: 'emoji', productId: emoji[1] };

  return null;
}

export function buildLinePackZipUrl(pack: ParsedLinePack, format: LinePackFormat): string {
  if (pack.kind === 'emoji') {
    if (format !== 'static') throw new Error('Animated emoji pack downloads are not supported.');
    return `https://${LINE_CDN_HOST}/sticonshop/v1/${pack.productId}/sticon/iphone/package.zip`;
  }

  const zipName = format === 'animated' ? 'stickerpack.zip' : 'stickers.zip';
  return `https://${LINE_CDN_HOST}/stickershop/v1/product/${pack.productId}/android/${zipName}`;
}

export interface DownloadedLinePack {
  buffer: Buffer;
  filename: string;
  size: number;
}

/** Download a ZIP from LINE's CDN with a strict size cap and bounded request time. */
export async function downloadLinePackZip(
  pack: ParsedLinePack,
  format: LinePackFormat,
): Promise<DownloadedLinePack> {
  const url = buildLinePackZipUrl(pack, format);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(35_000),
    headers: { 'user-agent': 'KurisuGifBot/1.0 (LINE pack export)' },
  });

  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      throw new Error('That pack does not provide this ZIP format.');
    }
    throw new Error(`LINE returned HTTP ${response.status}.`);
  }

  const finalUrl = new URL(response.url || url);
  if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== LINE_CDN_HOST) {
    throw new Error('LINE redirected the download to an unexpected host.');
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ZIP_BYTES) {
    throw new Error('This pack ZIP is too large to send through Telegram (45 MB limit).');
  }
  if (!response.body) throw new Error('LINE returned an empty response.');

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ZIP_BYTES) {
        await reader.cancel();
        throw new Error('This pack ZIP is too large to send through Telegram (45 MB limit).');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = Buffer.concat(chunks, total);
  // Reject HTML error pages and other non-ZIP responses before sending them as a document.
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('LINE did not return a valid ZIP archive for this pack.');
  }

  const suffix = pack.kind === 'emoji' ? 'emoji' : format === 'animated' ? 'animated-stickers' : 'stickers';
  return {
    buffer,
    filename: `line-${suffix}-${pack.productId}.zip`,
    size: buffer.length,
  };
}

export const LINE_PACK_MAX_BYTES = MAX_ZIP_BYTES;
