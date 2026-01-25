import { createCliRenderer, TextAttributes } from "@opentui/core";
import { createRoot } from "@opentui/react";

export interface Args {}

export function tui(input: {
	url: string;
	args: Args;
	directory?: string;
	onExit?: () => Promise<void>;
}) {
	return new Promise<void>(async (resolve) => {
		// const mode = await getTerminalBackgroundColor()
		const onExit = async () => {
			await input.onExit?.();
			resolve();
		};

		return <App />;
	});
}

function App() {
	return (
		<box alignItems="center" justifyContent="center" flexGrow={1}>
			<box justifyContent="center" alignItems="flex-end">
				<ascii-font font="tiny" text="OpenTUI" />
				<text attributes={TextAttributes.DIM}>
					What will you build?
				</text>
				<text attributes={TextAttributes.DIM}>
					Press Ctrl+C to exit
				</text>
			</box>
		</box>
	);
}

const renderer = await createCliRenderer();
createRoot(renderer).render(<App />);
