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
	reviewRequired = false,
}: {
	values: FeedbackValues;
	error?: string;
	demo?: boolean;
	diagnosticsEnabled?: boolean;
	reviewRequired?: boolean;
}) {
	return (
		<div class="max-w-2xl">
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				Send feedback
			</h1>
			<p class="mt-2 text-muted">
				Before a new report is sent, Tally applies deterministic pattern
				redaction to recognizable links, email addresses, phone numbers, labeled
				passwords, tokens, API keys, authorization values, street addresses,
				account-like numbers, currency amounts, IPv4-formatted addresses, and
				some title-case name patterns, then asks you to review the cleaned text.
				It cannot reliably identify arbitrary names or every sensitive detail in
				prose; inspect the text and remove anything you do not want to send. The
				Worker repeats redaction before storage and private GitHub filing. New
				feedback records do not include your sign-in email. A random one-hour
				limiter cookie provides a best-effort per-browser rate limit; it can be
				cleared and is not a person-level identity or security boundary. Tally
				stores the report type, feeling, cleaned message, approved route
				category, coarse device category, and submission time in Cloudflare D1.
				Private GitHub filing receives the cleaned report fields without the
				sign-in email or submission time. This is best-effort redaction, not a
				guarantee that a report contains no personal information.
			</p>
			{demo ? (
				<p class="mt-8 rounded-control border border-rule bg-band p-4">
					Feedback is off in the demo. Sign in to your Tally to send it.
				</p>
			) : (
				<form method="post" action="/feedback" class="mt-8 grid gap-7">
					<input type="hidden" name="from" value={values.from} />
					<input
						type="hidden"
						name="device_category"
						value="Unknown"
						data-feedback-device-category
					/>
					<input
						type="hidden"
						name="return_to"
						value={values.returnTo ?? values.from}
					/>
					<input
						type="hidden"
						name="message_reviewed"
						value={reviewRequired ? values.message : ""}
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
										Optional: generic allowlisted browser-error type. The
										approved route and coarse device category are included with
										every report. It excludes raw user-agent text, screen
										dimensions, versions, error text, stacks, screen contents,
										and financial values.
									</span>
								</span>
							</label>
							<input type="hidden" name="client_context" value="" />
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
						<p class="mt-2 text-sm text-muted">
							Automatic redaction can miss names and identifying details in
							ordinary prose. Review the cleaned text before sending.
						</p>
						<div
							id="feedback-redaction-review"
							class="mt-3 rounded-control border border-rule bg-band p-3"
							role="status"
							hidden
						/>
						<label
							class="mt-3 flex min-h-11 w-full items-start gap-2 rounded-control px-2 py-2"
							hidden={!reviewRequired}
							data-feedback-confirm-label
						>
							<input
								type="checkbox"
								name="confirm_review"
								value="yes"
								required={reviewRequired}
							/>
							<span>I reviewed the cleaned message above.</span>
						</label>
					</div>
					<div>
						<Button type="submit">Send</Button>
					</div>
				</form>
			)}
		</div>
	);
}
