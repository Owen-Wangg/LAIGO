# Dependency Management Guide

## Overview

This document explains how dependencies are locked and managed across Lambda functions and Lambda layers in this project to ensure reproducible builds and security.

## Lambda Functions with Locked Dependencies

The following Lambda functions have their Python dependencies locked using `uv`:

| Lambda Function         | Location                            | Lock File          |
| ----------------------- | ----------------------------------- | ------------------ |
| `text_generation`       | `cdk/lambda/text_generation/`       | `requirements.txt` |
| `playground_generation` | `cdk/lambda/playground_generation/` | `requirements.txt` |

## Lambda Layers with Locked Dependencies

The following Lambda layers have locked dependencies. Each layer is deployed as a **pre-built zip file** stored in `cdk/layers/`. CDK reads the zip directly — no Docker-based bundling is performed at deploy time.

| Layer Name        | Source Directory              | Zip File                         | Language | Lock File           |
| ----------------- | ----------------------------- | -------------------------------- | -------- | ------------------- |
| `psycopg3`        | `cdk/layers/psycopg3/`        | `cdk/layers/psycopg3-layer.zip`  | Python   | `requirements.txt`  |
| `aws-jwt-verify`  | `cdk/layers/aws-jwt-verify/`  | `cdk/layers/aws-jwt-verify.zip`  | Node.js  | `package-lock.json` |
| `postgres`        | `cdk/layers/postgres/`        | `cdk/layers/postgres.zip`        | Node.js  | `package-lock.json` |
| `node-pg-migrate` | `cdk/layers/node-pg-migrate/` | `cdk/layers/node-pg-migrate.zip` | Node.js  | `package-lock.json` |

> **Important:** When you update a layer's dependencies, you must rebuild and re-zip the layer before running `cdk deploy`. The zip file is what gets uploaded to AWS.

`cdk/layers/bedrock_client/` is a first-party Python package (Bedrock client factory and prompt-input sanitizer) with no third-party dependencies. CDK deploys the folder directly as a layer (no zip), and the `text_generation` and `playground_generation` Dockerfiles copy it into their images. Changes to it are picked up by the next `cdk deploy` and, for the Docker functions, by the CI/CD pipeline.

`cdk/layers/psycopg2.zip` is not referenced by any stack.

Dependabot (`.github/dependabot.yml`) opens weekly update PRs for the npm projects (`frontend`, `cdk`, and the three Node.js layers) and the pip projects (`text_generation`, `playground_generation`, and the `psycopg3` layer). Minor and patch bumps are grouped into one PR per ecosystem.

## How Dependencies Were Locked

### 1. Requirements Structure

Python Lambda functions and Python layers use a two-file approach:

- `requirements.in` - Contains high-level dependencies (what we directly need)
- `requirements.txt` - Contains all dependencies with exact versions (generated from `requirements.in`)

Node.js layers use:

- `package.json` - Declares direct dependencies
- `package-lock.json` - Locks the full dependency tree with exact versions

### 2. Locking Process

Python dependencies are locked using `uv pip compile`.

Steps:

```bash
# From the repository root, compile a Lambda requirements lock file
uv pip compile cdk/lambda/text_generation/requirements.in \
  -o cdk/lambda/text_generation/requirements.txt

# Compile another Lambda requirements lock file
uv pip compile cdk/lambda/playground_generation/requirements.in \
  -o cdk/lambda/playground_generation/requirements.txt

# Compile the Python layer lock file (run inside the layer folder)
cd cdk/layers/psycopg3
uv pip compile requirements.in -o requirements.txt
```

For Node.js layers, lock files are generated/updated by npm:

```bash
# Example for a Node.js layer
cd cdk/layers/postgres
npm install
```

This updates `package-lock.json` to lock all transitive dependencies.

### 3. Building Layer Zip Files

After updating a layer's lock file, you must rebuild the zip so CDK can deploy the updated layer.

#### Node.js Layers

Lambda layers for Node.js must contain a `nodejs/node_modules/` directory structure inside the zip. Run the following from the repository root, replacing `<layer-name>` and `<zip-name>` as appropriate:

| Layer | `<layer-name>` | `<zip-name>` |
| --- | --- | --- |
| aws-jwt-verify | `aws-jwt-verify` | `aws-jwt-verify` |
| postgres | `postgres` | `postgres` |
| node-pg-migrate | `node-pg-migrate` | `node-pg-migrate` |

```bash
cd cdk/layers/<layer-name>
npm install
mkdir -p /tmp/<layer-name>-build/nodejs
cp -r node_modules /tmp/<layer-name>-build/nodejs/
cd /tmp/<layer-name>-build
zip -r /path/to/repo/cdk/layers/<zip-name>.zip nodejs/
```

No Docker is required for Node.js layers.

#### Python Layer — `psycopg3` (Requires Docker)

`psycopg3` includes binary C extensions (`psycopg-binary`) that must be compiled for the Lambda Linux environment. Docker is required to produce a compatible build.

With Docker Desktop running, execute:

```bash
docker run --rm \
  -v "$(pwd)/cdk/layers/psycopg3":/var/task \
  -v "$(pwd)/cdk/layers":/output \
  public.ecr.aws/lambda/python:3.12 \
  bash -c "pip install -r /var/task/requirements.txt -t /tmp/python && \
           cd /tmp && zip -r /output/psycopg3-layer.zip python/"
```

