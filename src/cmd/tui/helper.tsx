import { createContext, type ReactNode, useContext } from "react";
export function createSimpleContext<
  T,
  Props extends Record<string, unknown> = Record<string, unknown>,
>(input: { name: string; useInit: (props: Props) => T }) {
  const ctx = createContext<T | undefined>(undefined);
  function Provider({ children, ...rest }: Props & { children: ReactNode }) {
    const value = input.useInit(rest as unknown as Props);
    return <ctx.Provider value={value}>{children}</ctx.Provider>;
  }
  function use() {
    const value = useContext(ctx);
    if (value === undefined) {
      throw new Error(
        `${input.name} context must be used within a ${input.name}Provider`
      );
    }
    return value;
  }
  return { Provider, use };
}
