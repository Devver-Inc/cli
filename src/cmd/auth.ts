import { getAuthClient, startLogin, terminateAuthClient } from "../auth/client";
import { cmd } from "./cmd";

const AuthLoginCommand = cmd({
  command: "login",
  describe: "authenticate to your devver server",
  async handler() {
    console.log("Opening browser for login...");

    const { onSuccess, onError } = await startLogin();

    await new Promise<void>((resolve, reject) => {
      onSuccess(() => {
        console.log("✓ Login successful!");
        resolve();
      });
      onError((e) => {
        console.error("✗ Login failed:", e.error);
        reject(new Error(e.error));
      });
    });

    await terminateAuthClient();
  },
});

const AuthLogoutCommand = cmd({
  command: "logout",
  describe: "logout from your devver server",
  async handler() {
    const client = getAuthClient();
    await client.call("logout", undefined);
    console.log("✓ Logged out");
    await terminateAuthClient();
  },
});

const AuthStatusCommand = cmd({
  command: "status",
  describe: "Show login status",
  async handler() {
    const client = getAuthClient();
    const user = await client.call("getUser", undefined);
    if (user) {
      console.log("✓ Logged in as:", user.username ?? user.sub);
    } else {
      console.log("✗ Not logged in");
    }
    await terminateAuthClient();
  },
});

export const AuthCommand = cmd({
  command: "auth",
  describe: "manage authentication",
  builder: (yargs) =>
    yargs
      .command(AuthLoginCommand)
      .command(AuthLogoutCommand)
      .command(AuthStatusCommand)
      .demandCommand(),
  async handler() {
    await new Promise(() => ({}));
  },
});