This produces `cdk/layers/psycopg3-layer.zip` compiled for the Amazon Linux 2023 runtime used by Lambda Python 3.12.

### 4. Key Locked Dependencies

These versions are a snapshot; the lock files are the source of truth.

**Python (LLM Lambda Functions):**

```
langchain==1.4.6
langchain-aws==1.9.0
langchain-classic==1.0.8
langchain-community==0.4.2
langchain-core==1.6.12 (text_generation)
langchain-core==1.6.10 (playground_generation)
langgraph==1.2.16
```

**Python (Database Connectivity):**

(`psycopg` and `psycopg-binary` are used in Lambda functions; `psycopg-pool` is locked in the `psycopg3` layer.)

```
psycopg==3.3.6
psycopg-binary==3.3.6
psycopg-pool==3.3.3
```

**Python (AWS Services):**

```
boto3==1.43.114
botocore==1.43.116
```

**Node.js Layers:**

```
aws-jwt-verify==5.2.1
postgres==3.4.9
node-pg-migrate==9.0.0
pg==8.23.1
```

## How to Modify Dependencies

### Adding New Dependencies

1. **Add to dependency source file:**

   - Python Lambda/Layer: add package to `requirements.in`
   - Node.js Layer: add package to `package.json` (or use `npm install <package>`)

2. **Regenerate lock file:**
   In the terminal run the following commands depending on target:

   ```bash
   # Python Lambda (example)
   uv pip compile cdk/lambda/text_generation/requirements.in \
     -o cdk/lambda/text_generation/requirements.txt

   # Python Layer (example)
   cd cdk/layers/psycopg3
   uv pip compile requirements.in -o requirements.txt

   # Node.js Layer (example)
   cd cdk/layers/node-pg-migrate
   npm install
   ```

3. **Commit and Push Changes:**
   After regenerating lock files, commit and push the updated files to trigger the deployment pipeline.

   - For Python Dockerized Lambda functions (for example `text_generation` and `playground_generation`), commit + push is sufficient. The CI/CD pipeline rebuilds and redeploys those functions.

   - For Lambda layers, after updating dependencies/lock files, rebuild the layer zip (see [Building Layer Zip Files](#3-building-layer-zip-files); only the `psycopg3` build needs Docker) and run:

     ```bash
     cd cdk
     npx cdk deploy --all \
       --context StackPrefix=<YOUR-STACK-PREFIX> \
       --context Environment=<dev|test|prod> \
       --context GithubRepo=<YOUR-GITHUB-REPO> \
       --profile <YOUR-PROFILE-NAME>
     ```

     Pass the same context values you used for the original deployment (including `DomainName` or `FrontendOrigin` for `prod`). This updates the layer assets in AWS.

   - **Option 1: Using Git in the Terminal**

     ```bash
     # Stage updated dependency files
     git add requirements.in requirements.txt package.json package-lock.json

     # Commit with a descriptive message
     git commit -m "Update Lambda/Lambda layer dependencies"

     # Push to your working branch (e.g., main or dev)
     git push origin <branch-name>
     ```

   - **Option 2: Using Git in Your IDE (e.g., VS Code)**

     1. Go to the Source Control tab.

     2. You’ll see updated dependency files under Changes.

     3. Write a commit message (e.g., “Update Lambda dependencies”).

     4. Click ✓ Commit.

     5. Click the … menu or right-click → Push to send your changes to the remote repository.

Once the push is complete, CodePipeline will automatically detect and redeploy affected Python Dockerized Lambda functions. Layer updates are applied when you run `cdk deploy`.

### Updating Existing Dependencies

1. **Use upgrade commands (recommended):**

   ```bash
   # Python: upgrade one package and regenerate lock file
   uv pip compile cdk/lambda/text_generation/requirements.in \
     -o cdk/lambda/text_generation/requirements.txt \
     --upgrade-package langchain

   # Python: upgrade all packages in a lock file
   uv pip compile cdk/lambda/playground_generation/requirements.in \
     -o cdk/lambda/playground_generation/requirements.txt \
     --upgrade

   # Node.js layer: upgrade according to package.json ranges
   cd cdk/layers/postgres
   npm update

   # Node.js layer: force latest major for a specific package
   npm install postgres@latest
   ```

2. **Manual pinning (optional):**

   If you need an exact version, update the source dependency file directly:

   - Python: pin in `requirements.in`, then run `uv pip compile ...`
   - Node.js: pin in `package.json` (or run `npm install <package>@<version>`)

3. **Rebuild the layer zip** (Lambda layers only — see [Building Layer Zip Files](#3-building-layer-zip-files) for the exact commands):

   - **Node.js layers**: run `npm install` in the layer directory, then re-zip into `cdk/layers/<name>.zip` with the `nodejs/node_modules/` structure. No Docker required.
   - **`psycopg3` layer**: run the Docker build command to produce a Linux-compatible `cdk/layers/psycopg3-layer.zip`. Docker Desktop must be running.

4. **Deploy and push:**

   Run `cdk deploy` to publish the updated zip as a new layer version:

   ```bash
   cd cdk
   npx cdk deploy --all \
     --context StackPrefix=<YOUR-STACK-PREFIX> \
     --context Environment=<dev|test|prod> \
     --context GithubRepo=<YOUR-GITHUB-REPO> \
     --profile <YOUR-PROFILE-NAME>
   ```

   Use the same context values as your original deployment. Then commit and push the updated lock files and zip file to keep the repository in sync.
