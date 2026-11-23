import { getStorage } from 'firebase-admin/storage';
import { createHash, randomUUID } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';

const maxBytes = 4 * 1024 * 1024;
const photoKey = /^bazaar-photos\/([a-z0-9-]{12,60})\/([a-z0-9-]{2,50})\/[a-f0-9]{64}$/;
const bucket = () => getStorage().bucket(process.env.BAZAAR_STORAGE_BUCKET || undefined);

async function downloadLink(file) {
  const [metadata] = await file.getMetadata();
  const token = metadata.metadata?.firebaseStorageDownloadTokens?.split(',')[0];
  if (!token) throw new Error('Missing photo download token');
  const endpoint = process.env.STORAGE_EMULATOR_HOST || 'https://firebasestorage.googleapis.com';
  return `${endpoint}/v0/b/${file.bucket.name}/o/${encodeURIComponent(file.name)}?alt=media&token=${encodeURIComponent(token)}`;
}

function imageType(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new HttpsError('invalid-argument', 'JPEG, PNG 또는 WebP 사진을 선택해 주세요.');
}

export async function storePhoto(eventId, productId, { content, sourcePath }) {
  let bytes;
  const storage = bucket();
  if (typeof sourcePath === 'string' && photoKey.test(sourcePath)) {
    const source = storage.file(sourcePath);
    const [metadata] = await source.getMetadata();
    if (Number(metadata.size) > maxBytes) throw new HttpsError('invalid-argument', '사진은 4MB 이하로 선택해 주세요.');
    [bytes] = await source.download();
  } else if (typeof content === 'string' && content.length <= Math.ceil(maxBytes / 3) * 4
    && /^[A-Za-z0-9+/]+={0,2}$/.test(content)) {
    bytes = Buffer.from(content, 'base64');
  }
  if (!bytes?.length || bytes.length > maxBytes) throw new HttpsError('invalid-argument', '4MB 이하의 사진 파일을 선택해 주세요.');
  const contentType = imageType(bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const photoPath = `bazaar-photos/${eventId}/${productId}/${digest}`;
  const file = storage.file(photoPath);
  const [exists] = await file.exists();
  if (exists) return { photoPath, imageUrl: await downloadLink(file) };
  try {
    await file.save(bytes, {
      resumable: false,
      preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { contentType, cacheControl: 'public, max-age=31536000, immutable',
        metadata: { firebaseStorageDownloadTokens: randomUUID() } },
    });
  } catch (error) {
    if (Number(error.code) !== 412) throw error;
  }
  return { photoPath, imageUrl: await downloadLink(file) };
}

export async function eventPhoto(eventId, productId, product) {
  if (!product?.imageUrl && !product?.photoPath) return { imageUrl: '', photoPath: '' };
  const key = typeof product.photoPath === 'string' ? photoKey.exec(product.photoPath) : null;
  if (key?.[1] !== eventId || key?.[2] !== productId) {
    throw new HttpsError('failed-precondition', '이 행사에 사진을 복사하지 못했습니다. 사진 파일을 다시 선택해 주세요.');
  }
  try {
    return { photoPath: product.photoPath, imageUrl: await downloadLink(bucket().file(product.photoPath)) };
  } catch {
    throw new HttpsError('failed-precondition', '저장된 사진을 읽을 수 없습니다. 사진 파일을 다시 선택해 주세요.');
  }
}
