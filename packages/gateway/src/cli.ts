import { createGateway } from "./server.js";

const port = Number(process.env.SWITCHYARD_PORT ?? process.argv[2] ?? 8787);
const gateway = await createGateway({
  port,
  apiKey: process.env.OPENROUTER_API_KEY,
  escalation: (process.env.SWITCHYARD_ESCALATION as "always" | "never" | "uncertain") ?? "always",
});
console.log(`switchyard gateway: http://127.0.0.1:${gateway.port}/v1  (model: switchyard/auto)`);
