// How long a typed text may be. Each limit is written here once, and the form's maxlength and the server's check both read
// it, so a form never lets through what the server refuses. test/text-limits.test.ts fails if a number is spelled out again.

/** A category's name (Settings, the Maybe card's new category, the edit panel's New category). Jev's suggested names stop here too. */
export const CATEGORY_NAME_MAX = 40;

/** A person's name in Settings' People. */
export const PERSON_NAME_MAX = 40;

/** A name a person gives a merchant or a transaction: the edit panel's rename, Organize's name, a Maybe card's own name. */
export const DISPLAY_NAME_MAX = 80;

/** A planned expense's name. */
export const PLAN_NAME_MAX = 80;

/** A note on a transaction, a cash purchase or a suggestion's row. */
export const NOTE_MAX = 500;

/** Where a cash purchase was made. */
export const CASH_MERCHANT_MAX = 120;

/** A feedback message. */
export const FEEDBACK_MESSAGE_MAX = 2000;

/** A merchant's key (its raw name) as a suggestion form sends it back in a hidden field. */
export const MERCHANT_KEY_MAX = 500;
