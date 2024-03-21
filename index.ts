import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";

const FORWARDER_JS = `
"use strict";

var AWS = require('aws-sdk');

console.log("AWS Lambda SES Forwarder // @arithmetric // Version 5.1.0");

/**
 * Parses the SES event record provided for the mail and receipients data.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.parseEvent = function (data) {
    // Validate characteristics of a SES event record.
    if (!data.event ||
        !data.event.hasOwnProperty('Records') ||
        data.event.Records.length !== 1 ||
        !data.event.Records[0].hasOwnProperty('eventSource') ||
        data.event.Records[0].eventSource !== 'aws:ses' ||
        data.event.Records[0].eventVersion !== '1.0') {
        data.log({
            message: "parseEvent() received invalid SES message:",
            level: "error", event: JSON.stringify(data.event)
        });
        return Promise.reject(new Error('Error: Received invalid SES message.'));
    }

    data.email = data.event.Records[0].ses.mail;
    data.recipients = data.event.Records[0].ses.receipt.recipients;
    return Promise.resolve(data);
};

/**
 * Transforms the original recipients to the desired forwarded destinations.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.transformRecipients = function (data) {
    var newRecipients = [];
    data.originalRecipients = data.recipients;
    data.recipients.forEach(function (origEmail) {
        var origEmailKey = origEmail.toLowerCase();
        if (data.config.allowPlusSign) {
            origEmailKey = origEmailKey.replace(/\+.*?@/, '@');
        }
        if (data.config.forwardMapping.hasOwnProperty(origEmailKey)) {
            newRecipients = newRecipients.concat(
                data.config.forwardMapping[origEmailKey]);
            data.originalRecipient = origEmail;
        } else {
            var origEmailDomain;
            var origEmailUser;
            var pos = origEmailKey.lastIndexOf("@");
            if (pos === -1) {
                origEmailUser = origEmailKey;
            } else {
                origEmailDomain = origEmailKey.slice(pos);
                origEmailUser = origEmailKey.slice(0, pos);
            }
            if (origEmailDomain &&
                data.config.forwardMapping.hasOwnProperty(origEmailDomain)) {
                newRecipients = newRecipients.concat(
                    data.config.forwardMapping[origEmailDomain]);
                data.originalRecipient = origEmail;
            } else if (origEmailUser &&
                data.config.forwardMapping.hasOwnProperty(origEmailUser)) {
                newRecipients = newRecipients.concat(
                    data.config.forwardMapping[origEmailUser]);
                data.originalRecipient = origEmail;
            } else if (data.config.forwardMapping.hasOwnProperty("@")) {
                newRecipients = newRecipients.concat(
                    data.config.forwardMapping["@"]);
                data.originalRecipient = origEmail;
            }
        }
    });

    if (!newRecipients.length) {
        data.log({
            message: "Finishing process. No new recipients found for " +
                "original destinations: " + data.originalRecipients.join(", "),
            level: "info"
        });
        return data.callback();
    }

    data.recipients = newRecipients;
    return Promise.resolve(data);
};

/**
 * Fetches the message data from S3.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.fetchMessage = function (data) {
    // Copying email object to ensure read permission
    data.log({
        level: "info",
        message: "Fetching email at s3://" + data.config.emailBucket + '/' +
            data.config.emailKeyPrefix + data.email.messageId
    });
    return new Promise(function (resolve, reject) {
        data.s3.copyObject({
            Bucket: data.config.emailBucket,
            CopySource: data.config.emailBucket + '/' + data.config.emailKeyPrefix +
                data.email.messageId,
            Key: data.config.emailKeyPrefix + data.email.messageId,
            ACL: 'private',
            ContentType: 'text/plain',
            StorageClass: 'STANDARD'
        }, function (err) {
            if (err) {
                data.log({
                    level: "error",
                    message: "copyObject() returned error:",
                    error: err,
                    stack: err.stack
                });
                return reject(
                    new Error("Error: Could not make readable copy of email."));
            }

            // Load the raw email from S3
            data.s3.getObject({
                Bucket: data.config.emailBucket,
                Key: data.config.emailKeyPrefix + data.email.messageId
            }, function (err, result) {
                if (err) {
                    data.log({
                        level: "error",
                        message: "getObject() returned error:",
                        error: err,
                        stack: err.stack
                    });
                    return reject(
                        new Error("Error: Failed to load message body from S3."));
                }
                data.emailData = result.Body.toString();
                return resolve(data);
            });
        });
    });
};

/**
 * Processes the message data, making updates to recipients and other headers
 * before forwarding message.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.processMessage = function (data) {
    var match = data.emailData.match(/^((?:.+\r?\n)*)(\r?\n(?:.*\s+)*)/m);
    var header = match && match[1] ? match[1] : data.emailData;
    var body = match && match[2] ? match[2] : '';

    // Add "Reply-To:" with the "From" address if it doesn't already exists
    if (!/^reply-to:[\t ]?/mi.test(header)) {
        match = header.match(/^from:[\t ]?(.*(?:\r?\n\s+.*)*\r?\n)/mi);
        var from = match && match[1] ? match[1] : '';
        if (from) {
            header = header + 'Reply-To: ' + from;
            data.log({
                level: "info",
                message: "Added Reply-To address of: " + from
            });
        } else {
            data.log({
                level: "info",
                message: "Reply-To address not added because From address was not " +
                    "properly extracted."
            });
        }
    }

    // SES does not allow sending messages from an unverified address,
    // so replace the message's "From:" header with the original
    // recipient (which is a verified domain)
    header = header.replace(
        /^from:[\t ]?(.*(?:\r?\n\s+.*)*)/mgi,
        function (match, from) {
            var fromText;
            if (data.config.fromEmail) {
                fromText = 'From: ' + from.replace(/<(.*)>/, '').trim() +
                    ' <' + data.config.fromEmail + '>';
            } else {
                fromText = 'From: ' + from.replace('<', 'at ').replace('>', '') +
                    ' <' + data.originalRecipient + '>';
            }
            return fromText;
        });

    // Add a prefix to the Subject
    if (data.config.subjectPrefix) {
        header = header.replace(
            /^subject:[\t ]?(.*)/mgi,
            function (match, subject) {
                return 'Subject: ' + data.config.subjectPrefix + subject;
            });
    }

    // Replace original 'To' header with a manually defined one
    if (data.config.toEmail) {
        header = header.replace(/^to:[\t ]?(.*)/mgi, 'To: ' + data.config.toEmail);
    }

    // Remove the Return-Path header.
    header = header.replace(/^return-path:[\t ]?(.*)\r?\n/mgi, '');

    // Remove Sender header.
    header = header.replace(/^sender:[\t ]?(.*)\r?\n/mgi, '');

    // Remove Message-ID header.
    header = header.replace(/^message-id:[\t ]?(.*)\r?\n/mgi, '');

    // Remove all DKIM-Signature headers to prevent triggering an
    // "InvalidParameterValue: Duplicate header 'DKIM-Signature'" error.
    // These signatures will likely be invalid anyways, since the From
    // header was modified.
    header = header.replace(/^dkim-signature:[\t ]?.*\r?\n(\s+.*\r?\n)*/mgi, '');

    data.emailData = header + body;
    return Promise.resolve(data);
};

/**
 * Send email using the SES sendRawEmail command.
 *
 * @param {object} data - Data bundle with context, email, etc.
 *
 * @return {object} - Promise resolved with data.
 */
exports.sendMessage = function (data) {
    var params = {
        Destinations: data.recipients,
        Source: data.originalRecipient,
        RawMessage: {
            Data: data.emailData
        }
    };
    data.log({
        level: "info",
        message: "sendMessage: Sending email via SES. Original recipients: " +
            data.originalRecipients.join(", ") + ". Transformed recipients: " +
            data.recipients.join(", ") + "."
    });
    return new Promise(function (resolve, reject) {
        data.ses.sendRawEmail(params, function (err, result) {
            if (err) {
                data.log({
                    level: "error",
                    message: "sendRawEmail() returned error.",
                    error: err,
                    stack: err.stack
                });
                return reject(new Error('Error: Email sending failed.'));
            }
            data.log({
                level: "info",
                message: "sendRawEmail() successful.",
                result: result
            });
            resolve(data);
        });
    });
};

/**
 * Handler function to be invoked by AWS Lambda with an inbound SES email as
 * the event.
 *
 * @param {object} event - Lambda event from inbound email received by AWS SES.
 * @param {object} context - Lambda context object.
 * @param {object} callback - Lambda callback object.
 * @param {object} overrides - Overrides for the default data, including the
 * configuration, SES object, and S3 object.
 */
exports.handler = function (event, context, callback, overrides) {
    var steps = overrides && overrides.steps ? overrides.steps :
        [
            exports.parseEvent,
            exports.transformRecipients,
            exports.fetchMessage,
            exports.processMessage,
            exports.sendMessage
        ];
    var data = {
        event: event,
        callback: callback,
        context: context,
        config: overrides.config,
        log: overrides && overrides.log ? overrides.log : console.log,
        ses: overrides && overrides.ses ? overrides.ses : new AWS.SES(),
        s3: overrides && overrides.s3 ?
            overrides.s3 : new AWS.S3({ signatureVersion: 'v4' })
    };
    Promise.series(steps, data)
        .then(function (data) {
            data.log({
                level: "info",
                message: "Process finished successfully."
            });
            return data.callback();
        })
        .catch(function (err) {
            data.log({
                level: "error",
                message: "Step returned error: " + err.message,
                error: err,
                stack: err.stack
            });
            return data.callback(new Error("Error: Step returned error."));
        });
};

Promise.series = function (promises, initValue) {
    return promises.reduce(function (chain, promise) {
        if (typeof promise !== 'function') {
            return chain.then(() => {
                throw new Error("Error: Invalid promise item: " + promise);
            });
        }
        return chain.then(promise);
    }, Promise.resolve(initValue));
};

`;
const getIndexJS = ({
  fromEmail,
  bucketName,
  forwardMapping,
}: {
  fromEmail: string;
  bucketName: string;
  forwardMapping: Record<string, string[]>;
}) => `
  var LambdaForwarder = require("./forwarder");
  
  exports.handler = function (event, context, callback) {
      var config = {
          fromEmail: "${fromEmail}",
          subjectPrefix: "",
          emailBucket: "${bucketName}",
          emailKeyPrefix: "emails/",
          allowPlusSign: true,
          forwardMapping: ${JSON.stringify(forwardMapping)}
      };
      LambdaForwarder.handler(event, context, callback, { config });
  };
  `;

