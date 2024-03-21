/// <reference path="./.sst/platform/config.d.ts" />

import { EmailForwarder } from ".";

export default $config({
  app: (input) => {
    return {
      name: "pulumi-email-forwarder",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: { region: "eu-central-1" },
      },
    };
  },
  run: async () => {
    new EmailForwarder("EmailForwarder", {
      recipients: ["example.com"],
      hostedZones: ["example.com"],
      fromEmail: "noreply@example.com",
      forwardMapping: {
        "info@example.com": ["john@example.com", "jane@gmail.com"],
        "@example.com": ["john@example.com"],
      },
    });
  },
});
