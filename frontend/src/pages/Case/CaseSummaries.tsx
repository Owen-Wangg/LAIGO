import React, { useState, useEffect } from "react";
import {
  Box,
  Typography,
  Button,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Divider,
  Collapse,
  Card,
  CardContent,
  CircularProgress,
  Snackbar,
  Alert,
} from "@mui/material";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { marked } from "marked";
import DOMPurify from "dompurify";
import html2pdf from "html2pdf.js";
import KeyboardDoubleArrowLeftIcon from "@mui/icons-material/KeyboardDoubleArrowLeft";
import KeyboardDoubleArrowRightIcon from "@mui/icons-material/KeyboardDoubleArrowRight";
import DownloadIcon from "@mui/icons-material/Download";
import DeleteIcon from "@mui/icons-material/Delete";
import AddIcon from "@mui/icons-material/Add";
import ExpandLess from "@mui/icons-material/ExpandLess";
import ExpandMore from "@mui/icons-material/ExpandMore";
import ArticleIcon from "@mui/icons-material/Article";
import AssignmentIcon from "@mui/icons-material/Assignment";
import { useParams, useOutletContext } from "react-router-dom";
import { fetchAuthSession } from "aws-amplify/auth";
import { useWebSocket } from "../../hooks/useWebSocket";
import type { CaseOutletContext } from "./CaseLayout";

// --- Types ---

type SummaryScope = "full_case" | "block";
type BlockType = "intake" | "legal_analysis" | "contrarian" | "policy";

// Updated to match API response
interface Summary {
  summary_id: number;
  case_id: string;
  title: string;
  content: string; // Markdown
  scope: SummaryScope;
  block_context?: BlockType;
  time_created: string; // ISO string
}

/*
interface Annotation {
  id: string;
  summaryId: string;
  authorName: string;
  date: string; // ISO string
  startOffset: number; // For mock purpose, just visual reference
  endOffset: number;
  quote: string;
  comment: string;
}

// --- Mock Annotations (kept for now) ---

const MOCK_ANNOTATIONS: Annotation[] = [
  {
    id: "ann-1",
    summaryId: "1",
    authorName: "Allan Jordan",
    date: "2025-11-20T10:45:00",
    startOffset: 0,
    endOffset: 0,
    quote: "unsafe or uninhabitable conditions",
    comment:
      "Make sure to describe the unsafe conditions precisely (e.g., 'persistent ceiling leak causing mold growth,' 'collapsed flooring,' etc.) rather than using generic categories.",
  },
  {
    id: "ann-2",
    summaryId: "1",
    authorName: "Allan Jordan",
    date: "2025-11-17T11:09:00",
    startOffset: 0,
    endOffset: 0,
    quote: "tenant withheld a portion of her rent",
    comment:
      "Check local statutes regarding rent withholding. Did she escrow the funds properly? This is a critical defense point.",
  },
];
*/

// --- Helper Components ---

const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
};

const formatTime = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatBlockName = (blockContext?: string) => {
  if (!blockContext) return "Stage";
  return blockContext
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
};

