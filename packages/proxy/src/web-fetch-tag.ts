/**
 * Signed-URL capability tags for /web/fetch.
 *
 * A bare authenticated /web/fetch lets any token holder fetch any URL — an open relay. A
 * fetchTag makes a URL a capability: /web/search (and /web/grant, for user-pasted URLs) is the
 * only place a tag is minted, and /web/fetch refuses to run without one that verifies against
 * the exact URL and hasn't expired. See plans/browser_web_tools_via_proxy_plan.html's W3 section.
 *
 * Tag shape: `${exp}.${base64url(HMAC-SHA256(PROXY_SECRET, url + "\n" + exp))}` — exp (unix
 * seconds) travels alongside the signature so verification doesn't need a side channel to know
 * what expiry to check against; the signature covers exp too, so a forged/altered exp fails
 * verification just like a forged signature would.
 */

export const FETCH_TAG_TTL_SECONDS = 15 * 60

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return new Uint8Array(signature)
}

async function signPayload(url: string, exp: number, secret: string): Promise<string> {
  const mac = await hmacSha256(secret, `${url}\n${exp}`)
  return base64UrlEncode(mac)
}

export async function signFetchTag(url: string, secret: string, ttlSeconds: number = FETCH_TAG_TTL_SECONDS): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const sig = await signPayload(url, exp, secret)
  return `${exp}.${sig}`
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifyFetchTag(url: string, tag: string | undefined, secret: string): Promise<boolean> {
  if (!tag) return false
  const dotIndex = tag.indexOf('.')
  if (dotIndex === -1) return false
  const expPart = tag.slice(0, dotIndex)
  const sigPart = tag.slice(dotIndex + 1)
  const exp = Number(expPart)
  if (!Number.isInteger(exp) || exp <= 0) return false
  if (exp < Math.floor(Date.now() / 1000)) return false

  const expected = await signPayload(url, exp, secret)
  return timingSafeEqual(expected, sigPart)
}
