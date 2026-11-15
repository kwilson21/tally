// The household's people, in the order the pages list them: by id, so Everyone (the first row) comes first.
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { householdPeople } from "./schema";

export const householdPeopleList = (db: D1Database) =>
	drizzle(db)
		.select({ id: householdPeople.id, name: householdPeople.name })
		.from(householdPeople)
		.orderBy(asc(householdPeople.id))
		.all();
