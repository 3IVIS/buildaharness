/**
 * The "[Recorded by the system ...]" action list. Only the system writes it, into the stored transcript, from the
 * approved actions it really carried out. The model sees it in earlier stored replies and was observed imitating it
 * (benchmark scenarios 05 and 13: a reply listed a test file and writes that never happened), which makes a false
 * claim look like a system record. Anything shaped like the marker in model-written text is therefore removed.
 */
export declare const ACTION_RECORD_MARKER = "[Recorded by the system, not part of the reply";
export declare function actionRecordSuffix(actions: string[]): string;
export declare function containsActionRecord(text: string): boolean;
/** Removes every block that starts at the marker and runs to its closing bracket, with the blank lines before it. */
export declare function stripActionRecord(text: string): string;
/** Shown in place of a forged record, so the user knows why the list is gone. */
export declare const FORGED_ACTION_RECORD_NOTE = "[Note from the system: the reply listed actions as \"recorded by the system\", but the system recorded no such action this turn, so the list was removed.]";
