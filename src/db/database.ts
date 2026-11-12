// The household's database, handed to the Effect rules' reads and saves as a service (decision 206), so a handler
// provides the request's own D1 binding and a test provides whichever database it likes.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export class Database extends Context.Service<Database, D1Database>()(
	"tally/db/Database",
) {}

/** Runs a program that needs only the database, with this database: a handler passes its request's own D1 binding. */
export const runWith = <A>(
	db: D1Database,
	program: Effect.Effect<A, never, Database>,
) => Effect.runPromise(program.pipe(Effect.provideService(Database, db)));