const CaseSummaries: React.FC = () => {
  const { caseId } = useParams();
  const { caseStatus, caseTitle } = useOutletContext<CaseOutletContext>();
  const [summaries, setSummaries] = useState<Summary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedSummaryId, setSelectedSummaryId] = useState<number | null>(
    null,
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [showGenerateSnackbar, setShowGenerateSnackbar] = useState(false);
  const [errorSnackbar, setErrorSnackbar] = useState<{
    open: boolean;
    message: string;
  }>({ open: false, message: "" });
  const [leftOpen, setLeftOpen] = useState(true);
  // const [rightOpen, setRightOpen] = useState(true);
  const [openCategories, setOpenCategories] = useState<{
    [key: string]: boolean;
  }>({
    full_case: true,
    block: true,
  });
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  // Set up WebSocket connection
  const { sendStreamingRequest, isConnected } = useWebSocket(wsUrl, {
    protocols: token ? [token, "chat.v1"] : undefined,
  });

  // Initialize WebSocket URL when auth is available
  useEffect(() => {
    const setupWebSocket = async () => {
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();
        if (token && import.meta.env.VITE_WEBSOCKET_URL) {
          setToken(token);
          setWsUrl(import.meta.env.VITE_WEBSOCKET_URL);
        }
      } catch {
      }
    };
    setupWebSocket();
  }, []);

  // Fetch summaries from API
  const fetchSummaries = React.useCallback(async () => {
    if (!caseId) return;

    setIsLoading(true);
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();

      if (!token) {
        setIsLoading(false);
        return;
      }

      const response = await fetch(
        `${
          import.meta.env.VITE_API_ENDPOINT
        }/student/get_summaries?case_id=${caseId}`,
        {
          method: "GET",
          headers: {
            Authorization: token,
          },
        },
      );

      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data)) {
          setSummaries(data);
        }
      }
    } catch {
    } finally {
      setIsLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    fetchSummaries();
  }, [fetchSummaries]);

  // Auto-select first summary on initial load if nothing selected
  useEffect(() => {
    if (summaries.length > 0 && selectedSummaryId === null) {
      setSelectedSummaryId(summaries[0].summary_id);
    }
  }, [summaries, selectedSummaryId]);

  const handleGenerateSummary = async () => {
    if (!caseId) return;

    setIsGenerating(true);
    setShowGenerateSnackbar(true);

    // Try WebSocket first if connected
    if (isConnected) {
      sendStreamingRequest(
        "generate_summary",
        { case_id: caseId, sub_route: "full-case" },
        {
          onStart: () => {
          },
          onChunk: () => {
            // Summary is being streamed - could display progress if desired
          },
          onComplete: async () => {
            // Refresh summaries to show the new one
            await fetchSummaries();
            setIsGenerating(false);
          },
          onError: (msg) => {
            setIsGenerating(false);
            setShowGenerateSnackbar(false);
            setErrorSnackbar({
              open: true,
              message:
                msg ||
                "Failed to generate summary. Please try again.",
            });
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
        setIsGenerating(false);
        return;
      }

      // Defaulting to full-case summary generation
      const response = await fetch(
        `${
          import.meta.env.VITE_API_ENDPOINT
        }/student/generate_summary?case_id=${caseId}&sub_route=full-case`,
        {
          method: "GET",
          headers: {
            Authorization: token,
          },
        },
      );

      if (response.ok) {
        // Refresh messages to show the new one
        await fetchSummaries();
      } else {
        // Could implement a snackbar here
      }
    } catch {
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = async (summary: Summary) => {
    if (!caseId) return;

    // Create a temporary container for the PDF content
    const element = document.createElement("div");
    element.style.padding = "40px";
    element.style.fontFamily = "Outfit, sans-serif";
    element.style.color = "#000000"; // Force black text for PDF
    element.style.backgroundColor = "#ffffff";

    // Create header with title and date
    const headerHtml = `
      <div style="margin-bottom: 20px; border-bottom: 2px solid #eaeaea; padding-bottom: 10px;">
        <h1 style="font-size: 24px; font-weight: bold; margin: 0 0 10px 0; color: #000000;">Case Summary: ${summary.title || "Untitled"}</h1>
        <p style="font-size: 12px; color: #666666; margin: 0;">Generated: ${new Date(summary.time_created).toLocaleString()}</p>
      </div>
    `;

    // Convert markdown directly to HTML string
    // We use marked.parse() to get the HTML string
    const bodyHtml = await (marked.parse(
      summary.content || "",
    ) as Promise<string>);

    // Combine and set innerHTML
    const combinedHtml =
      headerHtml +
      `<div class="markdown-body" style="font-size: 12px; line-height: 1.6;">${bodyHtml}</div>`;
    element.innerHTML = DOMPurify.sanitize(combinedHtml);

    // Add custom styles for the PDF content - matching UI display
    const style = document.createElement("style");
    style.innerHTML = `
      .markdown-body h1 { 
        font-family: 'Outfit', sans-serif;
        font-size: 1.5rem; 
        font-weight: 700; 
        margin-top: 24px; 
        margin-bottom: 16px; 
        color: #000000;
      }
      .markdown-body h2 { 
        font-family: 'Outfit', sans-serif;
        font-size: 1.25rem; 
        font-weight: 600; 
        margin-top: 24px; 
        margin-bottom: 16px; 
        color: #000000;
      }
      .markdown-body h3 { 
        font-family: 'Outfit', sans-serif;
        font-size: 1.1rem; 
        font-weight: 600; 
        margin-top: 16px; 
        margin-bottom: 8px; 
        color: #000000;
      }
      .markdown-body p { 
        font-family: 'Inter', sans-serif;
        margin-bottom: 16px; 
        line-height: 1.7;
        color: #000000;
      }
      .markdown-body ul, .markdown-body ol { 
        font-family: 'Inter', sans-serif;
        margin-bottom: 16px; 
        padding-left: 0;
        list-style: none;
      }
      .markdown-body li { 
        margin-bottom: 4px; 
        line-height: 1.7;
        color: #000000;
        display: flex;
        align-items: flex-start;
      }
      .markdown-body ul li::before {
        content: "•";
        flex-shrink: 0;
        width: 24px;
        text-align: center;
      }
      .markdown-body ol {
        counter-reset: item;
      }
      .markdown-body ol li::before {
        content: counter(item) ". ";
        counter-increment: item;
        flex-shrink: 0;
        width: 24px;
        text-align: right;
        margin-right: 8px;
        font-weight: 500;
      }
      .markdown-body li > p {
        margin-bottom: 0;
      }
    `;
    element.appendChild(style);

    let filenameStr = `${caseTitle || "Case"} - `;
    if (summary.scope === "full_case") {
      filenameStr += "Full Case Summary";
    } else {
      const blockName = formatBlockName(summary.block_context);
      filenameStr += `${blockName} Summary`;
    }
    filenameStr += ".pdf";

    // Options for html2pdf
    const opt = {
      margin: 10,
      filename: filenameStr,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    };

    try {
      // @ts-expect-error html2pdf types are missing
      await html2pdf().set(opt).from(element).save();
    } catch {
    }
  };

  const selectedSummary = summaries.find(
    (s) => s.summary_id === selectedSummaryId,
  );
  /*
  const currentAnnotations = MOCK_ANNOTATIONS.filter(
    (a) => a.summaryId === String(selectedSummaryId),
  );
  */

  // Group summaries
  const groupedSummaries = summaries.reduce(
    (acc, summary) => {
      const key = summary.scope;
      if (!acc[key]) acc[key] = [];
      acc[key].push(summary);
      return acc;
    },
    {} as Record<string, Summary[]>,
  );

  const toggleCategory = (category: string) => {
    setOpenCategories((prev) => ({ ...prev, [category]: !prev[category] }));
  };

  const handleDeleteSummary = async (summaryId: number) => {
    if (!caseId) return;

    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();

      if (!token) {
        return;
      }

      const response = await fetch(
        `${
          import.meta.env.VITE_API_ENDPOINT
        }/student/delete_summary?summary_id=${summaryId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: token,
          },
        },
      );

      if (response.ok) {
        // Remove the deleted summary from state
        setSummaries((prev) => prev.filter((s) => s.summary_id !== summaryId));
        // If the deleted summary was selected, clear selection
        if (selectedSummaryId === summaryId) {
          setSelectedSummaryId(null);
        }
      }
    } catch {
    }
  };

  return (
    <Box
      sx={{
        display: "flex",
        height: "calc(100vh - 80px)", // Adjust based on header height
        position: "relative", // Needed for absolute ribbons
        backgroundColor: "var(--background)",
        color: "var(--text)",
        borderTop: "1px solid var(--border)",
        overflow: "hidden",
      }}
    >
      {/* --- Left Ribbon Trigger --- */}
      {!leftOpen && (
        <Box
          sx={{
            position: "absolute",
            left: 0,
            top: 12, // Align with header icon
            zIndex: 10,
            backgroundColor: "var(--background2)",
            border: "1px solid var(--border)",
            borderLeft: "none",
            borderTopRightRadius: "8px",
            borderBottomRightRadius: "8px",
            boxShadow: "2px 0 5px rgba(0,0,0,0.1)",
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
          onClick={() => setLeftOpen(true)}
        >
          <KeyboardDoubleArrowRightIcon
            sx={{ fontSize: "16px", color: "var(--text-secondary)" }}
          />
        </Box>
      )}

      {/* --- Right Ribbon Trigger --- */}
      {/*
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
      */}

      {/* --- Left Sidebar (Summaries List) --- */}
      <Box
        sx={{
          width: leftOpen ? 240 : 0,
          transition: "width 0.3s ease",
          borderRight: leftOpen ? "1px solid var(--border)" : "none",
          backgroundColor: "var(--background2)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          whiteSpace: "nowrap",
          overflow: "hidden", // Hide content when width is 0
        }}
      >
        {/* Header */}
        <Box
          sx={{
            p: 2,
            display: "flex",
            alignItems: "center",
            justifyContent: leftOpen ? "space-between" : "center",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {leftOpen && (
            <Typography
              variant="subtitle1"
              fontWeight="bold"
              sx={{ fontFamily: "Outfit" }}
            >
              Summaries
            </Typography>
          )}
          <IconButton
            size="small"
            onClick={() => setLeftOpen(!leftOpen)}
            sx={{ color: "var(--text-secondary)" }}
          >
            {leftOpen ? (
              <KeyboardDoubleArrowLeftIcon />
            ) : (
              <KeyboardDoubleArrowRightIcon />
            )}
          </IconButton>
        </Box>

        {/* Generate Button Area */}
        {leftOpen && (
          <Box sx={{ p: 1 }}>
            <Button
              variant="contained"
              fullWidth
              startIcon={
                isGenerating ? (
                  <CircularProgress size={20} color="inherit" />
                ) : (
                  <AddIcon />
                )
              }
              onClick={handleGenerateSummary}
              disabled={isGenerating || caseStatus === "archived"}
              sx={{
                backgroundColor: "var(--primary)",
                color: "white", // Fixed as primary usually needs white text
                fontFamily: "Outfit",
                textTransform: "none",
                "&:hover": {
                  backgroundColor: "#42a5f5", // Slightly lighter/darker
                },
                "&.Mui-disabled": {
                  backgroundColor: "var(--secondary)",
                  color: "rgba(255, 255, 255, 0.7)",
                },
              }}
            >
              {isGenerating ? "Generating..." : "Generate Full Case Summary"}
            </Button>
          </Box>
        )}

        {/* List Content */}
        {leftOpen && (
          <Box
            sx={{
              flexGrow: 1,
              overflowY: "auto",
              // Hide scrollbar while keeping scroll functionality
              "&::-webkit-scrollbar": {
                display: "none",
              },
              scrollbarWidth: "none", // Firefox
              msOverflowStyle: "none", // IE and Edge
            }}
          >
            {/* Loading State */}
            {isLoading && (
              <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
                <CircularProgress size={24} sx={{ color: "var(--primary)" }} />
              </Box>
            )}

            {/* Empty State */}
            {!isLoading && summaries.length === 0 && (
              <Box sx={{ p: 2, textAlign: "center" }}>
                <Typography
                  variant="body2"
                  sx={{ color: "var(--text-secondary)" }}
                >
                  No summaries generated yet
                </Typography>
              </Box>
            )}

            {/* Full Case Summaries */}
            {!isLoading && groupedSummaries["full_case"] && (
              <>
                <ListItemButton
                  onClick={() => toggleCategory("full_case")}
                  sx={{ py: 0.5, backgroundColor: "rgba(0,0,0,0.03)" }}
                >
                  <AssignmentIcon
                    sx={{
                      fontSize: 18,
                      mr: 1,
                      color: "var(--text-secondary)",
                    }}
                  />
                  <ListItemText
                    primary="Full Case"
                    slotProps={{
                      primary: {
                        fontSize: "0.85rem",
                        fontWeight: 600,
                        color: "var(--text-secondary)",
                        fontFamily: "Outfit",
                      },
                    }}
                  />
                  {openCategories["full_case"] ? (
                    <ExpandLess
                      sx={{ fontSize: 18, color: "var(--text-secondary)" }}
                    />
                  ) : (
                    <ExpandMore
                      sx={{ fontSize: 18, color: "var(--text-secondary)" }}
                    />
                  )}
                </ListItemButton>
                <Collapse
                  in={openCategories["full_case"]}
                  timeout="auto"
                  unmountOnExit
                >
                  <List component="div" disablePadding>
                    {groupedSummaries["full_case"].map((summary) => (
                      <ListItemButton
                        key={summary.summary_id}
                        selected={selectedSummaryId === summary.summary_id}
                        onClick={() => setSelectedSummaryId(summary.summary_id)}
                        sx={{
                          pl: 2,
                          borderLeft:
                            selectedSummaryId === summary.summary_id
                              ? "4px solid var(--primary)"
                              : "4px solid transparent",
                          "&.Mui-selected": {
                            backgroundColor: "var(--secondary)",
                          },
                          "&.Mui-selected:hover": {
                            backgroundColor: "var(--secondary)",
                          },
                        }}
                      >
                        <ListItemText
                          sx={{ pr: 1, minWidth: 0, my: 0 }}
                          primary={
                            <Typography
                              variant="body2"
                              fontWeight={
                                selectedSummaryId === summary.summary_id
                                  ? 600
                                  : 400
                              }
                              sx={{
                                fontFamily: "Outfit",
                                color: "var(--text)",
                                whiteSpace: "normal",
                                wordBreak: "break-word",
                                lineHeight: 1.2,
                                mb: 0.5,
                              }}
                            >
                              {formatDate(summary.time_created)}
                            </Typography>
                          }
                          secondary={
                            <Typography
                              variant="caption"
                              sx={{
                                color: "var(--text-secondary)",
                                whiteSpace: "normal",
                                wordBreak: "break-word",
                                display: "block",
                                lineHeight: 1.2,
                              }}
                            >
                              {formatTime(summary.time_created)}
                            </Typography>
                          }
                        />
                        <Box sx={{ display: "flex", flexShrink: 0 }}>
                          <IconButton
                            size="small"
                            sx={{ color: "var(--text-secondary)" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownload(summary);
                            }}
                          >
                            <DownloadIcon fontSize="small" />
                          </IconButton>
                          <IconButton
                            size="small"
                            sx={{ color: "var(--text-secondary)" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteSummary(summary.summary_id);
                            }}
                            disabled={caseStatus === "archived"}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Box>
                      </ListItemButton>
                    ))}
                  </List>
                </Collapse>
              </>
            )}

            {/* Stage Summaries */}
            {groupedSummaries["block"] && (
              <>
                <ListItemButton
                  onClick={() => toggleCategory("block")}
                  sx={{ py: 0.5, backgroundColor: "var(--background2)", mt: 1 }}
                >
                  <ArticleIcon
                    sx={{
                      fontSize: 18,
                      mr: 1,
                      color: "var(--text-secondary)",
                    }}
                  />
                  <ListItemText
                    primary="Stage Summaries"
                    slotProps={{
                      primary: {
                        fontSize: "0.85rem",
                        fontWeight: 600,
                        color: "var(--text-secondary)",
                        fontFamily: "Outfit",
                      },
                    }}
                  />
                  {openCategories["block"] ? (
                    <ExpandLess
                      sx={{ fontSize: 18, color: "var(--text-secondary)" }}
                    />
                  ) : (
                    <ExpandMore
                      sx={{ fontSize: 18, color: "var(--text-secondary)" }}
                    />
                  )}
                </ListItemButton>
                <Collapse
                  in={openCategories["block"]}
                  timeout="auto"
                  unmountOnExit
                >
                  <List component="div" disablePadding>
                    {groupedSummaries["block"].map((summary) => (
                      <ListItemButton
                        key={summary.summary_id}
                        selected={selectedSummaryId === summary.summary_id}
                        onClick={() => setSelectedSummaryId(summary.summary_id)}
                        sx={{
                          pl: 2,
                          borderLeft:
                            selectedSummaryId === summary.summary_id
                              ? "4px solid var(--primary)"
                              : "4px solid transparent",
                          "&.Mui-selected": {
                            backgroundColor: "var(--secondary)",
                          },
                          "&.Mui-selected:hover": {
                            backgroundColor: "var(--secondary)",
                          },
                        }}
                      >
                        <ListItemText
                          sx={{ pr: 1, minWidth: 0, my: 0 }}
                          primary={
                            <Typography
                              variant="body2"
                              fontWeight={
                                selectedSummaryId === summary.summary_id
                                  ? 600
                                  : 400
                              }
                              sx={{
                                fontFamily: "Outfit",
                                color: "var(--text)",
                                whiteSpace: "normal",
                                wordBreak: "break-word",
                                lineHeight: 1.2,
                                mb: 0.5,
                              }}
                            >
                              {formatBlockName(summary.block_context)}
                            </Typography>
                          }
                          secondary={
                            <>
                              <Typography
                                variant="caption"
                                sx={{
                                  color: "var(--text-secondary)",
                                  whiteSpace: "normal",
                                  wordBreak: "break-word",
                                  display: "block",
                                  lineHeight: 1.2,
                                }}
                              >
                                {formatDate(summary.time_created)}
                              </Typography>
                              <Typography
                                variant="caption"
                                sx={{
                                  color: "var(--text-secondary)",
                                  whiteSpace: "normal",
                                  wordBreak: "break-word",
                                  display: "block",
                                  lineHeight: 1.2,
                                }}
                              >
                                {formatTime(summary.time_created)}
                              </Typography>
                            </>
                          }
                        />
                        <Box sx={{ display: "flex", flexShrink: 0 }}>
                          <IconButton
                            size="small"
                            sx={{ color: "var(--text-secondary)" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownload(summary);
                            }}
                          >
                            <DownloadIcon fontSize="small" />
                          </IconButton>
                          <IconButton
                            size="small"
                            sx={{ color: "var(--text-secondary)" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteSummary(summary.summary_id);
                            }}
                            disabled={caseStatus === "archived"}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </Box>
                      </ListItemButton>
                    ))}
                  </List>
                </Collapse>
              </>
            )}
          </Box>
        )}
      </Box>

      {/* --- Center Content (Markdown) --- */}
      <Box
        sx={{
          flexGrow: 1,
          overflowY: "auto",
          p: 4,
          display: "flex",
          justifyContent: "center",
          backgroundColor: "var(--background)", // Same color as card, but darker overlay for "document" feel
        }}
      >
        <Card
          sx={{
            width: "100%",
            maxWidth: "800px",
            height: "fit-content",
            backgroundColor: "var(--background)", // Contrast against the container
            border: "1px solid var(--border)",
            borderRadius: 2,
            boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
          }}
        >
          <CardContent sx={{ p: 4, "&:last-child": { pb: 4 } }}>
            {selectedSummary ? (
              <Box
                sx={{
                  color: "var(--text)",
                  fontFamily: "Inter",
                  textAlign: "left",
                  "& h1": {
                    fontFamily: "Outfit",
                    color: "var(--text)",
                    fontSize: "1.5rem",
                    fontWeight: 700,
                    mt: 3,
                    mb: 2,
                  },
                  "& h2": {
                    fontFamily: "Outfit",
                    color: "var(--text)",
                    fontSize: "1.25rem",
                    fontWeight: 600,
                    mt: 3,
                    mb: 2,
                  },
                  "& h3": {
                    fontFamily: "Outfit",
                    color: "var(--text)",
                    fontSize: "1.1rem",
                    fontWeight: 600,
                    mt: 2,
                    mb: 1,
                  },
                  "& p": {
                    mb: 2,
                    lineHeight: 1.7,
                  },
                  "& ul": {
                    pl: 4,
                    mb: 2,
                    listStyleType: "disc",
                  },
                  "& ol": {
                    pl: 4,
                    mb: 2,
                    listStyleType: "decimal",
                  },
                  "& li": {
                    mb: 0.5,
                    pl: 1,
                  },
                  "& li > p": {
                    mb: 0,
                  },
                }}
              >
                {/* Title Header inside the doc */}
                <Typography
                  variant="h5"
                  fontFamily="Outfit"
                  fontWeight="bold"
                  mb={3}
                >
                  {selectedSummary.title}
                </Typography>
                <Divider sx={{ mb: 3 }} />

                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeSanitize]}
                >
                  {selectedSummary.content}
                </ReactMarkdown>
              </Box>
            ) : (
              <Typography color="var(--text-secondary)">
                Select a summary to view details.
              </Typography>
            )}
          </CardContent>
        </Card>
      </Box>

      {/* --- Right Sidebar (Annotations) --- */}
      {/*
      <Box
        sx={{
          width: rightOpen ? 320 : 0,
          transition: "width 0.3s ease",
          borderLeft: rightOpen ? "1px solid var(--border)" : "none",
          backgroundColor: "var(--background)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        <Box
          sx={{
            p: 2, // Consistent padding
            height: "56px", // Explicit height to match typical headers if needed, or let it flow
            display: "flex",
            alignItems: "center",
            justifyContent: rightOpen ? "space-between" : "center",
            borderBottom: "1px solid var(--border)",
            boxSizing: "border-box", // Ensure padding is included in height
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
            // Placeholder for potential header title or actions
            <div />
          )}
        </Box>

        {rightOpen && (
          <Box
            sx={{
              flexGrow: 1,
              overflowY: "auto",
              p: 2,
              backgroundColor: "var(--background)",
            }}
          >
            {currentAnnotations.length > 0 ? (
              <Stack spacing={2}>
                {currentAnnotations.map((ann) => (
                  <Card
                    key={ann.id}
                    sx={{
                      backgroundColor: "var(--background2)",
                      border: "1px solid var(--border)",
                      boxShadow: "none",
                    }}
                  >
                    <CardContent sx={{ p: 2, "&:last-child": { pb: 2 } }}>
                      <Box
                        sx={{
                          display: "flex",
                          justifyContent: "space-between",
                          mb: 1,
                        }}
                      >
                        <Typography
                          variant="caption"
                          fontWeight="bold"
                          sx={{ color: "var(--text)", fontFamily: "Outfit" }}
                        >
                          {ann.authorName}
                        </Typography>
                        <Typography
                          variant="caption"
                          sx={{ color: "var(--text-secondary)" }}
                        >
                          {formatDate(ann.date)}
                        </Typography>
                      </Box>

                      <Typography
                        variant="body2"
                        sx={{
                          color: "var(--text)",
                          fontSize: "0.9rem",
                          mb: 1.5,
                        }}
                      >
                        {ann.comment}
                      </Typography>

                      <Box
                        sx={{
                          backgroundColor: "rgba(0,0,0,0.1)", // Light separate background for quote
                          p: 1,
                          borderRadius: 1,
                          borderLeft: "3px solid var(--primary)",
                        }}
                      >
                        <Typography
                          variant="caption"
                          sx={{
                            color: "var(--text-secondary)",
                            fontStyle: "italic",
                            display: "block",
                            mb: 0.5,
                          }}
                        >
                          Quote:
                        </Typography>
                        <Typography
                          variant="body2"
                          sx={{
                            color: "var(--text-secondary)",
                            fontStyle: "italic",
                            fontSize: "0.85rem",
                          }}
                        >
                          "{ann.quote}"
                        </Typography>
                      </Box>
                    </CardContent>
                  </Card>
                ))}
              </Stack>
            ) : (
              <Typography
                variant="body2"
                sx={{
                  color: "var(--text-secondary)",
                  textAlign: "center",
                  mt: 4,
                }}
              >
                No annotations for this summary.
              </Typography>
            )}
          </Box>
        )}
      </Box>
      */}

      <Snackbar
        open={showGenerateSnackbar}
        autoHideDuration={7000}
        onClose={() => setShowGenerateSnackbar(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          onClose={() => setShowGenerateSnackbar(false)}
          severity="info"
          sx={{ width: "100%" }}
        >
          Summary generation started. Check back in a moment for the completed
          summary.
        </Alert>
      </Snackbar>

      <Snackbar
        open={errorSnackbar.open}
        autoHideDuration={7000}
        onClose={() => setErrorSnackbar({ open: false, message: "" })}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          onClose={() => setErrorSnackbar({ open: false, message: "" })}
          severity="error"
          sx={{ width: "100%" }}
        >
          {errorSnackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default CaseSummaries;
