/** How long one sync holds a bank before another run may take it over; every page the sync reads renews it. */
export const SYNC_LEASE_MINUTES = 5;

/** How soon after a bank's last attempt a manual sync may try that bank again. */
export const SYNC_COOLDOWN_SECONDS = 60;

/** How long one run over all the banks may go on before it leaves the rest for the next run. */
export const SYNC_RUN_BUDGET_MS = 12 * 60 * 1000;
