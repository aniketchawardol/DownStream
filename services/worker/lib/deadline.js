// @ts-check
// Optional time budget for one-shot runs (GitHub Actions kills a job at its timeout). With
// JOB_TIME_BUDGET_MIN set, long jobs stop starting new work once it's spent and save their place, so the
// next run carries on. Unset (local worker): no limit.
const START = Date.now();
const budgetMin = Number(process.env.JOB_TIME_BUDGET_MIN) || 0;

/** True once the budget is used up. */
export const outOfTime = () => budgetMin > 0 && Date.now() - START > budgetMin * 60_000;
