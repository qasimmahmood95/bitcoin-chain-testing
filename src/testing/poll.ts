/**
 * Bounded polling — the only waiting primitive in this repo. Every wait has
 * an explicit budget and a label; bare sleeps as synchronization are banned
 * (determinism policy).
 */

export interface PollBudget {
  readonly attempts: number;
  readonly delayMs: number;
}

export class PollTimeoutError extends Error {
  constructor(label: string, budget: PollBudget) {
    super(
      `${label}: no result after ${String(budget.attempts)} attempts × ${String(budget.delayMs)}ms`,
    );
    this.name = 'PollTimeoutError';
  }
}

/** Resolves with the first defined probe result; throws when the budget is spent. */
export async function pollUntil<T>(
  label: string,
  budget: PollBudget,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  for (let attempt = 0; attempt < budget.attempts; attempt += 1) {
    const result = await probe();
    if (result !== undefined) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, budget.delayMs));
  }
  throw new PollTimeoutError(label, budget);
}
