// Static palette for this first UI trial; all view colors come from here.
export const theme = {
  line: "#56615d",
  ink: "#ded9cb",
  muted: "#9daaa3",
  mint: "#9ad2b5",
  amber: "#f0c67b",
  rose: "#e4a5a3",
  blue: "#a7bee7",
} as const;

export const statuses = {
  stable: theme.mint,
  testing: theme.amber,
  review: theme.blue,
  idea: theme.rose,
} as const;
