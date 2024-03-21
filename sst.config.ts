/// <reference path="./.sst/platform/config.d.ts" />

import { EmailForwarder } from ".";

export default $config({
  app: (input) => {
    return {
      name: "sst-email-forwarder",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: { region: "eu-central-1" },
      },
    };
  },
  run: async () => {
    new EmailForwarder("EmailForwarder", {
      recipients: ["asius.ee"],
      fromEmail: "noreply@asius.ee",
      forwardMapping: {
        "info@asius.ee": ["ouasius@gmail.com", "nagelkarel@gmail.com"],
        "@asius.ee": ["nagelkarel@gmail.com"],
      },
    });
  },
});
