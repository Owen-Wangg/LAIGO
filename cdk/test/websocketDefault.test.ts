// Verifies the WebSocket dispatcher applies the same role rule as REST to
// generate_text, generate_summary and audio_to_text. The AWS SDK clients and logger are replaced with mocks.
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

const studentActions: { action: string; extra: Record<string, unknown> }[] = [
  { action: "generate_text", extra: { case_id: "case-1", sub_route: "full-case", message_content: "hi" } },
  { action: "generate_summary", extra: { case_id: "case-1", sub_route: "full-case" } },
  { action: "audio_to_text", extra: { audio_file_id: "a-1", file_name: "a.wav", file_type: "wav", case_title: "t", case_id: "case-1" } },
];

function actionEvent(action: string, extra: Record<string, unknown>, roles: string[]) {
  return {
    body: JSON.stringify({ action, requestId: "req-1", ...extra }),
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

describe.each(studentActions)("websocket $action role gate", ({ action, extra }) => {
  beforeEach(() => {
    mockSend.mockClear();
    process.env.TEXT_GEN_FUNCTION_NAME = "text-fn";
    process.env.SUMMARY_GEN_FUNCTION_NAME = "summary-fn";
    process.env.AUDIO_TO_TEXT_FUNCTION_NAME = "audio-fn";
  });

  test("rejects an instructor-only caller without invoking the function", async () => {
    const result = await handler(actionEvent(action, extra, ["instructor"]), {});
    expect(result.statusCode).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("rejects an admin-only caller", async () => {
    const result = await handler(actionEvent(action, extra, ["admin"]), {});
    expect(result.statusCode).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("rejects a caller with no roles", async () => {
    const result = await handler(actionEvent(action, extra, []), {});
    expect(result.statusCode).toBe(403);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test("invokes the function for a student", async () => {
    const result = await handler(actionEvent(action, extra, ["student"]), {});
    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test("invokes the function for a user with student and instructor roles", async () => {
    const result = await handler(
      actionEvent(action, extra, ["student", "instructor"]),
      {},
    );
    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});