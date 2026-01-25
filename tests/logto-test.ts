import { createLogtoClient } from "../src/auth/logto";

console.log("Creating client...");
const client = createLogtoClient((url) => console.log("Navigate:", url));
console.log("Client created");

console.log("Calling signIn...");
try {
  await client.signIn({ redirectUri: "http://localhost:9999/callback" });
  console.log("signIn completed");
} catch (e) {
  console.error("signIn error:", e);
}
