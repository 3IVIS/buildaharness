import { WorldModel } from '../state/world-model.js';
import { Diagnostics } from '../state/diagnostics.js';
import { FailureDiagnostics } from '../state/failure-diagnostics.js';
import { ControlState } from '../state/control-state.js';
import { ReviewerVerdict } from './reviewer-pass.js';
import { CRITICAL_THRESHOLD, CAUTION_THRESHOLD, RECOVERY_ACTION_DEPENDENCIES } from '../_core-generated.js';
export { CRITICAL_THRESHOLD, CAUTION_THRESHOLD, RECOVERY_ACTION_DEPENDENCIES };
export declare function resolveControlState(diagnostics: Diagnostics, worldModel: WorldModel, failureDiagnostics: FailureDiagnostics, _step?: number, pendingReviewerVerdict?: ReviewerVerdict | null): ControlState;
