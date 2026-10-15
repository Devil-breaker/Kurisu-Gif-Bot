import { spawn } from 'node:child_process';
import { getFfmpegPath } from './ffmpeg.js';
import { logSafeError } from './safe-log.js';

/** Hamming distance threshold for two dHashes to be considered near-duplicates. */
export const PHASH_DUPLICATE_THRESHOLD = 8;

/**
 * Compute a 16-hex-char dHash from any media file recognised by ffmpeg.
 * Downloads nothing — caller provides the file path.  Returns null on any
 * failure (missing ffmpeg, corrupt file, unexpected output size) so callers
 * never crash on a bad image.
 */
export async function computePhash(filePath: string): Promise<string | null> {
  try {
    const ffmpeg = getFfmpegPath();
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const proc = spawn(ffmpeg, [
        '-i', filePath,
        '-frames:v', '1',
        '-vf', 'scale=9:8',
        '-f', 'rawvideo',
        '-pix_fmt', 'gray',
        'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => proc.kill(), 10_000);

      proc.stdout?.on('data', (c: Buffer) => chunks.push(c));
      let stderr = '';
      proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && chunks.length > 0) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-300)}`));
        }
      });
    });

    if (buf.length < 72) {
      console.warn('[phash] unexpected frame size from ffmpeg:', buf.length, '(expected 72)');
      return null;
    }

    // Trim to exactly 72 bytes if ffmpeg wrote extra (should not happen, but be safe)
    return dHashFromGray(buf.subarray(0, 72));
  } catch (err) {
    logSafeError('phash', err);
    return null;
  }
}

/**
 * Pure: 72-byte grayscale buffer (9px wide × 8px tall) → 16-char hex dHash.
 *
 * dHash algorithm: for each of the 8 rows, compare each pair of adjacent pixels
 * (left-to-right).  Bit i of the row-byte is 1 if the right pixel is brighter
 * than the left one.  Result: 8 bytes = 64 bits = 16 hex chars.
 *
 * The 9th column is only used as the right-hand reference for column 8; it never
 * sets a bit itself.
 */
export function dHashFromGray(gray: Buffer): string {
  if (gray.length < 72) {
    throw new Error(`dHashFromGray needs 72 bytes (9×8), got ${gray.length}`);
  }

  let hash = 0n;
  for (let row = 0; row < 8; row++) {
    let bits = 0;
    const rowBase = row * 9; // first pixel of this row in the 9-wide grid
    for (let col = 0; col < 8; col++) {
      // bit 7 = leftmost comparison; bit 0 = rightmost
      bits |= (gray[rowBase + col + 1] > gray[rowBase + col] ? 1 : 0) << (7 - col);
    }
    hash = (hash << 8n) | BigInt(bits);
  }

  return hash.toString(16).padStart(16, '0');
}

/**
 * Pure: number of differing bits between two 16-char hex dHashes.
 * Returns -1 if either input is not exactly 16 hex chars.
 */
export function hammingDistance(a: string, b: string): number {
  if (!/^[0-9a-f]{16}$/i.test(a) || !/^[0-9a-f]{16}$/i.test(b)) return -1;
  const x = BigInt('0x' + a);
  const y = BigInt('0x' + b);
  const diff = x ^ y;
  let count = 0;
  for (let v = diff; v > 0n; v >>= 1n) {
    count += Number(v & 1n);
  }
  return count;
}

/**
 * Compute the dHash from an image file already on disk.
 * Calls computePhash(filePath) internally.
 */
export async function downloadThenHash(
  _fileId: string,
  filePathOnDisk: string,
): Promise<string | null> {
  return computePhash(filePathOnDisk);
}
