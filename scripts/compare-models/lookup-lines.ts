// Hand-written store lines for the lookup measurement (#984, decision 216), keyed by the seed's raw name, and the
// hand-written payee rows (#984, part two). Hand-written on purpose: this is the best case for a line, so a real
// web search can only do as well or worse. Pure data: no network, no clock.

/** The line Jev is told about each store, by raw name. A raw name not here has no line, so it is never searched. */
export const LOOKUP_LINES = {
	"TRADER JOE'S #552": "Grocery store chain",
	"COSTCO WHSE #0431": "Warehouse club selling groceries and household goods",
	"WHOLEFDS MKT 10233": "Grocery store chain",
	"BLUE BOTTLE COFFEE": "Coffee shop chain",
	"CHIPOTLE 2291": "Fast-casual Mexican restaurant chain",
	"OLIVE GARDEN 1187": "Italian restaurant chain",
	"MARIO'S PIZZA": "Pizza restaurant",
	"STARBUCKS STORE 5521": "Coffee shop chain",
	"THAI PALACE": "Thai restaurant",
	"SHELL OIL 57442": "Gas station",
	"CHEVRON 0098812": "Gas station",
	"TARGET T-1432":
		"Department store selling clothes, toys, groceries and household goods",
	"YOUTH SOCCER LEAGUE": "Children's sports league",
	"BARNES & NOBLE #2831": "Bookstore chain",
	"THE HOME DEPOT #6612": "Home improvement store",
	"AMAZON.COM*RT4K2": "Online store selling almost everything",
	"AMZN MKTP US*2K4": "Online store selling almost everything",
	"CHECKCARD 0921 CVS": "Pharmacy and convenience store chain",
	"NETFLIX.COM": "Video streaming subscription",
	"APPLE.COM/BILL": "Apple's billing for apps, subscriptions and iCloud",
	"CITY GYM MEMBERSHIP": "Gym",
	"DD *DOORDASH TACO": "Restaurant food delivered by DoorDash",
	"GOOGLE *YOUTUBE PREMIUM": "Video streaming subscription",
	"GOOGLE *YOUTUBE": "Video streaming service",
	"HARBOR PROPERTY MGMT": "Property management company that collects rent",
	"LITTLE SPROUTS DAYCARE": "Daycare for young children",
	"POS 4417 CITY PARKING": "Parking garage",
	"PROCREATE DREAMS": "Animation app for iPad",
	"SP * CRAFTSUPPLY": "Online craft supplies shop",
	"SQ *FARMERS MKT": "Farmers market stall",
	"SQ *LOCAL BAKERY 4432": "Bakery",
	"TST* CORNER DELI": "Deli and sandwich shop",
	"DR MARTIN FAMILY PRACTICE REFUND": "Family doctor's office",
} satisfies Record<string, string>;

const LINE_BY_NAME = new Map(Object.entries(LOOKUP_LINES));

/** The line for a raw name, or undefined: a raw name not in the table has no line, so it is never searched. */
export const lookupLine = (rawName: string) => LINE_BY_NAME.get(rawName);

/** A hand-written payee row: money out, with the account type of the seed's main checking account. */
export type PayeeCase = {
	rawName: string;
	plaidCategory: string;
	amountCents: number;
	payee: "person" | "business";
};

export const PAYEE_CASES: PayeeCase[] = [
	{
		rawName: "JANE DOE",
		plaidCategory: "GENERAL_SERVICES",
		amountCents: 45000,
		payee: "person",
	},
	{
		rawName: "MARCUS LEE",
		plaidCategory: "RENT_AND_UTILITIES",
		amountCents: 120000,
		payee: "person",
	},
	{
		rawName: "J RIVERA",
		plaidCategory: "GENERAL_MERCHANDISE",
		amountCents: 6000,
		payee: "person",
	},
	{
		rawName: "EMILY CHEN TUTORING",
		plaidCategory: "GENERAL_SERVICES",
		amountCents: 8000,
		payee: "person",
	},
	{
		rawName: "ROSA MARTINEZ",
		plaidCategory: "PERSONAL_CARE",
		amountCents: 5500,
		payee: "person",
	},
	{
		rawName: "DAVID OKAFOR",
		plaidCategory: "HOME_IMPROVEMENT",
		amountCents: 30000,
		payee: "person",
	},
	{
		rawName: "LA COOP ARLINGTON",
		plaidCategory: "FOOD_AND_DRINK",
		amountCents: 675,
		payee: "business",
	},
	{
		rawName: "SMITH & SONS PLUMBING",
		plaidCategory: "HOME_IMPROVEMENT",
		amountCents: 22000,
		payee: "business",
	},
	{
		rawName: "ANNA'S NAILS",
		plaidCategory: "PERSONAL_CARE",
		amountCents: 4500,
		payee: "business",
	},
	{
		rawName: "DR MARTIN FAMILY PRACTICE",
		plaidCategory: "MEDICAL",
		amountCents: 3000,
		payee: "business",
	},
	{
		rawName: "CORNER DELI",
		plaidCategory: "FOOD_AND_DRINK",
		amountCents: 1250,
		payee: "business",
	},
	{
		rawName: "CITY GYM MEMBERSHIP",
		plaidCategory: "PERSONAL_CARE",
		amountCents: 3900,
		payee: "business",
	},
];
