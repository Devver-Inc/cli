import { listInstances, loadInstance } from "../identity";

const [command, name] = process.argv.slice(2);
if (command === "create" && name) {
  console.log(JSON.stringify(await loadInstance(name)));
} else if (command === "list") {
  console.log(JSON.stringify(await listInstances()));
} else {
  throw new Error("Expected create <name> or list");
}
