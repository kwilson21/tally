import type { Child } from "hono/jsx";

type LayoutProps = {
	title?: string;
	children?: Child;
};

export function Layout({ title = "Tally", children }: LayoutProps) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{title}</title>
			</head>
			<body>
				<main>{children}</main>
			</body>
		</html>
	);
}
