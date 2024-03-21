/// <reference path="./.sst/platform/config.d.ts" />
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

export default $config({
  app: (input) => {
    return {
      name: "sst-email-forwarder",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: {
          region: "eu-central-1",
        },
      },
    };
  },
  run: async () => {
    // LAMBDA
    const lambdaRole = new aws.iam.Role("LambdaRole", {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
    });

    // Attach the AWSLambdaBasicExecutionRole policy to the IAM role
    new aws.iam.RolePolicyAttachment("LambdaPolicyAttachment", {
      role: lambdaRole,
      policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
    });

    // Define the Lambda function
    const emailProcessorLambda = new aws.lambda.Function("EmailProcessorLambda", {
      runtime: "nodejs18.x",
      code: new pulumi.asset.AssetArchive({
        "index.js": new pulumi.asset.StringAsset(
          "/* global fetch */" +
          "exports.handler = async (event) => {" +
            '   console.log("Processing event: ", event);' +
            '   await fetch("https://asius.ai/api/emails",{method:"POST",body:JSON.stringify(event)}).then(res=>res.status);' +
            "};"
        ),
      }),
      timeout: 10,
      handler: "index.handler",
      role: lambdaRole.arn,
      environment: {
        variables: {},
      },
    });

    // Add permission for SES to invoke the Lambda function
    new aws.lambda.Permission("SESLambdaInvokePermission", {
      action: "lambda:InvokeFunction",
      function: emailProcessorLambda.name,
      principal: "ses.amazonaws.com",
      sourceAccount: pulumi.output(aws.getCallerIdentity({})).apply((id) => id.accountId),
    });

    // EMAIL
    const ruleSet = new aws.ses.ReceiptRuleSet("Main", { ruleSetName: "main" });
    const bounceRule = new aws.ses.ReceiptRule("BounceRule", {
      ruleSetName: ruleSet.ruleSetName,
      recipients: ["no-reply@asius.ai"],
      bounceActions: [
        {
          position: 1,
          message: "Rejected because the sender is not no-reply@asius.ai",
          sender: "no-reply@asius.ai",
          smtpReplyCode: "550",
          statusCode: "5.7.1",
        },
      ],
      enabled: true,
    });

    const forwardRule = new aws.ses.ReceiptRule("FrowardRule", {
      ruleSetName: ruleSet.ruleSetName,
      enabled: true,
      recipients: ["uploads@asius.ai"],
      scanEnabled: true,
      lambdaActions: [
        {
          position: 1,
          functionArn: emailProcessorLambda.arn,
        },
      ],
    });
    new aws.ses.ActiveReceiptRuleSet("ActiveRuleSet", {
      ruleSetName: ruleSet.ruleSetName,
    });
    
  },
});
