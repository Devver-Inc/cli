import { TextAttributes, createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { ExitProvider, useExit } from "./exit"

export type Args = object

export function tui(input: {
  url: string
  args: Args
  directory?: string
  onExit?: () => Promise<void>
}) {
  // biome-ignore lint/suspicious/noAsyncPromiseExecutor: used here for tui execution
  return new Promise<void>(async (resolve) => {
    const renderer = await createCliRenderer({
      exitOnCtrlC: false,
    })

    const onExit = async () => {
      await input.onExit?.()
      resolve()
    }

    createRoot(renderer).render(
      <ExitProvider onExit={onExit}>
        <App />
      </ExitProvider>,
    )
  })
}

function App() {
  const exit = useExit()

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      exit()
    }
  })

  return (
    <box alignItems="center" justifyContent="center" flexGrow={1}>
      <box flexDirection="column" justifyContent="center" alignItems="center">
        <ascii-font font="slick" text="Devver" />
        <text attributes={TextAttributes.DIM}>What will you build?</text>
        <text attributes={TextAttributes.DIM}>Press Ctrl+C to exit</text>
      </box>
    </box>
  )
}
