import { ChatMessage } from '@buildaharness/runtime';
export type UndoPlan = {
    nothingToUndo: true;
} | {
    nothingToUndo: false;
    wasPendingApproval: boolean;
};
/**
 * What /undo and the apps' Undo button must know from the transcript before calling undoLastTurn: an empty
 * transcript has nothing to undo, and a transcript whose last message is not the assistant's is a turn still
 * waiting for approval (no reply was appended). The notices shown to the user are each surface's own.
 */
export declare function planUndo(transcriptBefore: readonly ChatMessage[]): UndoPlan;
