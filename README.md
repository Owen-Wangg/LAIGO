# LAIGO — Legal AI Guide and Organizer

This prototype explores how Large Language Models (LLMs) can enhance legal workflows by enabling intelligent case analysis, real-time transcription, and contextual feedback. By integrating AI into the legal process, it supports more efficient decision-making, improves accessibility to complex information, and fosters a deeper understanding of legal content through personalized, adaptive assistance.

| Index                                               | Description                                             |
| :-------------------------------------------------- | :------------------------------------------------------ |
| [High Level Architecture](#high-level-architecture) | High level overview illustrating component interactions |
| [Deployment](#deployment-guide)                     | How to deploy the project                               |
| [User Guide](#user-guide)                           | The working solution                                    |
| [Directories](#directories)                         | General project directory structure                     |
| [API Documentation](#api-documentation)             | Documentation on the API the project uses               |
| [Credits](#credits)                                 | Meet the team behind the solution                       |
| [License](#license)                                 | License details                                         |
| [User Removal](#user-removal)                       | How to completely remove a user from the platform       |

## High-Level Architecture

The following architecture diagram illustrates the various AWS components utilized to deliver the solution. For an in-depth explanation of the frontend and backend stacks, please look at the [Architecture Guide](docs/architectureDeepDive.md).

![Architecture Diagram](./docs/media/architecture.png)

## Deployment Guide

To deploy this solution, please follow the steps laid out in the [Deployment Guide](./docs/deploymentGuide.md)

## User Guide

Please refer to the [Web App User Guide](./docs/userGuide.md) for instructions on navigating the web app interface.

## Directories

```
├── cdk/
│   ├── bin/                        # CDK app entry point
│   ├── lambda/                     # Lambda function source code
│   │   ├── assess_progress/        # Progress assessment (Python)
│   │   ├── audioToText/            # Audio transcription (Python)
│   │   ├── authorization/          # Cognito triggers and authorizers (Node.js)
│   │   ├── case_generation/        # AI case title generation (Python)
│   │   ├── db_setup/               # Database initialization and migrations (Node.js)
│   │   ├── generatePreSignedURL/   # S3 presigned URL generation (Python)
│   │   ├── handlers/               # REST API handlers — admin, instructor, student (Node.js)
│   │   ├── notificationService/    # EventBridge notification delivery (Node.js)
│   │   ├── playground_generation/  # Prompt playground testing (Python)
│   │   ├── summary_generation/     # Legal summary generation (Python)
│   │   ├── text_generation/        # Interview assistant chat (Python)
│   │   └── websocket/              # WebSocket connect, disconnect, default route (Node.js)
│   ├── layers/                     # Lambda layers (Node.js and Python dependencies)
│   ├── lib/                        # CDK stack definitions
│   │   ├── api-stack.ts            # API Gateway, Cognito, Lambda functions, Bedrock guardrails
│   │   ├── database-stack.ts       # RDS PostgreSQL, RDS Proxy
│   │   ├── dbFlow-stack.ts         # Database initialization trigger
│   │   ├── vpc-stack.ts            # VPC and networking
│   │   ├── amplify-stack.ts        # Frontend hosting
│   │   ├── cicd-stack.ts           # CI/CD pipeline
│   │   └── waf-stack.ts            # WAF configuration
│   ├── test/                       # CDK tests
│   └── OpenAPI_Swagger_Definition.yaml
│
├── frontend/
│   ├── public/                     # Static assets
│   └── src/
│       ├── components/             # Reusable UI components
│       │   ├── Admin/              # Admin-specific components (prompt editor, playground, model config)
│       │   ├── Case/               # Case components (notepad, feedback)
│       │   ├── Chat/               # Chat interface (chat bar, AI response, user message)
│       │   ├── Help/               # Help and onboarding components
│       │   ├── Notifications/      # Notification system components
│       │   └── Supervisor/         # Supervisor/instructor components
│       ├── contexts/               # React Context providers (user, theme)
│       ├── hooks/                  # Custom React hooks (useWebSocket, etc.)
│       ├── lib/                    # Shared library utilities
│       ├── pages/                  # Page components
│       │   ├── Admin/              # Admin dashboard, AI configuration, settings
│       │   ├── Advocate/           # Student/advocate dashboard and case management
│       │   ├── Case/               # Case detail views (overview, assistant, summaries, transcriptions, feedback)
│       │   ├── Supervisor/         # Instructor dashboard and case oversight
│       │   └── Login.tsx           # Authentication page
│       ├── services/               # API service layer
│       ├── types/                  # TypeScript type definitions
│       └── utils/                  # Utility functions
│
├── docs/
│   ├── llm_interaction/            # LLM interaction documentation
│   ├── media/                      # Screenshots and diagrams
│   ├── api-documentation.md        # REST API documentation
│   ├── architectureDeepDive.md     # Architecture deep dive
│   ├── databaseMigrations.md       # Database migration guide
│   ├── dependencyManagement.md     # Python dependency management
│   ├── deploymentGuide.md          # Deployment instructions
│   ├── modificationGuide.md        # Customization guide
│   ├── securityGuide.md            # Security documentation
│   └── userGuide.md                # End-user guide
```

- `/cdk`: AWS CDK infrastructure code (TypeScript)
  - `/bin`: CDK app entry point and stack orchestration
  - `/lambda`: Lambda function source code (Node.js 22.x and Python 3.11/3.12)
  - `/layers`: Lambda layers for shared dependencies (postgres, psycopg3, aws-jwt-verify)
  - `/lib`: CDK stack definitions for all infrastructure (VPC, database, API, auth, hosting, WAF)
- `/frontend`: React 19 frontend application (TypeScript, Vite, MUI, Tailwind CSS)
  - `/src/components`: Reusable UI components organized by feature area
  - `/src/contexts`: React Context providers for global state
  - `/src/hooks`: Custom hooks including WebSocket management
  - `/src/pages`: Page-level components organized by user role
  - `/src/services`: API service layer for backend communication
  - `/src/types`: Shared TypeScript type definitions
- `/docs`: Project documentation including deployment, architecture, security, and user guides

## API Documentation

REST API documentation: [API Documentation](./docs/api-documentation.md)

LLM interaction details: [LLM Interaction Overview](./docs/llm_interaction/llm_interaction.md)

## Dependency Management

For information on how Python dependencies are locked and managed across Lambda functions, see the [Dependency Management Guide](./docs/dependencyManagement.md).

## Database Migrations

For information on the database migration system, see the [Database Migrations Guide](./docs/databaseMigrations.md).

## Security

For details on the security architecture including WAF, guardrails, authentication, and encryption, see the [Security Guide](./docs/securityGuide.md).

## Modification Guide

Steps to implement optional modifications such as changing the colours of the application can be found
[here](./docs/modificationGuide.md).

## User Removal

To disable or remove a user from the platform (database records, Cognito identity, and DynamoDB data), follow the [User Disable / Removal Guide](./docs/userDisableRemovalGuide.md).

## Credits

This application was architected and developed by Aniket Nemade with project assistance by Thien Lam Nguyen. Thanks to the UBC Cloud Innovation Centre Technical and Project Management teams for their guidance and support.

## License

This project is distributed under the [MIT License](LICENSE).

Licenses of libraries and tools used by the system are listed below:

[PostgreSQL license](https://www.postgresql.org/about/licence/)

- For PostgreSQL and pgvector
- "a liberal Open Source license, similar to the BSD or MIT licenses."

[LLaMa 3 Community License Agreement](https://llama.meta.com/llama3/license/)

- For Llama 3 70B Instruct model

[Anthropic Acceptable Use Policy](https://www.anthropic.com/legal/aup)

- For Claude Sonnet 5.5, accessed via AWS Bedrock
- Usage governed by the [AWS Bedrock Service Terms](https://aws.amazon.com/service-terms/) and Anthropic's Acceptable Use Policy
