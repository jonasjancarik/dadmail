import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Error reports from DadMail. See README.md in this folder.
export default defineConfig({
	// Jonáš's personal Cloudflare account
	accountId: "7756b12931ecfb3900a31049e157d706",
	worker: {
		name: "dadmail-telemetry",
		compatibilityDate: "2026-09-30",
		entrypoint,
		workersDev: true,
		env: {
			DB: bindings.d1({ name: "dadmail-telemetry", id: "6db4efc3-be81-46b4-8da8-5def48336566" }),
			// Password for the report page (user name is ignored)
			VIEW_PASSWORD: bindings.secret(),
		},
		// Daily: delete reports older than 90 days
		triggers: [triggers.scheduled({ schedule: "17 3 * * *" })],
	},
});
