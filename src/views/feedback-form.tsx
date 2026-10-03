import { Button } from "./button";
import { Chip } from "./chip";

export type FeedbackValues = {
	type: string;
	feeling: string;
	message: string;
	from: string;
	returnTo?: string;
};

const TYPES = ["Bug", "Idea", "Question", "Other"];
const FEELINGS = ["Frustrated", "Confused", "Okay", "Happy", "Delighted"];

/** The short, labeled form used to tell Tally's builder what happened. */
export function FeedbackForm({
	values,
	error,
	demo = false,
	diagnosticsEnabled = false,
	replayLinksEnabled = false,
	replayOrigin,
	appVersion,
}: {
	values: FeedbackValues;
	error?: string;
	demo?: boolean;
	diagnosticsEnabled?: boolean;
	replayLinksEnabled?: boolean;
	replayOrigin?: string;
	appVersion?: string;
}) {
	return (
		<div class="max-w-2xl">
			<h1 class="font-serif text-4xl font-semibold">Send feedback</h1>
			<p class="mt-2 text-muted">
				Goes straight to the person who builds Tally.
			</p>
			{demo ? (
				<p class="mt-8 rounded-control border border-rule bg-band p-4">
					Feedback is off in the demo. Sign in to your Tally to send it.
				</p>
			) : (
				<form
					method="post"
					action="/feedback"
					class="mt-8 grid gap-7"
					data-app-version={appVersion ?? ""}
				>
					<input type="hidden" name="from" value={values.from} />
					<input
						type="hidden"
						name="return_to"
						value={values.returnTo ?? values.from}
					/>
					{diagnosticsEnabled && (
						<fieldset class="rounded-control border border-rule bg-band p-4">
							<label class="flex items-start gap-3">
								<input
									type="checkbox"
									name="include_diagnostics"
									value="yes"
									class="mt-1 size-4 accent-ink"
								/>
								<span>
									<span class="block font-medium">
										Attach technical details
									</span>
									<span class="mt-1 block text-sm text-muted">
										Optional: route, browser and OS versions, screen size, app
										build, and the type of a recent browser error. It excludes
										screen contents, amounts, account details, notes, and error
										text.
									</span>
								</span>
							</label>
							<input type="hidden" name="client_context" value="" />
							{replayLinksEnabled && (
								<label class="mt-4 block text-sm">
									<input
										type="checkbox"
										name="include_replay"
										value="yes"
										class="mr-2 size-4 accent-ink"
									/>
									Attach a replay link at {replayOrigin}. A separately recorded
									replay may include screen contents and interactions. This does
									not start recording.
									<input type="hidden" name="posthog_session_id" value="" />
								</label>
							)}
						</fieldset>
					)}
					{error && (
						<p
							role="alert"
							class="rounded-control border border-error p-3 text-error"
						>
							{error}
						</p>
					)}
					<fieldset>
						<legend class="font-medium">What is it?</legend>
						<div class="mt-2 flex flex-wrap gap-2">
							{TYPES.map((type) => (
								<Chip
									type="radio"
									name="type"
									value={type}
									checked={values.type === type}
								>
									{type}
								</Chip>
							))}
						</div>
					</fieldset>
					<fieldset>
						<legend class="font-medium">How does Tally feel right now?</legend>
						<div class="mt-2 flex flex-wrap gap-2">
							{FEELINGS.map((feeling) => (
								<Chip
									type="radio"
									name="feeling"
									value={feeling}
									checked={values.feeling === feeling}
								>
									{feeling}
								</Chip>
							))}
						</div>
					</fieldset>
					<div>
						<label for="feedback-message" class="block font-medium">
							Message
						</label>
						<textarea
							id="feedback-message"
							name="message"
							maxlength={2000}
							required
							rows={7}
							class="mt-2 w-full rounded-control border border-ink bg-paper px-3 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
						>
							{values.message}
						</textarea>
					</div>
					<div>
						<Button type="submit">Send</Button>
					</div>
				</form>
			)}
		</div>
	);
}
