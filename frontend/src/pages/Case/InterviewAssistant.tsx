import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  Box,
  Container,
  CircularProgress,
  LinearProgress,
  Typography,
  Snackbar,
  Alert,
  IconButton,
  Card,
  CardContent,
} from "@mui/material";
import KeyboardDoubleArrowLeftIcon from "@mui/icons-material/KeyboardDoubleArrowLeft";
import KeyboardDoubleArrowRightIcon from "@mui/icons-material/KeyboardDoubleArrowRight";
import { useParams, useOutletContext } from "react-router-dom";
import { fetchAuthSession } from "aws-amplify/auth";
import UserMessage from "../../components/Chat/UserMessage";
import AiResponse from "../../components/Chat/AIResponse";
import ChatBar from "../../components/Chat/ChatBar";
import type { CaseOutletContext } from "./CaseLayout";
import { useWebSocket } from "../../hooks/useWebSocket";
import { readApiErrorMessage } from "../../utils/apiError";
import type { WebSocketMessage } from "../../types/websocket";
import ThinkingIndicator from "../../components/Chat/ThinkingIndicator";
import { useUser } from "../../contexts/UserContext";

interface Message {
  type: "human" | "ai";
  content: string;
  isStreaming?: boolean;
}

interface AssessmentResponse {
  progress: number;
  reasoning?: string;
  unlocked?: boolean;
}

// Map sub_route to stage_type for assessment (variable names remain unchanged)
const SUB_ROUTE_TO_BLOCK: Record<string, string> = {
  "intake-facts": "intake",
  "legal-analysis": "legal_analysis",
  "contrarian-analysis": "contrarian",
  "policy-context": "policy",
};

