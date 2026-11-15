// The categories not archived, in the order Organize and Suggestions list them. categoryNames (categories.ts) also lists the
// archived ones, so it is not used for these pages.
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { categories } from "./schema";

export const activeCategories = (db: D1Database) =>
	drizzle(db)
		.select({
			id: categories.id,
			name: categories.name,
			icon: categories.icon,
			color: categories.color,
		})
		.from(categories)
		.where(eq(categories.archived, 0))
		.orderBy(asc(categories.sortOrder), asc(categories.name))
		.all();
