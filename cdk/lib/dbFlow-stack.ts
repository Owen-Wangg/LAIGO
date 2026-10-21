import { Stack, StackProps, triggers } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import { VpcStack } from "./vpc-stack";
import { DatabaseStack } from "./database-stack";
import { applyStandardTags } from "./shared/tagging";

export class DBFlowStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    vpcStack: VpcStack,
    db: DatabaseStack,
    props?: StackProps,
  ) {
    super(scope, id, props);
    applyStandardTags(this, "DBFlow");

    // Create IAM role for Lambda within the VPC
    const lambdaRole = new iam.Role(this, `${id}-lambda-vpc-role`, {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "Role for all Lambda functions inside VPC",
    });

    // Grant permissions on specific database secrets
    db.secretPathAdmin.grantRead(lambdaRole);
    db.secretPathUser.grantRead(lambdaRole);
    db.secretPathUser.grantWrite(lambdaRole);
    db.secretPathTableCreator.grantRead(lambdaRole);
    db.secretPathTableCreator.grantWrite(lambdaRole);

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          // CloudWatch Logs
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: ["arn:aws:logs:*:*:*"],
      }),
    );

    // VPC Lambda execution permissions (standard AWS pattern)
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "ec2:CreateNetworkInterface",
          "ec2:DescribeNetworkInterfaces",
          "ec2:DeleteNetworkInterface",
          "ec2:AssignPrivateIpAddresses",
          "ec2:UnassignPrivateIpAddresses",
        ],
        resources: ["*"],
      }),
    );

    // Add additional managed policies
    lambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMReadOnlyAccess"),
    );

    // Create a Lambda layer for node-pg-migrate
    const nodePgMigrateLayer = new lambda.LayerVersion(
      this,
      "nodePgMigrateLayer",
      {
        code: lambda.Code.fromAsset("./layers/node-pg-migrate.zip"),
        compatibleRuntimes: [lambda.Runtime.NODEJS_24_X],
        description: "Lambda layer with node-pg-migrate and pg",
      },
    );

    new triggers.TriggerFunction(this, `${id}-triggerLambda`, {
      description: `Database initializer and migration runner - ${new Date().toISOString()}`,
      functionName: `${id}-initializerFunction`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: "index.handler",
      timeout: Duration.seconds(300),
      memorySize: 512,
      environment: {
        DB_SECRET_NAME: db.secretPathAdmin.secretName,
        DB_USER_SECRET_NAME: db.secretPathUser.secretName,
        DB_TABLE_CREATOR_SECRET_NAME: db.secretPathTableCreator.secretName,
        RDS_PROXY_ENDPOINT: db.rdsProxyEndpoint,
        RDS_CA_BUNDLE_PATH: "/var/task/certs/global-bundle.pem",
      },
      vpc: db.dbInstance.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [db.dbClientSecurityGroup],
      code: lambda.Code.fromAsset("lambda/db_setup"),
      layers: [nodePgMigrateLayer],
      role: lambdaRole,
    });
  }
}
