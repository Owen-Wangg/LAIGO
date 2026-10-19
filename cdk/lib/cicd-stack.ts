// AWS CDK core imports
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
// AWS service-specific imports for CI/CD pipeline
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as codepipeline_actions from "aws-cdk-lib/aws-codepipeline-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import { applyStandardTags } from "./shared/tagging";

// Configuration interface for Lambda functions in the pipeline
interface LambdaConfig {
  name: string; // Module name used for ECR repository naming
  functionName: string; // Target Lambda function name for deployment
  sourceDir: string; // Source directory containing Dockerfile and code
}

// Stack properties for CI/CD pipeline configuration
interface CICDStackProps extends cdk.StackProps {
  githubRepo: string; // GitHub repository name
  githubBranch?: string; // Branch to monitor (defaults to main)
  environmentName?: string; // Environment name for tagging (defaults to dev)
  lambdaFunctions: LambdaConfig[]; // List of Lambda functions to build
  pathFilters?: string[]; // Path filters for triggering builds
}

/**
 * CICDStack creates a CI/CD pipeline for building and deploying Docker-based Lambda functions
 * Monitors GitHub repository changes and builds/deploys affected Lambda functions
 */
export class CICDStack extends cdk.Stack {
  // Map of ECR repositories created for each Lambda function
  public readonly ecrRepositories: { [key: string]: ecr.Repository } = {};

