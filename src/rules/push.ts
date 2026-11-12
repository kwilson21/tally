// The push area's rule (decisions 187 and 206): turn on notifications for a device, or bring a lost device back on a
// page load. It takes a typed request and what is stored about the person and the device, and answers what to save. The
// time and the person are inputs (decision 195), and nothing here parses, reads a clock or touches the database. The
// save's guard is in src/db/push-saves.ts (decision 190).

import * as Data from "effect/Data";
import { MAX_DEVICES_PER_PERSON } from "../push/devices";
import { rule, term, unless } from "./terms";

export type DeviceRequest = {
	member: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	/** True for a page load's quiet re-post, which brings a lost device back and never moves one (decision 149). */
	restore: boolean;
	/** The time of the request, as SQLite writes it in UTC: YYYY-MM-DD HH:MM:SS. */
	now: string;
};

export type DeviceFacts = {
	/** Whether the person is a member of the household now (not removed). */
	isMember: boolean;
	/** The stored row for this endpoint and the person it is stored for, or null when there is none. */
	device: { id: number; owner: string } | null;
	/** The person's other stored devices (not this endpoint). */
	others: { id: number; createdAt: string }[];
	/** Stands for everything above as it was read. A save lands only while the stored rows still have this version. */
	version: string;
};

/** What the rule saves: this device for the person, as their newest, and the ids of their devices past the cap to drop. */
export type DeviceWrite = Omit<DeviceRequest, "restore"> & {
	drop: number[];
	expectedVersion: string;
};

// The refusals: one class each. The sentences are for the rule sheet; the script that posts here reads only the status.

export class NotAMember extends Data.TaggedError("NotAMember") {
	readonly say = "Only a member of the household can turn on notifications.";
}

export class DeviceIsSomeoneElses extends Data.TaggedError(
	"DeviceIsSomeoneElses",
) {
	readonly say = "This device is turned on for someone else.";
}

type Given = DeviceRequest & DeviceFacts & { mine: boolean; taken: boolean };

/** The person's other devices past the newest that still fit beside this one, newest first by time and then id. */
const pastTheCap = (others: DeviceFacts["others"]) =>
	[...others]
		.sort((a, b) =>
			a.createdAt === b.createdAt
				? b.id - a.id
				: a.createdAt < b.createdAt
					? 1
					: -1,
		)
		.slice(MAX_DEVICES_PER_PERSON - 1)
		.map((d) => d.id);

export const subscribeDevice = rule({
	name: "Turn on notifications for a device",
	given: (request: DeviceRequest, facts: DeviceFacts): Given => ({
		...request,
		...facts,
		mine: facts.device?.owner === request.member,
		taken: facts.device !== null && facts.device.owner !== request.member,
	}),
	nothingToDoIf: term<Given>(
		"a page load re-posts a device that is already stored for this member",
		(g) => g.isMember && g.restore && g.mine,
	),
	refusals: [
		unless(
			term<Given>("the person is a member of the household", (g) => g.isMember),
			() => new NotAMember(),
		),
		unless(
			term<Given>(
				"a page load does not re-post a device stored for someone else",
				(g) => !(g.restore && g.taken),
			),
			() => new DeviceIsSomeoneElses(),
		),
	],
	writes: (g): DeviceWrite => ({
		member: g.member,
		endpoint: g.endpoint,
		p256dh: g.p256dh,
		auth: g.auth,
		now: g.now,
		drop: pastTheCap(g.others),
		expectedVersion: g.version,
	}),
	writesText: `Stores the device for the person as their newest, moving it from whoever had it, and drops their devices past the newest ${MAX_DEVICES_PER_PERSON}.`,
});
