export interface RecoveryPolicy {
    failure_class: string;
    policy: string;
    action: string;
}
export declare function classifyRecovery(failureClass: string | null | undefined): RecoveryPolicy | null;