  constructor(scope: Construct, id: string, props: CICDStackProps) {
    super(scope, id, props);
    applyStandardTags(this, "CICD");

    // Set default environment name if not provided
    const envName = props.environmentName ?? "dev";

    // Create shared IAM role for all CodeBuild projects with necessary permissions
    const codeBuildRole = new iam.Role(this, "DockerBuildRole", {
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
    });

    // Grant ECR permissions for pushing/pulling Docker images
    codeBuildRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonEC2ContainerRegistryPowerUser",
      ),
    );

    // Grant Lambda permissions for updating function code and configuration
    codeBuildRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "lambda:GetFunction", // Read function configuration
          "lambda:UpdateFunctionCode", // Deploy new Docker images
          "lambda:UpdateFunctionConfiguration", // Update function settings
        ],
        resources: [
          // Specific Lambda function ARNs that can be updated (Docker-based functions only)
          `arn:aws:lambda:${this.region}:${this.account}:function:*-TextGenLambdaDockerFunction`,
          `arn:aws:lambda:${this.region}:${this.account}:function:*-PlaygroundTextGenLambdaDockerFunction`,
        ],
      }),
    );

    // Create pipeline artifact to pass source code between stages
    const sourceOutput = new codepipeline.Artifact();

    // Create the main CI/CD pipeline for Docker image builds
    const pipeline = new codepipeline.Pipeline(this, "DockerImagePipeline", {
      pipelineName: `${id}-DockerImagePipeline`,
    });

    // Retrieve GitHub username from SSM Parameter Store
    const username = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      "laigo-owner-name",
    );

    // Add source stage to pull code from GitHub repository
    pipeline.addStage({
      stageName: "Source",
      actions: [
        new codepipeline_actions.GitHubSourceAction({
          actionName: "GitHub",
          owner: username, // GitHub repository owner
          repo: props.githubRepo, // Repository name
          branch: props.githubBranch ?? "main", // Branch to monitor
          oauthToken: cdk.SecretValue.secretsManager(
            "github-personal-access-token", // GitHub token stored in Secrets Manager
            {
              jsonField: "my-github-token",
            },
          ),
          output: sourceOutput, // Output artifact for next stage
          trigger: codepipeline_actions.GitHubTrigger.WEBHOOK, // Trigger on push events
          // Optional path filters to trigger builds only for specific directories
          ...(props.pathFilters
            ? {
                filter: {
                  json: JSON.stringify({
                    push: {
                      paths: {
                        includes: props.pathFilters,
                      },
                    },
                  }),
                },
              }
            : {}),
        }),
      ],
    });

    // Create build actions for each Lambda function configuration
    const buildActions: codepipeline_actions.CodeBuildAction[] = [];

    props.lambdaFunctions.forEach((lambda) => {
      // Create ECR repository for each Lambda function's Docker images
      const repoName = `${id.toLowerCase()}-${lambda.name.toLowerCase()}`;
      const ecrRepo = new ecr.Repository(this, `${lambda.name}Repo`, {
        repositoryName: repoName,
        imageTagMutability: ecr.TagMutability.IMMUTABLE, // Prevent overwriting pushed image tags
        removalPolicy: cdk.RemovalPolicy.RETAIN, // Keep repository when stack is deleted
        imageScanOnPush: true, // Enable vulnerability scanning
      });

      // Grant Lambda service permission to pull images from ECR repository
      ecrRepo.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: "LambdaPullAccess",
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal("lambda.amazonaws.com")],
          actions: [
            "ecr:GetDownloadUrlForLayer", // Download image layers
            "ecr:BatchGetImage", // Get image manifest
            "ecr:BatchCheckLayerAvailability", // Check layer availability
          ],
          conditions: {
            StringEquals: {
              "aws:SourceAccount": this.account, // Restrict to same AWS account
            },
          },
        }),
      );

      // Store repository reference and add resource-specific tags
      this.ecrRepositories[lambda.name] = ecrRepo;
      cdk.Tags.of(ecrRepo).add("module", lambda.name); // Resource-specific tag (not part of global standard set)

      // Create CodeBuild project for building Docker images
      const buildProject = new codebuild.PipelineProject(
        this,
        `${lambda.name}BuildProject`,
        {
          projectName: `${id}-${lambda.name}Builder`,
          role: codeBuildRole, // Use shared IAM role
          environment: {
            buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, // Ubuntu-based build environment
            privileged: true, // Required for Docker builds
          },
          // Environment variables available during build process
          environmentVariables: {
            AWS_ACCOUNT_ID: { value: this.account }, // Current AWS account ID
            AWS_REGION: { value: this.region }, // Current AWS region
            ENVIRONMENT: { value: envName }, // Environment name for tagging
            MODULE_NAME: { value: lambda.name }, // Lambda module name
            LAMBDA_FUNCTION_NAME: { value: lambda.functionName }, // Target Lambda function
            REPO_NAME: { value: repoName }, // ECR repository name
            REPOSITORY_URI: { value: ecrRepo.repositoryUri }, // Full ECR repository URI
            GITHUB_USERNAME: { value: username }, // GitHub repository owner
            GITHUB_REPO: { value: props.githubRepo }, // GitHub repository name
            GITHUB_TOKEN: {
              type: codebuild.BuildEnvironmentVariableType.SECRETS_MANAGER,
              value: "github-personal-access-token:my-github-token", // GitHub access token
            },
            PATH_FILTER: { value: lambda.sourceDir }, // Directory to monitor for changes
            BLOCKING_SEVERITIES: { value: "CRITICAL HIGH" }, // Finding severities that block deployment
            SCAN_TIMEOUT_SECONDS: { value: "300" }, // Max time to wait for scan completion
          },
          // Build specification defining the build process
          buildSpec: codebuild.BuildSpec.fromObject({
            version: "0.2",
            phases: {
              pre_build: {
                commands: [
                  // Authenticate with ECR
                  "echo Logging in to Amazon ECR...",
                  "aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com",
                  // Create script to check if build is needed based on file changes
                  'echo "#!/bin/bash" > check_and_build.sh',
                  'echo "set -e" >> check_and_build.sh',
                  "echo 'git clone https://$GITHUB_TOKEN@github.com/$GITHUB_USERNAME/$GITHUB_REPO.git repo' >> check_and_build.sh",
                  'echo "cd repo" >> check_and_build.sh',
                  'echo "git fetch origin" >> check_and_build.sh',
                  'echo "git checkout $CODEBUILD_RESOLVED_SOURCE_VERSION" >> check_and_build.sh',
                  // Skip path checking for first deployment
                  'echo "# Check if image exists in ECR" >> check_and_build.sh',
                  'echo "if ! aws ecr describe-images --repository-name $REPO_NAME --image-ids imageTag=latest &>/dev/null; then" >> check_and_build.sh',
                  'echo "  echo \\"First deployment or image doesn\'t exist - building without path check\\"" >> check_and_build.sh',
                  'echo "  exit 0" >> check_and_build.sh',
                  'echo "fi" >> check_and_build.sh',
                  // Check for changes in specific path
                  'echo "PREV_COMMIT=\\$(git rev-parse HEAD~1 || echo \\"\\")" >> check_and_build.sh',
                  'echo "CHANGED_FILES=\\$(git diff --name-only \\$PREV_COMMIT HEAD)" >> check_and_build.sh',
                  'echo "echo \\"Changed files:\\"" >> check_and_build.sh',
                  'echo "echo \\"\\$CHANGED_FILES\\"" >> check_and_build.sh',
                  'echo "if ! echo \\"\\$CHANGED_FILES\\" | grep -q \\"^$PATH_FILTER/\\"; then" >> check_and_build.sh',
                  'echo "  echo \\"No changes in $PATH_FILTER — skipping build.\\"" >> check_and_build.sh',
                  'echo "  exit 1" >> check_and_build.sh',
                  'echo "fi" >> check_and_build.sh',
                  'echo "exit 0" >> check_and_build.sh',
                  "chmod +x check_and_build.sh",
                  // Generate unique image tag based on commit hash
                  "COMMIT_HASH=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)",
                  "IMAGE_TAG=${MODULE_NAME}-${ENVIRONMENT}-${COMMIT_HASH}",
                  "export DOCKER_HOST=unix:///var/run/docker.sock",
                  // Execute the change detection script
                  './check_and_build.sh || { echo "Skipping build due to no changes"; exit 1; }',
                ],
              },
              build: {
                commands: [
                  // Build Docker image from the specified source directory
                  'echo "Building Docker image..."',
                  `docker build --platform linux/amd64 --provenance=false --sbom=false -t $REPOSITORY_URI:$IMAGE_TAG $CODEBUILD_SRC_DIR -f $CODEBUILD_SRC_DIR/${lambda.sourceDir}/Dockerfile`,
                ],
              },
              post_build: {
                commands: [
                  // Push the immutable, commit-scoped tag only
                  "docker push $REPOSITORY_URI:$IMAGE_TAG",
                  // Fail-closed vulnerability gate: wait for the scan to complete,
                  // then block on any configured severity. Any CLI error, scan
                  // failure, or timeout stops the deployment.
                  `bash -c '
                    set -euo pipefail
                    echo "Waiting for vulnerability scan to complete (timeout: $SCAN_TIMEOUT_SECONDS s)..."
                    INTERVAL=10
                    ELAPSED=0
                    STATUS=""
                    while true; do
                      # Right after a push ECR briefly returns ScanNotFoundException
                      # before the scan is registered. Tolerate any describe error
                      # here (treat as not-ready) and keep polling until COMPLETE,
                      # FAILED, or the timeout below; do not let set -e abort.
                      STATUS=$(aws ecr describe-image-scan-findings \
                        --repository-name $REPO_NAME \
                        --image-id imageTag=$IMAGE_TAG \
                        --query "imageScanStatus.status" \
                        --output text 2>/dev/null) || STATUS="PENDING"
                      echo "Scan status: $STATUS"
                      if [ "$STATUS" = "COMPLETE" ]; then
                        break
                      fi
                      if [ "$STATUS" = "FAILED" ]; then
                        echo "Vulnerability scan FAILED. Blocking deployment."
                        exit 1
                      fi
                      if [ "$ELAPSED" -ge "$SCAN_TIMEOUT_SECONDS" ]; then
                        echo "Timed out waiting for scan to complete (last status: $STATUS). Blocking deployment."
                        exit 1
                      fi
                      sleep $INTERVAL
                      ELAPSED=$((ELAPSED + INTERVAL))
                    done
                    for SEV in $BLOCKING_SEVERITIES; do
                      COUNT=$(aws ecr describe-image-scan-findings \
                        --repository-name $REPO_NAME \
                        --image-id imageTag=$IMAGE_TAG \
                        --query "imageScanFindingsSummary.findingCounts.$SEV" \
                        --output text)
                      if [ "$COUNT" = "None" ]; then
                        COUNT=0
                      fi
                      echo "Severity $SEV findings: $COUNT"
                      if [ "$COUNT" -gt 0 ]; then
                        echo "$SEV vulnerabilities found: $COUNT. Blocking deployment."
                        exit 1
                      fi
                    done
                    echo "No blocking vulnerabilities found. Proceeding with deployment."
                  '`,
                  // Resolve the exact digest of the scanned image so the deployed
                  // artifact is pinned to the one that passed the gate.
                  `bash -c '
                    set -euo pipefail
                    IMAGE_DIGEST=$(aws ecr describe-images \
                      --repository-name $REPO_NAME \
                      --image-ids imageTag=$IMAGE_TAG \
                      --query "imageDetails[0].imageDigest" \
                      --output text)
                    if [ -z "$IMAGE_DIGEST" ] || [ "$IMAGE_DIGEST" = "None" ]; then
                      echo "Could not resolve image digest. Blocking deployment."
                      exit 1
                    fi
                    echo "Resolved image digest: $IMAGE_DIGEST"
                    echo "Checking if Lambda function exists before updating..."
                    if aws lambda get-function --function-name $LAMBDA_FUNCTION_NAME &>/dev/null; then
                      echo "Updating Lambda function to use the scanned image digest..."
                      aws lambda update-function-code \
                        --function-name $LAMBDA_FUNCTION_NAME \
                        --image-uri $REPOSITORY_URI@$IMAGE_DIGEST
                    else
                      echo "Lambda function $LAMBDA_FUNCTION_NAME does not exist yet. Skipping update."
                    fi
                  '`,
                  // Seed a one-time bootstrap tag used only for CDK cold-create.
                  // Never overwrite an existing bootstrap tag (immutable-safe).
                  `bash -c '
                    set -euo pipefail
                    if aws ecr describe-images --repository-name $REPO_NAME --image-ids imageTag=bootstrap &>/dev/null; then
                      echo "Bootstrap tag already present. Skipping seed."
                    else
                      echo "Seeding bootstrap tag..."
                      docker tag $REPOSITORY_URI:$IMAGE_TAG $REPOSITORY_URI:bootstrap
                      docker push $REPOSITORY_URI:bootstrap
                    fi
                  '`,
                ],
              },
            },
          }),
        },
      );

      // Grant permissions to push to ECR
      ecrRepo.grantPullPush(buildProject);

      // Add build action to the list
      buildActions.push(
        new codepipeline_actions.CodeBuildAction({
          actionName: `Build_${lambda.name}`,
          project: buildProject,
          input: sourceOutput,
        }),
      );
    });

    // Add build stage with all build actions
    pipeline.addStage({
      stageName: "Build",
      actions: buildActions,
    });
  }
}
