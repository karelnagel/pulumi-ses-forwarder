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
        aws: { region: "eu-central-1" },
      },
    };
  },
  run: async () => {
    const emailStorageBucket = new aws.s3.Bucket("EmailStorage", {
      versioning: {
        enabled: true,
      },
    });

    const lambdaRole = new aws.iam.Role("LambdaSesForwarder", {
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
    });
    const lambdaCustomPolicy = new aws.iam.Policy("LambdaSesForwarderPolicy", {
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: "arn:aws:logs:*:*:*",
          },
          {
            Effect: "Allow",
            Action: "ses:SendRawEmail",
            Resource: "*",
          },
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject"],
            Resource: "*",
          },
        ],
      }),
    });
    new aws.iam.RolePolicyAttachment("LambdaSesForwarderPolicyAttachment", {
      role: lambdaRole,
      policyArn: lambdaCustomPolicy.arn,
    });
    new aws.iam.RolePolicyAttachment("LambdaBasicExecutionRoleAttachment", {
      role: lambdaRole,
      policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
    });

    const emailProcessorLambda = new aws.lambda.Function("SesForwarderLambda", {
      runtime: "nodejs16.x",
      code: new pulumi.asset.AssetArchive({
        "index.js": new pulumi.asset.FileAsset("/Users/karel/Documents/sst-email-forwarder/index.js"),
      }),
      timeout: 10,
      handler: "index.handler",
      role: lambdaRole.arn,
      environment: { variables: {} },
    });

    new aws.lambda.Permission("SESLambdaInvokePermission", {
      action: "lambda:InvokeFunction",
      function: emailProcessorLambda.name,
      principal: "ses.amazonaws.com",
      sourceAccount: pulumi.output(aws.getCallerIdentity({})).apply((id) => id.accountId),
    });

    const ruleSet = new aws.ses.ReceiptRuleSet("MainRuleSet", { ruleSetName: "main" });

    new aws.ses.ReceiptRule("EmailForwardingRule", {
      ruleSetName: ruleSet.ruleSetName,
      enabled: true,
      recipients: ["asius.ee"],
      s3Actions: [
        {
          position: 1,
          bucketName: emailStorageBucket.bucket,
          objectKeyPrefix: "emails/",
        },
      ],
      lambdaActions: [
        {
          position: 2,
          functionArn: emailProcessorLambda.arn,
        },
      ],
    });
    new aws.ses.ActiveReceiptRuleSet("ActiveMainRuleSet", {
      ruleSetName: ruleSet.ruleSetName,
    });

    const accountId = await aws.getCallerIdentity({}).then((c) => c.accountId);
    console.log({ accountId });

    new aws.s3.BucketPolicy("EmailStorageBucketPolicy", {
      bucket: emailStorageBucket.bucket,
      policy: emailStorageBucket.bucket.apply((bucketName) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: {
                Service: "ses.amazonaws.com",
              },
              Action: "s3:PutObject",
              Resource: `arn:aws:s3:::${bucketName}/*`,
              Condition: {
                StringEquals: {
                  "aws:Referer": accountId,
                },
              },
            },
          ],
        })
      ),
    });
  },
});
