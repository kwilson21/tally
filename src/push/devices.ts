// The devices a person keeps for Web Push (decision 149, spec §10): at most MAX_DEVICES_PER_PERSON, the oldest dropped. The route
// trims a person's rows in the same batch as the write that stores or moves one (routes/push.ts), and the ready push reads only
// that many per person (first-tally/ready-push.ts), so neither the Worker's outbound requests nor its database reads grow with
// the number of rows a person can post.

/**
 * The most devices one person keeps. A family member rarely has more than a phone, a tablet and two browsers, so five is
 * room for that. The newest by created_at, then id, are kept; a tap makes its device the newest (routes/push.ts).
 */
export const MAX_DEVICES_PER_PERSON = 5;
