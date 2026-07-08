import { eq } from 'drizzle-orm';
import { getDatabase } from '../connection';
import { onboardingState } from '../schema';
import type {
  OnboardingState,
  OnboardingObjective,
  Plan,
  LlmProviderId,
} from '../../../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

function rowToState(row: typeof onboardingState.$inferSelect | undefined): OnboardingState {
  if (!row) {
    return {
      completed: false,
      step: 0,
      plan: null,
      llmProvider: null,
      objectives: [],
      completedAt: null,
      updatedAt: nowIso(),
    };
  }
  return {
    completed: row.completed,
    step: row.step,
    plan: (row.plan as Plan | null) ?? null,
    llmProvider: (row.llmProvider as LlmProviderId | null) ?? null,
    objectives: (row.objectives ?? []) as OnboardingObjective[],
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
  };
}

export class OnboardingRepository {
  get(): OnboardingState {
    const db = getDatabase();
    const row = db.select().from(onboardingState).where(eq(onboardingState.id, 'singleton')).get();
    return rowToState(row);
  }

  setStep(step: number): OnboardingState {
    const db = getDatabase();
    const now = nowIso();
    db.insert(onboardingState)
      .values({ id: 'singleton', step, updatedAt: now })
      .onConflictDoUpdate({
        target: onboardingState.id,
        set: { step, updatedAt: now },
      })
      .run();
    return this.get();
  }

  markCompleted(input: {
    plan: Plan;
    llmProvider: string;
    objectives: OnboardingObjective[];
  }): OnboardingState {
    const db = getDatabase();
    const now = nowIso();
    db.insert(onboardingState)
      .values({
        id: 'singleton',
        completed: true,
        step: 10,
        plan: input.plan,
        llmProvider: input.llmProvider,
        objectives: input.objectives,
        completedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: onboardingState.id,
        set: {
          completed: true,
          step: 10,
          plan: input.plan,
          llmProvider: input.llmProvider,
          objectives: input.objectives,
          completedAt: now,
          updatedAt: now,
        },
      })
      .run();
    return this.get();
  }

  reset(): OnboardingState {
    const db = getDatabase();
    db.delete(onboardingState).run();
    return this.get();
  }
}
