import * as cdk from "aws-cdk-lib";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";
import { applyStandardTags } from "./shared/tagging";

interface WafStackProps extends cdk.StackProps {
  amplifyAppArn: string;
}

/**
 * WafStack creates a CloudFront-scoped WAF Web ACL and associates it with Amplify
 * MUST be deployed to us-east-1 region for CloudFront compatibility
 */
export class WafStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WafStackProps) {
    super(scope, id, props);
    applyStandardTags(this, "WAF");

    // Create CloudFront WAF Web ACL
    const webAcl = new wafv2.CfnWebACL(this, `${id}-cloudfront-waf`, {
      description: "WAF for Amplify CloudFront distribution protection",
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "CloudFront-WAF",
      },
      rules: [
        {
          // AWS managed rule set for common web exploits
          name: "AWS-AWSManagedRulesCommonRuleSet",
          priority: 1,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesCommonRuleSet-CloudFront",
          },
        },
        {
          // Rate limiting rule to prevent DDoS attacks
          name: "LimitRequests1000",
          priority: 2,
          action: {
            block: {}, // Block requests exceeding limit
          },
          statement: {
            rateBasedStatement: {
              limit: 1000, // 1000 requests per 5 minutes per IP
              aggregateKeyType: "IP",
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "LimitRequests1000-CloudFront",
          },
        },
        {
          // SQL injection protection for request parameters, body, and headers
          name: "AWS-AWSManagedRulesSQLiRuleSet",
          priority: 3,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesSQLiRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesSQLiRuleSet-CloudFront",
          },
        },
        {
          // Blocks request patterns known to be invalid or associated with exploits
          name: "AWS-AWSManagedRulesKnownBadInputsRuleSet",
          priority: 4,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesKnownBadInputsRuleSet",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesKnownBadInputsRuleSet-CloudFront",
          },
        },
        {
          // Blocks sources on the Amazon threat-intelligence IP reputation list
          name: "AWS-AWSManagedRulesAmazonIpReputationList",
          priority: 5,
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesAmazonIpReputationList",
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesAmazonIpReputationList-CloudFront",
          },
        },
      ],
    });

    // Associate WAF with Amplify app
    new wafv2.CfnWebACLAssociation(this, `${id}-WebACLAssociation`, {
      resourceArn: props.amplifyAppArn,
      webAclArn: webAcl.attrArn,
    });

    // WAF logging for incident response and false-positive analysis
    const wafLogGroup = new logs.LogGroup(this, `${id}-WafCfLogGroup`, {
      logGroupName: `aws-waf-logs-${id}-cloudfront`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new wafv2.CfnLoggingConfiguration(this, `${id}-WafCfLogging`, {
      resourceArn: webAcl.attrArn,
      logDestinationConfigs: [
        // WAF requires the ARN without :* suffix, but CDK log group ARN includes it
        cdk.Stack.of(this).formatArn({
          service: 'logs',
          resource: 'log-group',
          resourceName: wafLogGroup.logGroupName,
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        }),
      ],
      // Keep bearer tokens out of request logs
      redactedFields: [{ singleHeader: { Name: "authorization" } }],
    });

    // Export WAF ARN for reference
    new cdk.CfnOutput(this, "WebAclArn", {
      value: webAcl.attrArn,
      description: "ARN of the CloudFront WAF Web ACL",
      exportName: `${id}-WebAclArn`,
    });
  }
}
