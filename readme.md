# Pulumi SES Email Forwarder

Forwarding incoming emails with SES. 
You need to have the domain verified in SES. 
It will only change the MX record if you specify `hostedZone`, if you don't then you can manually set it to `10 inbound-smtp.YOUR_REGION.amazonaws.com`

the forwarder.js script is taken from here: https://github.com/arithmetric/aws-lambda-ses-forwarder

First time using Pulumi, so PRs are welcome!

Note: at first deploy it throws an error, idk why, but after a retry it works fine.

## Example

This will:
- change MX record for `example.com` to `10 inbound-smtp.YOUR_REGION.amazonaws.com`
- will forward every mail from `info@example.com` to `john@example.com` and `jane@gmail.com`
- will forward every mail from `*@example.com` to `john@example.com`
- use `noreply@example.com` as the forwarding email address

```ts
 new EmailForwarder("EmailForwarder", {
      recipients: ["example.com"],
      hostedZones: ["example.com"],
      fromEmail: "noreply@example.com",
      forwardMapping: {
        "info@example.com": ["john@example.com", "jane@gmail.com"],
        "@example.com": ["john@example.com"],
      },
    });
```