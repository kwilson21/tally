/** A parsed JSON value: what `JSON.parse` and `response.json()` give before any of it is checked. */
export type Json =
	| string
	| number
	| boolean
	| null
	| Json[]
	| { [key: string]: Json };
