import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piUntilProject(pi: ExtensionAPI) {
  pi.registerCommand("pi-until-project", {
    description: "Show the pi-until validation gate",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Validation: npm run check && npm run pack:dry", "info");
    },
  });
}
