import { estimateTokens } from '@/lib/orchestration/chat/token-estimator';

export type DocumentSizeClass = 'small' | 'medium' | 'large' | 'too-large';

export interface DocumentSizeReport {
  tokenCount: number;
  sizeClass: DocumentSizeClass;
  llmRewriteAllowed: boolean;
}

// Whole-doc LLM rewrites get expensive and lose detail past this point;
// per-section rewrites still work because they target a slice. Deterministic
// capabilities (regex strips, whitespace collapse, etc.) are unaffected.
const SMALL_MAX = 8_000;
const MEDIUM_MAX = 32_000;
const LARGE_MAX = 100_000;

export function getDocumentSizeReport(content: string, modelId?: string): DocumentSizeReport {
  const tokenCount = estimateTokens(content, modelId);
  const sizeClass: DocumentSizeClass =
    tokenCount <= SMALL_MAX
      ? 'small'
      : tokenCount <= MEDIUM_MAX
        ? 'medium'
        : tokenCount <= LARGE_MAX
          ? 'large'
          : 'too-large';

  return {
    tokenCount,
    sizeClass,
    llmRewriteAllowed: sizeClass !== 'too-large',
  };
}
