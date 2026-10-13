import React, { useState, useEffect } from "react";
import {
  Box,
  Typography,
  Container,
  Button,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  IconButton,
  Menu,
  MenuItem,
  CircularProgress,
  TextField,
  Snackbar,
  Alert,
} from "@mui/material";
import { useParams, useOutletContext } from "react-router-dom";
import { jsPDF } from "jspdf";
import { fetchAuthSession } from "aws-amplify/auth";
import { marked } from "marked";
import CloseIcon from "@mui/icons-material/Close";
import DOMPurify from "dompurify";
import DownloadIcon from "@mui/icons-material/Download";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import { v4 as uuidv4 } from "uuid";
import { useWebSocket } from "../../hooks/useWebSocket";
import type { CaseOutletContext } from "./CaseLayout";
import DeleteConfirmationDialog from "../../components/Admin/DeleteConfirmationDialog";

interface Transcription {
  audio_file_id: string;
  time_uploaded: string;
  file_title: string;
  audio_text?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface CaseData {
  case_title: string;
  case_hash?: string;
  status?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

const CaseTranscriptions: React.FC = () => {
  const { caseId } = useParams();
  const { caseStatus } = useOutletContext<CaseOutletContext>();
  const [transcriptions, setTranscriptions] = useState<Transcription[]>([]);
  const [caseData, setCaseData] = useState<CaseData | null>(null);
  const [audioFile, setAudioFile] = useState<{
    file: File;
    name: string;
    type: string;
  } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [selectedTranscription, setSelectedTranscription] =
    useState<Transcription | null>(null);
  const [snackbarMessage, setSnackbarMessage] = useState("");
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [selectedTranscriptionId, setSelectedTranscriptionId] = useState<
    string | null
  >(null);
  const [audioTitle, setAudioTitle] = useState("");
  const [maxFileSizeMB, setMaxFileSizeMB] = useState(500);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [snackbarSeverity, setSnackbarSeverity] = useState<
    "success" | "info" | "error" | "warning"
  >("success");
  const [token, setToken] = useState<string | null>(null);

  // Set up WebSocket connection (same hook as CaseSummaries, InterviewAssistant, etc.)
  const { sendStreamingRequest, isConnected } = useWebSocket(wsUrl, {
    protocols: token ? [token] : undefined,
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

  const fetchFileSizeLimit = async () => {
    try {
      const { tokens } = await fetchAuthSession();
      const token = tokens?.idToken?.toString();
      if (!token) return;
      const response = await fetch(
        `${import.meta.env.VITE_API_ENDPOINT}student/file_size_limit`,
        {
          method: "GET",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        },
      );
      if (response.ok) {
        const data = await response.json();
        setMaxFileSizeMB(parseInt(data.value));
      }
    } catch {
    }
  };

  const fetchTranscriptions = async () => {
    try {
      const { tokens } = await fetchAuthSession();
      const token = tokens?.idToken?.toString();
      if (!token) return;

      const response = await fetch(
        `${
          import.meta.env.VITE_API_ENDPOINT
        }student/get_transcriptions?case_id=${caseId}`,
        {
          method: "GET",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        },
      );

      if (!response.ok) throw new Error("Transcriptions not found");
      const data = await response.json();
      setTranscriptions(data);
    } catch {
    }
  };

  useEffect(() => {
    const fetchCaseData = async () => {
      try {
        const { tokens } = await fetchAuthSession();
        const token = tokens?.idToken?.toString();
        if (!token) return;

        const response = await fetch(
          `${
            import.meta.env.VITE_API_ENDPOINT
          }student/case_page?case_id=${caseId}`,
          {
            method: "GET",
            headers: {
              Authorization: token,
              "Content-Type": "application/json",
            },
          },
        );

        if (!response.ok) throw new Error("Case not found");
        const data = await response.json();
        setCaseData(data.caseData);
      } catch {
        setCaseData(null);
      }
      setIsLoading(false);
    };

    if (caseId) {
      fetchCaseData();
      fetchTranscriptions();
      fetchFileSizeLimit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  const generatePresignedUrl = async (audioFileId: string) => {
    if (!audioFile) return;
    const fileName = audioFile.name;
    const fileType = audioFile.type;
    const { tokens } = await fetchAuthSession();
    const token = tokens?.idToken?.toString();
    if (!token) throw new Error("No token");

    const response = await fetch(
      `${import.meta.env.VITE_API_ENDPOINT}student/generate_presigned_url?` +
        `audio_file_id=${encodeURIComponent(audioFileId)}&` +
        `file_name=${encodeURIComponent(fileName)}&` +
        `file_type=${encodeURIComponent(fileType)}`,
      {
        method: "GET",
        headers: { Authorization: token, "Content-Type": "application/json" },
      },
    );

    if (!response.ok) throw new Error("Failed to generate presigned URL");
    const data = await response.json();
    return data.presignedurl;
  };

  const initializeAudioFileInDb = async (
    audioFileId: string,
    fileName: string,
  ) => {
    const { tokens } = await fetchAuthSession();
    const token = tokens?.idToken?.toString();
    if (!token) throw new Error("No token");
    const s3FilePath = `${audioFileId}/${fileName}`;

    const response = await fetch(
      `${import.meta.env.VITE_API_ENDPOINT}student/initialize_audio_file?` +
        `audio_file_id=${encodeURIComponent(audioFileId)}&` +
        `s3_file_path=${encodeURIComponent(s3FilePath)}&` +
        `case_id=${encodeURIComponent(caseId || "")}&` +
        `title=${encodeURIComponent(audioTitle)}`,
      {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
      },
    );

    if (!response.ok) throw new Error("Failed to initialize audio file");
    const data = await response.json();
    return data;
  };

  const uploadFile = async (file: File, presignedUrl: string) => {
    const response = await fetch(presignedUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
    if (!response.ok) throw new Error("Upload failed");
    return response;
  };

  const handleAudioUploading = async () => {
    if (isUploading || !audioFile) return;

    setIsUploading(true);
    setError(null);

    try {
      const audioFileId = uuidv4();

      // Create the DB record first so the audio file is bound to the case
      // before any upload capability is issued.
      await initializeAudioFileInDb(audioFileId, audioFile.name);

      const presignedUrl = await generatePresignedUrl(audioFileId);
      if (!presignedUrl) {
        throw new Error("Failed to generate presigned URL");
      }

      // Upload file to S3
      await uploadFile(audioFile.file, presignedUrl);

      // Trigger transcription via WebSocket (primary) or HTTP (fallback)
      if (isConnected) {
        sendStreamingRequest(
          "audio_to_text",
          {
            audio_file_id: audioFileId,
            file_name: audioFile.name,
            file_type: audioFile.type,
            case_title: caseData?.case_title || "Unknown Case",
            case_id: caseId || "unknown",
          },
          {
            onStart: () => {
              closeUploadDialog();
            },
            onChunk: () => {
              setSnackbarSeverity("info");
              setSnackbarMessage(
                "Transcription in progress, check back momentarily",
              );
            },
            onComplete: async () => {
              await fetchTranscriptions();
              setSnackbarSeverity("success");
              setSnackbarMessage("Transcription complete!");
              setIsUploading(false);
            },
            onError: (msg) => {
              setSnackbarSeverity("error");
              setSnackbarMessage("An error occurred during transcription");
              setError(msg || "Transcription failed");
              setIsUploading(false);
            },
          },
        );
        // Don't set isUploading=false here; the callbacks handle it
        return;
      }

      // HTTP fallback: fire-and-forget to the REST endpoint
      const { tokens } = await fetchAuthSession();
      const token = tokens?.idToken?.toString();
      if (token) {
        // Fire the request but don't await it (it will timeout at 29s anyway)
        fetch(
          `${import.meta.env.VITE_API_ENDPOINT}student/audio_to_text?` +
            `audio_file_id=${encodeURIComponent(audioFileId)}&` +
            `file_name=${encodeURIComponent(audioFile.name)}&` +
            `file_type=${encodeURIComponent(audioFile.type)}&` +
            `case_title=${encodeURIComponent(caseData?.case_title || "Unknown Case")}&` +
            `case_id=${encodeURIComponent(caseId || "unknown")}&` +
            `cognito_token=${encodeURIComponent(token)}`,
          {
            method: "GET",
            headers: {
              Authorization: token,
              "Content-Type": "application/json",
            },
          },
        ).catch(() => undefined);
      }

      setSnackbarMessage(
        "Transcription started. You will be notified when it completes.",
      );
      closeUploadDialog();
    } catch (error: unknown) {
      setError((error as Error).message || "Failed to upload audio file");
    } finally {
      setIsUploading(false);
      setAudioTitle("");
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Add file size check
    const fileSizeInMB = file.size / 1024 / 1024;

    if (fileSizeInMB > maxFileSizeMB) {
      setError(
        `File size (${fileSizeInMB.toFixed(
          2,
        )}MB) exceeds the ${maxFileSizeMB}MB limit`,
      );
      return;
    }
    const fileType = file.type;
    // Allowed MIME types
    const allowedTypes = [
      "audio/wav",
      "audio/x-wav",
      "audio/mpeg",
      "audio/mp4",
      "audio/x-m4a",
      "audio/m4a",
    ];

    if (!allowedTypes.includes(fileType)) {
      setError("Invalid file type. Only WAV, MP3, and M4A are supported.");
      return;
    }

    const fileNameWithoutExtension = file.name.replace(/\.[^/.]+$/, "");
    const fileTypeShort = fileType.split("/")[1];

    // Normalize file type to match backend allowed types
    let normalizedType = fileTypeShort;
    if (fileTypeShort === "mpeg") {
      normalizedType = "mp3";
    } else if (fileTypeShort.startsWith("x-")) {
      // Handle types like "x-m4a" -> "m4a"
      normalizedType = fileTypeShort.substring(2);
    } else if (fileType === "audio/mp4" || fileType === "audio/m4a") {
      normalizedType = "m4a";
    }

    // Final check for normalized type
    if (!["mp3", "wav", "m4a"].includes(normalizedType)) {
      setError("Invalid file type. Only WAV, MP3, and M4A are supported.");
      return;
    }

    setAudioFile({
      file: file,
      name: fileNameWithoutExtension,
      type: normalizedType,
    });
  };

  const openUploadDialog = () => {
    setUploadDialogOpen(true);
    setAudioFile(null);
    setError(null);
  };

  const closeUploadDialog = () => {
    setUploadDialogOpen(false);
    setAudioFile(null);
    setError(null);
  };

  const fetchTranscriptionText = async (audioFileId: string) => {
    try {
      const { tokens } = await fetchAuthSession();
      const token = tokens?.idToken?.toString();
      if (!token) return "Error: No token";

      const response = await fetch(
        `${
          import.meta.env.VITE_API_ENDPOINT
        }student/transcription?audio_file_id=${audioFileId}`,
        {
          method: "GET",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        },
      );

      if (!response.ok) throw new Error("Failed to fetch transcription text");
      const data = await response.json();
      return data.audio_text;
    } catch (error) {
      return "Error loading transcription.";
    }
  };

  const handleView = async (transcription: Transcription) => {
    const audioText = await fetchTranscriptionText(transcription.audio_file_id);
    setSelectedTranscription({ ...transcription, audio_text: audioText });
    setViewDialogOpen(true);
  };

  const handleCloseView = () => {
    setViewDialogOpen(false);
    setSelectedTranscription(null);
  };

  const handleDownload = async (transcription: Transcription | null) => {
    if (!transcription || !caseData) return;
    const audioText = await fetchTranscriptionText(transcription.audio_file_id);

    const doc = new jsPDF();
    const pageHeight = doc.internal.pageSize.height;
    const margin = 10;
    let y = margin;

    doc.setFontSize(12);
    y += 10;
    doc.text("Transcription:", margin, y);
    y += 10;

    const tempDiv = document.createElement("div");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tempDiv.innerHTML = await (marked.parse(audioText || "") as any);
    const content = tempDiv.textContent || tempDiv.innerText || "";
    const lines = doc.splitTextToSize(content, 180);

    for (let i = 0; i < lines.length; i++) {
      if (y + 10 > pageHeight - margin) {
        doc.addPage();
        y = margin;
      }
      doc.text(lines[i], margin, y);
      y += 7;
    }

    doc.text(
      `Interview Date: ${new Date(
        transcription.time_uploaded,
      ).toLocaleString()}`,
      margin,
      y + 10,
    );

    doc.save(
      `Case-${caseData.case_hash}:Transcription-${new Date(
        transcription.time_uploaded,
      ).toLocaleString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "numeric",
        hour12: true,
      })}.pdf`,
    );
  };

  const openMenu = Boolean(anchorEl);

  const handleMenuOpen = (
    event: React.MouseEvent<HTMLElement>,
    transcriptionId: string,
  ) => {
    setAnchorEl(event.currentTarget);
    setSelectedTranscriptionId(transcriptionId);
  };

  const handleMenuClose = () => {
    setAnchorEl(null);
    setSelectedTranscriptionId(null);
  };

  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleteTranscriptionId, setDeleteTranscriptionId] = useState<
    string | null
  >(null);

  const handleDelete = async () => {
    if (!deleteTranscriptionId) return;

    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token) return;

      const response = await fetch(
        `${
          import.meta.env.VITE_API_ENDPOINT
        }student/delete_transcription?audio_file_id=${deleteTranscriptionId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: token,
            "Content-Type": "application/json",
          },
        },
      );
      if (!response.ok) throw new Error("Failed to delete transcription");
      setTranscriptions((prev) =>
        prev.filter((t) => t.audio_file_id !== deleteTranscriptionId),
      );
    } catch (error) {
    } finally {
      setConfirmDeleteOpen(false);
      setDeleteTranscriptionId(null);
    }
  };

  return (
    <Box
      sx={{
        width: "100%",
        minHeight: "calc(100vh - 80px)",
        backgroundColor: "var(--background)",
        color: "var(--text)",
        borderTop: "1px solid var(--border)",
        p: 4,
      }}
    >
      <Container maxWidth="lg">
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
          sx={{ mb: 4 }}
        >
          <Box>
            <Typography
              variant="h4"
              fontWeight={600}
              mb={0}
              fontFamily="Outfit"
              textAlign="left"
            >
              Transcriptions
            </Typography>
            {caseData && (
              <Typography
                variant="h4"
                fontWeight={400}
                fontSize={20}
                mb={0}
                fontFamily="Outfit"
                textAlign="left"
              >
                For Case: "{caseData.case_title}"
              </Typography>
            )}

            {caseStatus === "archived" && (
              <Typography
                sx={{
                  mt: 1,
                  color: "gray",
                  fontStyle: "italic",
                  fontFamily: "Outfit",
                }}
              >
                This case is archived. Unarchive the case to upload new audio.
              </Typography>
            )}
          </Box>
          <Button
            variant="contained"
            color="primary"
            startIcon={<CloudUploadIcon />}
            onClick={openUploadDialog}
            disabled={caseStatus === "archived"}
            sx={{
              textTransform: "none",
              fontFamily: "Inter",
              fontWeight: 500,
              px: 3,
              py: 1,
              color: "var(--text)",
              backgroundColor: "var(--primary)",
              "&:hover": {
                backgroundColor: "var(--primary)",
                opacity: 0.9,
              },
              "&.Mui-disabled": {
                backgroundColor: "var(--border)",
                color: "#000000",
              },
              boxShadow: "none",
              borderRadius: 5,
            }}
          >
            Upload Audio
          </Button>
        </Stack>

        {isLoading ? (
          <Box sx={{ display: "flex", justifyContent: "center", mt: 4 }}>
            <CircularProgress
              size={30}
              sx={{ color: "var(--text-secondary)" }}
            />
          </Box>
        ) : transcriptions.length > 0 ? (
          <TableContainer
            component={Paper}
            sx={{
              backgroundColor: "transparent",
              backgroundImage: "none",
              boxShadow: "none",
              border: "1px solid var(--border)",
              "& .MuiTableBody-root .MuiTableRow-root:last-child .MuiTableCell-root": {
                borderBottom: "none",
              },
            }}
          >
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell
                    sx={{
                      color: "var(--text)",
                      borderColor: "var(--border)",
                    }}
                  >
                    Interview Date
                  </TableCell>
                  <TableCell
                    sx={{
                      color: "var(--text)",
                      borderColor: "var(--border)",
                    }}
                  >
                    Title
                  </TableCell>
                  <TableCell
                    align="right"
                    sx={{ borderColor: "var(--border)" }}
                  ></TableCell>
                </TableRow>
              </TableHead>

              <TableBody>
                {transcriptions.map((transcription) => (
                  <TableRow key={transcription.audio_file_id}>
                    <TableCell
                      sx={{
                        color: "var(--text)",
                        borderColor: "var(--border)",
                      }}
                    >
                      {new Date(transcription.time_uploaded).toLocaleString(
                        "en-US",
                        {
                          month: "long",
                          day: "numeric",
                          year: "numeric",
                          hour: "numeric",
                          minute: "numeric",
                          hour12: true,
                        },
                      )}
                    </TableCell>
                    <TableCell
                      sx={{
                        color: "var(--text)",
                        borderColor: "var(--border)",
                      }}
                    >
                      {transcription.file_title || "Untitled"}
                    </TableCell>
                    <TableCell
                      align="right"
                      sx={{ borderColor: "var(--border)" }}
                    >
                      <Stack
                        direction="row"
                        spacing={1}
                        justifyContent="flex-end"
                      >
                        <Button
                          variant="contained"
                          sx={{
                            textTransform: "none",
                            fontFamily: "Inter",
                            fontWeight: 500,
                            px: 3,
                            py: 1,
                            color: "var(--text)",
                            backgroundColor: "var(--primary)",
                            "&:hover": {
                              backgroundColor: "var(--primary)",
                              opacity: 0.9,
                            },
                            boxShadow: "none",
                            borderRadius: 5,
                          }}
                          onClick={() => handleView(transcription)}
                        >
                          View
                        </Button>
                        <Button
                          variant="contained"
                          startIcon={<DownloadIcon />}
                          onClick={() => handleDownload(transcription)}
                          sx={{
                            textTransform: "none",
                            fontFamily: "Inter",
                            fontWeight: 500,
                            px: 3,
                            py: 1,
                            color: "var(--text)",
                            backgroundColor: "var(--primary)",
                            "&:hover": {
                              backgroundColor: "var(--primary)",
                              opacity: 0.9,
                            },
                            boxShadow: "none",
                            borderRadius: 5,
                          }}
                        >
                          Download
                        </Button>
                        <IconButton
                          onClick={(e) =>
                            handleMenuOpen(e, transcription.audio_file_id)
                          }
                        >
                          <MoreVertIcon sx={{ color: "var(--text)" }} />
                        </IconButton>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <Typography variant="body2" color="gray">
            No transcriptions yet.
          </Typography>
        )}

        {/* Audio Upload Dialog */}
        {/* Audio Upload Dialog */}
        <Dialog
          open={uploadDialogOpen}
          onClose={closeUploadDialog}
          maxWidth="sm"
          fullWidth
          PaperProps={{
            sx: {
              backgroundColor: "var(--background)",
              color: "var(--text)",
              border: "1px solid var(--border-color)",
              boxShadow:
                "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
            },
          }}
        >
          <DialogTitle
            sx={{
              color: "var(--text)",
              fontFamily: "Outfit",
              fontWeight: 600,
            }}
          >
            Upload Audio File
            <IconButton
              aria-label="close"
              onClick={closeUploadDialog}
              sx={{
                position: "absolute",
                right: 8,
                top: 8,
                color: "var(--text-secondary)",
              }}
            >
              <CloseIcon />
            </IconButton>
          </DialogTitle>
          <DialogContent>
            <Box sx={{ p: 2 }}>
              <TextField
                fullWidth
                label="Audio Title"
                value={audioTitle}
                onChange={(e) => setAudioTitle(e.target.value)}
                sx={{
                  mb: 2,
                  "& .MuiInputLabel-root": { color: "var(--text-secondary)" },
                  "& .MuiInputBase-input": { color: "var(--text)" },
                  "& .MuiOutlinedInput-root": {
                    "& fieldset": { borderColor: "var(--border-color)" },
                    "&:hover fieldset": {
                      borderColor: "var(--text-secondary)",
                    },
                    "&.Mui-focused fieldset": { borderColor: "var(--primary)" },
                  },
                }}
                inputProps={{ maxLength: 100 }}
              />

              <Typography
                variant="body1"
                gutterBottom
                sx={{ color: "var(--text)" }}
              >
                Select an audio file to upload for transcription
              </Typography>

              {audioFile ? (
                <Box
                  sx={{
                    mt: 2,
                    p: 2,
                    border: "1px solid var(--border-color)",
                    borderRadius: 1,
                    backgroundColor: "rgba(255, 255, 255, 0.05)",
                  }}
                >
                  <Typography variant="subtitle1" sx={{ color: "var(--text)" }}>
                    Selected file:
                  </Typography>
                  <Typography sx={{ color: "var(--text-secondary)" }}>
                    {audioFile.file.name} (
                    {(audioFile.file.size / 1024 / 1024).toFixed(2)} MB)
                  </Typography>
                </Box>
              ) : (
                <Box
                  sx={{
                    mt: 2,
                    p: 3,
                    border: "2px dashed var(--border-color)",
                    borderRadius: 1,
                    textAlign: "center",
                    cursor: "pointer",
                    "&:hover": {
                      backgroundColor: "rgba(255, 255, 255, 0.05)",
                      borderColor: "var(--text-secondary)",
                    },
                    transition: "all 0.2s ease-in-out",
                  }}
                  onClick={() =>
                    document.getElementById("audio-file-input")?.click()
                  }
                >
                  <input
                    id="audio-file-input"
                    type="file"
                    accept="audio/wav, audio/mpeg, audio/mp4, audio/x-m4a, audio/m4a"
                    onChange={handleFileUpload}
                    style={{ display: "none" }}
                  />
                  <CloudUploadIcon
                    sx={{ fontSize: 48, color: "var(--text-secondary)", mb: 1 }}
                  />
                  <Typography sx={{ color: "var(--text)" }}>
                    Click to select an audio file or drag & drop here
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{ color: "var(--text-secondary)" }}
                  >
                    Supported formats: WAV, MP3, M4A
                  </Typography>
                </Box>
              )}

              {error && (
                <Typography color="error" sx={{ mt: 2 }}>
                  {error}
                </Typography>
              )}
            </Box>
          </DialogContent>
          <DialogActions sx={{ p: 2 }}>
            <Button
              onClick={closeUploadDialog}
              disabled={isUploading}
              sx={{
                textTransform: "none",
                color: "var(--text-secondary)",
                fontFamily: "Outfit",
                "&:hover": {
                  backgroundColor: "rgba(255, 255, 255, 0.05)",
                },
              }}
            >
              Cancel
            </Button>
            <Button
              variant="contained"
              color="primary"
              onClick={handleAudioUploading}
              disabled={!audioFile || isUploading}
              startIcon={
                isUploading ? (
                  <CircularProgress size={20} color="inherit" />
                ) : null
              }
              sx={{
                textTransform: "none",
                backgroundColor: "var(--secondary)",
                color: "white",
                "&:hover": {
                  backgroundColor: "var(--primary)",
                },
                boxShadow: "none",
                borderRadius: 5,
                fontFamily: "Outfit",
                "&.Mui-disabled": {
                  backgroundColor: "rgba(255, 255, 255, 0.12)",
                  color: "rgba(255, 255, 255, 0.3)",
                },
              }}
            >
              {isUploading ? "Processing..." : "Upload & Transcribe"}
            </Button>
          </DialogActions>
        </Dialog>

        {/* Menu */}
        <Menu
          anchorEl={anchorEl}
          open={openMenu}
          onClose={handleMenuClose}
          PaperProps={{
            sx: {
              backgroundColor: "var(--background)",
              color: "var(--text)",
              border: "1px solid var(--border-color)",
            },
          }}
        >
          <MenuItem
            onClick={() => {
              setDeleteTranscriptionId(selectedTranscriptionId);
              setConfirmDeleteOpen(true);
              handleMenuClose();
            }}
            disabled={caseStatus === "archived"}
            sx={{
              color: "var(--text)",
              "&.Mui-disabled": {
                color: "var(--text-secondary)",
                opacity: 0.6,
              },
            }}
          >
            Delete
          </MenuItem>
        </Menu>

        {/* Delete Confirmation */}
        <DeleteConfirmationDialog
          open={confirmDeleteOpen}
          onClose={() => {
            setConfirmDeleteOpen(false);
            setDeleteTranscriptionId(null);
          }}
          onConfirm={handleDelete}
          itemName="delete transcription"
          title="Delete Transcription"
          description="Are you sure you want to delete this transcription? This action cannot be undone."
        />

        {/* View Dialog */}
        <Dialog
          open={viewDialogOpen}
          onClose={handleCloseView}
          maxWidth="md"
          fullWidth
          PaperProps={{
            sx: {
              backgroundColor: "var(--background)",
              color: "var(--text)",
              border: "1px solid var(--border-color)",
              boxShadow:
                "0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)",
            },
          }}
        >
          <DialogTitle
            sx={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              pr: 6,
              borderBottom: "1px solid var(--border-color)",
            }}
          >
            <Typography
              variant="h6"
              fontWeight={600}
              fontFamily="Outfit"
              color="var(--text)"
            >
              Transcription Preview
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <Button
                variant="outlined"
                startIcon={<DownloadIcon />}
                onClick={() => handleDownload(selectedTranscription)}
                sx={{
                  backgroundColor: "var(--secondary)",
                  color: "white",
                  textTransform: "none",
                  "&:hover": {
                    backgroundColor: "var(--primary)",
                  },
                  boxShadow: "none",
                  padding: 1,
                  borderRadius: 5,
                  fontFamily: "Outfit",
                  border: "none",
                }}
              >
                Download
              </Button>
              <IconButton
                aria-label="close"
                onClick={handleCloseView}
                sx={{
                  position: "absolute",
                  right: 8,
                  top: 8,
                  color: "var(--text-secondary)",
                }}
              >
                <CloseIcon />
              </IconButton>
            </Stack>
          </DialogTitle>
          <DialogContent
            dividers
            sx={{
              borderColor: "var(--border-color)",
              color: "var(--text)",
              "& p": {
                color: "var(--text)",
                fontFamily: "Outfit",
              },
            }}
          >
            {selectedTranscription ? (
              <div
                dangerouslySetInnerHTML={{
                  __html: DOMPurify.sanitize(
                    marked.parse(
                      selectedTranscription.audio_text ||
                        "No transcription available",
                    ) as string,
                  ),
                }}
                style={{ fontFamily: "Outfit, sans-serif" }}
              />
            ) : (
              <Typography variant="body2" sx={{ color: "var(--text)" }}>
                No transcription available
              </Typography>
            )}
          </DialogContent>
        </Dialog>

        <Snackbar
          open={!!snackbarMessage}
          autoHideDuration={8000}
          onClose={() => setSnackbarMessage("")}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        >
          <Alert
            onClose={() => setSnackbarMessage("")}
            severity={snackbarSeverity}
            sx={{ width: "100%" }}
          >
            {snackbarMessage}
          </Alert>
        </Snackbar>
      </Container>
    </Box>
  );
};

export default CaseTranscriptions;
