import type { ILLMClient } from '@buildaharness/runtime'
import { withSpendCap, type SpendMeter } from './writer/write-permissions.js'
import { MAIL_CACHED_TYPES, classifyMailCall } from './email/mail-spend.js'

/**
 * Every mail model call goes through here: the client is wrapped by the writer's `withSpendCap` with the mail call types, so the
 * meter counts it by type and no call starts once the cap is reached. This file sits outside `email/` because the modules there may
 * not import an LLM client (F8 source scan); they take a text function, and this builds that function.
 */
export function withMailSpendCap(inner: ILLMClient, meter: SpendMeter, getCap: () => number | undefined): ILLMClient {
  return withSpendCap(inner, meter, getCap, classifyMailCall, MAIL_CACHED_TYPES)
}

/** The `(system, user) => text` function the email modules take (triage, drafting, rules, voice, intent, summaries), counted and capped. */
export function createCappedMailModel(inner: ILLMClient, meter: SpendMeter, getCap: () => number | undefined): (system: string, user: string) => Promise<string> {
  const capped = withMailSpendCap(inner, meter, getCap)
  return (system, user) => capped.callChatSync([{ role: 'system', content: system }, { role: 'user', content: user }])
}
