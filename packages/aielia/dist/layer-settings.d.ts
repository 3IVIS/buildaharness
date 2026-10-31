/**
 * The user-facing on/off surface for reasoning layers, shared by the CLI (`/layers`) and the desktop/browser
 * Settings screen. It is a thin layer over the existing `AUDIT_*` env flags, which every layer already reads in
 * exactly one place: `applyLayerSettings` writes the persisted `config.layers` choices into an env object, so no
 * layer needed a second code path. An env value the operator set themselves always wins and renders as pinned,
 * the same precedence `explicitEnvOverride` already gives it.
 *
 * Floor layers: control state, tool policy and verification each have a gate flag and may be switched off (they carry
 * a `caution`). Approval staging is locked on purpose, and diagnostics and template hypotheses have no effect of their own
 * (they only feed the control state), so they follow `control_state`.
 */
export type LayerGroup = 'escalation' | 'behaviour' | 'opt_in' | 'floor';
export interface LayerSetting {
    id: string;
    group: LayerGroup;
    /** The env flag that carries the choice; absent for locked layers. */
    flag?: string;
    /** What the layer does when the user hasn't chosen. */
    defaultOn: boolean;
    summary: string;
    /** Rough extra cost when it fires, in plain words. */
    cost: string;
    /** What the audit found, in plain words — the record, not a promise. */
    evidence: string;
    /** What switching it off gives up; set on floor layers a user may still switch off. */
    caution?: string;
    /** A layer with no gate of its own: it is on exactly when this layer is. */
    followsLayer?: string;
    /** Layers this one does nothing without. Switching it on while one of them is off is allowed but reported. */
    requires?: readonly string[];
}
export declare const LAYER_SETTINGS: readonly LayerSetting[];
export type LayerChoices = Readonly<Record<string, boolean>>;
export declare function findLayer(id: string): LayerSetting | undefined;
/** The layers that have no switch of their own and are on exactly when `leader` is. */
export declare function followersOf(leader: LayerSetting): LayerSetting[];
/** The layers `layer` needs that are currently off. Empty when `layer` is off itself: nothing is lost then. */
export declare function unmetRequirements(layer: LayerSetting, choices: LayerChoices | undefined, pinned: ReadonlySet<string>, env: Env): LayerSetting[];
/** One line per switched-on layer that has no effect because a layer it needs is off. */
export declare function layerWarnings(choices: LayerChoices | undefined, pinned: ReadonlySet<string>, env: Env): string[];
/** The layers a user may change: everything except the locked floor. */
export declare function isToggleable(layer: LayerSetting): boolean;
type Env = Record<string, string | undefined>;
export interface AppliedLayers {
    /** Layer ids whose env flag was set outside this module (shell env / build var), so the saved choice is ignored. */
    pinned: Set<string>;
}
/**
 * Makes `env` reflect `choices`. Idempotent: a layer no longer in `choices` is restored to unset, and a flag that
 * holds a value this module did not write is left alone and reported as pinned. Unknown ids and locked layers are ignored.
 */
export declare function applyLayerSettings(choices: LayerChoices | undefined, env: Env): AppliedLayers;
/** What a layer will do right now: the saved choice, else its default; a pinned layer reports its env value. */
export declare function effectiveState(layer: LayerSetting, choices: LayerChoices | undefined, pinned: ReadonlySet<string>, env: Env): boolean;
/** Returns the choices after setting one layer; throws on an unknown or locked id so a typo never silently persists. */
export declare function withLayerChoice(choices: LayerChoices | undefined, id: string, on: boolean | undefined): Record<string, boolean>;
export declare class LayerSettingError extends Error {
}
/** Drops anything in a persisted value that is not a known toggleable layer with a boolean, so a stale or hand-edited file can't smuggle junk in. */
export declare function sanitizeLayerChoices(raw: unknown): Record<string, boolean>;
export declare function formatLayerListing(choices: LayerChoices | undefined, pinned: ReadonlySet<string>, env: Env): string;
export {};
