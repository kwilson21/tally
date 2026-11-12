// The household's database, handed to the Effect rules' reads and saves as a service (decision 206), so a handler
// provides the request's own D1 binding and a test provides whichever database it likes.
import * as Context from "effect/Context";

export class Database extends Context.Service<Database, D1Database>()(
	"tally/db/Database",
) {}
