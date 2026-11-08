/**
 * Expands scheduled transactions into dated occurrences. Dates are plain
 * YYYY-MM-DD strings handled in UTC, so time zones can't shift them.
 *
 * Month-based frequencies repeat on the day of date_first, moved to the last
 * day of shorter months (a schedule starting Jan 31 lands on Feb 28, then Mar 31).
 *
 * YNAB doesn't document which two days "twiceAMonth" uses. When date_first and
 * date_next fall on different days we use those two; otherwise we assume the
 * second date is 15 days from the first and mark the result approximate.
 */

import type { ScheduledFrequency } from "./ynab";

const DAY_STEPS: Partial<Record<ScheduledFrequency, number>> = {
	daily: 1,
	weekly: 7,
	everyOtherWeek: 14,
	every4Weeks: 28,
};

const MONTH_STEPS: Partial<Record<ScheduledFrequency, number>> = {
	monthly: 1,
	everyOtherMonth: 2,
	every3Months: 3,
	every4Months: 4,
	twiceAYear: 6,
	yearly: 12,
	everyOtherYear: 24,
};

const MAX_OCCURRENCES = 400;

function parts(date: string) {
	const [y, m, d] = date.split("-").map(Number);
	return { y, m, d };
}

function fmt(y: number, m: number, d: number) {
	return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function daysInMonth(y: number, m: number) {
	return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(date: string, n: number) {
	const { y, m, d } = parts(date);
	return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Move `date` by whole months, landing on `anchorDay` (or the month's last day if shorter). */
function addMonthsAnchored(date: string, months: number, anchorDay: number) {
	const { y, m } = parts(date);
	const total = y * 12 + (m - 1) + months;
	const ny = Math.floor(total / 12);
	const nm = (total % 12) + 1;
	return fmt(ny, nm, Math.min(anchorDay, daysInMonth(ny, nm)));
}

export interface Schedule {
	date_first: string;
	date_next: string;
	frequency: ScheduledFrequency;
}

/** Occurrence dates from `from` through `to` (inclusive), starting no earlier than date_next. */
export function occurrences(s: Schedule, from: string, to: string): { dates: string[]; approximate: boolean } {
	const dates: string[] = [];
	const start = s.date_next;
	const keep = (d: string) => {
		if (d >= from && d <= to && d >= start) dates.push(d);
	};

	if (s.frequency === "never") {
		keep(start);
		return { dates, approximate: false };
	}

	const dayStep = DAY_STEPS[s.frequency];
	if (dayStep) {
		for (let d = start; d <= to && dates.length < MAX_OCCURRENCES; d = addDays(d, dayStep)) keep(d);
		return { dates, approximate: false };
	}

	const monthStep = MONTH_STEPS[s.frequency];
	if (monthStep) {
		const anchor = parts(s.date_first).d;
		for (let k = 0, d = start; d <= to && dates.length < MAX_OCCURRENCES; k++, d = addMonthsAnchored(start, k * monthStep, anchor)) {
			keep(d);
		}
		return { dates, approximate: false };
	}

	if (s.frequency === "twiceAMonth") {
		const a = parts(s.date_first).d;
		const b = parts(s.date_next).d;
		const approximate = a === b;
		const pair = approximate ? [a, a <= 15 ? a + 15 : a - 15] : [a, b];
		pair.sort((x, y) => x - y);
		let { y, m } = parts(start);
		while (fmt(y, m, 1) <= to && dates.length < MAX_OCCURRENCES) {
			for (const day of pair) keep(fmt(y, m, Math.min(day, daysInMonth(y, m))));
			m === 12 ? ((y += 1), (m = 1)) : (m += 1);
		}
		return { dates, approximate };
	}

	return { dates, approximate: true };
}
