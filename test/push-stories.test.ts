import { describe, expect, it } from "vitest";
import { type DeviceFacts, subscribeDevice } from "../src/rules/push";
import { answerOf, nothingToDo, refuse, write } from "./helpers/rule-answers";

// The push area's one rule as stories (decisions 187, 206): each row is what was asked, what was stored, and what the
// rule answers. The time and the person are inputs (decision 195); nothing here touches a clock or a database.

const ME = "person@example.com";
const RILEY = "riley@example.com";
const NOW = "2026-11-12 15:00:00";
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/this-device";

const ask = (facts: Partial<DeviceFacts>, restore = false) =>
	answerOf(
		subscribeDevice.decide(
			{
				member: ME,
				endpoint: ENDPOINT,
				p256dh: "key",
				auth: "secret",
				restore,
				now: NOW,
			},
			{ isMember: true, device: null, others: [], version: "v1", ...facts },
		),
	);

const saves = (...drop: number[]) =>
	write({
		member: ME,
		endpoint: ENDPOINT,
		p256dh: "key",
		auth: "secret",
		now: NOW,
		drop,
		expectedVersion: "v1",
	});

/** The person's other devices, one a day from January 1: id 1 is the oldest. */
const others = (count: number) =>
	Array.from({ length: count }, (_, i) => ({
		id: i + 1,
		createdAt: `2026-01-0${i + 1} 09:00:00`,
	}));

const NOT_A_MEMBER = refuse(
	"NotAMember",
	"Only a member of the household can turn on notifications.",
);

const SOMEONE_ELSES = refuse(
	"DeviceIsSomeoneElses",
	"This device is turned on for someone else.",
);

describe("Turn on notifications for a device (a tap)", () => {
	it.each([
		["stores a new device", {}, saves()],
		[
			"stores it again for the same person, as the newest",
			{ device: { id: 7, owner: ME } },
			saves(),
		],
		[
			"moves a device turned on for someone else to the person who tapped",
			{ device: { id: 7, owner: RILEY } },
			saves(),
		],
		["keeps a fifth device", { others: others(4) }, saves()],
		[
			"drops the oldest when this is a sixth device",
			{ others: others(5) },
			saves(1),
		],
		[
			"drops every device past the four newest others",
			{ others: others(7) },
			saves(3, 2, 1),
		],
		[
			"keeps the newer of two devices stored in the same second by its id",
			{
				others: [...others(4), { id: 9, createdAt: "2026-01-01 09:00:00" }],
			},
			saves(1),
		],
		["refuses a person who is not a member", { isMember: false }, NOT_A_MEMBER],
	])("%s", (_story, facts, answer) => {
		expect(ask(facts)).toEqual(answer);
	});
});

describe("Bring a device back on a page load (restore)", () => {
	it.each([
		["stores a device that was lost", {}, saves()],
		[
			"stores a lost device and drops the oldest past five",
			{ others: others(5) },
			saves(1),
		],
		[
			"has nothing to do for a device that is already this person's",
			{ device: { id: 7, owner: ME }, others: others(6) },
			nothingToDo(),
		],
		[
			"refuses a device turned on for someone else, and moves nothing",
			{ device: { id: 7, owner: RILEY } },
			SOMEONE_ELSES,
		],
		[
			"refuses a person who is not a member, even for their own device",
			{ isMember: false, device: { id: 7, owner: ME } },
			NOT_A_MEMBER,
		],
	])("%s", (_story, facts, answer) => {
		expect(ask(facts, true)).toEqual(answer);
	});
});
