console.log("Starting debug test...");

const worker = new Worker(new URL("../src/auth/worker.ts", import.meta.url));

worker.onerror = (e) => {
  console.error("Worker error:", e);
};

worker.addEventListener("message", (evt) => {
  console.log("Message from worker:", evt.data);
});

console.log("Worker spawned, waiting 5s...");
await globalThis.Bun.sleep(5000);
console.log("Done");
