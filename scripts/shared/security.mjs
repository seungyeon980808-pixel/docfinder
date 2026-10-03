import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

export const opaque = () => randomBytes(32).toString('hex');
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export const csrfFor = (token, key) => createHmac('sha256', key).update(token).digest('hex');
export function equal(left, right) {
  const a = Buffer.from(String(left || '')); const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const deny = (status, message) => { throw new HttpError(status, message); };
export function emailAddress(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/u.test(email)) deny(400, '이메일 주소를 확인하세요.');
  return email;
}
export function identityFromPayload(payload) {
  const email = emailAddress(payload?.email);
  if (!payload?.sub || payload.email_verified !== true || !(email.endsWith('@gmail.com') || payload.hd)) {
    deny(403, 'Gmail 또는 Google Workspace 계정으로 로그인하세요.');
  }
  return { id: String(payload.sub), email, name: String(payload.name || email).slice(0, 120) };
}
export function googleVerifier(clientId) {
  const client = new OAuth2Client(clientId);
  return async (credential) => {
    if (!clientId) deny(503, '운영자의 Google 로그인 설정이 필요합니다.');
    try { const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId }); return identityFromPayload(ticket.getPayload()); }
    catch (error) { if (error instanceof HttpError) throw error; deny(401, 'Google 로그인을 다시 시도하세요.'); }
  };
}
export function encrypt(value, key) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
}
export function decrypt(value, key) {
  const bytes = Buffer.from(value, 'base64'); const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString());
}
