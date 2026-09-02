/**
 * First-load demo for the hosted browser trial (buildaharness.com/try).
 *
 * A visitor lands with no API key configured. Before asking them to paste one,
 * show the single most distinctive thing Aielia does: a consequential request
 * pauses for approval *before* any model call is made. This is a static
 * illustration — `ApprovalCard illustrative` renders an explanatory line rather
 * than live Approve/Deny buttons, since there's nothing configured to resolve
 * it against yet. It's cleared the moment the visitor sends their own first
 * message (see App.tsx's `showDemo`), and never shown on the desktop build.
 */

export const DEMO_USER_MESSAGE = 'Send an email to my boss saying I quit.'

export const DEMO_APPROVAL_REASON =
  'High-risk "send message" request. Aielia stopped here before making any model call — ' +
  'a keyword risk pass runs first, and anything that sends, deletes, pays, or posts needs ' +
  'your approval to proceed.'

export const DEMO_NOTE =
  "Example — this is what a visitor sees first, before adding a key. Send your own message to clear it."
