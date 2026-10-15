import { Notebook } from "./notebook";

/** The notebook-and-pencil line drawing beside the headline: ink notebook with all five tally strokes, terracotta pencil. */
export function LedgerIllustration() {
	return <Notebook strokes={5} ink size="size-28 lg:size-36" />;
}
