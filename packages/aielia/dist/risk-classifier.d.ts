export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export interface RiskClassification {
    riskLevel: RiskLevel;
    requiresApproval: boolean;
    reason: string;
}
/**
 * The lexical risk judgment, gated by lexicalMode's `risk` family (off by default). Off → no judgment
 * is made and the answer is the conservative one an unknown risk gets: HIGH, requiring approval. Its
 * only production caller is a durable plan step persisted without its own risk level.
 */
export declare function classifyRisk(message: string): RiskClassification;
/** The raw keyword judgment, never switched off — for test doubles standing in for the classifier model (scripted-llm-client.ts). */
export declare function classifyRiskLexical(message: string): RiskClassification;
