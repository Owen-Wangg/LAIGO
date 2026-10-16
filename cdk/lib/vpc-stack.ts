import { Stack, StackProps } from "aws-cdk-lib";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as logs from "aws-cdk-lib/aws-logs";
import { Fn } from "aws-cdk-lib";
import { applyStandardTags } from "./shared/tagging";

/** Free gateway endpoints for S3 and DynamoDB (no hourly ENI charge). */
function addGatewayEndpoints(vpc: ec2.IVpc, idPrefix: string): void {
  vpc.addGatewayEndpoint(`${idPrefix}-S3GatewayEndpoint`, {
    service: ec2.GatewayVpcEndpointAwsService.S3,
  });

  vpc.addGatewayEndpoint(`${idPrefix}-DynamoDbGatewayEndpoint`, {
    service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
  });
}

export class VpcStack extends Stack {
  public readonly vpc: ec2.Vpc;
  public readonly vpcCidrString: string;
  public readonly privateSubnetsCidrStrings: string[];

  constructor(
    scope: Construct,
    id: string,
    props: StackProps & { stackPrefix: string }
  ) {
    super(scope, id, props);
    applyStandardTags(this, "VPC");

    const existingVpcId: string = ""; // CHANGE IF DEPLOYING WITH EXISTING VPC

    if (existingVpcId !== "") {
      const AWSControlTowerStackSet = ""; // CHANGE TO YOUR CONTROL TOWER STACK SET
      const existingPublicSubnetID: string = ""; // CHANGE IF DEPLOYING WITH EXISTING PUBLIC SUBNET

      const latPrefix = props.stackPrefix;

      // Allow users to specify custom CIDR via CDK context, otherwise use default
      this.vpcCidrString = this.node.tryGetContext('publicSubnetCidr') || "172.31.94.0/20";

      // VPC for application
      this.vpc = ec2.Vpc.fromVpcAttributes(this, `${id}-Vpc`, {
        vpcId: existingVpcId,
        availabilityZones: cdk.Stack.of(this).availabilityZones,
        privateSubnetIds: [
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1AID`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2AID`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3AID`),
        ],
        privateSubnetRouteTableIds: [
          Fn.importValue(
            `${AWSControlTowerStackSet}-PrivateSubnet1ARouteTable`
          ),
          Fn.importValue(
            `${AWSControlTowerStackSet}-PrivateSubnet2ARouteTable`
          ),
          Fn.importValue(
            `${AWSControlTowerStackSet}-PrivateSubnet3ARouteTable`
          ),
        ],
        isolatedSubnetIds: [
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1AID`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2AID`),
          Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3AID`),
        ],
        isolatedSubnetRouteTableIds: [
          Fn.importValue(
            `${AWSControlTowerStackSet}-PrivateSubnet1ARouteTable`
          ),
          Fn.importValue(
            `${AWSControlTowerStackSet}-PrivateSubnet2ARouteTable`
          ),
          Fn.importValue(
            `${AWSControlTowerStackSet}-PrivateSubnet3ARouteTable`
          ),
        ],
        vpcCidrBlock: Fn.importValue(`${AWSControlTowerStackSet}-VPCCIDR`),
      }) as ec2.Vpc;

      // Extract CIDR ranges from the private subnets
      this.privateSubnetsCidrStrings = [
        Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet1ACIDR`),
        Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet2ACIDR`),
        Fn.importValue(`${AWSControlTowerStackSet}-PrivateSubnet3ACIDR`),
      ];

      if (existingPublicSubnetID === "") {
        console.log(
          "No public subnet exists. Creating new public subnet, IGW, and NAT GW."
        );

        // Create a public subnet
        const publicSubnet = new ec2.Subnet(this, `PublicSubnet`, {
          vpcId: this.vpc.vpcId,
          availabilityZone: this.vpc.availabilityZones[0],
          cidrBlock: this.vpcCidrString,
          mapPublicIpOnLaunch: true,
        });

        // Create an Internet Gateway and attach it to the VPC
        const internetGateway = new ec2.CfnInternetGateway(
          this,
          `InternetGateway`,
          {}
        );
        new ec2.CfnVPCGatewayAttachment(this, "VPCGatewayAttachment", {
          vpcId: this.vpc.vpcId,
          internetGatewayId: internetGateway.ref,
        });

        // Add a NAT Gateway in the public subnet
        const natGateway = new ec2.CfnNatGateway(this, `NatGateway`, {
          subnetId: publicSubnet.subnetId,
          allocationId: new ec2.CfnEIP(this, "EIP", {}).attrAllocationId,
        });

        // Use the route table associated with the public subnet
        const publicRouteTableId = publicSubnet.routeTable.routeTableId;

        // Add a route to the Internet Gateway in the existing public route table
        new ec2.CfnRoute(this, `PublicRoute`, {
          routeTableId: publicRouteTableId,
          destinationCidrBlock: "0.0.0.0/0",
          gatewayId: internetGateway.ref,
        });

        // Update route table for private subnets
        new ec2.CfnRoute(this, `${latPrefix}PrivateSubnetRoute1`, {
          routeTableId: this.vpc.privateSubnets[0].routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
        });

        new ec2.CfnRoute(this, `${latPrefix}PrivateSubnetRoute2`, {
          routeTableId: this.vpc.privateSubnets[1].routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
        });

        new ec2.CfnRoute(this, `${latPrefix}PrivateSubnetRoute3`, {
          routeTableId: this.vpc.privateSubnets[2].routeTable.routeTableId,
          destinationCidrBlock: "0.0.0.0/0",
          natGatewayId: natGateway.ref,
        });
      } else {
        console.log(
          `Public subnet already exists. Skipping creation of public resources.`
        );
      }