const InterviewAssistant: React.FC = () => {
  const { caseId, section } = useParams();
  const {
    refreshUnlockedBlocks,
    caseStatus,
    completedBlocks,
    caseStudentId,
  } = useOutletContext<CaseOutletContext>();
  const { activePerspective, userInfo } = useUser();
  
  // Determine if user is in instructor perspective
  const isInstructorRole =
    activePerspective === "instructor" || activePerspective === "admin";
  
  // Check if instructor owns this case (instructor created the case, not just assigned to it)
  const instructorOwnCase =
    isInstructorRole && userInfo?.userId === caseStudentId;
  
  // Only disable messaging if they're an instructor AND don't own the case
  const isInstructorPerspective = isInstructorRole && !instructorOwnCase;

  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [isAssessingProgress, setIsAssessingProgress] = useState(false);
  const [wsUrl, setWsUrl] = useState<string | null>(null);

  // Progress & Notification State
  const [progress, setProgress] = useState(0);
  const [showSnackbar, setShowSnackbar] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState(
    "Success! You have unlocked the next stage. Feel free to proceed or continue asking questions.",
  );
  const [snackbarSeverity, setSnackbarSeverity] = useState<
    "success" | "info" | "warning" | "error"
  >("success");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [rightOpen, setRightOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [isResizing, setIsResizing] = useState(false);

  const startResizing = useCallback(() => {
    setIsResizing(true);
  }, []);

  const stopResizing = useCallback(() => {
    setIsResizing(false);
  }, []);

  const resize = useCallback(
    (e: MouseEvent) => {
      if (isResizing) {
        const newWidth = window.innerWidth - e.clientX;
        if (newWidth > 240 && newWidth < 600) {
          setSidebarWidth(newWidth);
        }
      }
    },
    [isResizing],
  );

  useEffect(() => {
    if (isResizing) {
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", resize);
      window.addEventListener("mouseup", stopResizing);
    } else {
      document.body.style.cursor = "default";
      document.body.style.userSelect = "auto";
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
    }
    return () => {
      document.body.style.cursor = "default";
      document.body.style.userSelect = "auto";
      window.removeEventListener("mousemove", resize);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [isResizing, resize, stopResizing]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const streamingIndexRef = useRef<number | null>(null);

  // Get current stage type from section
  const currentBlock = section ? SUB_ROUTE_TO_BLOCK[section] : null;

  const isCurrentBlockCompleted = React.useMemo(() => {
    if (!currentBlock) return false;
    return completedBlocks.includes(currentBlock) || progress >= 100;
  }, [currentBlock, completedBlocks, progress]);

  // Show progress bar only when current stage is not fully completed
  const showProgressBar = React.useMemo(() => {
    if (!currentBlock) return false;
    return !isCurrentBlockCompleted;
  }, [currentBlock, isCurrentBlockCompleted]);

  const assessProgressRef = useRef<(() => Promise<void>) | null>(null);
  const sectionRef = useRef(section);

  const [token, setToken] = useState<string | null>(null);

  // Handle incoming WebSocket messages
  const handleWebSocketMessage = useCallback(
    (message: WebSocketMessage) => {
      if (message.type === "start") {
        // Add an empty AI message that will be filled with chunks
        setMessages((prev) => {
          const newMessages = [
            ...prev,
            { type: "ai" as const, content: "", isStreaming: true },
          ];
          streamingIndexRef.current = newMessages.length - 1;
          return newMessages;
        });
      } else if (message.type === "chunk" && message.content) {
        // Append chunk to the streaming message
        setMessages((prev) => {
          if (streamingIndexRef.current === null) return prev;
          const updated = [...prev];
          const idx = streamingIndexRef.current;
          if (updated[idx]) {
            updated[idx] = {
              ...updated[idx],
              content: updated[idx].content + message.content,
            };
          }
          return updated;
        });
      } else if (message.type === "complete") {
        // Mark streaming as complete
        // Capture the index before the setState to avoid closure issues
        const completedIndex = streamingIndexRef.current;

        setMessages((prev) => {
          if (completedIndex === null) {
            return prev;
          }
          const updated = [...prev];
          if (updated[completedIndex]) {
            updated[completedIndex] = {
              type: updated[completedIndex].type,
              content: updated[completedIndex].content,
              isStreaming: false,
            };
          }
          return updated;
        });
        streamingIndexRef.current = null;
        setIsLoading(false);

        // Always trigger assessment for continuous feedback
        if (currentBlock) {
          assessProgressRef.current?.();
        }
      } else if (message.type === "error") {
        // Handle error
        setMessages((prev) => {
          if (streamingIndexRef.current !== null) {
            const updated = [...prev];
            const idx = streamingIndexRef.current;
            if (updated[idx]) {
              updated[idx] = {
                ...updated[idx],
                content: message.content || "An error occurred.",
                isStreaming: false,
              };
            }
            return updated;
          }
          return [
            ...prev,
            {
              type: "ai" as const,
              content: message.content || "An error occurred.",
            },
          ];
        });
        streamingIndexRef.current = null;
        setIsLoading(false);
      }
    },
    [currentBlock],
  );
  // Initialize WebSocket connection
  const { sendStreamingRequest, isConnected } = useWebSocket(wsUrl, {
    onMessage: handleWebSocketMessage,
    protocols: token ? [token, "chat.v1"] : undefined,
  });

  // Call assess_progress endpoint
  const assessProgress = useCallback(async () => {
    if (!caseId || !currentBlock) return;

    const capturedSection = section; // snapshot for stale-response check
    setIsAssessingProgress(true);

    // Try WebSocket first if connected
    if (isConnected) {
      sendStreamingRequest(
        "assess_progress",
        { case_id: caseId, block_type: currentBlock },
        {
          onComplete: async (data: Record<string, unknown>) => {
            // Discard if user switched stages while request was in-flight
            if (sectionRef.current !== capturedSection) {
              setIsAssessingProgress(false);
              return;
            }

            const assessment = data as unknown as AssessmentResponse;
            const progress =
              typeof assessment.progress === "number" ? assessment.progress : 0;
            setProgress((progress / 5) * 100);

            if (assessment.reasoning) {
              setFeedback(assessment.reasoning);
            }

            if (progress === 5 || assessment.unlocked) {
              await refreshUnlockedBlocks();
            }
            setIsAssessingProgress(false);
          },
          onError: () => {
            setIsAssessingProgress(false);
          },
        },
      );
      return;
    }

    // Fallback to HTTP
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();

      if (!token) return;

      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}/student/assess_progress`,
        {
          method: "POST",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            case_id: caseId,
            block_type: currentBlock,
          }),
        },
      );

      if (response.ok) {
        // Discard if user switched stages while request was in-flight
        if (sectionRef.current !== capturedSection) return;

        const data = await response.json();
        const currentScore =
          typeof data.progress === "number" ? data.progress : 0;
        setProgress((currentScore / 5) * 100);

        if (data.reasoning) {
          setFeedback(data.reasoning);
        }

        if (currentScore === 5 || data.unlocked) {
          await refreshUnlockedBlocks();
        }
      }
    } catch (error) {
    } finally {
      setIsAssessingProgress(false);
    }
  }, [
    caseId,
    section,
    currentBlock,
    isConnected,
    sendStreamingRequest,
    refreshUnlockedBlocks,
  ]);

  useEffect(() => {
    assessProgressRef.current = assessProgress;
  }, [assessProgress]);

  // Set up WebSocket URL when auth is available
  useEffect(() => {
    const setupWebSocket = async () => {
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();
        if (token && import.meta.env.VITE_WEBSOCKET_URL) {
          setToken(token);
          setWsUrl(import.meta.env.VITE_WEBSOCKET_URL);
        }
      } catch (error) {
      }
    };
    setupWebSocket();
  }, []);

  // Generate summary for current block
  const handleGenerateSummary = async () => {
    if (!caseId || !section) return;

    setIsGeneratingSummary(true);
    setSnackbarMessage(
      "Summary generation started. It may take a bit—check back in Case Summaries shortly.",
    );
    setSnackbarSeverity("info");
    setShowSnackbar(true);

    // Try WebSocket first if connected
    if (isConnected) {
      sendStreamingRequest(
        "generate_summary",
        { case_id: caseId, sub_route: section },
        {
          onStart: () => {
          },
          onChunk: () => {
            // Summary is being streamed - could display progress if desired
          },
          onComplete: () => {
            setIsGeneratingSummary(false);
            setSnackbarMessage(
              "Summary generated. Open Case Summaries to review it.",
            );
            setSnackbarSeverity("success");
            setShowSnackbar(true);
          },
          onError: (msg) => {
            setIsGeneratingSummary(false);
            setSnackbarMessage(
              msg ||
                "Summary generation failed. Chat first in this stage, then try again.",
            );
            setSnackbarSeverity("error");
            setShowSnackbar(true);
          },
        },
      );
      return;
    }

    // Fallback to HTTP
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();

      if (!token) {
        setIsGeneratingSummary(false);
        return;
      }

      const response = await fetch(
        `${
          import.meta.env.VITE_API_ENDPOINT
        }/student/generate_summary?case_id=${caseId}&sub_route=${section}`,
        {
          method: "GET",
          headers: {
            Authorization: token,
          },
        },
      );

      if (response.ok) {
        setSnackbarMessage(
          "Summary generated. Open Case Summaries to review it.",
        );
        setSnackbarSeverity("success");
        setShowSnackbar(true);
      } else {
        const message = await readApiErrorMessage(
          response,
          "Summary generation failed. Chat first in this stage, then try again.",
        );
        setSnackbarMessage(message);
        setSnackbarSeverity("error");
        setShowSnackbar(true);
      }
    } catch {
      setSnackbarMessage(
        "Summary generation failed. Please try again in a moment.",
      );
      setSnackbarSeverity("error");
      setShowSnackbar(true);
    } finally {
      setIsGeneratingSummary(false);
    }
  };

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isLoading]);

  // Reset state when section changes
  useEffect(() => {
    setProgress(0); // Reset progress on new section
    setFeedback(null); // clear stale reasoning when switching blocks
    sectionRef.current = section; // keep ref in sync for stale-response checks

    // Stage-specific greetings that explain the purpose and suggest starting points
    const BLOCK_GREETINGS: Record<string, string> = {
      "intake-facts":
        'Hello. As your assistant, I am here to guide you and provide suggestions alongside your assessment of the case facts. This includes considering further evidence, analyzing the strengths and weaknesses of identified evidence, and exploring other potentially relevant areas.\n\nTo begin, you may ask me to "please analyze the facts of the case." Alternatively, you can ask specific questions regarding potential areas for further inquiry, other relevant areas of evidence, or methods for analyzing the strengths and weaknesses of the evidence. You may also ask follow-up questions to any response provided.',

      "legal-analysis":
        'Hello. As your assistant, I am here to guide you and provide suggestions alongside your comprehensive legal analysis of the case. This includes identifying legal issues, developing research strategies, and constructing persuasive arguments.\n\nTo begin, you may ask me to "analyze the legal issues in this case" or "suggest arguments." You can also ask specific questions about causes of action, research approaches, argument structure, or how to connect facts to legal principles. You may ask follow-up questions to explore any aspect of your legal analysis in greater depth.',

      "contrarian-analysis":
        'Hello. As your assistant, I am here to guide you and provide suggestions alongside your evaluation of proposed approaches. You may articulate your strategies, and I will suggest potential weaknesses and identify further areas for analysis.\n\nTo begin, you can present your main arguments or strategy and ask, "what are the weaknesses in this approach?" or "what counterarguments might the opposing side raise?" You can also ask about specific vulnerabilities in your case, alternative interpretations of the law or facts, or how to strengthen your position against anticipated challenges. You may ask for more detail on any issues raised during our discussion.',

      "policy-context":
        'Hello. As your assistant, I am here to guide you and provide suggestions alongside your exploration of the broader policy implications and considerations underlying your case.\n\nTo begin, you may ask, "what are the policy considerations in this case?" Alternatively, you can ask more specific questions about how policy arguments might support your position, what societal interests are at stake, or how courts have balanced competing policy concerns in similar cases. You can also ask about the practical implications of different legal outcomes, how policy considerations might influence judicial decision-making, or how to incorporate policy arguments into an overall case strategy. You may ask follow-up questions to explore policy dimensions in greater depth or to understand how policy analysis connects to your legal arguments.',
    };

    const DEFAULT_GREETING: Message = {
      type: "ai",
      content:
        BLOCK_GREETINGS[section || "intake-facts"] ||
        "Hi, I'm your Legal Interview Assistant. Try asking me to analyze the case to begin!",
    };

    const fetchChatHistory = async () => {
      if (!caseId || !section) return;

      setIsLoadingHistory(true);
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();

        if (!token) {
          setMessages([DEFAULT_GREETING]);
          return;
        }

        const response = await fetch(
          `${
            import.meta.env.VITE_API_ENDPOINT
          }/student/get_messages?case_id=${caseId}&sub_route=${section}`,
          {
            method: "GET",
            headers: {
              Authorization: token,
            },
          },
        );

        if (response.ok) {
          const history = await response.json();
          setMessages(
            Array.isArray(history) && history.length > 0
              ? history
              : [DEFAULT_GREETING],
          );
          // Set message count based on existing human messages
          // Initialize feedback with existing chat history
          if (Array.isArray(history) && history.length > 0 && currentBlock) {
            assessProgress();
          }
        } else {
          setMessages([DEFAULT_GREETING]);
        }
      } catch {
        setMessages([DEFAULT_GREETING]);
      } finally {
        setIsLoadingHistory(false);
      }
    };

    fetchChatHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId, section]);

  const handleSendMessage = async (message: string) => {
    if (!caseId || !section) return;

    setMessages((prev) => [...prev, { type: "human", content: message }]);
    setIsLoading(true);

    // Use WebSocket if connected, otherwise fall back to HTTP
    if (isConnected) {
      const requestId = sendStreamingRequest(
        "generate_text",
        {
          case_id: caseId,
          sub_route: section,
          message_content: message,
        },
        {
          onStart: () => {
            // Start acknowledged — keep thinking dots visible until first chunk
          },
          onChunk: (content) => {
            // On first chunk, create the streaming message; on subsequent chunks, append
            setMessages((prev) => {
              if (streamingIndexRef.current === null) {
                // First chunk: add the AI message with initial content
                const newMessages = [
                  ...prev,
                  { type: "ai" as const, content: content, isStreaming: true },
                ];
                streamingIndexRef.current = newMessages.length - 1;
                return newMessages;
              }
              // Subsequent chunks: append to existing message
              const updated = [...prev];
              const idx = streamingIndexRef.current;
              if (updated[idx]) {
                updated[idx] = {
                  ...updated[idx],
                  content: updated[idx].content + content,
                };
              }
              return updated;
            });
          },
          onComplete: () => {
            // Mark streaming as complete
            const completedIndex = streamingIndexRef.current;
            setMessages((prev) => {
              if (completedIndex === null) return prev;
              const updated = [...prev];
              if (updated[completedIndex]) {
                updated[completedIndex] = {
                  type: updated[completedIndex].type,
                  content: updated[completedIndex].content,
                  isStreaming: false,
                };
              }
              return updated;
            });
            streamingIndexRef.current = null;
            setIsLoading(false);

            if (currentBlock) {
              assessProgress();
            }
          },
          onError: (errorMsg) => {
            setMessages((prev) => {
              if (streamingIndexRef.current !== null) {
                const updated = [...prev];
                const idx = streamingIndexRef.current;
                if (updated[idx]) {
                  updated[idx] = {
                    ...updated[idx],
                    content: errorMsg || "An error occurred.",
                    isStreaming: false,
                  };
                }
                return updated;
              }
              return [
                ...prev,
                {
                  type: "ai" as const,
                  content: errorMsg || "An error occurred.",
                },
              ];
            });
            streamingIndexRef.current = null;
            setIsLoading(false);
          },
        },
      );

      if (!requestId) {
        setMessages((prev) => [
          ...prev,
          { type: "ai", content: "Failed to send message. Please try again." },
        ]);
        setIsLoading(false);
      }
    } else {
      // Fallback to HTTP (backward compatibility)
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();

        if (!token) {
          return;
        }

        const response = await fetch(
          `${
            import.meta.env.VITE_API_ENDPOINT
          }/student/text_generation?case_id=${caseId}&sub_route=${section}`,
          {
            method: "POST",
            headers: {
              Authorization: token,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message_content: message,
            }),
          },
        );

        if (response.ok) {
          const data = await response.json();
          if (data.llm_output) {
            setMessages((prev) => [
              ...prev,
              { type: "ai", content: data.llm_output },
            ]);

            if (currentBlock) {
              assessProgress();
            }
          }
        } else {
          let errorMsg =
            "Sorry, I encountered an error connecting to the server.";
          if (response.status === 429) {
            try {
              const errorData = await response.json();
              errorMsg = errorData.error || errorMsg;
            } catch {
            }
          }
          setMessages((prev) => [
            ...prev,
            {
              type: "ai",
              content: errorMsg,
            },
          ]);
        }
      } catch {
        setMessages((prev) => [
          ...prev,
          { type: "ai", content: "Sorry, I encountered a network error." },
        ]);
      } finally {
        setIsLoading(false);
      }
    }
  };

  return (
    <Box
      sx={{
        width: "100%",
        height: "calc(100vh - 80px)",
        backgroundColor: "var(--background)",
        display: "flex",
        flexDirection: "column",
        color: "var(--text)",
        overflow: "hidden", // Prevent outer scroll
      }}
    >
      {/* Main Layout: Split into Center (Chat) and Right (Sidebar) */}
      <Box
        sx={{
          display: "flex",
          flexGrow: 1,
          overflow: "hidden",
          position: "relative",
        }}
      >
        {/* Chat Area + Bottom Bar Container */}
        <Box
          sx={{
            flexGrow: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            position: "relative",
          }}
        >
          {/* Progress Bar (Above messages, constrained to layout width) */}
          {showProgressBar && (
            <Box
              sx={{
                width: "100%",
                zIndex: 10,
                backgroundColor: "var(--background)",
                backdropFilter: "blur(10px)",
                borderTop: "1px solid var(--border)",
                boxShadow: "0px -2px 4px rgba(0, 0, 0, 0.9)",
                display: "flex",
                alignItems: "center",
                py: "2px",
                px: 3,
                gap: 2,
              }}
            >
              <Typography
                variant="caption"
                sx={{
                  color: "var(--text)",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  fontFamily: "Outfit",
                }}
              >
                Progress in current stage
              </Typography>
              <Box sx={{ flexGrow: 1 }}>
                <LinearProgress
                  variant="determinate"
                  value={progress}
                  sx={{
                    color: "var(--feedback)",
                    height: 6,
                    borderRadius: 999,
                    backgroundColor: "var(--feedback-bg)",
                    boxShadow: "0 0 0 1px var(--feedback-bg)",
                    "&.MuiLinearProgress-root": {
                      backgroundColor: "var(--feedback-bg)",
                    },
                    "& .MuiLinearProgress-bar": {
                      backgroundColor: "var(--feedback) !important",
                      backgroundImage:
                        "linear-gradient(90deg, var(--feedback), rgba(var(--primary-rgb), 1))",
                      borderRadius: 999,
                    },
                  }}
                />
              </Box>
            </Box>
          )}
          {/* Right Ribbon Trigger (only visible when sidebar is closed) */}
          {!rightOpen && (
            <Box
              sx={{
                position: "absolute",
                right: 0,
                top: 12,
                zIndex: 10,
                backgroundColor: "var(--background)",
                border: "1px solid var(--border)",
                borderRight: "none",
                borderTopLeftRadius: "8px",
                borderBottomLeftRadius: "8px",
                boxShadow: "-2px 0 5px rgba(0,0,0,0.1)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: "24px",
                height: "40px",
                cursor: "pointer",
                "&:hover": {
                  backgroundColor: "var(--secondary)",
                },
              }}
              onClick={() => setRightOpen(true)}
            >
              <KeyboardDoubleArrowLeftIcon
                sx={{ fontSize: "16px", color: "var(--text-secondary)" }}
              />
            </Box>
          )}

          {/* Messages Area */}
          <Container
            maxWidth="lg"
            sx={{
              flexGrow: 1,
              display: "flex",
              flexDirection: "column",
              gap: 4,
              overflowY: "auto",
              py: 4,
              px: { xs: 2, md: 8 },
              position: "relative",
            }}
          >
            {isLoadingHistory ? (
              <Box
                sx={{
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  height: "100%",
                }}
              >
                <CircularProgress sx={{ color: "var(--text-secondary)" }} />
              </Box>
            ) : (
              messages.map((msg, index) =>
                msg.type === "human" ? (
                  <UserMessage key={index} message={msg.content} />
                ) : (
                  <AiResponse
                    key={`ai-${index}-${
                      msg.isStreaming ? "streaming" : "complete"
                    }`}
                    message={msg.content}
                    onGenerateSummary={
                      caseStatus === "archived"
                        ? undefined
                        : handleGenerateSummary
                    }
                    isGeneratingSummary={isGeneratingSummary}
                    isStreaming={msg.isStreaming === true}
                  />
                ),
              )
            )}

            {isLoading && !messages.some((m) => m.isStreaming) && (
              <Box
                sx={{ display: "flex", justifyContent: "flex-start", pl: 2 }}
              >
                <ThinkingIndicator />
              </Box>
            )}

            <div ref={scrollRef} />
          </Container>

          {/* Bottom Bar Area */}
          <Box
            sx={{
              width: "100%",
              pb: 2,
              pt: 1,
              backgroundColor: "var(--background)",
              flexShrink: 0,
            }}
          >
            <Container maxWidth="lg" sx={{ px: { xs: 2, md: 8 } }}>
              {isInstructorPerspective && (
                <Typography
                  variant="caption"
                  sx={{
                    display: "block",
                    mb: 1,
                    color: "var(--text-secondary)",
                    fontFamily: "Outfit",
                  }}
                >
                  Supervisors can review this chat history, but only advocates can send messages.
                </Typography>
              )}
              <ChatBar
                onSendMessage={handleSendMessage}
                isLoading={isLoading}
                disabled={caseStatus === "archived" || isInstructorPerspective}
              />
            </Container>
          </Box>
        </Box>

        {/* Right Sidebar */}
        <Box
          sx={{
            width: rightOpen ? sidebarWidth : 0,
            transition: isResizing ? "none" : "width 0.1s ease",
            borderLeft: rightOpen ? "1px solid var(--border)" : "none",
            backgroundColor: "var(--background)",
            display: "flex",
            flexDirection: "column",
            flexShrink: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            height: "100%",
            position: "relative",
          }}
        >
          {/* Resize Handle */}
          {rightOpen && (
            <Box
              onMouseDown={startResizing}
              sx={{
                position: "absolute",
                left: 0,
                top: 0,
                bottom: 0,
                width: "4px",
                cursor: "col-resize",
                zIndex: 100,
                "&:hover": {
                  backgroundColor: "rgba(25, 118, 210, 0.2)",
                  width: "6px",
                },
                transition: "background-color 0.2s",
              }}
            />
          )}

          <Box
            sx={{
              p: 2,
              height: "56px",
              display: "flex",
              alignItems: "center",
              justifyContent: rightOpen ? "space-between" : "center",
              borderBottom: "1px solid var(--border)",
              boxSizing: "border-box",
            }}
          >
            <IconButton
              size="small"
              onClick={() => setRightOpen(!rightOpen)}
              sx={{ color: "var(--text-secondary)" }}
            >
              {rightOpen ? (
                <KeyboardDoubleArrowRightIcon />
              ) : (
                <KeyboardDoubleArrowLeftIcon />
              )}
            </IconButton>

            {rightOpen && (
              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                <Typography
                  variant="subtitle2"
                  sx={{
                    fontFamily: "Outfit",
                    fontWeight: 600,
                    color: "var(--text)",
                  }}
                >
                  Assessment Feedback
                </Typography>
                {isAssessingProgress && (
                  <CircularProgress
                    size={16}
                    sx={{ color: "var(--primary)" }}
                  />
                )}
              </Box>
            )}
          </Box>

          {rightOpen && (
            <>
              <Box
                sx={{
                  flexGrow: 1,
                  overflowY: "auto",
                  p: 1.5,
                  backgroundColor: "var(--background)",
                }}
              >
                {feedback ? (
                  <Card
                    sx={{
                      backgroundColor: "var(--background2)",
                      border: "1px solid var(--border)",
                      boxShadow: "none",
                    }}
                  >
                    <CardContent sx={{ p: 1.25, "&:last-child": { pb: 1.25 } }}>
                      <Typography
                        variant="body2"
                        sx={{
                          color: "var(--text)",
                          fontSize: "0.875rem",
                          lineHeight: 1.4,
                          whiteSpace: "pre-wrap",
                          textAlign: "left",
                        }}
                      >
                        {feedback}
                      </Typography>
                    </CardContent>
                  </Card>
                ) : (
                  <Typography
                    variant="body2"
                    sx={{
                      color: "var(--text-secondary)",
                      textAlign: "center",
                      mt: 4,
                      fontSize: "0.875rem",
                      whiteSpace: "normal",
                      lineHeight: 1.4,
                    }}
                  >
                    No feedback available yet. Continue the conversation to
                    receive assessment.
                  </Typography>
                )}
              </Box>
            </>
          )}
        </Box>
      </Box>

      {/* Unlock Notification Snackbar */}
      <Snackbar
        open={showSnackbar}
        autoHideDuration={8000}
        onClose={() => setShowSnackbar(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          onClose={() => setShowSnackbar(false)}
          severity={snackbarSeverity}
          sx={{ width: "100%" }}
        >
          {snackbarMessage}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default InterviewAssistant;
