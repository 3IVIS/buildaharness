/**
 * First-load demo for the hosted browser trial (myaielia.com/chat).
 *
 * A visitor lands with no API key configured. Alongside the "add your key" notice (KeyNotice),
 * show the single most distinctive thing Aielia does: a consequential request
 * pauses for approval *before* any model call is made. This is a static
 * illustration — `ApprovalCard illustrative` renders an explanatory line rather
 * than live Approve/Deny buttons, since there's nothing configured to resolve
 * it against yet. It's cleared the moment the visitor sends their own first
 * message (see App.tsx's `showDemo`), and never shown on the desktop build.
 */

// Something the browser build really holds: what Aielia remembers about you is kept in this browser. (The risk pass reads
// this as a HIGH-risk delete, checked against classifyRisk.) No email or web search here, since the browser build has neither.
export const DEMO_USER_MESSAGE = 'Delete everything you remember about me.'

export const DEMO_APPROVAL_REASON =
  'High-risk "delete" request. Aielia stopped here before making any model call — ' +
  'a keyword risk pass runs first, and anything that deletes, sends, pays, or posts needs ' +
  'your approval to proceed.'

export const DEMO_NOTE =
  "Example — here is how Aielia handles a risky request. It clears when you send your own message."
