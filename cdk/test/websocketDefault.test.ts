// Verifies the WebSocket dispatcher applies the same role rule as REST to
// generate_summary. The AWS SDK clients and logger are replaced with mocks.
const mockSend = jest.fn().mockResolvedValue({});

jest.mock(
  "@aws-sdk/client-lambda",
  () => ({
    LambdaClient: jest.fn(() => ({ send: mockSend })),
    InvokeCommand: jest.fn((input) => ({ input })),
  }),
  { virtual: true },
);
jest.mock(
  "@aws-sdk/client-apigatewaymanagementapi",
  () => ({
    ApiGatewayManagementApiClient: jest.fn(() => ({ send: mockSend })),
    PostToConnectionCommand: jest.fn(),
    DeleteConnectionCommand: jest.fn(),
  }),
  { virtual: true },
);
jest.mock(
  "@aws-lambda-powertools/logger",
  () => ({
    Logger: jest.fn(() => ({
      addContext: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  }),
  { virtual: true },
);

const { handler } = require("../lambda/websocket/default");

function summaryEvent(roles: string[]) {
  return {
    body: JSON.stringify({
      action: "generate_summary",
      case_id: "case-1",
      sub_route: "full-case",
      requestId: "req-1",
    }),
    requestContext: {
      connectionId: "conn-1",
      domainName: "example.execute-api.amazonaws.com",
      stage: "prod",
      routeKey: "$default",
      authorizer: {
        userId: "user-1",
        roles: JSON.stringify(roles),
      },
    },
  };
}

describe("websocket generate_summary role gate", () => {
  beforeEach(() => {
    mockSend.mockClear();
    process.env.SUMMARY_GEN_FUNCTION_NAME = "summary-fn";
  });

  test("rejects an instructor-only caller without invoking the function", async () => {
    const result = await handler(summaryEvent(["instructor"]), {});
    expect(result.statusCode).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("rejects an admin-only caller", async () => {
    const result = await handler(summaryEvent(["admin"]), {});
    expect(result.statusCode).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("invokes the summary function for a student", async () => {
    const result = await handler(summaryEvent(["student"]), {});
    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test("invokes the summary function for a user with student and instructor roles", async () => {
    const result = await handler(summaryEvent(["student", "instructor"]), {});
    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});