type EmailForwarderConfig = {
  fromEmail: string;
  recipients: string[];
  forwardMapping: Record<string, string[]>;
};

export class EmailForwarder extends pulumi.ComponentResource {
  public bucket: aws.s3.Bucket;
  public function: aws.lambda.Function;

  constructor(name: string, args: EmailForwarderConfig, opts?: pulumi.ComponentResourceOptions) {
    // By calling super(), we ensure any instantiation of this class
    // inherits from the ComponentResource class so we don't have to
    // declare all the same things all over again.
    super("pkg:index:EmailForwarder", name, args, opts);

    this.bucket = new aws.s3.Bucket(name + "Storage", { forceDestroy: true, versioning: { enabled: true } }, { parent: this });

    const lambdaRole = new aws.iam.Role(
      name + "LambdaSesForwarder",
      {
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
      },
      { parent: this }
    );
    const lambdaCustomPolicy = new aws.iam.Policy(
      name + "LambdaSesForwarderPolicy",
      {
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
              // Todo allow access to only the one bucket
              Resource: "*",
            },
          ],
        }),
      },
      { parent: this }
    );
    new aws.iam.RolePolicyAttachment(
      name + "LambdaSesForwarderPolicyAttachment",
      {
        role: lambdaRole,
        policyArn: lambdaCustomPolicy.arn,
      },
      { parent: this }
    );
    new aws.iam.RolePolicyAttachment(
      name + "LambdaBasicExecutionRoleAttachment",
      {
        role: lambdaRole,
        policyArn: aws.iam.ManagedPolicy.AWSLambdaBasicExecutionRole,
      },
      { parent: this }
    );

    this.function = new aws.lambda.Function(
      name + "SesForwarderLambda",
      {
        runtime: "nodejs16.x",
        code: new pulumi.asset.AssetArchive({
          // Todo correct path
          "index.js": this.bucket.bucket.apply(
            (bucketName) =>
              new pulumi.asset.StringAsset(
                getIndexJS({
                  bucketName,
                  fromEmail: args.fromEmail,
                  forwardMapping: args.forwardMapping,
                })
              )
          ),
          "forwarder.js": new pulumi.asset.StringAsset(FORWARDER_JS),
        }),
        timeout: 10,
        handler: "index.handler",
        role: lambdaRole.arn,
        environment: { variables: {} },
      },
      { parent: this }
    );

    new aws.lambda.Permission(
      name + "SESLambdaInvokePermission",
      {
        action: "lambda:InvokeFunction",
        function: this.function.name,
        principal: "ses.amazonaws.com",
        sourceAccount: pulumi.output(aws.getCallerIdentity({})).apply((id) => id.accountId),
      },
      { parent: this }
    );

    const ruleSet = new aws.ses.ReceiptRuleSet(name + "MainRuleSet", { ruleSetName: "main" }, { parent: this });

    new aws.ses.ReceiptRule(
      name + "Rule",
      {
        ruleSetName: ruleSet.ruleSetName,
        enabled: true,
        recipients: args.recipients,
        s3Actions: [
          {
            position: 1,
            bucketName: this.bucket.bucket,
            objectKeyPrefix: "emails/",
          },
        ],
        lambdaActions: [
          {
            position: 2,
            functionArn: this.function.arn,
          },
        ],
      },
      { parent: this }
    );
    new aws.ses.ActiveReceiptRuleSet(
      name + "ActiveMainRuleSet",
      {
        ruleSetName: ruleSet.ruleSetName,
      },
      { parent: this }
    );

    aws.getCallerIdentity({}).then(({ accountId }) => {
      new aws.s3.BucketPolicy(
        name + "BucketPolicy",
        {
          bucket: this.bucket.bucket,
          policy: this.bucket.bucket.apply((bucketName) =>
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
        },
        { parent: this }
      );

      this.registerOutputs({
        bucketName: this.bucket.id,
        functionName: this.function.name,
      });
    });
  }
}
