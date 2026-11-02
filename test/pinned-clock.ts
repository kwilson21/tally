import { vi } from "vitest";

/**
 * Sets Date to mid-October 2026 and freezes it there, so a test that seeds the demo or expects a month name runs
 * the same way on any real day (#808). Only Date is faked: promises and timers still run. Restore with
 * `vi.useRealTimers()` in an afterEach.
 */
export function pinClock(instant = "2026-10-11T12:00:00Z"): void {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(instant));
}