      // Add interface endpoints for private isolated subnets
      this.vpc.addInterfaceEndpoint("SSM Endpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.SSM,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        privateDnsEnabled: false, // Disable private DNS to avoid conflicts
      });

      this.vpc.addInterfaceEndpoint("Secrets Manager Endpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        privateDnsEnabled: false, // Disable private DNS to avoid conflicts
      });

      this.vpc.addInterfaceEndpoint("RDS Endpoint", {
        service: ec2.InterfaceVpcEndpointAwsService.RDS,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
        privateDnsEnabled: false, // Disable private DNS to avoid conflicts
      });

      addGatewayEndpoints(this.vpc, id);

      // Enhanced VPC Flow Log with custom format and explicit retention
      const flowLogGroupExisting = new logs.LogGroup(this, 'FlowLogGroupExisting', {
        logGroupName: `/vpc/flow-logs/${id}-existing`,
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      this.vpc.addFlowLog(`${id}-vpcFlowLog`, {
        destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroupExisting),
        trafficType: ec2.FlowLogTrafficType.ALL,
        logFormat: [
          ec2.LogFormat.VERSION,
          ec2.LogFormat.ACCOUNT_ID,
          ec2.LogFormat.INTERFACE_ID,
          ec2.LogFormat.SRC_ADDR,
          ec2.LogFormat.DST_ADDR,
          ec2.LogFormat.SRC_PORT,
          ec2.LogFormat.DST_PORT,
          ec2.LogFormat.PROTOCOL,
          ec2.LogFormat.PACKETS,
          ec2.LogFormat.BYTES,
          ec2.LogFormat.START_TIMESTAMP,
          ec2.LogFormat.END_TIMESTAMP,
          ec2.LogFormat.ACTION,
          ec2.LogFormat.LOG_STATUS,
          ec2.LogFormat.VPC_ID,
          ec2.LogFormat.SUBNET_ID,
          ec2.LogFormat.TCP_FLAGS,
          ec2.LogFormat.FLOW_DIRECTION,
        ],
      });
    } else {
      // Allow users to specify custom CIDR via CDK context, otherwise use default
      this.vpcCidrString = this.node.tryGetContext('vpcCidr') || "10.0.0.0/16";

      const natGatewayProvider = ec2.NatProvider.gateway();

      // VPC for application
      this.vpc = new ec2.Vpc(this, "laigo-Vpc", {
        ipAddresses: ec2.IpAddresses.cidr(this.vpcCidrString),
        natGatewayProvider: natGatewayProvider,
        natGateways: 1,
        maxAzs: 2,
        subnetConfiguration: [
          {
            name: "public-subnet-1",
            subnetType: ec2.SubnetType.PUBLIC,
          },
          {
            name: "private-subnet-1",
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
          {
            name: "isolated-subnet-1",
            subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          },
        ],
      });

      // Enhanced VPC Flow Log with custom format and explicit retention
      const flowLogGroup = new logs.LogGroup(this, 'FlowLogGroup', {
        logGroupName: `/vpc/flow-logs/${id}`,
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      this.vpc.addFlowLog("laigo-vpcFlowLog", {
        destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup),
        trafficType: ec2.FlowLogTrafficType.ALL,
        logFormat: [
          ec2.LogFormat.VERSION,
          ec2.LogFormat.ACCOUNT_ID,
          ec2.LogFormat.INTERFACE_ID,
          ec2.LogFormat.SRC_ADDR,
          ec2.LogFormat.DST_ADDR,
          ec2.LogFormat.SRC_PORT,
          ec2.LogFormat.DST_PORT,
          ec2.LogFormat.PROTOCOL,
          ec2.LogFormat.PACKETS,
          ec2.LogFormat.BYTES,
          ec2.LogFormat.START_TIMESTAMP,
          ec2.LogFormat.END_TIMESTAMP,
          ec2.LogFormat.ACTION,
          ec2.LogFormat.LOG_STATUS,
          ec2.LogFormat.VPC_ID,
          ec2.LogFormat.SUBNET_ID,
          ec2.LogFormat.TCP_FLAGS,
          ec2.LogFormat.FLOW_DIRECTION,
        ],
      });

      // Add secrets manager endpoint to VPC
      this.vpc.addInterfaceEndpoint(`${id}-Secrets Manager Endpoint`, {
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      });

      // Add RDS endpoint to VPC
      this.vpc.addInterfaceEndpoint(`${id}-RDS Endpoint`, {
        service: ec2.InterfaceVpcEndpointAwsService.RDS,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      });

      // Add SSM endpoint for the private-with-egress subnets where the Lambdas
      // run so Parameter Store calls stay on the AWS private network instead of
      // traversing the NAT Gateway (removes NAT data-processing cost and latency).
      this.vpc.addInterfaceEndpoint(`${id}-SSM Endpoint Private`, {
        service: ec2.InterfaceVpcEndpointAwsService.SSM,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });

      addGatewayEndpoints(this.vpc, id);
    }
  }
}
